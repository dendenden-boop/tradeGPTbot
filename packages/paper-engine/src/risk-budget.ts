import { z } from 'zod';
import {
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  decimalSubtract,
  idSchema,
  immutable,
  instrumentRecordSchema,
  newOrderSchema,
  nonNegativeAmountSchema,
  orderBookSchema,
  parseDecimal,
  positiveAmountSchema,
  positiveDecimalSchema,
  timestampSchema,
  tradeTickSchema,
} from '@ctp/exchange-core';
import {
  deriveRiskExposure,
  intersectRiskLimits,
  riskEvidenceScopeSchema,
  riskExposureEvidenceSchema,
  riskLimitsSchema,
} from '@ctp/risk-engine';
import { paperOwnerSchema } from './configuration-domain.js';
import { paperModelSchema } from './model.js';
import { calculatePaperReservationCoverage } from './reservation-coverage.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const effect = {
  intentId: uuid,
  accountId: uuid,
  instrumentId: idSchema,
  base: idSchema,
  quote: idSchema,
  side: z.enum(['BUY', 'SELL']),
  notional: positiveDecimalSchema,
};
const schema = z.strictObject({
  now: timestampSchema,
  model: paperModelSchema,
  record: instrumentRecordSchema,
  book: orderBookSchema,
  trade: tradeTickSchema,
  order: newOrderSchema,
  owner: paperOwnerSchema,
  target: z.strictObject({ orderId: uuid, intentId: uuid }),
  platform: riskLimitsSchema,
  user: riskLimitsSchema,
  fx: z.strictObject({
    from: idSchema,
    to: idSchema,
    rate: positiveDecimalSchema,
    kind: z.enum(['IDENTITY', 'OBSERVED']),
    sourceId: idSchema,
    asOf: timestampSchema,
  }),
  evidence: z.strictObject({
    scope: riskEvidenceScopeSchema,
    asOf: timestampSchema,
    complete: z.boolean(),
    accountIds: z.array(uuid).min(1).max(100),
    positions: riskExposureEvidenceSchema.shape.positions,
    orders: z
      .array(
        z.strictObject({ id: idSchema, ...effect, status: z.enum(['PENDING', 'OPEN', 'UNKNOWN']) }),
      )
      .max(10000),
    reservations: z
      .array(
        z.strictObject({
          id: idSchema,
          orderId: idSchema,
          ...effect,
          unknown: z.boolean(),
          debits: z
            .array(
              z.strictObject({ asset: idSchema, amount: positiveAmountSchema, holdId: idSchema }),
            )
            .min(1)
            .max(2),
        }),
      )
      .max(10000),
    holds: z
      .array(
        z.strictObject({
          id: idSchema,
          accountId: uuid,
          asset: idSchema,
          amount: positiveAmountSchema,
          unknown: z.boolean(),
          reflected: z.boolean(),
        }),
      )
      .max(20000),
    balances: z
      .array(
        z.strictObject({ accountId: uuid, asset: idSchema, available: nonNegativeAmountSchema }),
      )
      .min(1)
      .max(3200),
  }),
});
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const sub = (a: string, b: string) => decimalSubtract(parseDecimal(a), parseDecimal(b));
const mul = (a: string, b: string) => decimalMultiply(parseDecimal(a), parseDecimal(b));
const cmp = (a: string, b: string) => decimalCompare(parseDecimal(a), parseDecimal(b));
const key = (a: string, b: string) => JSON.stringify([a, b]);
function unique(values: readonly string[]) {
  if (new Set(values).size !== values.length) throw new Error('PAPER_BUDGET_DUPLICATE');
}

/** Pure conservative budget arithmetic, not a Risk evaluation/grant. The future
 * gateway must capture ALL normalized rows in one certified transaction and
 * enforce the resulting budgets and complete debit vector atomically. Serialized
 * rows, completeness flags and this result establish no financial authority. */
