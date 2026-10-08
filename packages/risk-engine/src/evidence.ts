import { z } from 'zod';
import {
  amountDecimalSchema,
  decimalSchema,
  nonNegativeDecimalSchema,
  positiveDecimalSchema,
  timestampSchema,
  idSchema,
  decimalAdd,
  decimalSubtract,
  decimalMultiply,
  decimalCompare,
  parseDecimal,
  immutable,
} from '@ctp/exchange-core';
import { policyModeSchema } from './policies.js';

export const riskEvidenceScopeSchema = z.strictObject({
  tenantId: z.uuid(),
  mode: policyModeSchema,
  valuationAsset: idSchema,
});
export type RiskEvidenceScope = z.infer<typeof riskEvidenceScopeSchema>;
const sequence = z.string().regex(/^[1-9][0-9]{0,63}$/);
const age = z.number().int().min(1).max(5000);
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const sub = (a: string, b: string) => decimalSubtract(parseDecimal(a), parseDecimal(b));
const mul = (a: string, b: string) => decimalMultiply(parseDecimal(a), parseDecimal(b));
const cmp = (a: string, b: string) => decimalCompare(parseDecimal(a), parseDecimal(b));
const max = <T extends string>(a: T, b: T): T => (cmp(a, b) >= 0 ? a : b);
const sameScope = (a: RiskEvidenceScope, b: RiskEvidenceScope) =>
  a.tenantId === b.tenantId && a.mode === b.mode && a.valuationAsset === b.valuationAsset;
const fresh = (at: number, now: number, maxAge: number) => at <= now && now - at <= maxAge;
const unique = (ids: readonly string[], error: string) => {
  if (new Set(ids).size !== ids.length) throw new Error(error);
};
export const utcLossEvidenceSchema = z.strictObject({
  scope: riskEvidenceScopeSchema,
  utcDayStart: timestampSchema,
  coveredThrough: timestampSchema,
  complete: z.boolean(),
  opening: z.strictObject({ id: idSchema, sequence, at: timestampSchema, equity: decimalSchema }),
  events: z
    .array(
      z.strictObject({
        id: idSchema,
        sequence,
        at: timestampSchema,
        kind: z.enum(['FLOW', 'REALIZED', 'EQUITY']),
        amount: decimalSchema,
      }),
    )
    .max(100_000),
});
export type UtcLossEvidence = z.infer<typeof utcLossEvidenceSchema>;
/**
 * Rebuilds a source-proved complete UTC journal, never a process-local baseline.
 * FLOW is signed external cash flow; REALIZED is already net of fees/funding.
 * This calculation does not certify the journal's source or authorize an order.
 */
export function reconstructUtcLoss(
  raw: unknown,
  rawScope: RiskEvidenceScope,
  now: number,
  maxAge: number,
) {
  let e: UtcLossEvidence;
  let scope: RiskEvidenceScope;
  try {
    e = utcLossEvidenceSchema.parse(raw);
    scope = riskEvidenceScopeSchema.parse(rawScope);
    timestampSchema.parse(now);
    age.parse(maxAge);
  } catch {
    throw new Error('RISK_LOSS_INPUT');
  }
  const start = Math.floor(now / 86400000) * 86400000;
  if (
    !sameScope(e.scope, scope) ||
    !e.complete ||
    e.utcDayStart !== start ||
    e.opening.at !== start ||
    !fresh(e.coveredThrough, now, maxAge)
  )
    throw new Error('RISK_LOSS_BASELINE');
  unique([e.opening.id, ...e.events.map((x) => x.id)], 'RISK_LOSS_REPLAY');
  let lastSequence = BigInt(e.opening.sequence);
  let lastAt = start;
  let lastEquitySequence = lastSequence;
  let lastFlowSequence = lastSequence;
  let equityAt = start;
  let externalFlows = '0';
  let realized = '0';
  let current: string = e.opening.equity;
  let peak: string = e.opening.equity;
  try {
    for (const event of e.events) {
      const next = BigInt(event.sequence);
      if (next !== lastSequence + 1n) throw new Error('RISK_LOSS_SEQUENCE');
      if (event.at < lastAt || event.at > e.coveredThrough) throw new Error('RISK_LOSS_BASELINE');
      lastSequence = next;
      lastAt = event.at;
      if (event.kind === 'FLOW') {
        externalFlows = add(externalFlows, event.amount);
        lastFlowSequence = next;
      } else if (event.kind === 'REALIZED') realized = add(realized, event.amount);
      else {
        current = sub(event.amount, externalFlows);
        peak = max(peak, current);
        equityAt = event.at;
        lastEquitySequence = next;
      }
    }
    if (equityAt !== e.coveredThrough || lastEquitySequence < lastFlowSequence)
      throw new Error('RISK_LOSS_BASELINE');
    return immutable({
      utcDayStart: start,
      adjustedOpeningEquity: e.opening.equity,
      adjustedCurrentEquity: current,
      adjustedPeakEquity: peak,
      dailyNetRealizedPnl: realized,
      externalFlows,
      lastSequence: lastSequence.toString(),
    });
  } catch (error) {
    if (error instanceof Error && /^RISK_LOSS_/.test(error.message)) throw error;
    throw new Error('RISK_LOSS_ARITHMETIC', { cause: error });
  }
}

