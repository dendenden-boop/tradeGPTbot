import { Decimal } from 'decimal.js';
import { expect, it } from 'vitest';
import { parseDecimal } from '@ctp/exchange-core';
import { createState, reducePortfolio, type Posting } from '@ctp/portfolio';
import * as paper from '../src/index.js';
import { fixture, marketFixture, NOW } from './fixtures.js';
import { binding, fill, snapshot } from '../../portfolio/test/fixtures.js';

type Calculation = {
  kind: 'PAPER_EXECUTION_LEDGER_CALCULATION';
  version: 'spot-l2-taker-ledger-v1';
  execution: ReturnType<typeof paper.calculatePaperCompetition>;
  orders: readonly {
    orderId: string;
    admissionSequence: string;
    transactions: readonly {
      fillId: string;
      causeIdentity: string;
      postings: readonly Posting[];
    }[];
    availableDeltas: readonly { asset: string; amount: string }[];
  }[];
};
const D = Decimal.clone({ precision: 120 });
function calculate(raw: unknown): Calculation {
  const fn = (paper as unknown as Record<string, unknown>)['calculatePaperExecutionLedger'];
  if (typeof fn !== 'function') throw new Error('PAPER_EXECUTION_LEDGER_MISSING');
  return (fn as (value: unknown) => Calculation)(raw);
}
function item(index = 1) {
  const { now, ...execution } = fixture().execution;
  void now;
  return {
    ...execution,
    admissionSequence: String(index),
    orderId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    order: { ...execution.order, clientOrderId: `ledger-client-${index}` },
  };
}
function input(side: 'BUY' | 'SELL' = 'BUY') {
  const candidate = item();
  candidate.order = {
    ...candidate.order,
    side,
    limitPrice: parseDecimal(side === 'BUY' ? '10.5' : '9.5'),
  };
  return {
    now: fixture().now,
    frame: paper.preparePaperFrame(marketFixture()),
    orders: [candidate],
  };
}
const sum = (rows: readonly Posting[], asset: string, bucket?: string) =>
  rows
    .filter((p) => p.asset === asset && (bucket === undefined || p.bucket === bucket))
    .reduce((n, p) => n.add(p.amount), new D(0))
    .toFixed();

