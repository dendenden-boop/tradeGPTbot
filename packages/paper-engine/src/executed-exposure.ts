import { z } from 'zod';
import {
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  immutable,
  instrumentRecordSchema,
  orderBookSchema,
  parseDecimal,
  positiveDecimalSchema,
  sameMarketScope,
  timestampSchema,
  tradeTickSchema,
} from '@ctp/exchange-core';
import { marketSnapshotPublicationSchema } from '@ctp/market-data';
import { paperModelSchema } from './model.js';
import { calculatePaperStartedTransition } from './started-transition.js';
import { calculatePaperReservationProgress } from './reservation-progress.js';
import type { PaperExecutionAttempt } from './execution-attempt.js';

const input = z.strictObject({
  now: timestampSchema,
  asOf: timestampSchema,
  executionInput: z.unknown(),
  currentMarket: z.unknown(),
});
const historicalInput = z.object({
  now: timestampSchema,
  attempt: z.unknown(),
  original: z.strictObject({
    now: timestampSchema,
    model: paperModelSchema,
    record: instrumentRecordSchema,
    book: orderBookSchema,
    trade: tradeTickSchema,
  }),
});
function fail(code = 'EVIDENCE'): never {
  throw Error('PAPER_EXECUTED_EXPOSURE_' + code);
}
const mul = (a: string, b: string) => decimalMultiply(parseDecimal(a), parseDecimal(b));
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const cmp = (a: string, b: string) => decimalCompare(parseDecimal(a), parseDecimal(b));

// Inspect complete JSON descriptors before schemas, canonical hashing or the
// historical transition. No accessor, cycle, sparse collection or large
// untrusted traversal may precede this bound.
function bounded(raw: unknown) {
  const active = new WeakSet<object>();
  let nodes = 0,
    bytes = 0;
  function visit(v: unknown, depth: number) {
    if (++nodes > 400000 || depth > 40) fail('INPUT');
    if (typeof v === 'string') {
      if (v.length > 1048576) fail('INPUT');
      bytes += Buffer.byteLength(v);
    } else if (v === null || typeof v === 'boolean') return;
    else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) fail('INPUT');
    } else if (typeof v === 'object') {
      if (active.has(v)) fail('INPUT');
      active.add(v);
      if (Array.isArray(v)) {
        if (v.length > 3200 || Reflect.ownKeys(v).length !== v.length + 1) fail('INPUT');
        for (let n = 0; n < v.length; n++) {
          const d = Object.getOwnPropertyDescriptor(v, String(n));
          if (!d?.enumerable || !('value' in d)) fail('INPUT');
          visit(d.value, depth + 1);
        }
      } else {
        const keys = Reflect.ownKeys(v);
        const proto = Object.getPrototypeOf(v) as unknown;
        if ((proto !== Object.prototype && proto !== null) || keys.length > 64) fail('INPUT');
        for (const key of keys) {
          if (typeof key !== 'string' || key.length > 128) fail('INPUT');
          const d = Object.getOwnPropertyDescriptor(v, key);
          if (!d?.enumerable || !('value' in d)) fail('INPUT');
          bytes += Buffer.byteLength(key);
          visit(d.value, depth + 1);
        }
      }
      active.delete(v);
    } else fail('INPUT');
    if (bytes > 16777216) fail('INPUT');
  }
  visit(raw, 0);
}

/** Pure single-book arithmetic prerequisite for post-execution Risk inventory.
 * Replays the accepted first pristine transition at its ORIGINAL time. Supplied
 * JSON, public price content and identities authenticate no storage or current
 * permission. This cannot certify tenant completeness, renew a lease, admit an
 * order, resolve UNKNOWN, reserve funds or execute any monetary effect. A future
 * fixed source must capture complete durable inventory coherently; a financial
 * writer must independently repeat current Risk/authorization atomically. */