const effect = {
  accountId: z.uuid(),
  instrumentId: idSchema,
  base: idSchema,
  notional: nonNegativeDecimalSchema,
  reductionQuantity: nonNegativeDecimalSchema,
};
export const riskExposureEvidenceSchema = z.strictObject({
  scope: riskEvidenceScopeSchema,
  now: timestampSchema,
  maxEvidenceAgeMs: age,
  accountIds: z.array(z.uuid()).min(1).max(100),
  complete: z.boolean(),
  positions: z
    .array(
      z.strictObject({
        id: idSchema,
        accountId: z.uuid(),
        instrumentId: idSchema,
        base: idSchema,
        quantity: amountDecimalSchema,
        price: positiveDecimalSchema,
        priceAsset: idSchema,
        at: timestampSchema,
        fx: z.strictObject({
          from: idSchema,
          to: idSchema,
          rate: positiveDecimalSchema,
          kind: z.enum(['IDENTITY', 'OBSERVED']),
          sourceId: idSchema,
          at: timestampSchema,
        }),
      }),
    )
    .max(30_000),
  orders: z
    .array(
      z.strictObject({
        id: idSchema,
        ...effect,
        status: z.enum(['PENDING', 'OPEN', 'UNKNOWN']),
      }),
    )
    .max(10_000),
  reservations: z
    .array(
      z.strictObject({
        id: idSchema,
        orderId: idSchema,
        ...effect,
        asset: idSchema,
        amount: nonNegativeDecimalSchema,
        holdId: idSchema,
        unknown: z.boolean(),
      }),
    )
    .max(10_000),
  holds: z
    .array(
      z.strictObject({
        id: idSchema,
        accountId: z.uuid(),
        asset: idSchema,
        amount: nonNegativeDecimalSchema,
        unknown: z.boolean(),
        reflected: z.boolean(),
      }),
    )
    .max(10_000),
  controls: z
    .array(
      z.strictObject({
        id: idSchema,
        intentId: idSchema,
        orderId: idSchema,
        primaryReservationId: idSchema,
        accountId: z.uuid(),
        asset: idSchema,
        amount: nonNegativeDecimalSchema,
        holdId: idSchema,
        unknown: z.boolean(),
      }),
    )
    .max(10_000)
    .optional(),
});
export type RiskExposureEvidence = z.infer<typeof riskExposureEvidenceSchema>;
/**
 * Reconstructs exposure from normalized durable sources. Order and reservation
 * share one effect identity; a Portfolio hold represents its collateral, not
 * another exposure. Bounded UNKNOWN exposure remains counted and held.
 * Shape/completeness flags alone are not a certificate or grant.
 */