it('BUY principal and quote fee have separately balanced canonical postings', () => {
  const r = calculate(input()),
    t = r.orders[0]!.transactions[0]!;
  expect(r.kind).toBe('PAPER_EXECUTION_LEDGER_CALCULATION');
  expect(r.version).toBe('spot-l2-taker-ledger-v1');
  expect(t.postings).toEqual([
    { asset: 'BTC', bucket: 'AVAILABLE', amount: '0.5' },
    { asset: 'BTC', bucket: 'EXTERNAL', amount: '-0.5' },
    { asset: 'USDT', bucket: 'AVAILABLE', amount: '-5.025' },
    { asset: 'USDT', bucket: 'EXTERNAL', amount: '5.025' },
    { asset: 'USDT', bucket: 'AVAILABLE', amount: '-0.005025' },
    { asset: 'USDT', bucket: 'FEE', amount: '0.005025' },
  ]);
  expect(r.orders[0]!.availableDeltas).toEqual([
    { asset: 'BTC', amount: '0.5' },
    { asset: 'USDT', amount: '-5.030025' },
  ]);
});
it('SELL credits principal once and debits its quote fee once', () => {
  const r = calculate(input('SELL')),
    p = r.orders[0]!.transactions[0]!.postings;
  expect(p).toEqual([
    { asset: 'BTC', bucket: 'AVAILABLE', amount: '-0.5' },
    { asset: 'BTC', bucket: 'EXTERNAL', amount: '0.5' },
    { asset: 'USDT', bucket: 'AVAILABLE', amount: '4.975' },
    { asset: 'USDT', bucket: 'EXTERNAL', amount: '-4.975' },
    { asset: 'USDT', bucket: 'AVAILABLE', amount: '-0.004975' },
    { asset: 'USDT', bucket: 'FEE', amount: '0.004975' },
  ]);
  expect(sum(p, 'USDT', 'AVAILABLE')).toBe('4.970025');
});
it.each(['BUY', 'SELL'] as const)('preserves existing Portfolio %s posting semantics', (side) => {
  const x = input(side),
    r = calculate(x),
    f = r.execution.executions[0]!.fills[0]!;
  // Existing isolated native-shaped Portfolio fixtures compare arithmetic only;
  // no simulated native ACK/event is constructed or exported by production code.
  const clock = { now: () => x.now };
  let s = reducePortfolio(createState(binding()), snapshot({ timestamp: NOW - 3 }), clock).state;
  s = reducePortfolio(
    s,
    fill({ id: 'opening-fixture', timestamp: NOW - 2, price: '10' }),
    clock,
  ).state;
  const reduced = reducePortfolio(
    s,
    fill({
      id: 'posting-fixture',
      timestamp: x.now,
      side,
      quantity: f.quantity,
      price: f.price,
      fees: [{ asset: 'USDT', amount: f.quoteFee, quoteEquivalent: f.quoteFee }],
    }),
    clock,
  );
  expect(r.orders[0]!.transactions[0]!.postings).toEqual(reduced.postings);
});
it('omits a zero fee instead of creating zero-value journal entries', () => {
  const x = input();
  const r = calculate({
    ...x,
    frame: { ...x.frame, model: { ...x.frame.model, takerFeeRate: '0' } },
  });
  expect(r.orders[0]!.transactions[0]!.postings).toHaveLength(4);
  expect(r.orders[0]!.transactions[0]!.postings.every((p) => p.amount !== '0')).toBe(true);
});
it('every fill independently conserves each asset and matches its calculated wallet deltas', () => {
  const x = input(),
    orders = [
      item(1),
      { ...item(2), order: { ...item(2).order, side: 'SELL', limitPrice: '9.5' } },
    ];
  const r = calculate({
    ...x,
    orders,
    frame: { ...x.frame, model: { ...x.frame.model, participationRate: '1' } },
  });
  for (const order of r.orders)
    for (const transaction of order.transactions) {
      const f = r.execution.executions
        .find((v) => v.orderId === order.orderId)!
        .fills.find((v) => v.id === transaction.fillId)!;
      expect(sum(transaction.postings, 'BTC')).toBe('0');
      expect(sum(transaction.postings, 'USDT')).toBe('0');
      expect(sum(transaction.postings, 'BTC', 'AVAILABLE')).toBe(f.baseDelta);
      expect(sum(transaction.postings, 'USDT', 'AVAILABLE')).toBe(f.quoteDelta);
      expect(transaction.causeIdentity).toBe('spot-l2-taker-ledger-v1:' + f.id);
    }
});
it('preserves per-slice upward fee rounding rather than rounding an aggregate fee', () => {
  const x = input(),
    frame = structuredClone(x.frame);
  frame.model.participationRate = '1';
  frame.model.takerFeeRate = '0.000000000000000001';
  frame.book.asks = Array.from({ length: 10 }, (_, i) => ({
    price: new D('10.05').add(new D('0.05').mul(i)).toFixed(),
    quantity: '0.05',
  }));
  frame.asksUsed = frame.book.asks.map(() => '0');
  const r = calculate({ ...x, frame }),
    postings = r.orders[0]!.transactions.flatMap((t) => t.postings);
  expect(r.orders[0]!.transactions).toHaveLength(10);
  expect(sum(postings, 'USDT', 'FEE')).toBe('0.00000000000000001');
  expect(sum(postings, 'USDT')).toBe('0');
});
it('retains quantities beyond Number precision without iterating over lots', () => {
  const x = input(),
    frame = structuredClone(x.frame),
    quantity = '9007199254740993.05';
  frame.model.participationRate = '1';
  frame.model.takerFeeRate = '0';
  frame.record.rules.maxQuantity = parseDecimal('99999999999999999999');
  frame.record.rules.maxNotional = null;
  frame.book.asks = [{ price: '10.05', quantity }];
  frame.asksUsed = ['0'];
  frame.trade.quantity = quantity;
  const order = {
    ...item(),
    order: { ...item().order, size: { kind: 'BASE_QUANTITY', value: quantity } },
  };
  const r = calculate({ ...x, frame, orders: [order] });
  expect(r.orders[0]!.availableDeltas[0]).toEqual({ asset: 'BTC', amount: quantity });
  expect(sum(r.orders[0]!.transactions[0]!.postings, 'USDT', 'AVAILABLE')).toBe(
    '-90522352510146980.1525',
  );
});
it('reuses complete competition priority and shared volume without a second allocation', () => {
  const x = input(),
    request = { ...x, orders: Array.from({ length: 300 }, (_, i) => item(i + 1)) };
  const r = calculate(request);
  expect(r.execution).toEqual(paper.calculatePaperCompetition(request));
  expect(r.orders).toHaveLength(300);
  expect(r.orders.flatMap((o) => o.transactions)).toHaveLength(1);
});
it('is deterministic after input permutation', () => {
  const x = { ...input(), orders: [item(2), item(1)] };
  expect(calculate(x)).toEqual(calculate({ ...x, orders: [...x.orders].reverse() }));
});
it('retains calculation identities across JSON serialization, without claiming durable replay', () => {
  const x = input();
  expect(calculate(JSON.parse(JSON.stringify(x)))).toEqual(calculate(x));
});
it('does not mutate deeply frozen input or shared frame consumption', () => {
  const x = input(),
    before = JSON.stringify(x);
  const freeze = (v: unknown): void => {
    if (v && typeof v === 'object') {
      Object.freeze(v);
      for (const child of Object.values(v)) freeze(child);
    }
  };
  freeze(x);
  calculate(x);
  expect(JSON.stringify(x)).toBe(before);
});
it('returns deeply immutable execution, transactions, entries and deltas', () => {
  const r = calculate(input());
  for (const v of [
    r,
    r.execution,
    r.orders,
    r.orders[0],
    r.orders[0]!.transactions,
    r.orders[0]!.transactions[0],
    r.orders[0]!.transactions[0]!.postings[0],
    r.orders[0]!.availableDeltas[0],
  ])
    expect(Object.isFrozen(v)).toBe(true);
});
it('a consumed frame calculates no repeated financial effect', () => {
  const x = input(),
    first = calculate(x),
    r = calculate({ ...x, frame: first.execution.frame });
  expect(r.orders[0]!.transactions).toEqual([]);
  expect(r.orders[0]!.availableDeltas).toEqual([]);
});
it('posts only newly calculated remaining quantity, never historical fills again', () => {
  const x = input(),
    r = calculate({ ...x, orders: [{ ...x.orders[0]!, executedQuantity: '0.25' }] });
  expect(r.execution.executions[0]!.quantity).toBe('0.25');
  expect(r.orders[0]!.availableDeltas[0]).toEqual({ asset: 'BTC', amount: '0.25' });
});
it('waiting for modeled latency produces no transaction', () => {
  const x = input(),
    r = calculate({ ...x, orders: [{ ...x.orders[0]!, submittedAt: x.now }] });
  expect(r.execution.executions[0]!.reason).toBe('LATENCY');
  expect(r.orders[0]!.transactions).toEqual([]);
});
it('an untriggered conditional order produces no transaction', () => {
  const x = input(),
    r = calculate({
      ...x,
      orders: [
        {
          ...item(),
          order: { ...item().order, type: 'STOP_LIMIT', trigger: { price: '11', source: 'LAST' } },
        },
      ],
    });
  expect(r.execution.executions[0]!.reason).toBe('TRIGGER');
  expect(r.orders[0]!.transactions).toEqual([]);
});
it('FOK failure discards provisional economics and liquidity consumption', () => {
  const x = input(),
    r = calculate({
      ...x,
      orders: [
        {
          ...item(),
          order: {
            ...item().order,
            timeInForce: 'FOK',
            size: { kind: 'BASE_QUANTITY', value: '1' },
          },
        },
      ],
    });
  expect(r.execution.executions[0]!.reason).toBe('FOK');
  expect(r.orders[0]!.transactions).toEqual([]);
  expect(r.execution.frame).toEqual(x.frame);
});
it.each(['IOC', 'GTC'] as const)(
  '%s partial execution posts only its actual slice',
  (timeInForce) => {
    const x = input(),
      r = calculate({
        ...x,
        orders: [
          {
            ...item(),
            order: { ...item().order, timeInForce, size: { kind: 'BASE_QUANTITY', value: '1' } },
          },
        ],
      });
    expect(r.execution.executions[0]!.status).toBe(
      timeInForce === 'IOC' ? 'EXPIRED' : 'PARTIALLY_FILLED',
    );
    expect(r.orders[0]!.availableDeltas[0]).toEqual({ asset: 'BTC', amount: '0.5' });
  },
);
it('already completed quantity produces no transaction or fee', () => {
  const x = input(),
    r = calculate({ ...x, orders: [{ ...x.orders[0]!, executedQuantity: '0.5' }] });
  expect(r.execution.executions[0]!.reason).toBe('COMPLETE');
  expect(r.orders[0]!.transactions).toEqual([]);
});
it('a later invalid contender rejects the whole calculation without partial output', () => {
  const x = input(),
    bad = item(2),
    before = JSON.stringify(x);
  bad.order.ruleVersion = 'replaced';
  expect(() => calculate({ ...x, orders: [item(), bad] })).toThrow('PAPER_ORDER_RULES');
  expect(JSON.stringify(x)).toBe(before);
});
it('stale market evidence cannot produce postings', () => {
  const x = input();
  expect(() => calculate({ ...x, now: x.now + 5001 })).toThrow('PAPER_EVIDENCE');
});
it('gapped market evidence cannot produce postings', () => {
  const x = input();
  expect(() =>
    calculate({ ...x, frame: { ...x.frame, book: { ...x.frame.book, stale: true } } }),
  ).toThrow('PAPER_EVIDENCE');
});
it('duplicate order/client identities cannot duplicate principal or fees', () => {
  const x = input();
  expect(() => calculate({ ...x, orders: [item(), item()] })).toThrow('PAPER_COMPETITION_IDENTITY');
});
it('bounds the order collection before evaluating its members', () => {
  expect(() => calculate({ ...input(), orders: Array.from({ length: 301 }, () => null) })).toThrow(
    'PAPER_COMPETITION_INPUT',
  );
});
it.each(['tenantId', 'receipt', 'grant', 'permit', 'fills', 'postings', 'balance', 'resolved'])(
  'caller %s cannot provide financial authority or override calculated economics',
  (key) => {
    expect(() => calculate({ ...input(), [key]: {} })).toThrow('PAPER_COMPETITION_INPUT');
  },
);
it('exposes only a calculation and does not fabricate native or durable identities', () => {
  const r = calculate(input()),
    tx = r.orders[0]!.transactions[0]!;
  expect(Object.keys(r).sort()).toEqual(['execution', 'kind', 'orders', 'version']);
  expect(Object.keys(tx).sort()).toEqual(['causeIdentity', 'fillId', 'postings']);
  expect(tx.fillId).toBe(r.execution.executions[0]!.fills[0]!.id);
});
it('uses instrument assets without hard-coded currency names or conversion', () => {
  const x = input(),
    frame = structuredClone(x.frame);
  frame.record.instrument.baseAsset = 'ETH';
  frame.record.instrument.quoteAsset = 'USDC';
  const r = calculate({ ...x, frame });
  expect(r.orders[0]!.availableDeltas).toEqual([
    { asset: 'ETH', amount: '0.5' },
    { asset: 'USDC', amount: '-5.030025' },
  ]);
});
it('isolates arithmetic from global Decimal precision and rounding changes', () => {
  const x = input(),
    expected = calculate(x),
    before = { precision: Decimal.precision, rounding: Decimal.rounding };
  try {
    Decimal.set({ precision: 5, rounding: Decimal.ROUND_UP });
    expect(calculate(x)).toEqual(expected);
  } finally {
    Decimal.set(before);
  }
});
it('rejects numeric money instead of coercing rounded quantities', () => {
  const x = input();
  expect(() =>
    calculate({
      ...x,
      orders: [
        {
          ...item(),
          order: {
            ...item().order,
            size: { kind: 'BASE_QUANTITY', value: Number('9007199254740993') },
          },
        },
      ],
    }),
  ).toThrow('PAPER_COMPETITION_INPUT');
});