export function calculatePaperExecutedExposure(raw: unknown) {
  try {
    bounded(raw);
    const x = input.parse(raw);
    const historical = historicalInput.parse(x.executionInput);
    // Full historical validation/recalculation remains the accepted contract.
    // Never evaluate an old financial lease against a new capture clock.
    const transition = calculatePaperStartedTransition(x.executionInput),
      attempt = historical.attempt as PaperExecutionAttempt,
      admission = attempt.request.admission,
      original = historical.original.record,
      execution = transition.execution.calculation.ledger.execution.executions[0]!,
      state = transition.state,
      mark = marketSnapshotPublicationSchema.parse(x.currentMarket),
      age = Math.min(5000, historical.original.model.maxEvidenceAgeMs);
    if (mark.kind !== 'SNAPSHOT') fail();
    if (
      historical.now > x.asOf ||
      x.asOf > x.now ||
      x.now - x.asOf > age ||
      admission.command.side !== 'BUY' ||
      !['LIMIT', 'MARKET'].includes(admission.command.type) ||
      execution.status === 'WAITING' ||
      transition.reservation.revision !== '2' ||
      state.binding.mode !== 'PAPER' ||
      state.binding.connectionId !== null ||
      state.status !== 'RECONCILED' ||
      state.differences.length ||
      state.pending.length !== transition.execution.calculation.fills.length ||
      state.pending.some(
        (id) => !transition.execution.calculation.fills.some((f) => f.event.id === id),
      ) ||
      state.positions.length > 1 ||
      !sameMarketScope(original.instrument.scope, mark.key.scope) ||
      !sameMarketScope(original.instrument.scope, mark.record.instrument.scope) ||
      mark.key.instrumentId !== original.instrument.id ||
      mark.key.dbInstrumentId !== admission.dbInstrumentId ||
      mark.record.instrument.id !== original.instrument.id ||
      mark.record.instrument.baseAsset !== original.instrument.baseAsset ||
      mark.record.instrument.quoteAsset !== original.instrument.quoteAsset ||
      mark.record.instrument.status !== 'TRADING' ||
      mark.record.rules.effectiveAt > x.now ||
      mark.record.rules.expiresAt <= x.now ||
      mark.ticker.last.state !== 'AVAILABLE'
    )
      fail();
    const price = positiveDecimalSchema.parse(mark.ticker.last.value);
    const times = [
      mark.timestamp,
      mark.ticker.receivedAt,
      mark.ticker.exchangeTime,
      mark.book.receivedAt,
      mark.book.exchangeTime,
    ].filter((t): t is number => t !== null);
    if (times.some((t) => t > x.now || x.now - t > age)) fail('STALE');
    const asOf = Math.min(x.asOf, ...times),
      validUntil = Math.min(
        x.asOf + age + 1,
        ...times.map((t) => t + age + 1),
        mark.record.rules.expiresAt,
        mark.record.instrument.expiryAt ?? mark.record.rules.expiresAt,
      );
    if (!Number.isSafeInteger(validUntil) || validUntil <= x.now) fail('STALE');

    const position = state.positions[0];
    if (
      position &&
      (position.instrumentId !== original.instrument.id ||
        position.base !== original.instrument.baseAsset ||
        position.quote !== original.instrument.quoteAsset ||
        position.positionSide !== 'NET' ||
        position.bucket !== 'SPOT' ||
        position.quantity !== transition.order.executedQuantity ||
        position.basis === null ||
        position.realizedGross === null ||
        position.feesQuote === null)
    )
      fail();
    if (!position && transition.order.executedQuantity !== '0') fail();
    const quantity = position?.quantity ?? '0';
    if (cmp(quantity, '0') < 0) fail();
    const positionNotional = mul(quantity, price);
    const progress = calculatePaperReservationProgress({
      original: { ...historical.original, order: admission.command },
      fills: execution.fills,
    });
    if (
      progress.filledQuantity !== transition.order.executedQuantity ||
      progress.remainingQuantity !== transition.order.remainingQuantity
    )
      fail();
    const active = transition.reservation.status === 'ACTIVE';
    if (
      active !== (transition.order.status === 'PARTIALLY_FILLED') ||
      transition.reservation.debits.length !== 1
    )
      fail();
    const debit = transition.reservation.debits[0]!;
    // The order and its reservation are one remaining exposure identity.
    // Fee collateral is a separate liability; neither the reservation nor its
    // Portfolio hold contributes a second notional or position.
    const pendingNotional = active
      ? mul(progress.remainingQuantity, progress.envelope.executionPrice.maximum)
      : '0';
    const hold = state.holds[0];
    if (state.holds.length !== (active ? 1 : 0)) fail();
    if (
      active &&
      (!hold ||
        hold.id !== debit.holdId ||
        hold.asset !== debit.asset ||
        hold.amount !== debit.remaining ||
        hold.status !== 'RESERVED' ||
        hold.reflected ||
        cmp(debit.remaining, '0') <= 0 ||
        cmp(debit.remaining, pendingNotional) < 0 ||
        cmp(progress.remainingQuantity, '0') <= 0)
    )
      fail();
    if (!active && debit.remaining !== '0') fail();
    return immutable({
      kind: 'PAPER_EXECUTED_EXPOSURE_CALCULATION' as const,
      version: 'paper-single-executed-exposure-v1' as const,
      coverage: 'SINGLE_EXECUTED_ORDER' as const,
      tenantInventoryComplete: false as const,
      computedAt: x.now,
      asOf,
      validUntil,
      executedAt: historical.now,
      owner: {
        tenantId: state.binding.tenantId,
        accountId: state.binding.accountId,
        mode: 'PAPER' as const,
      },
      instrumentId: original.instrument.id,
      valuationAsset: original.instrument.quoteAsset,
      position: { quantity, price, notional: positionNotional },
      pending: active
        ? {
            orderId: admission.orderId,
            intentId: admission.intentId,
            reservationId: admission.reservationId,
            quantity: progress.remainingQuantity,
            notional: pendingNotional,
          }
        : null,
      collateral: active
        ? { holdId: debit.holdId, asset: debit.asset, amount: debit.remaining }
        : null,
      combinedNotional: add(positionNotional, pendingNotional),
      openOrders: active ? 1 : 0,
      positionCount: quantity === '0' ? 0 : 1,
      market: {
        id: mark.id,
        expectedRevision: mark.expectedRevision,
        asOf: Math.min(...times),
        ruleVersion: mark.record.rules.version,
      },
    });
  } catch (error) {
    if (error instanceof Error && /^PAPER_EXECUTED_EXPOSURE_/u.test(error.message)) throw error;
    fail();
  }
}
export type PaperExecutedExposureCalculation = ReturnType<typeof calculatePaperExecutedExposure>;