export function deriveRiskExposure(
  raw: unknown,
  rawScope: RiskEvidenceScope,
  accountId: string,
  instrumentId: string,
  base: string,
) {
  let e: RiskExposureEvidence;
  let scope: RiskEvidenceScope;
  try {
    e = riskExposureEvidenceSchema.parse(raw);
    scope = riskEvidenceScopeSchema.parse(rawScope);
    z.uuid().parse(accountId);
    idSchema.parse(instrumentId);
    idSchema.parse(base);
  } catch {
    throw new Error('RISK_EXPOSURE_INPUT');
  }
  if (!sameScope(e.scope, scope) || !e.complete || !e.accountIds.includes(accountId))
    throw new Error('RISK_EXPOSURE_INCOMPLETE');
  unique(e.accountIds, 'RISK_EXPOSURE_DUPLICATE');
  for (const rows of [e.positions, e.orders, e.reservations, e.holds]) {
    unique(
      rows.map((x) => x.id),
      'RISK_EXPOSURE_DUPLICATE',
    );
    if (rows.some((x) => !e.accountIds.includes(x.accountId)))
      throw new Error('RISK_EXPOSURE_SCOPE');
  }
  unique(
    e.reservations.map((x) => x.orderId),
    'RISK_RESERVATION_OVERLAP',
  );
  unique(
    e.reservations.map((x) => x.holdId),
    'RISK_HOLD_EVIDENCE',
  );
  const holds = new Map(e.holds.map((h) => [h.id, h]));
  const reservations = new Map(e.reservations.map((r) => [r.orderId, r]));
  const holdTotals = new Map<string, { accountId: string; asset: string; amount: string }>();
  for (const r of e.reservations) {
    const h = holds.get(r.holdId);
    if (
      !h ||
      h.accountId !== r.accountId ||
      h.asset !== r.asset ||
      h.amount !== r.amount ||
      (r.unknown && !h.unknown)
    )
      throw new Error('RISK_HOLD_EVIDENCE');
    holds.delete(r.holdId);
    if (!h.reflected) {
      const key = JSON.stringify([h.accountId, h.asset]);
      holdTotals.set(key, {
        accountId: h.accountId,
        asset: h.asset,
        amount: add(holdTotals.get(key)?.amount ?? '0', h.amount),
      });
    }
  }
  const controls = e.controls ?? [];
  for (const field of ['id', 'intentId', 'orderId', 'holdId'] as const)
    unique(
      controls.map((c) => c[field]),
      'RISK_CONTROL_OVERLAP',
    );
  for (const c of controls) {
    const primary = reservations.get(c.orderId),
      hold = holds.get(c.holdId);
    if (
      !primary ||
      !hold ||
      c.id !== c.holdId ||
      primary.id !== c.primaryReservationId ||
      c.id === primary.id ||
      c.accountId !== primary.accountId ||
      c.asset !== primary.asset ||
      c.accountId !== hold.accountId ||
      c.asset !== hold.asset ||
      c.amount !== '0' ||
      hold.amount !== '0' ||
      hold.reflected ||
      (c.unknown && (!hold.unknown || !primary.unknown))
    )
      throw new Error('RISK_CONTROL_EVIDENCE');
    holds.delete(c.holdId);
  }
  if (holds.size) throw new Error('RISK_HOLD_EVIDENCE');
  let instrumentExposure = '0',
    assetExposure = '0',
    accountExposure = '0',
    userExposure = '0';
  let committedReductionQuantity = '0',
    openOrders = 0,
    instrumentHasPendingEntry = false;
  const positions = new Set<string>();
  const total = (
    x: { accountId: string; instrumentId: string; base: string },
    notional: string,
  ) => {
    userExposure = add(userExposure, notional);
    if (x.accountId === accountId) {
      accountExposure = add(accountExposure, notional);
      if (x.base === base) assetExposure = add(assetExposure, notional);
      if (x.instrumentId === instrumentId) {
        if (x.base !== base) throw new Error('RISK_EXPOSURE_SCOPE');
        instrumentExposure = add(instrumentExposure, notional);
      }
    }
  };
  try {
    for (const p of e.positions) {
      if (
        !fresh(p.at, e.now, e.maxEvidenceAgeMs) ||
        !fresh(p.fx.at, e.now, e.maxEvidenceAgeMs) ||
        p.fx.from !== p.priceAsset ||
        p.fx.to !== scope.valuationAsset ||
        (p.fx.from === p.fx.to) !== (p.fx.kind === 'IDENTITY') ||
        (p.fx.kind === 'IDENTITY' && p.fx.rate !== '1')
      )
        throw new Error('RISK_EXPOSURE_VALUATION');
      total(
        p,
        mul(mul(p.quantity.startsWith('-') ? p.quantity.slice(1) : p.quantity, p.price), p.fx.rate),
      );
      if (p.accountId === accountId && p.quantity !== '0') positions.add(p.instrumentId);
    }
    const effects = new Map(e.reservations.map((r) => [r.orderId, { ...r }]));
    for (const o of e.orders) {
      const r = reservations.get(o.id);
      if (
        !r ||
        r.accountId !== o.accountId ||
        r.instrumentId !== o.instrumentId ||
        r.base !== o.base ||
        (o.status === 'UNKNOWN' && !r.unknown)
      )
        throw new Error('RISK_ORDER_EVIDENCE');
      if ((o.reductionQuantity === '0') !== (r.reductionQuantity === '0'))
        throw new Error('RISK_ORDER_EVIDENCE');
      effects.set(o.id, {
        ...r,
        notional: max(o.notional, r.notional),
        reductionQuantity: max(o.reductionQuantity, r.reductionQuantity),
      });
    }
    for (const x of effects.values()) {
      if (x.unknown && x.notional === '0' && x.reductionQuantity === '0')
        throw new Error('RISK_ORDER_EVIDENCE');
      if (x.reductionQuantity !== '0' && x.notional !== '0') throw new Error('RISK_ORDER_EVIDENCE');
      total(x, x.notional);
      if (x.accountId === accountId) {
        openOrders++;
        if (x.instrumentId === instrumentId) {
          committedReductionQuantity = add(committedReductionQuantity, x.reductionQuantity);
          if (x.reductionQuantity === '0') instrumentHasPendingEntry = true;
        }
      }
    }
    return immutable({
      instrumentExposure,
      assetExposure,
      accountExposure,
      userExposure,
      concurrentPositions: positions.size,
      openOrders,
      committedReductionQuantity,
      instrumentHasPendingEntry,
      unknownExposure: false,
      unreflectedHolds: [...holdTotals.values()].sort((a, b) => {
        const x = JSON.stringify([a.accountId, a.asset]),
          y = JSON.stringify([b.accountId, b.asset]);
        return x < y ? -1 : x > y ? 1 : 0;
      }),
    });
  } catch (error) {
    if (error instanceof Error && /^RISK_/.test(error.message)) throw error;
    throw new Error('RISK_EXPOSURE_ARITHMETIC', { cause: error });
  }
}
