import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  decimalCompare,
  immutable,
  nonNegativeAmountSchema,
  parseDecimal,
  timestampSchema,
} from '@ctp/exchange-core';
import { marketSnapshotPublicationSchema, marketTradePublicationSchema } from '@ctp/market-data';
import { evaluateRiskPolicy, reconstructUtcLoss, type RiskEvaluation } from '@ctp/risk-engine';
import { paperOrderRiskRequestSchema } from './order-risk-domain.js';
import { decodePaperTenantRiskContextSource } from './tenant-risk-context-domain.js';
import { calculatePaperRiskBudget } from './risk-budget.js';

const input = z.strictObject({
  now: timestampSchema,
  request: paperOrderRiskRequestSchema,
  capture: z.unknown(),
});
const D = Decimal.clone({
  precision: 120,
  rounding: Decimal.ROUND_HALF_EVEN,
  modulo: Decimal.ROUND_FLOOR,
  minE: -100,
  maxE: 100,
  toExpNeg: -100,
  toExpPos: 100,
  crypto: false,
});
const adapterVersion = 'paper-spot-l2-taker-v1';
const evidenceUrl =
  'https://github.com/dendenden-boop/tradeGPTbot/blob/8dd14f4b77c3bda8a5f0df3003be54adde55bd07/packages/paper-engine/src/model.ts';
// Extract only already content-validated original publication text. This does
// not turn caller JSON into SQL source authority or a durable certificate.
const publications = z.object({
  context: z.object({
    authority: z.object({
      orderRisk: z.object({
        snapshot: z.object({ publicationText: z.string() }),
        trade: z.object({ publicationText: z.string() }),
      }),
    }),
  }),
});
type Debit = ReturnType<typeof calculatePaperRiskBudget>['coverage']['debits'][number];
export interface PaperRiskEvaluationCalculation {
  readonly kind: 'PAPER_RISK_EVALUATION_CALCULATION';
  readonly computedAt: number;
  readonly validUntil: number;
  readonly sourceHash: string | null;
  readonly request: z.infer<typeof paperOrderRiskRequestSchema>;
  readonly result:
    | Extract<RiskEvaluation, { kind: 'REJECTED' }>
    | {
        readonly kind: 'EVALUATED';
        readonly effect: 'INCREASE';
        readonly notional: string;
        readonly debits: readonly Debit[];
      };
}

/** Pure prerequisite for a future certified coordinator. Neither serialized
 * capture, hash nor EVALUATED result grants admission, reserves money or enables
 * dispatch. Only pristine quote-cash inventory is supported in this increment. */
