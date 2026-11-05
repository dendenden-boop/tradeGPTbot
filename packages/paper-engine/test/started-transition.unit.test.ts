import { beforeEach, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  canonical,
  reducePortfolio,
  type HoldWatermark,
  type PortfolioEvent,
  type PortfolioState,
} from '@ctp/portfolio';
import { parseDecimal } from '@ctp/exchange-core';
import * as paper from '../src/index.js';
import { admissionWire, wireHash, wireNow } from './admission-wire-fixtures.js';
import { startedExecutionFixture } from './started-execution-fixtures.js';
import { executionStartFixture } from './execution-start-fixtures.js';

interface Result {
  kind: 'PAPER_STARTED_TRANSITION_CALCULATION';
  version: 'paper-pristine-transition-v1';
  execution: paper.PaperStartedExecutionPortfolioCalculation;
  order: {
    orderId: string;
    intentId: string;
    executedQuantity: string;
    remainingQuantity: string;
    status: string;
  };
  reservation: {
    id: string;
    revision: string;
    status: string;
    debits: {
      asset: string;
      holdId: string;
      original: string;
      spent: string;
      remaining: string;
      released: string;
    }[];
  };
  holdChanges: {
    event: PortfolioEvent;
    previousWatermark: HoldWatermark;
    watermark: HoldWatermark;
  }[];
  state: PortfolioState;
}
function entry() {
  const fn = (paper as unknown as Record<string, unknown>)['calculatePaperStartedTransition'];
  if (typeof fn !== 'function') throw Error('PAPER_STARTED_TRANSITION_MISSING');
  return fn as (raw: unknown) => Result;
}
beforeEach(() => {
  entry();
});
const calculate = (raw: unknown) => entry()(raw);
function fixture() {
  const x = startedExecutionFixture(),
    a = x.attempt.request.admission;
  const { model, record, book, trade } = admissionWire(a.admittedAt).packet.budget;
  const hold = x.portfolio.holds[0]!;
  return {
    ...x,
    original: { now: a.admittedAt, model, record, book, trade },
    reservation: {
      id: a.reservationId,
      decisionId: a.decisionId,
      orderId: a.orderId,
      intentId: a.intentId,
      revision: '1',
      status: 'ACTIVE',
      debits: [{ asset: hold.asset, amount: hold.amount, holdId: hold.id }],
      watermarks: [
        {
          holdId: hold.id,
          timestamp: wireNow,
          fingerprint: wireHash({ type: 'COMMITMENT', hold }),
          released: false,
          unknown: false,
        },
      ],
    },
  };
}
function rebind(x: ReturnType<typeof fixture>) {
  const a = x.attempt.request.admission;
  a.commandHash = wireHash({ operation: 'createOrder', command: a.command, binding: a.binding });
  x.attempt.requestHash = wireHash(x.attempt.request);
}
function partial() {
  const x = fixture();
  x.frame.trade.quantity = parseDecimal('0.5');
  return x;
}

