import { Decimal } from 'decimal.js';
import { beforeEach, expect, it } from 'vitest';
import { newOrderSchema, parseDecimal, immutable } from '@ctp/exchange-core';
import {
  bindingSchema,
  createState,
  reducePortfolio,
  paperFillEventSchema,
  type PaperFillEvent,
  type PortfolioState,
  type Posting,
} from '@ctp/portfolio';
import * as paper from '../src/index.js';
import { fixture, marketFixture, NOW } from './fixtures.js';
import { binding, snapshot } from '../../portfolio/test/fixtures.js';

interface Calculation {
  kind: 'PAPER_EXECUTION_PORTFOLIO_CALCULATION';
  version: 'spot-l2-taker-portfolio-v1';
  ledger: ReturnType<typeof paper.calculatePaperExecutionLedger>;
  before: PortfolioState;
  state: PortfolioState;
  fills: readonly {
    orderId: string;
    admissionSequence: string;
    fillId: string;
    event: PaperFillEvent;
    postings: readonly Posting[];
  }[];
}
function entry() {
  const fn = (paper as unknown as Record<string, unknown>)['calculatePaperExecutionPortfolio'];
  if (typeof fn !== 'function') throw new Error('PAPER_EXECUTION_PORTFOLIO_MISSING');
  return fn as (raw: unknown) => Calculation;
}
beforeEach(() => {
  entry();
});
const calculate = (raw: unknown) => entry()(raw);
function item(index = 1) {
  const { now, ...candidate } = fixture().execution;
  void now;
  return {
    ...candidate,
    orderId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    admissionSequence: String(index),
    order: { ...candidate.order, clientOrderId: `portfolio-client-${index}` },
  };
}
function input() {
  const competition = {
    now: fixture().now,
    frame: structuredClone(paper.preparePaperFrame(marketFixture())),
    orders: [item()],
  };
  const b = bindingSchema.parse({
    ...binding(),
    mode: 'PAPER',
    connectionId: null,
    externalAccountId: 'paper-scenario',
    scope: competition.frame.record.instrument.scope,
  });
  const portfolio = reducePortfolio(createState(b), snapshot({ timestamp: NOW - 1 }), {
    now: () => competition.now,
  }).state;
  return { competition, portfolio };
}
const balance = (s: PortfolioState, asset: string) => s.balances.find((b) => b.asset === asset)!;
const Exact = Decimal.clone({ precision: 120 });
const sum = (rows: readonly Posting[], asset: string, bucket: string) =>
  rows
    .filter((p) => p.asset === asset && p.bucket === bucket)
    .reduce((n, p) => n.add(p.amount), new Exact(0))
    .toFixed();

