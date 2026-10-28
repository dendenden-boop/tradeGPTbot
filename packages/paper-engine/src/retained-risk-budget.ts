import { z } from 'zod';
import {
  decimalCompare,
  immutable,
  parseDecimal,
  sameMarketScope,
  timestampSchema,
} from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { intersectRiskLimits } from '@ctp/risk-engine';
import { preparePaperExecutionAttempt } from './execution-attempt.js';
import { calculatePaperRiskBudget, paperRiskBudgetInputSchema } from './risk-budget.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const schema = z.strictObject({
  now: timestampSchema,
  deadline: timestampSchema,
  preparation: z.unknown(),
  metadata: z.strictObject({ instrumentId: uuid, ruleId: uuid }),
  reservation: z.strictObject({
    id: uuid,
    decisionId: uuid,
    status: z.literal('ACTIVE'),
    revision: z.literal('1'),
    expiresAt: timestampSchema,
  }),
  budget: paperRiskBudgetInputSchema,
});
export interface PaperRetainedRiskBudgetCalculation {
  readonly kind: 'PAPER_RETAINED_RISK_BUDGET_CALCULATION';
  readonly computedAt: number;
  readonly validUntil: number;
  readonly attemptId: string;
  readonly requestHash: string;
  readonly reservationId: string;
  readonly retained: readonly {
    readonly asset: string;
    readonly amount: string;
    readonly holdId: string;
  }[];
  readonly budget: ReturnType<typeof calculatePaperRiskBudget>;
}
function fail(code = 'EVIDENCE'): never {
  throw Error('PAPER_RETAINED_' + code);
}
function bounded(raw: unknown) {
  // Inputs are JSON content only. Inspect descriptors before any schema/hash or
  // underlying budget traversal; oversized arrays and accessors are never read.
  let nodes = 0,
    bytes = 0;
  const active = new WeakSet<object>();
  function visit(value: unknown, depth: number, key: string) {
    if (++nodes > 150000 || depth > 16) fail('INPUT');
    if (typeof value === 'string') {
      if (value.length > 65536) fail('INPUT');
      bytes += Buffer.byteLength(value);
    } else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) fail('INPUT');
    } else if (value === null || typeof value === 'boolean') return;
    else if (typeof value === 'object') {
      if (active.has(value)) fail('INPUT');
      active.add(value);
      if (Array.isArray(value)) {
        const max = key === 'balances' ? 3200 : 1000;
        if (value.length > max) fail('INPUT');
        for (let n = 0; n < value.length; n++) {
          const property = Object.getOwnPropertyDescriptor(value, String(n));
          if (!property || !('value' in property) || !property.enumerable) fail('INPUT');
          visit(property.value, depth + 1, key);
        }
        // Non-index properties are not JSON array content.
        if (Reflect.ownKeys(value).length !== value.length + 1) fail('INPUT');
      } else {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) fail('INPUT');
        const keys = Reflect.ownKeys(value);
        if (keys.length > 64) fail('INPUT');
        for (const k of keys) {
          if (typeof k !== 'string' || k.length > 64) fail('INPUT');
          const property = Object.getOwnPropertyDescriptor(value, k);
          if (!property || !('value' in property) || !property.enumerable) fail('INPUT');
          bytes += Buffer.byteLength(k);
          visit(property.value, depth + 1, k);
        }
      }
      active.delete(value);
    } else fail('INPUT');
    if (bytes > 4194304) fail('INPUT');
  }
  visit(raw, 0, '');
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Pure retained-budget arithmetic, never final Risk validation or authority.
 * The future fixed atomic writer must authenticate all supplied history/current
 * rows, recheck policies/health/controls/epochs at one-use START and commit all
 * financial effects together. No hold is removed, renewed, released or written
 * here. Excluding the exact target only reconstructs a counterfactual arithmetic
 * input so the accepted budget calculator counts this retained effect once.
 */