it('joins first partial fill with remaining reservation and monotonic hold content', () => {
  const x = partial(),
    r = calculate(x);
  expect(r).toMatchObject({
    kind: 'PAPER_STARTED_TRANSITION_CALCULATION',
    version: 'paper-pristine-transition-v1',
    order: {
      orderId: x.reservation.orderId,
      intentId: x.reservation.intentId,
      executedQuantity: '0.25',
      remainingQuantity: '0.25',
      status: 'PARTIALLY_FILLED',
    },
    reservation: {
      id: x.reservation.id,
      revision: '2',
      status: 'ACTIVE',
      debits: [
        {
          asset: 'USDT',
          original: '5.25525',
          spent: '2.5150125',
          remaining: '2.627625',
          released: '0.1126125',
        },
      ],
    },
  });
  expect(r.holdChanges).toHaveLength(1);
  expect(r.holdChanges[0]!.event).toMatchObject({
    type: 'COMMITMENT',
    timestamp: x.now,
    hold: {
      id: x.portfolio.holds[0]!.id,
      amount: '2.627625',
      status: 'RESERVED',
      reflected: false,
    },
  });
});
it('terminal fill releases only unspent collateral without posting a second economic effect', () => {
  const x = fixture(),
    r = calculate(x);
  expect(r.order.status).toBe('FILLED');
  expect(r.order.executedQuantity).toBe('0.5');
  expect(r.reservation).toMatchObject({
    status: 'RELEASED',
    debits: [{ spent: '5.030025', remaining: '0', released: '0.225225' }],
  });
  expect(r.holdChanges[0]!.event).toMatchObject({ type: 'RELEASE', resolved: false });
  expect(r.holdChanges[0]!.watermark.released).toBe(true);
  expect(r.state.holds).toEqual([]);
  expect(r.state.balances).toEqual(r.execution.calculation.state.balances);
  expect(r.state.positions).toEqual(r.execution.calculation.state.positions);
});
it('applying the proposed hold event uses the existing reducer with zero postings', () => {
  const x = partial(),
    r = calculate(x),
    h = r.holdChanges[0]!;
  const applied = reducePortfolio(r.execution.calculation.state, h.event, {
    now: () => x.now,
    holdWatermark: h.previousWatermark,
  });
  expect(applied.postings).toEqual([]);
  expect(applied.holdWatermark).toEqual(h.watermark);
  expect(applied.state).toEqual(r.state);
  expect(applied.ignored).not.toBe(true);
});
it('waiting preserves the full hold and does not advance a reservation revision', () => {
  const x = fixture();
  x.now = wireNow + 99;
  x.frame.book.receivedAt = x.frame.book.exchangeTime = x.now;
  x.frame.trade.receivedAt = x.frame.trade.exchangeTime = x.now;
  const r = calculate(x);
  expect(r.order).toMatchObject({
    status: 'OPEN',
    executedQuantity: '0',
    remainingQuantity: '0.5',
  });
  expect(r.reservation).toMatchObject({
    revision: '1',
    status: 'ACTIVE',
    debits: [{ spent: '0', remaining: '5.25525', released: '0' }],
  });
  expect(r.holdChanges).toEqual([]);
  expect(r.state).toEqual(x.portfolio);
});
it.each(['IOC', 'FOK'] as const)(
  'definitive %s expiration retains fills but releases the unfilled liability',
  (tif) => {
    const x = partial();
    x.attempt.request.admission.command.timeInForce = tif;
    rebind(x);
    const r = calculate(x);
    expect(r.order.status).toBe('EXPIRED');
    expect(r.reservation.status).toBe('RELEASED');
    expect(r.reservation.debits[0]!.remaining).toBe('0');
    expect(r.order.executedQuantity).toBe(tif === 'FOK' ? '0' : '0.25');
    expect(r.reservation.debits[0]!.spent).toBe(tif === 'FOK' ? '0' : '2.5150125');
    expect(r.state.balances).toEqual(r.execution.calculation.state.balances);
  },
);
it('market remainder expires rather than receiving a future release-and-retry grant', () => {
  const x = partial();
  const a = x.attempt.request.admission;
  a.command.type = 'MARKET';
  a.command.limitPrice = null;
  a.command.timeInForce = null;
  rebind(x);
  const original = paper.calculatePaperRiskEnvelope({ ...x.original, order: a.command });
  const debit = x.reservation.debits[0]!,
    hold = x.portfolio.holds[0]!;
  debit.amount = original.debits[0]!.amount;
  hold.amount = debit.amount;
  x.reservation.watermarks[0]!.fingerprint = wireHash({ type: 'COMMITMENT', hold });
  // Match the potentially larger market envelope with actual fixture cash.
  x.portfolio.balances[0]!.total =
    x.portfolio.balances[0]!.free =
    x.portfolio.balances[0]!.available =
      parseDecimal('1000000');
  const r = calculate(x);
  expect(r.order.status).toBe('EXPIRED');
  expect(r.order.executedQuantity).toBe('0.25');
  expect(r.reservation.status).toBe('RELEASED');
  expect(r.state.holds).toEqual([]);
});
it('preserves unrelated holds and their complete vectors', () => {
  const x = partial(),
    other = { ...x.portfolio.holds[0]!, id: 'unrelated-hold', amount: parseDecimal('1') };
  x.portfolio.holds.push(other);
  expect(calculate(x).state.holds.find((h) => h.id === other.id)).toEqual(other);
});
it('retains remaining shared liquidity instead of recreating a fresh market frame', () => {
  const x = fixture();
  x.frame.volumeUsed = parseDecimal('0.4');
  x.frame.asksUsed[0] = parseDecimal('0.4');
  const r = calculate(x);
  expect(r.order.executedQuantity).toBe('0.1');
  expect(r.order.remainingQuantity).toBe('0.4');
  expect(r.execution.calculation.ledger.execution.frame.volumeUsed).toBe('0.5');
});
it('is deterministic deeply immutable calculation content without mutation authority', () => {
  const x = partial(),
    before = canonical(x),
    r = calculate(x);
  expect(calculate(JSON.parse(before))).toEqual(r);
  expect(canonical(x)).toBe(before);
  expect(Object.isFrozen(r.state.holds)).toBe(true);
  expect(Object.isFrozen(r.holdChanges[0]!.event)).toBe(true);
  for (const key of ['grant', 'permit', 'committed', 'receipt', 'authorized', 'resolutionEvidence'])
    expect(key in r).toBe(false);
});
it.each(['id', 'decisionId', 'orderId', 'intentId'])(
  'rejects mismatched reservation %s',
  (field) => {
    const x = fixture();
    Object.assign(x.reservation, { [field]: '99999999-9999-4999-8999-999999999999' });
    expect(() => calculate(x)).toThrow();
  },
);
it.each(['UNKNOWN', 'RELEASED'])(
  'rejects %s reservation instead of weakening retained risk',
  (status) => {
    const x = fixture();
    x.reservation.status = status;
    expect(() => calculate(x)).toThrow();
  },
);
it('rejects reservation progress after the original admission lease expires', () => {
  const x = fixture();
  x.now = x.attempt.request.admission.expiresAt;
  expect(() => calculate(x)).toThrow();
});
it('rejects a nonpristine reservation revision', () => {
  const x = fixture();
  x.reservation.revision = '2';
  expect(() => calculate(x)).toThrow();
});
it.each(['amount', 'asset', 'holdId'])(
  'rejects incomplete or conflicting debit %s coverage',
  (field) => {
    const x = fixture();
    Object.assign(x.reservation.debits[0]!, { [field]: field === 'amount' ? '5' : 'different' });
    expect(() => calculate(x)).toThrow();
  },
);
it('rejects absent collateral instead of calculating an unreserved execution', () => {
  const x = fixture();
  x.portfolio.holds = [];
  expect(() => calculate(x)).toThrow();
});
it('rejects reflected collateral', () => {
  const x = fixture();
  x.portfolio.holds[0]!.reflected = true;
  expect(() => calculate(x)).toThrow();
});
it('rejects UNKNOWN hold content and an UNKNOWN attempt', () => {
  const x = fixture();
  x.portfolio.holds[0]!.status = 'UNKNOWN';
  expect(() => calculate(x)).toThrow();
  const y = fixture();
  y.attempt = structuredClone(executionStartFixture().unknown);
  expect(() => calculate(y)).toThrow();
});
it.each(['released', 'unknown', 'fingerprint', 'timestamp'])(
  'rejects contradictory durable hold watermark %s',
  (field) => {
    const x = fixture();
    Object.assign(x.reservation.watermarks[0]!, {
      [field]: field === 'fingerprint' ? '0'.repeat(64) : field === 'timestamp' ? x.now : true,
    });
    expect(() => calculate(x)).toThrow();
  },
);
it('rejects duplicate debits or watermarks', () => {
  const x = fixture();
  x.reservation.debits.push(x.reservation.debits[0]!);
  expect(() => calculate(x)).toThrow();
  const y = fixture();
  y.reservation.watermarks.push(y.reservation.watermarks[0]!);
  expect(() => calculate(y)).toThrow();
});
it.each(['seed', 'fee', 'rules', 'time'])(
  'rejects replacement of original %s evidence',
  (field) => {
    const x = fixture();
    if (field === 'seed') x.original.model.seed = '123';
    else if (field === 'fee') x.original.model.takerFeeRate = '0.01';
    else if (field === 'rules') x.original.record.rules.version = 'different-rules';
    else x.original.now--;
    expect(() => calculate(x)).toThrow();
  },
);
it('rejects replay against the already advanced Portfolio', () => {
  const x = partial(),
    r = calculate(x);
  expect(() => calculate({ ...x, portfolio: r.state })).toThrow();
});
it('conserves original debit as posted spend plus active collateral plus release', () => {
  const D = Decimal.clone({ precision: 120 });
  for (const x of [fixture(), partial()]) {
    const r = calculate(x),
      d = r.reservation.debits[0]!;
    expect(new D(d.spent).add(d.remaining).add(d.released).toFixed()).toBe(d.original);
  }
});
it('retains per-fill quote fee atoms and exact lot-rounded remainder', () => {
  const x = partial();
  x.original.model.takerFeeRate = x.frame.model.takerFeeRate = '0.000000000000000001';
  const envelope = paper.calculatePaperRiskEnvelope({
    ...x.original,
    order: x.attempt.request.admission.command,
  });
  const hold = x.portfolio.holds[0]!;
  hold.amount = x.reservation.debits[0]!.amount = envelope.debits[0]!.amount;
  x.reservation.watermarks[0]!.fingerprint = wireHash({ type: 'COMMITMENT', hold });
  const r = calculate(x),
    fill = r.execution.calculation.ledger.execution.executions[0]!.fills[0]!;
  expect(fill.quoteFee).toBe('0.000000000000000003');
  expect(r.reservation.debits[0]!.spent).toBe('2.512500000000000003');
  const expected = paper.calculatePaperReservationProgress({
    original: { ...x.original, order: x.attempt.request.admission.command },
    fills: [fill],
  });
  expect(r.reservation.debits[0]!.remaining).toBe(expected.debits[0]!.remaining);
});
it('preserves release tombstone ordering when an old commitment is replayed after JSON restart', () => {
  const x = fixture(),
    r = calculate(x),
    h = r.holdChanges[0]!;
  const replay = reducePortfolio(
    JSON.parse(canonical(r.state)),
    {
      id: 'old-commitment',
      timestamp: wireNow,
      type: 'COMMITMENT',
      hold: x.portfolio.holds[0]!,
    },
    { now: () => x.now, holdWatermark: JSON.parse(canonical(h.watermark)) },
  );
  expect(replay.ignored).toBe(true);
  expect(replay.state).toEqual(r.state);
  expect(replay.holdWatermark).toEqual(h.watermark);
  expect(replay.postings).toEqual([]);
});
it.each(['fills', 'postings', 'released', 'riskGrant'])('rejects caller %s overrides', (key) =>
  expect(() => calculate({ ...fixture(), [key]: [] })).toThrow(),
);
it('rejects accessor and oversized collection inputs before visiting them', () => {
  const x = fixture();
  let visited = false;
  Object.defineProperty(x, 'reservation', {
    enumerable: true,
    get() {
      visited = true;
      throw Error('ACCESSOR');
    },
  });
  expect(() => calculate(x)).toThrow();
  expect(visited).toBe(false);
  const y = fixture();
  y.reservation.debits = new Array(1001).fill(y.reservation.debits[0]);
  expect(() => calculate(y)).toThrow();
});