it('derives native-free PAPER events from the original fills and exact frame versions', () => {
  const x = input(),
    r = calculate(x),
    f = r.fills[0]!;
  expect(r.kind).toBe('PAPER_EXECUTION_PORTFOLIO_CALCULATION');
  expect(r.version).toBe('spot-l2-taker-portfolio-v1');
  expect(r.ledger).toEqual(paper.calculatePaperExecutionLedger(x.competition));
  expect(f.fillId).toBe(r.ledger.execution.executions[0]!.fills[0]!.id);
  expect(f.event).toMatchObject({
    type: 'PAPER_FILL',
    id: `paper-fill:${f.fillId}`,
    timestamp: x.competition.now,
    internalOrderId: x.competition.orders[0]!.orderId,
    instrumentId: 'btc-usdt',
    metadataVersion: 'metadata-v1',
    ruleVersion: 'rules-v1',
    side: 'BUY',
    quantity: '0.5',
    price: '10.05',
    positionSide: 'NET',
    bucket: 'SPOT',
    base: 'BTC',
    quote: 'USDT',
    fees: [{ asset: 'USDT', amount: '0.005025', quoteEquivalent: '0.005025' }],
    paper: {
      fillId: f.fillId,
      modelVersion: 'spot-l2-taker-v1',
      scope: x.competition.frame.record.instrument.scope,
    },
  });
  expect(paperFillEventSchema.parse(f.event)).toEqual(f.event);
  expect('native' in f.event).toBe(false);
  expect('exchangeOrderId' in f.event).toBe(false);
  expect(f.postings).toEqual(r.ledger.orders[0]!.transactions[0]!.postings);
});
it('projects BUY principal, fee, position basis and pending evidence exactly once', () => {
  const x = input(),
    r = calculate(x);
  expect(balance(r.state, 'USDT').total).toBe('994.969975');
  expect(balance(r.state, 'BTC').total).toBe('0.5');
  expect(r.state.positions[0]).toMatchObject({
    instrumentId: 'btc-usdt',
    quantity: '0.5',
    basis: '5.025',
    realizedGross: '0',
    feesQuote: '0.005025',
  });
  expect(r.state.pending).toEqual(r.fills.map((f) => f.event.id));
  expect(r.state.lastEconomicAt).toBe(x.competition.now);
  expect(r.before).toEqual(x.portfolio);
});
it('projects SELL PnL without an additional cash or PnL posting', () => {
  const x = input(),
    bought = calculate(x);
  x.portfolio = structuredClone(bought.state);
  x.competition.now++;
  x.competition.orders = [item(2)];
  x.competition.orders[0]!.order = newOrderSchema.parse({
    ...item(2).order,
    side: 'SELL',
    limitPrice: '9.5',
    size: { kind: 'BASE_QUANTITY', value: '0.25', asset: 'BTC' },
  });
  const f = x.competition.frame;
  f.book.bids = [{ price: parseDecimal('12'), quantity: parseDecimal('1') }];
  f.book.asks = [{ price: parseDecimal('12.05'), quantity: parseDecimal('1') }];
  f.bidsUsed = [parseDecimal('0')];
  f.asksUsed = [parseDecimal('0')];
  f.trade.price = parseDecimal('12');
  const r = calculate(x);
  expect(r.state.positions[0]).toMatchObject({
    quantity: '0.25',
    basis: '2.5125',
    realizedGross: '0.4875',
    feesQuote: '0.008025',
  });
  expect(balance(r.state, 'USDT').total).toBe('997.966975');
  expect(sum(r.fills[0]!.postings, 'USDT', 'AVAILABLE')).toBe('2.997');
  expect(r.fills[0]!.postings).toHaveLength(6);
});
it('uses no synthetic zero fee event or FEE posting', () => {
  const x = input();
  x.competition.frame.model.takerFeeRate = '0';
  const r = calculate(x);
  expect(r.fills[0]!.event.fees).toEqual([]);
  expect(r.fills[0]!.postings).toHaveLength(4);
  expect(r.state.positions[0]!.feesQuote).toBe('0');
});
it('keeps one original event and balanced posting transaction per depth-level fill', () => {
  const x = input(),
    f = x.competition.frame;
  f.model.participationRate = '1';
  f.book.asks = [
    { price: parseDecimal('10.05'), quantity: parseDecimal('0.25') },
    { price: parseDecimal('10.1'), quantity: parseDecimal('0.25') },
  ];
  f.asksUsed = [parseDecimal('0'), parseDecimal('0')];
  const r = calculate(x);
  expect(r.fills).toHaveLength(2);
  expect(new Set(r.fills.map((e) => e.event.id)).size).toBe(2);
  for (const fill of r.fills)
    expect(fill.postings).toEqual(
      r.ledger.orders[0]!.transactions.find((t) => t.fillId === fill.fillId)!.postings,
    );
  expect(balance(r.state, 'BTC').total).toBe('0.5');
});
it('preserves admission FIFO and shared volume across all supplied contenders', () => {
  const x = input();
  x.competition.orders = [item(2), item(1)];
  const r = calculate(x);
  expect(r.ledger.orders.map((o) => o.admissionSequence)).toEqual(['1', '2']);
  expect(r.fills.map((f) => f.orderId)).toEqual([item(1).orderId]);
  expect(r.state.pending).toHaveLength(1);
  expect(r.ledger.execution.frame.volumeUsed).toBe('0.5');
});
it('is deterministic across input permutations and JSON serialization', () => {
  const x = input();
  x.competition.orders = [item(2), item(1)];
  expect(calculate(x)).toEqual(
    calculate({
      ...x,
      competition: { ...x.competition, orders: [...x.competition.orders].reverse() },
    }),
  );
  expect(calculate(JSON.parse(JSON.stringify(x)))).toEqual(calculate(x));
});
it('retains original cause identities across repeated calculations without claiming durable replay', () => {
  const x = input(),
    a = calculate(x),
    b = calculate(x);
  expect(a).toEqual(b);
  expect(a.fills[0]!.event.id).toBe(a.ledger.orders[0]!.transactions[0]!.causeIdentity);
  expect(a.state.binding).toEqual(x.portfolio.binding);
});
it('preserves input and deeply freezes every output including events, postings, state and frame', () => {
  const x = input(),
    original = JSON.stringify(x),
    r = calculate(immutable(x));
  expect(JSON.stringify(x)).toBe(original);
  function frozen(value: unknown) {
    if (value && typeof value === 'object') {
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) frozen(child);
    }
  }
  frozen(r);
});
it('retains UNKNOWN and ordinary holds without release, resize or resolution', () => {
  const x = input();
  x.portfolio.holds = [
    { id: 'unknown-hold', asset: 'USDT', amount: '20', status: 'UNKNOWN', reflected: false },
    { id: 'reserved-hold', asset: 'USDT', amount: '10', status: 'RESERVED', reflected: false },
  ];
  const r = calculate(x);
  expect(r.state.holds).toEqual(x.portfolio.holds);
  expect(Object.keys(r).sort()).toEqual(['before', 'fills', 'kind', 'ledger', 'state', 'version']);
});
it.each(['LATENCY', 'TRIGGER', 'FOK', 'COMPLETE'] as const)(
  'empty %s projection neither posts money nor resolves holds',
  (reason) => {
    const x = input(),
      c = x.competition.orders[0]!;
    x.portfolio.holds = [
      { id: 'uncertain', asset: 'USDT', amount: '20', status: 'UNKNOWN', reflected: false },
    ];
    if (reason === 'LATENCY') c.submittedAt = x.competition.now;
    if (reason === 'TRIGGER')
      c.order = newOrderSchema.parse({
        ...c.order,
        type: 'STOP_LIMIT',
        trigger: { price: '11', source: 'LAST' },
      });
    if (reason === 'FOK')
      c.order = newOrderSchema.parse({
        ...c.order,
        timeInForce: 'FOK',
        size: { kind: 'BASE_QUANTITY', value: '1', asset: 'BTC' },
      });
    if (reason === 'COMPLETE')
      c.executedQuantity =
        c.order.size.kind === 'BASE_QUANTITY' ? c.order.size.value : parseDecimal('0');
    const r = calculate(x);
    expect(r.ledger.execution.executions[0]!.reason).toBe(reason);
    expect(r.fills).toEqual([]);
    expect(r.state).toEqual(r.before);
    expect(r.state.holds).toEqual(x.portfolio.holds);
  },
);
it('rejects a duplicate pending fill rather than projecting it for a second time', () => {
  const x = input(),
    r = calculate(x);
  expect(() => calculate({ ...x, portfolio: r.state })).toThrow('EVIDENCE_ALREADY_PENDING');
});
it('rejects insufficient quote cash without mutating the supplied book', () => {
  const x = input(),
    q = balance(x.portfolio, 'USDT');
  q.total = q.free = q.available = '1';
  const original = JSON.stringify(x);
  expect(() => calculate(x)).toThrow('PAPER_EXECUTION_PORTFOLIO_BALANCE');
  expect(JSON.stringify(x)).toBe(original);
});
it('rejects overselling instead of opening a short Spot position', () => {
  const x = input();
  x.competition.orders[0]!.order = newOrderSchema.parse({
    ...item().order,
    side: 'SELL',
    limitPrice: '9.5',
  });
  expect(() => calculate(x)).toThrow('POSITION_DIRECTION');
});
it('returns no partial result when a later contender cannot be projected', () => {
  const x = input(),
    f = x.competition.frame;
  f.model.participationRate = '1';
  f.trade.quantity = parseDecimal('2');
  x.competition.orders = [item(1), item(2)];
  x.competition.orders[1]!.order = newOrderSchema.parse({
    ...item(2).order,
    side: 'SELL',
    limitPrice: '9.5',
    size: { kind: 'BASE_QUANTITY', value: '1', asset: 'BTC' },
  });
  const original = JSON.stringify(x);
  expect(() => calculate(x)).toThrow('POSITION_DIRECTION');
  expect(JSON.stringify(x)).toBe(original);
});
it('retains nullable availability rather than guessing balances', () => {
  const x = input();
  balance(x.portfolio, 'USDT').available = null;
  expect(balance(calculate(x).state, 'USDT').available).toBeNull();
});
it('rejects future snapshots and future economic state even when no fill is eligible', () => {
  const x = input();
  x.competition.orders[0]!.submittedAt = x.competition.now;
  x.portfolio.snapshotAt = x.competition.now + 1;
  expect(() => calculate(x)).toThrow('PAPER_EXECUTION_PORTFOLIO_STATE');
  x.portfolio.snapshotAt = NOW - 1;
  x.portfolio.lastEconomicAt = x.competition.now + 1;
  expect(() => calculate(x)).toThrow('PAPER_EXECUTION_PORTFOLIO_STATE');
});
it.each(['AWAITING_SNAPSHOT', 'GAP', 'UNRECONCILED'] as const)(
  'rejects %s before-state instead of inventing Portfolio truth',
  (status) => {
    const x = input();
    x.portfolio.status = status;
    expect(() => calculate(x)).toThrow('PAPER_EXECUTION_PORTFOLIO_STATE');
  },
);
it('rejects unknown prior position basis instead of inventing realized PnL', () => {
  const x = input();
  x.portfolio = structuredClone(calculate(x).state);
  x.portfolio.positions[0]!.basis = null;
  expect(() => calculate(x)).toThrow('PAPER_EXECUTION_PORTFOLIO_STATE');
});
it.each(['TESTNET', 'DEMO', 'LIVE'] as const)('rejects native %s Portfolio bindings', (mode) => {
  const x = input();
  x.portfolio.binding = {
    ...x.portfolio.binding,
    mode,
    connectionId: binding().connectionId,
    scope: { ...x.portfolio.binding.scope, environment: mode },
  };
  expect(() => calculate(x)).toThrow('PAPER_EXECUTION_PORTFOLIO_SCOPE');
});
it.each(['exchange', 'region', 'environment'] as const)(
  'rejects another public source %s',
  (field) => {
    const x = input();
    if (field === 'exchange')
      x.portfolio.binding.scope = { ...x.portfolio.binding.scope, exchange: 'BYBIT' };
    if (field === 'region')
      x.portfolio.binding.scope = { ...x.portfolio.binding.scope, region: 'other-region' };
    if (field === 'environment')
      x.portfolio.binding.scope = { ...x.portfolio.binding.scope, environment: 'LIVE' };
    expect(() => calculate(x)).toThrow('PAPER_EXECUTION_PORTFOLIO_SCOPE');
  },
);
it('rejects caller-shaped fills, postings, receipt, permit and authority fields', () => {
  for (const key of [
    'fills',
    'postings',
    'receipt',
    'permit',
    'paperExecutionEvidence',
    'tenantId',
    'accountId',
    'binding',
  ])
    expect(() => calculate({ ...input(), [key]: { authorized: true } })).toThrow(
      'PAPER_EXECUTION_PORTFOLIO_INPUT',
    );
});
it.each(['stale', 'gap', 'rule', 'identity'] as const)(
  'retains existing model %s rejection',
  (defect) => {
    const x = input();
    if (defect === 'stale') x.competition.now += 20000;
    if (defect === 'gap') x.competition.frame.book.stale = true;
    if (defect === 'rule') x.competition.orders[0]!.order.ruleVersion = 'replaced-rules';
    if (defect === 'identity') x.competition.orders.push(structuredClone(x.competition.orders[0]!));
    expect(() => calculate(x)).toThrow();
  },
);
it('bounds contenders before parsing poisoned entries', () => {
  const x = input();
  const poison = {
    get order() {
      throw new Error('WALKED_EXCESS');
    },
  };
  expect(() =>
    calculate({ ...x, competition: { ...x.competition, orders: Array(301).fill(poison) } }),
  ).toThrow('PAPER_EXECUTION_PORTFOLIO_INPUT');
});
it('bounds depth before parsing poisoned levels', () => {
  const x = input(),
    poison = {
      get price() {
        throw new Error('WALKED_EXCESS');
      },
    };
  expect(() =>
    calculate({
      ...x,
      competition: {
        ...x.competition,
        frame: {
          ...x.competition.frame,
          book: { ...x.competition.frame.book, asks: Array(1001).fill(poison) },
        },
      },
    }),
  ).toThrow('PAPER_EXECUTION_PORTFOLIO_INPUT');
});
it('keeps quantities above Number precision exact', () => {
  const x = input(),
    f = x.competition.frame,
    quantity = parseDecimal('9007199254740993.05');
  f.model.participationRate = '1';
  f.model.takerFeeRate = '0';
  f.record.rules.maxQuantity = parseDecimal('99999999999999999999');
  f.record.rules.maxNotional = null;
  f.book.asks = [{ price: parseDecimal('10.05'), quantity }];
  f.asksUsed = [parseDecimal('0')];
  f.trade.quantity = quantity;
  x.competition.orders[0]!.order = newOrderSchema.parse({
    ...item().order,
    size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: quantity },
  });
  const q = balance(x.portfolio, 'USDT');
  q.total = q.free = q.available = '9999999999999999999999999999';
  const r = calculate(x);
  expect(balance(r.state, 'BTC').total).toBe(quantity);
  expect(r.state.positions[0]!.quantity).toBe(quantity);
  expect(sum(r.fills[0]!.postings, 'USDT', 'AVAILABLE')).toBe('-90522352510146980.1525');
});
it('is independent of process-global Decimal configuration', () => {
  const x = input(),
    expected = calculate(x),
    precision = Decimal.precision,
    rounding = Decimal.rounding;
  try {
    Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN });
    expect(calculate(x)).toEqual(expected);
  } finally {
    Decimal.set({ precision, rounding });
  }
});
it('projects a bounded 300-contender batch without resetting liquidity', () => {
  const x = input();
  x.competition.orders = Array.from({ length: 300 }, (_, i) => item(i + 1));
  const r = calculate(x);
  expect(r.ledger.orders).toHaveLength(300);
  expect(r.fills).toHaveLength(1);
  expect(r.state.pending).toHaveLength(1);
  expect(r.ledger.execution.frame.volumeUsed).toBe('0.5');
});
it('keeps existing used frame consumption instead of minting fresh volume', () => {
  const x = input(),
    used = calculate(x);
  x.competition.frame = structuredClone(used.ledger.execution.frame);
  const r = calculate(x);
  expect(r.fills).toEqual([]);
  expect(r.state).toEqual(x.portfolio);
});
it('never presents a calculation as committed execution, source authority or a grant', () => {
  const r = calculate(input());
  for (const key of [
    'committed',
    'grant',
    'permit',
    'reservation',
    'holdWatermark',
    'certificate',
    'exchangeOrderId',
    'sourceAuthority',
  ])
    expect(key in r).toBe(false);
  expect(r.state.binding.mode).toBe('PAPER');
  expect(r.state.binding.connectionId).toBeNull();
});

