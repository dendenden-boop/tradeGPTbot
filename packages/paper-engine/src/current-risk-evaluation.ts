import { z } from 'zod';
import {
  immutable,
  newOrderSchema,
  timestampSchema,
  decimalCompare,
  parseDecimal,
} from '@ctp/exchange-core';
import { marketSnapshotPublicationSchema, marketTradePublicationSchema } from '@ctp/market-data';
import { evaluateRiskPolicy, type RiskEvaluation } from '@ctp/risk-engine';
import { paperOwnerSchema } from './configuration-domain.js';
import { decodePaperCurrentRiskContents } from './postgres-current-risk.js';
import { lookupPaperExecutionCommitRequest } from './postgres-execution-commit.js';
import { calculatePaperRiskBudget } from './risk-budget.js';

const inputSchema = z.strictObject({
  now: timestampSchema,
  sourceRequest: z.unknown(),
  certificate: z.unknown(),
  target: z.strictObject({
    owner: paperOwnerSchema,
    orderId: z.uuid(),
    intentId: z.uuid(),
    dbInstrumentId: z.uuid(),
    dbRuleId: z.uuid(),
    command: newOrderSchema,
  }),
});
type Budget = ReturnType<typeof calculatePaperRiskBudget>;
export interface PaperCurrentRiskEvaluationCalculation {
  readonly kind: 'PAPER_CURRENT_RISK_EVALUATION_CALCULATION';
  readonly computedAt: number;
  readonly validUntil: number;
  readonly target: z.infer<typeof inputSchema>['target'];
  readonly source: Readonly<{
    id: string;
    revision: string;
    hash: string;
    fingerprint: string;
  }> | null;
  readonly result:
    | Extract<RiskEvaluation, { kind: 'REJECTED' }>
    | {
        readonly kind: 'EVALUATED';
        readonly effect: 'INCREASE';
        readonly notional: string;
        readonly debits: Budget['coverage']['debits'];
        readonly budget: Pick<Budget, 'current' | 'projected' | 'orders' | 'potentialPositions'>;
      };
}
function fail(): never {
  throw Error('PAPER_CURRENT_EVALUATION_EVIDENCE');
}
function bounded(raw: unknown) {
  let nodes = 0,
    bytes = 0;
  const active = new WeakSet<object>();
  function visit(v: unknown, depth: number) {
    if (++nodes > 400000 || depth > 40) fail();
    if (typeof v === 'string') bytes += Buffer.byteLength(v);
    else if (v === null || typeof v === 'boolean') return;
    else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) fail();
    } else if (typeof v === 'object') {
      if (active.has(v)) fail();
      active.add(v);
      const keys = Reflect.ownKeys(v);
      if (Array.isArray(v)) {
        if (v.length > 10000 || keys.length !== v.length + 1) fail();
        for (let n = 0; n < v.length; n++) {
          const d = Object.getOwnPropertyDescriptor(v, String(n));
          if (!d?.enumerable || !('value' in d)) fail();
          visit(d.value, depth + 1);
        }
      } else {
        const prototype = Object.getPrototypeOf(v) as unknown;
        if ((prototype !== Object.prototype && prototype !== null) || keys.length > 64) fail();
        for (const key of keys) {
          if (typeof key !== 'string' || key.length > 128) fail();
          const d = Object.getOwnPropertyDescriptor(v, key);
          if (!d?.enumerable || !('value' in d)) fail();
          bytes += Buffer.byteLength(key);
          visit(d.value, depth + 1);
        }
      }
      active.delete(v);
    } else fail();
    if (bytes > 16777216) fail();
  }
  visit(raw, 0);
}

/** Pure next-order arithmetic over content of a current certificate. This does
 * not authenticate storage/current heads or prove that the target is a durable
 * new intent. A fixed future atomic writer must capture and independently repeat
 * all checks, then reserve/dispatch once. No caller JSON/hash/calculation grants
 * authority, renews evidence, credits collateral or modifies a financial row. */