export function calculatePaperRiskBudget(raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('PAPER_BUDGET_INPUT');
  try {
    const { owner, target, platform, user, fx, evidence: e, ...market } = parsed.data;
    const limits = intersectRiskLimits(platform, user),
      { instrument } = market.record,
      scope = {
        tenantId: owner.tenantId,
        mode: 'PAPER' as const,
        valuationAsset: limits.valuationAsset,
      },
      age = Math.min(limits.maxEvidenceAgeMs, market.model.maxEvidenceAgeMs);
    if (
      e.scope.tenantId !== scope.tenantId ||
      e.scope.mode !== 'PAPER' ||
      e.scope.valuationAsset !== scope.valuationAsset ||
      !e.complete ||
      !e.accountIds.includes(owner.accountId)
    )
      throw new Error('PAPER_BUDGET_SCOPE');
    unique(e.accountIds);
    const fresh = (at: number) => at <= market.now && market.now - at <= age;
    const marketTimes = [
      market.book.receivedAt,
      market.trade.receivedAt,
      market.trade.exchangeTime,
    ];
    if (market.book.exchangeTime !== null) marketTimes.push(market.book.exchangeTime);
    if (!fresh(e.asOf) || !fresh(fx.asOf) || marketTimes.some((at) => !fresh(at)))
      throw new Error('PAPER_BUDGET_STALE');
    if (
      fx.from !== instrument.quoteAsset ||
      fx.to !== scope.valuationAsset ||
      (fx.from === fx.to ? fx.kind !== 'IDENTITY' || fx.rate !== '1' : fx.kind !== 'OBSERVED')
    )
      throw new Error('PAPER_BUDGET_FX');
    const conversions = new Map([[key(fx.from, fx.to), key(fx.kind, fx.rate)]]);
    for (const p of e.positions) {
      const pair = key(p.fx.from, p.fx.to),
        value = key(p.fx.kind, p.fx.rate);
      if (conversions.has(pair) && conversions.get(pair) !== value)
        throw new Error('PAPER_BUDGET_FX');
      conversions.set(pair, value);
    }

    const instruments = new Map([
      [instrument.id, key(instrument.baseAsset, instrument.quoteAsset)],
    ]);
    for (const row of [
      ...e.positions.map((p) => ({
        instrumentId: p.instrumentId,
        base: p.base,
        quote: p.priceAsset,
      })),
      ...e.orders,
      ...e.reservations,
    ]) {
      const assets = key(row.base, row.quote),
        previous = instruments.get(row.instrumentId);
      if (row.base === row.quote || (previous !== undefined && previous !== assets))
        throw new Error('PAPER_BUDGET_SCOPE');
      instruments.set(row.instrumentId, assets);
    }
    for (const rows of [e.orders, e.reservations]) {
      unique(rows.map((r) => r.intentId));
      if (
        rows.some(
          (r) =>
            r.intentId === target.intentId ||
            ('orderId' in r ? r.orderId : r.id) === target.orderId,
        )
      )
        throw new Error('PAPER_BUDGET_REPLAY');
    }

    // Reuse the common position/FX validation and account-local asset semantics;
    // no synthetic scalar reservation is passed to native Risk.
    unique(e.positions.map((p) => key(p.accountId, p.instrumentId)));
    unique(e.positions.map((p) => key(p.accountId, p.base)));
    if (e.positions.some((p) => p.quantity.startsWith('-')))
      throw new Error('PAPER_BUDGET_POSITION');
    const positions = deriveRiskExposure(
      {
        scope,
        now: market.now,
        maxEvidenceAgeMs: age,
        accountIds: e.accountIds,
        complete: true,
        positions: e.positions,
        orders: [],
        reservations: [],
        holds: [],
      },
      scope,
      owner.accountId,
      instrument.id,
      instrument.baseAsset,
    );
    const current = {
      instrument: positions.instrumentExposure,
      asset: positions.assetExposure,
      account: positions.accountExposure,
      user: positions.userExposure,
    };
    const potential = new Set(
      e.positions
        .filter((p) => p.accountId === owner.accountId && p.quantity !== '0')
        .map((p) => p.instrumentId),
    );
    const accounts = new Set(e.accountIds);
    for (const rows of [e.orders, e.reservations, e.holds, e.balances]) {
      if (rows.some((r) => !accounts.has(r.accountId))) throw new Error('PAPER_BUDGET_SCOPE');
    }
    for (const rows of [e.orders, e.reservations, e.holds]) unique(rows.map((r) => r.id));
    unique(e.reservations.map((r) => r.orderId));
    unique(e.balances.map((b) => key(b.accountId, b.asset)));
    const balances = new Map(e.balances.map((b) => [key(b.accountId, b.asset), { ...b }]));
    for (const a of accounts) {
      if (
        !e.balances.some((b) => b.accountId === a) ||
        e.balances.filter((b) => b.accountId === a).length > 32
      )
        throw new Error('PAPER_BUDGET_SCOPE');
    }
    const holds = new Map(e.holds.map((h) => [h.id, h]));
    const orders = new Map(e.orders.map((o) => [o.id, o]));
    let openOrders = 0;
    for (const r of e.reservations) {
      const o = orders.get(r.orderId);
      if (
        r.base === r.quote ||
        (r.instrumentId === instrument.id &&
          (r.base !== instrument.baseAsset || r.quote !== instrument.quoteAsset))
      )
        throw new Error('PAPER_BUDGET_SCOPE');
      if (
        o &&
        (o.accountId !== r.accountId ||
          o.instrumentId !== r.instrumentId ||
          o.base !== r.base ||
          o.quote !== r.quote ||
          o.side !== r.side ||
          o.intentId !== r.intentId ||
          (o.status === 'UNKNOWN' && !r.unknown))
      )
        throw new Error('PAPER_BUDGET_ORDER');
      orders.delete(r.orderId);
      unique(r.debits.map((d) => d.asset));
      if (
        r.side === 'BUY'
          ? r.debits.length !== 1 || r.debits[0]!.asset !== r.quote
          : !r.debits.some((d) => d.asset === r.base) ||
            r.debits.some((d) => d.asset !== r.base && d.asset !== r.quote)
      )
        throw new Error('PAPER_BUDGET_VECTOR');
      for (const d of r.debits) {
        const h = holds.get(d.holdId),
          b = balances.get(key(r.accountId, d.asset));
        if (
          !h ||
          !b ||
          h.accountId !== r.accountId ||
          h.asset !== d.asset ||
          h.amount !== d.amount ||
          (r.unknown && !h.unknown)
        )
          throw new Error('PAPER_BUDGET_HOLD');
        holds.delete(d.holdId);
        if (!h.reflected) {
          b.available = nonNegativeAmountSchema.parse(sub(b.available, h.amount));
        }
      }
      const notional = o && cmp(o.notional, r.notional) > 0 ? o.notional : r.notional;
      current.user = add(current.user, notional);
      if (r.accountId === owner.accountId) {
        openOrders++;
        potential.add(r.instrumentId);
        current.account = add(current.account, notional);
        if (r.base === instrument.baseAsset) current.asset = add(current.asset, notional);
        if (r.instrumentId === instrument.id)
          current.instrument = add(current.instrument, notional);
      }
    }
    if (orders.size) throw new Error('PAPER_BUDGET_ORDER');
    if (holds.size) throw new Error('PAPER_BUDGET_HOLD');
    const coverage = calculatePaperReservationCoverage({
      ...market,
      balances: [...balances.values()]
        .filter((b) => b.accountId === owner.accountId)
        .map(({ asset, available }) => ({ asset, available })),
    });
    const notional = mul(coverage.envelope.quoteNotionalBound, fx.rate);
    if (cmp(notional, limits.maxOrderNotional) > 0) throw new Error('PAPER_BUDGET_MAX_ORDER');
    const projected = { ...current };
    for (const [name, limit] of [
      ['instrument', limits.maxInstrumentExposure],
      ['asset', limits.maxAssetExposure],
      ['account', limits.maxAccountExposure],
      ['user', limits.maxUserExposure],
    ] as const) {
      projected[name] = add(current[name], notional);
      if (cmp(projected[name], limit) > 0)
        throw new Error('PAPER_BUDGET_MAX_' + name.toUpperCase());
    }
    const currentPositions = potential.size;
    potential.add(instrument.id);
    if (potential.size > limits.maxConcurrentPositions)
      throw new Error('PAPER_BUDGET_MAX_POSITIONS');
    if (openOrders + 1 > limits.maxOpenOrders) throw new Error('PAPER_BUDGET_MAX_ORDERS');
    const validUntil = Math.min(
      coverage.validUntil,
      e.asOf + age + 1,
      fx.asOf + age + 1,
      ...marketTimes.map((at) => at + age + 1),
      ...e.positions.flatMap((p) => [p.at + age + 1, p.fx.at + age + 1]),
    );
    if (market.now >= validUntil) throw new Error('PAPER_BUDGET_STALE');
    return immutable({
      kind: 'PAPER_RISK_BUDGET_CALCULATION' as const,
      version: 'spot-l2-taker-budget-v1' as const,
      computedAt: market.now,
      validUntil,
      owner,
      target,
      valuationAsset: limits.valuationAsset,
      notional,
      current,
      projected,
      orders: { current: openOrders, projected: openOrders + 1 },
      potentialPositions: { current: currentPositions, projected: potential.size },
      coverage,
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && /^PAPER_BUDGET_[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'PAPER_BUDGET_EVIDENCE',
      {
        // eslint-disable-next-line preserve-caught-error -- Never disclose stored positions, balances or caller payloads.
        cause: new Error('PAPER_BUDGET_INVALID'),
      },
    );
  }
}
