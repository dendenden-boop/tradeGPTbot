import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  decimalSubtract,
  immutable,
  instrumentRecordSchema,
  nonNegativeAmountSchema,
  orderBookSchema,
  parseDecimal,
  positiveAmountSchema,
  timestampSchema,
  tradeTickSchema,
} from '@ctp/exchange-core';
import {
  canonical,
  reducePortfolio,
  stateSchema,
  type HoldWatermark,
  type PortfolioEvent,
} from '@ctp/portfolio';
import { paperFrameSchema, paperModelSchema } from './model.js';
import { calculatePaperStartedExecutionPortfolio } from './started-execution.js';
import { calculatePaperReservationProgress } from './reservation-progress.js';
import type { PaperExecutionAttempt } from './execution-attempt.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const schema = z.strictObject({
  now: timestampSchema,
  attempt: z.unknown(),
  frame: paperFrameSchema,
  portfolio: stateSchema,
  original: z.strictObject({
    now: timestampSchema,
    model: paperModelSchema,
    record: instrumentRecordSchema,
    book: orderBookSchema,
    trade: tradeTickSchema,
  }),
  reservation: z.strictObject({
    id: uuid,
    decisionId: uuid,
    orderId: uuid,
    intentId: uuid,
    revision: z.literal('1'),
    status: z.literal('ACTIVE'),
    debits: z
      .array(
        z.strictObject({
          asset: z.string().min(1).max(32),
          amount: positiveAmountSchema,
          holdId: uuid,
        }),
      )
      .length(1),
    watermarks: z
      .array(
        z.strictObject({
          holdId: uuid,
          timestamp: timestampSchema,
          fingerprint: digest,
          released: z.literal(false),
          unknown: z.literal(false),
        }),
      )
      .length(1),
  }),
});
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function fail(code = 'EVIDENCE'): never {
  throw Error('PAPER_STARTED_TRANSITION_' + code);
}
function bounded(raw: unknown) {
  const active = new WeakSet<object>();
  const arrays: Record<string, number> = {
    debits: 1,
    watermarks: 1,
    orderTypes: 4,
    timeInForce: 4,
    leverageTiers: 64,
    bids: 1000,
    asks: 1000,
    bidsUsed: 1000,
    asksUsed: 1000,
    balances: 1000,
    positions: 1000,
    holds: 1000,
    pending: 2000,
    differences: 2000,
  };
  let nodes = 0,
    bytes = 0;
  function visit(v: unknown, depth: number, name: string) {
    if (++nodes > 400000 || depth > 28) fail('INPUT');
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
        if (
          !Object.hasOwn(arrays, name) ||
          v.length > arrays[name]! ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          fail('INPUT');
        for (let i = 0; i < v.length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d?.enumerable || !('value' in d)) fail('INPUT');
          visit(d.value, depth + 1, '');
        }
      } else {
        const proto = Object.getPrototypeOf(v) as unknown,
          keys = Reflect.ownKeys(v);
        if ((proto !== Object.prototype && proto !== null) || keys.length > 64) fail('INPUT');
        for (const key of keys) {
          if (typeof key !== 'string' || key.length > 64) fail('INPUT');
          const d = Object.getOwnPropertyDescriptor(v, key);
          if (!d?.enumerable || !('value' in d)) fail('INPUT');
          bytes += Buffer.byteLength(key);
          visit(d.value, depth + 1, key);
        }
      }
      active.delete(v);
    } else fail('INPUT');
    if (bytes > 16777216) fail('INPUT');
  }
  visit(raw, 0, '');
}

/** Pure first-transition content only. No JSON, checksum, event or watermark
 * here authenticates storage, resolves UNKNOWN or grants execution/release.
 * A fixed private writer must reconstruct all inputs, re-evaluate current Risk
 * and atomically own permanent replay, one-use execution, shared liquidity,
 * order/reservation progress, all postings and durable hold watermarks. */