export function calculatePaperRiskEvaluation(raw: unknown): PaperRiskEvaluationCalculation {
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new Error('PAPER_EVALUATION_INPUT');
  const { now, request, capture } = parsed.data;
  let sourceHash: string | null = null,
    validUntil = now;
  const result = (value: PaperRiskEvaluationCalculation['result']) =>
    immutable({
      kind: 'PAPER_RISK_EVALUATION_CALCULATION' as const,
      computedAt: now,
      validUntil,
      sourceHash,
      request,
      result: value,
    });
  const reject = (reason: string) => result({ kind: 'REJECTED', reasons: [reason] });
  try {
    const source = decodePaperTenantRiskContextSource(capture, request, now),
      { authority, runtime } = source.context,
      orderRisk = authority.orderRisk,
      cfg = orderRisk.book.origin.configuration.configuration,
      order = orderRisk.target.command,
      inventory = source.loss.inventory,
      limits = authority.policies.effective;
    sourceHash = source.hash;
    validUntil = source.validUntil;
    if (
      order.side !== 'BUY' ||
      !['LIMIT', 'MARKET'].includes(order.type) ||
      cfg.source.market !== 'SPOT'
    )
      return reject('PAPER_EVALUATION_UNSUPPORTED');
    const wire = publications.parse(capture).context.authority.orderRisk,
      s = marketSnapshotPublicationSchema.parse(JSON.parse(wire.snapshot.publicationText)),
      t = marketTradePublicationSchema.parse(JSON.parse(wire.trade.publicationText));
    if (s.kind !== 'SNAPSHOT' || t.kind !== 'TRADE' || s.ticker.last.state !== 'AVAILABLE')
      return reject('PAPER_EVALUATION_MARKET');
    const { instrument } = s.record;
    if (instrument.quoteAsset !== limits.valuationAsset)
      return reject('PAPER_EVALUATION_FX_UNPROVED');
    const fx = {
        from: instrument.quoteAsset,
        to: limits.valuationAsset,
        rate: '1',
        kind: 'IDENTITY' as const,
        sourceId: 'paper-identity-fx',
        asOf: inventory.asOf,
      },
      budget = calculatePaperRiskBudget({
        now,
        model: cfg.model,
        record: s.record,
        book: s.book,
        trade: t.trade,
        order,
        owner: request.owner,
        target: { orderId: orderRisk.target.orderId, intentId: request.intentId },
        platform: authority.policies.platform.limits,
        user: authority.policies.user.limits,
        fx,
        evidence: {
          scope: source.loss.evidence.scope,
          asOf: inventory.asOf,
          complete: true,
          accountIds: inventory.accountIds,
          // The accepted decoder proves pristine cash-only inventory. Do not
          // generalize these empty sets to a source with active history.
          positions: [],
          orders: [],
          reservations: [],
          holds: [],
          balances: inventory.accounts.flatMap((a) =>
            a.state.balances.map((b) => ({
              accountId: a.state.binding.accountId,
              asset: b.asset,
              available: b.available,
            })),
          ),
        },
      });
    validUntil = Math.min(validUntil, budget.validUntil);
    const bid = s.book.bids[0]!,
      ask = s.book.asks[0]!,
      step = new D(s.record.rules.stepSize),
      liquidQuantity = D.min(bid.quantity, ask.quantity, t.trade.quantity)
        .mul(cfg.model.participationRate)
        .div(step)
        .floor()
        .mul(step),
      liquidityNotional = nonNegativeAmountSchema.parse(
        liquidQuantity.mul(D.min(bid.price, ask.price)).toFixed(),
      ),
      binding = {
        ...request.owner,
        profile: {
          ...cfg.source,
          accountMode: 'SIMULATED',
          endpointProfileId: 'paper-spot-v1',
          profileVersion: cfg.model.version,
        },
      },
      sourceId = 'paper-risk-calc:' + source.hash,
      revision = runtime.reference.revision,
      loss = reconstructUtcLoss(
        source.loss.evidence,
        source.loss.evidence.scope,
        now,
        Math.min(cfg.model.maxEvidenceAgeMs, limits.maxEvidenceAgeMs),
      ),
      h = runtime.health,
      evaluated = evaluateRiskPolicy({
        now,
        binding,
        adapterVersion,
        platform: authority.policies.platform.limits,
        user: authority.policies.user.limits,
        order,
        record: s.record,
        capabilities: (['LIMIT_ORDER', 'MARKET_ORDER'] as const).map((feature) => ({
          profile: binding.profile,
          feature,
          support: 'SUPPORTED',
          implementation: 'SYNTHETIC',
          constraints: { instrumentIds: [instrument.id] },
          evidenceUrl,
          checkedAt: orderRisk.asOf,
          expiresAt: validUntil,
          adapterVersion,
        })),
        snapshot: {
          binding,
          instrumentId: instrument.id,
          revision,
          sourceId,
          sourceAt: inventory.asOf,
          reconciledAt: source.asOf,
          complete: true,
          unknownExposure: false,
          valuationAsset: limits.valuationAsset,
          instrumentExposure: budget.current.instrument,
          assetExposure: budget.current.asset,
          accountExposure: budget.current.account,
          userExposure: budget.current.user,
          positionQuantity: '0',
          positionEvidence: {
            mode: 'SPOT',
            accountMode: 'SIMULATED',
            accountId: request.owner.accountId,
            instrumentId: instrument.id,
            sourceId,
            revision,
            asOf: inventory.asOf,
            side: 'NET',
            quantity: '0',
          },
          committedReductionQuantity: '0',
          instrumentHasPendingEntry: false,
          concurrentPositions: budget.potentialPositions.current,
          openOrders: budget.orders.current,
          ordersInLastMinute: inventory.accounts
            .flatMap((a) => a.drafts)
            .filter((d) => d.intentId !== request.intentId && d.createdAt >= now - 60000).length,
          leverage: '1',
          availableAsset: instrument.quoteAsset,
          availableAmount: budget.coverage.debits[0]!.available,
          dailyNetRealizedPnl: loss.dailyNetRealizedPnl,
          adjustedOpeningEquity: loss.adjustedOpeningEquity,
          adjustedCurrentEquity: loss.adjustedCurrentEquity,
          adjustedPeakEquity: loss.adjustedPeakEquity,
          utcDayStart: source.loss.evidence.utcDayStart,
          lossBaselineComplete: true,
          pauses: { ...authority.controls.pauses, connection: false },
          circuit: authority.controls.circuit,
          health: {
            database: h.database.status,
            limiter: h.limiter.status,
            authentication: h.authentication.status,
            // Legacy common-policy slot names: PAPER uses observed public
            // market and executor health, never an invented private stream.
            exchangeRest: h.publicMarket.status,
            privateStream: h.executor.status,
            clock: h.clock.status,
            latency: h.latency.status,
            rejectRate: h.rejectRate.status,
            maintenance: h.maintenance.status,
          },
          market: {
            sourceId: 'paper-market:' + orderRisk.evidence.snapshot.id,
            asOf: Math.min(s.timestamp, t.timestamp, s.book.receivedAt, t.trade.receivedAt),
            complete: true,
            referencePrice: s.ticker.last.value,
            lowerExecutionPrice: budget.coverage.envelope.executionPrice.minimum,
            upperExecutionPrice: budget.coverage.envelope.executionPrice.maximum,
            bid: bid.price,
            ask: ask.price,
            liquidityNotional,
            liquidityAsset: limits.valuationAsset,
            priceAsset: instrument.quoteAsset,
            quoteToValuation: '1',
            fxFromAsset: fx.from,
            fxToAsset: fx.to,
            fxKind: fx.kind,
            fxSourceId: fx.sourceId,
            fxAsOf: fx.asOf,
            kind: 'LAST',
            executionBoundEnforced: true,
            feeAsset: instrument.quoteAsset,
            maxFeeRate: cfg.model.takerFeeRate,
          },
        },
      });
    if (evaluated.kind === 'REJECTED') return result(evaluated);
    // The common scalar proposal does not include the worst-case per-lot fee
    // ceiling. Only the recomputed complete debit vector may feed future reserve.
    if (
      budget.coverage.debits.some(
        (d) =>
          decimalCompare(parseDecimal(d.remaining), parseDecimal(limits.minAvailableBalance)) < 0,
      )
    )
      return reject('RISK_AVAILABLE_BALANCE');
    return result({
      kind: 'EVALUATED',
      effect: 'INCREASE',
      notional: budget.notional,
      debits: budget.coverage.debits,
    });
  } catch (error) {
    return reject(
      error instanceof Error &&
        /^(?:PAPER_(?:TENANT_RISK_CONTEXT|BUDGET)_[A-Z_]+)$/u.test(error.message)
        ? error.message
        : 'PAPER_EVALUATION_EVIDENCE',
    );
  }
}