export function calculatePaperCurrentRiskEvaluation(
  raw: unknown,
): PaperCurrentRiskEvaluationCalculation {
  bounded(raw);
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw Error('PAPER_CURRENT_EVALUATION_INPUT');
  const { now, target, certificate } = parsed.data;
  let source: PaperCurrentRiskEvaluationCalculation['source'] = null,
    validUntil = now;
  const result = (value: PaperCurrentRiskEvaluationCalculation['result']) =>
    immutable({
      kind: 'PAPER_CURRENT_RISK_EVALUATION_CALCULATION' as const,
      computedAt: now,
      validUntil,
      target,
      source,
      result: value,
    });
  const reject = (reason: string) => result({ kind: 'REJECTED', reasons: [reason] });
  try {
    const original = lookupPaperExecutionCommitRequest(
      parsed.data.sourceRequest,
      'PAPER_CURRENT_RISK_CERTIFY',
    );
    const c = decodePaperCurrentRiskContents(
      certificate,
      { ...original, kind: 'PAPER_CURRENT_RISK_CERTIFY' },
      now,
    );
    source = { id: c.id, revision: c.revision, hash: c.hash, fingerprint: c.sourceFingerprint };
    validUntil = c.expiresAt;
    const owner = target.owner,
      originalOrder = original.admission;
    if (
      owner.tenantId !== c.scope.tenantId ||
      owner.accountId !== c.scope.accountId ||
      owner.mode !== c.scope.mode ||
      target.dbInstrumentId !== c.scope.dbInstrumentId ||
      target.dbRuleId !== c.scope.dbRuleId ||
      target.command.instrumentId !== c.scope.instrumentId ||
      target.orderId === originalOrder.orderId ||
      target.intentId === originalOrder.intentId
    )
      return reject('PAPER_CURRENT_EVALUATION_SCOPE');
    if (
      target.command.side !== 'BUY' ||
      !['LIMIT', 'MARKET'].includes(target.command.type) ||
      target.command.reduceOnly
    )
      return reject('PAPER_CURRENT_EVALUATION_UNSUPPORTED');
    const sealed = z.object({ text: z.string() }).parse(certificate);
    const wire = z
      .object({
        source: z.object({
          market: z.object({
            snapshot: z.object({ text: z.string() }),
            trade: z.object({ text: z.string() }),
          }),
        }),
      })
      .parse(JSON.parse(sealed.text));
    const snapshot = marketSnapshotPublicationSchema.parse(
        JSON.parse(wire.source.market.snapshot.text),
      ),
      trade = marketTradePublicationSchema.parse(JSON.parse(wire.source.market.trade.text));
    if (snapshot.kind !== 'SNAPSHOT' || trade.kind !== 'TRADE') fail();
    const cfg = c.inventory.accounts.find((a) => a.accountId === owner.accountId)?.configuration
      .configuration;
    if (!cfg || cfg.valuationAsset !== snapshot.record.instrument.quoteAsset) fail();
    const evidence = c.inventory.evidence,
      quote = cfg.valuationAsset;
    // The accepted closure has one authenticated executed order and pristine
    // siblings. Translate its remaining order/reservation identity, not a scalar
    // credit or a second order. General multi-history is not inferred here.
    if (
      evidence.orders.some((o) => o.id !== originalOrder.orderId) ||
      evidence.reservations.some((r) => r.orderId !== originalOrder.orderId)
    )
      fail();
    const effect = { intentId: originalOrder.intentId, quote, side: 'BUY' as const };
    const budget = calculatePaperRiskBudget({
      now,
      owner,
      target: { orderId: target.orderId, intentId: target.intentId },
      model: cfg.model,
      record: snapshot.record,
      book: snapshot.book,
      trade: trade.trade,
      order: target.command,
      platform: c.policies.platform.limits,
      user: c.policies.user.limits,
      fx: {
        from: quote,
        to: quote,
        rate: '1',
        kind: 'IDENTITY',
        sourceId: 'paper-identity-fx',
        asOf: c.inventory.asOf,
      },
      evidence: {
        scope: evidence.scope,
        asOf: c.inventory.asOf,
        complete: true,
        accountIds: c.inventory.accountIds,
        positions: evidence.positions,
        orders: evidence.orders.map((o) => ({ ...o, ...effect })),
        reservations: evidence.reservations.map((r) => ({
          ...r,
          ...effect,
          debits: [{ asset: r.asset, amount: r.amount, holdId: r.holdId }],
        })),
        holds: evidence.holds,
        balances: c.inventory.valuation.accounts.map((a) => {
          const b = a.balances.find((b) => b.asset === quote);
          if (!b || b.available === null) fail();
          return { accountId: a.accountId, asset: quote, available: b.available };
        }),
      },
    });
    validUntil = Math.min(validUntil, budget.validUntil);
    // Independent calculations must agree on all existing liabilities. Never
    // replace authenticated current exposure with empty pristine arrays.
    if (
      budget.current.instrument !== c.snapshot.instrumentExposure ||
      budget.current.asset !== c.snapshot.assetExposure ||
      budget.current.account !== c.snapshot.accountExposure ||
      budget.current.user !== c.snapshot.userExposure ||
      budget.orders.current !== c.snapshot.openOrders ||
      budget.potentialPositions.current !== c.snapshot.concurrentPositions ||
      budget.coverage.debits[0]?.available !== c.snapshot.availableAmount
    )
      fail();
    const evaluated = evaluateRiskPolicy({
      now,
      binding: c.snapshot.binding,
      adapterVersion: c.capabilities.adapterVersion,
      platform: c.policies.platform.limits,
      user: c.policies.user.limits,
      order: target.command,
      record: snapshot.record,
      capabilities: c.capabilities.features,
      snapshot: {
        ...c.snapshot,
        market: {
          ...c.snapshot.market,
          lowerExecutionPrice: budget.coverage.envelope.executionPrice.minimum,
          upperExecutionPrice: budget.coverage.envelope.executionPrice.maximum,
          // A mathematical enforced-bound proposal only. The certificate remains
          // unchanged with false; a future writer must actually enforce this bound.
          executionBoundEnforced: true,
        },
      },
    });
    if (evaluated.kind === 'REJECTED') return result(evaluated);
    if (
      budget.coverage.debits.some(
        (d) =>
          decimalCompare(
            parseDecimal(d.remaining),
            parseDecimal(c.policies.effective.minAvailableBalance),
          ) < 0,
      )
    )
      return reject('RISK_AVAILABLE_BALANCE');
    return result({
      kind: 'EVALUATED',
      effect: 'INCREASE',
      notional: budget.notional,
      debits: budget.coverage.debits,
      budget: {
        current: budget.current,
        projected: budget.projected,
        orders: budget.orders,
        potentialPositions: budget.potentialPositions,
      },
    });
  } catch (error) {
    return reject(
      error instanceof Error &&
        /^(?:PAPER_(?:BUDGET|CURRENT_RISK|ADMISSION)_[A-Z_]+)$/u.test(error.message)
        ? error.message
        : 'PAPER_CURRENT_EVALUATION_EVIDENCE',
    );
  }
}