export function calculatePaperStartedTransition(raw: unknown) {
  bounded(raw);
  const checked = schema.safeParse(raw);
  if (!checked.success) fail('INPUT');
  const x = checked.data;
  const execution = calculatePaperStartedExecutionPortfolio({
    now: x.now,
    attempt: x.attempt,
    frame: x.frame,
    portfolio: x.portfolio,
  });
  // The existing calculation validates the entire pristine START/hash protocol.
  const attempt = x.attempt as PaperExecutionAttempt,
    a = attempt.request.admission,
    r = x.reservation;
  if (
    r.id !== a.reservationId ||
    r.decisionId !== a.decisionId ||
    r.orderId !== a.orderId ||
    r.intentId !== a.intentId ||
    x.original.now !== a.admittedAt ||
    !same(x.original.model, x.frame.model) ||
    !same(x.original.record, x.frame.record)
  )
    fail();
  if (x.now >= a.expiresAt) fail('EXPIRED');
  const result = execution.calculation.ledger.execution.executions[0]!;
  const progress = calculatePaperReservationProgress({
    original: { ...x.original, order: a.command },
    fills: result.fills,
  });
  const debit = r.debits[0]!,
    arithmetic = progress.debits[0]!,
    old = x.portfolio.holds.find((h) => h.id === debit.holdId),
    wm = r.watermarks[0]!;
  if (
    progress.debits.length !== 1 ||
    debit.asset !== arithmetic.asset ||
    debit.amount !== arithmetic.original ||
    !old ||
    !same(old, {
      id: debit.holdId,
      asset: debit.asset,
      amount: debit.amount,
      status: 'RESERVED',
      reflected: false,
    }) ||
    wm.holdId !== debit.holdId ||
    wm.timestamp < a.admittedAt ||
    wm.timestamp > x.now ||
    wm.fingerprint !== hash({ type: 'COMMITMENT', hold: old })
  )
    fail();
  const terminal = result.status === 'FILLED' || result.status === 'EXPIRED';
  const changed = terminal || result.fills.length > 0;
  const remaining = terminal ? '0' : arithmetic.remaining;
  const released = nonNegativeAmountSchema.parse(
    decimalSubtract(
      decimalSubtract(parseDecimal(arithmetic.original), parseDecimal(arithmetic.spent)),
      parseDecimal(remaining),
    ),
  );
  if (!changed && (arithmetic.spent !== '0' || released !== '0')) fail();
  let state = execution.calculation.state;
  const holdChanges: {
    event: PortfolioEvent;
    previousWatermark: HoldWatermark;
    watermark: HoldWatermark;
  }[] = [];
  if (changed) {
    // Never manufacture a future timestamp to overtake durable ordering.
    if (x.now <= wm.timestamp) fail('ORDERING');
    const id =
      'paper-transition:' +
      hash({
        attemptId: attempt.request.attemptId,
        startEventId: execution.startEventId,
        fillIds: progress.fillIds,
        status: result.status,
        at: x.now,
      });
    const event: PortfolioEvent = terminal
      ? { id, timestamp: x.now, type: 'RELEASE', holdId: old.id, resolved: false }
      : {
          id,
          timestamp: x.now,
          type: 'COMMITMENT',
          hold: { ...old, amount: parseDecimal(remaining) },
        };
    const { holdId: _holdId, ...previousWatermark } = wm;
    const applied = reducePortfolio(state, event, {
      now: () => x.now,
      holdWatermark: previousWatermark,
    });
    if (applied.ignored || applied.postings.length || !applied.holdWatermark) fail();
    state = applied.state;
    holdChanges.push({ event, previousWatermark, watermark: applied.holdWatermark });
  }
  return immutable({
    kind: 'PAPER_STARTED_TRANSITION_CALCULATION' as const,
    version: 'paper-pristine-transition-v1' as const,
    execution,
    order: {
      orderId: a.orderId,
      intentId: a.intentId,
      executedQuantity: progress.filledQuantity,
      remainingQuantity: progress.remainingQuantity,
      status: result.status === 'WAITING' ? ('OPEN' as const) : result.status,
    },
    reservation: {
      id: r.id,
      decisionId: r.decisionId,
      revision: changed ? ('2' as const) : ('1' as const),
      status: terminal ? ('RELEASED' as const) : ('ACTIVE' as const),
      debits: [
        {
          asset: debit.asset,
          holdId: debit.holdId,
          original: arithmetic.original,
          spent: arithmetic.spent,
          remaining,
          released,
        },
      ],
    },
    holdChanges,
    state,
  });
}
export type PaperStartedTransitionCalculation = ReturnType<typeof calculatePaperStartedTransition>;