export function calculatePaperRetainedRiskBudget(raw: unknown): PaperRetainedRiskBudgetCalculation {
  try {
    bounded(raw);
    const x = schema.parse(raw),
      { budget: b, reservation: state } = x;
    const fields = z.object({ request: z.unknown() }).parse(x.preparation);
    const prepared = preparePaperExecutionAttempt(fields.request);
    if (!same(prepared, x.preparation)) fail();
    const a = prepared.request.admission,
      binding = a.binding,
      e = b.evidence;
    if (x.now >= x.deadline || x.now >= a.expiresAt) fail('EXPIRED');
    if (
      x.now < prepared.request.preparedAt ||
      b.now !== x.now ||
      x.metadata.instrumentId !== a.dbInstrumentId ||
      x.metadata.ruleId !== a.dbRuleId ||
      state.id !== a.reservationId ||
      state.decisionId !== a.decisionId ||
      state.expiresAt !== a.expiresAt ||
      b.owner.tenantId !== binding.tenantId ||
      b.owner.accountId !== binding.accountId ||
      b.target.orderId !== a.orderId ||
      b.target.intentId !== a.intentId ||
      !same(b.order, a.command) ||
      !sameMarketScope(b.record.instrument.scope, binding.profile) ||
      b.platform.valuationAsset !== b.record.instrument.quoteAsset ||
      b.user.valuationAsset !== b.record.instrument.quoteAsset ||
      e.balances.some((balance) => balance.asset !== b.record.instrument.quoteAsset) ||
      b.model.version !== binding.profile.profileVersion ||
      e.positions.length !== 0 ||
      e.orders.some((o) => o.status !== 'PENDING') ||
      e.reservations.some((r) => r.unknown) ||
      e.holds.some((h) => h.unknown || h.reflected)
    )
      fail();

    const orders = e.orders.filter((o) => o.id === a.orderId || o.intentId === a.intentId);
    const reservations = e.reservations.filter(
      (r) => r.id === state.id || r.orderId === a.orderId || r.intentId === a.intentId,
    );
    if (orders.length !== 1 || reservations.length !== 1) fail();
    const order = orders[0]!,
      r = reservations[0]!,
      inst = b.record.instrument;
    for (const effect of [order, r])
      if (
        effect.accountId !== binding.accountId ||
        effect.intentId !== a.intentId ||
        effect.instrumentId !== a.command.instrumentId ||
        effect.base !== inst.baseAsset ||
        effect.quote !== inst.quoteAsset ||
        effect.side !== 'BUY'
      )
        fail();
    if (
      order.id !== a.orderId ||
      r.id !== state.id ||
      r.orderId !== a.orderId ||
      r.debits.length !== 1
    )
      fail();
    const debit = r.debits[0]!,
      holds = e.holds.filter((h) => h.id === debit.holdId);
    if (holds.length !== 1) fail();
    const hold = holds[0]!;
    if (
      debit.asset !== inst.quoteAsset ||
      hold.accountId !== binding.accountId ||
      hold.asset !== debit.asset ||
      hold.amount !== debit.amount
    )
      fail();

    const result = calculatePaperRiskBudget({
      ...b,
      evidence: {
        ...e,
        orders: e.orders.filter((o) => o.id !== order.id),
        reservations: e.reservations.filter((other) => other.id !== r.id),
        holds: e.holds.filter((h) => h.id !== debit.holdId),
      },
    });
    // Recompute the entire lifetime price/fee envelope, never credit a stored
    // scalar merely because it parses. A changed/depleted vector fails closed.
    if (
      order.notional !== result.notional ||
      r.notional !== result.notional ||
      !same(
        r.debits.map(({ asset, amount }) => ({ asset, amount })),
        result.coverage.debits.map(({ asset, amount }) => ({ asset, amount })),
      )
    )
      fail();
    const limits = intersectRiskLimits(b.platform, b.user);
    if (
      result.coverage.debits.some(
        (d) =>
          decimalCompare(parseDecimal(d.remaining), parseDecimal(limits.minAvailableBalance)) < 0,
      )
    )
      fail('LIMIT');
    return immutable({
      kind: 'PAPER_RETAINED_RISK_BUDGET_CALCULATION' as const,
      computedAt: x.now,
      validUntil: Math.min(x.deadline, a.expiresAt, result.validUntil),
      attemptId: prepared.request.attemptId,
      requestHash: prepared.requestHash,
      reservationId: state.id,
      retained: r.debits,
      budget: result,
    });
  } catch (error) {
    const code =
      error instanceof Error && /^PAPER_RETAINED_[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'PAPER_RETAINED_EVIDENCE';
    // eslint-disable-next-line preserve-caught-error -- Do not expose caller financial payloads or schema diagnostics.
    throw new Error(code, { cause: new Error('PAPER_RETAINED_INVALID') });
  }
}