it('rejects a projection that loses another Spot position cost basis instead of returning unknown PnL', () => {
  const x = input();
  x.portfolio.positions.push({
    instrumentId: 'usdt-usdc',
    positionSide: 'NET',
    bucket: 'SPOT',
    base: 'USDT',
    quote: 'USDC',
    quantity: '1000',
    basis: '1000',
    realizedGross: '0',
    feesQuote: '0',
    fundingQuote: '0',
    fees: {},
    funding: {},
  });
  const original = JSON.stringify(x);
  expect(() => calculate(x)).toThrow('PAPER_EXECUTION_PORTFOLIO_STATE');
  expect(JSON.stringify(x)).toBe(original);
});
it('rejects cross-instrument inventory divergence even with a zero fee', () => {
  const x = input();
  x.competition.frame.model.takerFeeRate = '0';
  x.portfolio.positions.push({
    instrumentId: 'usdt-usdc',
    positionSide: 'NET',
    bucket: 'SPOT',
    base: 'USDT',
    quote: 'USDC',
    quantity: '1000',
    basis: '1000',
    realizedGross: '0',
    feesQuote: '0',
    fundingQuote: '0',
    fees: {},
    funding: {},
  });
  expect(() => calculate(x)).toThrow('PAPER_EXECUTION_PORTFOLIO_STATE');
});
it('projects actual fills for all 300 contenders without a second cash effect', () => {
  const x = input();
  x.competition.orders = Array.from({ length: 300 }, (_, i) => item(i + 1));
  x.competition.frame.model.participationRate = '1';
  x.competition.frame.trade.quantity = parseDecimal('150');
  x.competition.frame.book.asks = [{ price: parseDecimal('10.05'), quantity: parseDecimal('150') }];
  x.competition.frame.asksUsed = [parseDecimal('0')];
  const quote = balance(x.portfolio, 'USDT');
  quote.total = quote.free = quote.available = '3000';
  const r = calculate(x);
  expect(r.fills).toHaveLength(300);
  expect(r.state.pending).toHaveLength(300);
  expect(new Set(r.fills.map((f) => f.fillId)).size).toBe(300);
  expect(balance(r.state, 'BTC').total).toBe('150');
  expect(balance(r.state, 'USDT').total).toBe('1490.9925');
  expect(r.state.positions[0]!.basis).toBe('1507.5');
  expect(r.state.positions[0]!.feesQuote).toBe('1.5075');
});
it('fails atomically at the existing pending evidence bound', () => {
  const x = input();
  x.portfolio.pending = Array.from({ length: 2000 }, (_, i) => `earlier-fill-${i}`);
  const before = JSON.stringify(x);
  expect(() => calculate(x)).toThrow();
  expect(JSON.stringify(x)).toBe(before);
});
it('bounds Portfolio collections before parsing poisoned members', () => {
  const x = input();
  x.portfolio.positions = new Array(1001) as PortfolioState['positions'];
  Object.defineProperty(x.portfolio.positions, '0', {
    get() {
      throw new Error('POISONED_POSITION');
    },
  });
  expect(() => calculate(x)).toThrow('PAPER_EXECUTION_PORTFOLIO_INPUT');
});
