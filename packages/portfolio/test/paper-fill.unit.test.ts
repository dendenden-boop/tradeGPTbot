import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import * as portfolio from '../src/index.js';
import type { Binding, PortfolioEvent, PortfolioState } from '../src/index.js';
import { binding, fill, snapshot } from './fixtures.js';

const hash = (value: unknown) =>
  createHash('sha256').update(portfolio.canonical(value)).digest('hex');
function schema() {
  const candidate = (portfolio as unknown as Record<string, unknown>)['paperFillEventSchema'];
  expect(candidate, 'PAPER_FILL_SCHEMA_MISSING').toBeDefined();
  return candidate as {
    parse(raw: unknown): PortfolioEvent;
    safeParse(raw: unknown): { success: boolean };
  };
}
function paperBinding(): Binding {
  return portfolio.bindingSchema.parse({ ...binding(), mode: 'PAPER', connectionId: null });
}
function event(side: 'BUY' | 'SELL' = 'BUY', suffix = 'a') {
  const fillId = 'paper-' + suffix.repeat(64);
  return {
    type: 'PAPER_FILL',
    id: 'paper-fill:' + fillId,
    timestamp: 1000,
    internalOrderId: '44444444-4444-4444-8444-444444444444',
    instrumentId: 'BTCUSDT',
    metadataVersion: 'metadata1',
    ruleVersion: 'rules1',
    base: 'BTC',
    quote: 'USDT',
    positionSide: 'NET',
    bucket: 'SPOT',
    side,
    quantity: '1',
    price: '10',
    fees: [{ asset: 'USDT', amount: '0.01', quoteEquivalent: '0.01' }],
    paper: { fillId, modelVersion: 'spot-l2-taker-v1', scope: binding().scope },
  };
}
function anchored(b: Binding = paperBinding()) {
  return portfolio.reducePortfolio(portfolio.createState(b), snapshot(), { now: () => 2000 }).state;
}
function context(state: PortfolioState, raw: unknown) {
  const parsed = schema().parse(raw);
  return {
    now: () => 2000,
    paperExecutionEvidence: {
      eventId: parsed.id,
      fingerprint: hash(parsed),
      bindingHash: hash(state.binding),
    },
  };
}
function apply(state: PortfolioState, raw: unknown) {
  return portfolio.reducePortfolio(state, schema().parse(raw), context(state, raw));
}

it('parses explicit PAPER fill content without native IDs or acknowledgements', () => {
  const raw = event(),
    parsed = schema().parse(raw);
  expect(parsed).toEqual(raw);
  expect('native' in parsed).toBe(false);
  expect(portfolio.eventSchema.parse(raw)).toEqual(parsed);
});
it('BUY preserves the existing Spot Portfolio principal, fees and position accounting', () => {
  const raw = event(),
    reduced = apply(anchored(), raw);
  // Native-shaped events exist only in this old TESTNET arithmetic fixture.
  const native = portfolio.reducePortfolio(
    anchored(binding()),
    fill({
      id: raw.id,
      bucket: 'SPOT',
      price: raw.price,
      fees: raw.fees,
    }),
    { now: () => 2000 },
  );
  expect(reduced.postings).toEqual(native.postings);
  expect(reduced.state.balances).toEqual(native.state.balances);
  expect(reduced.state.positions).toEqual(native.state.positions);
  expect(reduced.state.binding.mode).toBe('PAPER');
  expect(reduced.state.binding.connectionId).toBeNull();
});
it('SELL realizes PnL as a projection and never posts that PnL as second cash', () => {
  const bought = apply(anchored(), event()).state;
  const sold = apply(bought, {
    ...event('SELL', 'b'),
    timestamp: 1001,
    quantity: '0.5',
    price: '12',
    fees: [{ asset: 'USDT', amount: '0.006', quoteEquivalent: '0.006' }],
  });
  expect(sold.state.balances.find((b) => b.asset === 'USDT')!.total).toBe('995.984');
  expect(sold.state.positions[0]).toMatchObject({
    quantity: '0.5',
    basis: '5',
    realizedGross: '1',
    feesQuote: '0.016',
  });
  expect(
    sold.postings
      .filter((p) => p.bucket === 'AVAILABLE' && p.asset === 'USDT')
      .map((p) => p.amount),
  ).toEqual(['6', '-0.006']);
});
it('zero fee content uses no fake zero charge or FEE posting', () => {
  const r = apply(anchored(), { ...event(), fees: [] });
  expect(r.postings).toHaveLength(4);
  expect(r.state.positions[0]!.feesQuote).toBe('0');
});
it('body-shaped evidence cannot authorize its own reduction', () => {
  expect(() =>
    portfolio.reducePortfolio(anchored(), schema().parse(event()), { now: () => 2000 }),
  ).toThrow('PAPER_EXECUTION_PROOF_REQUIRED');
});
it.each(['eventId', 'fingerprint', 'bindingHash'] as const)(
  'rejects mismatched server-context %s',
  (field) => {
    const s = anchored(),
      raw = event(),
      ctx = context(s, raw);
    expect(() =>
      portfolio.reducePortfolio(s, schema().parse(raw), {
        ...ctx,
        paperExecutionEvidence: { ...ctx.paperExecutionEvidence, [field]: 'wrong' },
      }),
    ).toThrow('PAPER_EXECUTION_PROOF_REQUIRED');
  },
);
it('a matching event proof cannot be reused for another account or wallet', () => {
  const s = anchored(),
    raw = event(),
    ctx = context(s, raw);
  const other = anchored({
    ...s.binding,
    accountId: '55555555-5555-4555-8555-555555555555',
    walletId: 'other',
  });
  expect(() => portfolio.reducePortfolio(other, schema().parse(raw), ctx)).toThrow(
    'PAPER_EXECUTION_PROOF_REQUIRED',
  );
});
it('changed economics invalidate the retained context fingerprint', () => {
  const s = anchored(),
    raw = event(),
    ctx = context(s, raw);
  expect(() =>
    portfolio.reducePortfolio(s, schema().parse({ ...raw, quantity: '2' }), ctx),
  ).toThrow('PAPER_EXECUTION_PROOF_REQUIRED');
});
it.each(['TESTNET', 'DEMO', 'LIVE'] as const)(
  'PAPER content cannot reduce an exact %s account',
  (mode) => {
    const b = portfolio.bindingSchema.parse({
      ...binding(),
      mode,
      scope: { ...binding().scope, environment: mode },
    });
    const s = anchored(b),
      raw = { ...event(), paper: { ...event().paper, scope: b.scope } };
    expect(() => apply(s, raw)).toThrow('PAPER_EXECUTION_SCOPE');
  },
);
it('public source environment LIVE is distinct from private LIVE account mode', () => {
  const b = portfolio.bindingSchema.parse({
    ...paperBinding(),
    scope: { ...binding().scope, environment: 'LIVE' },
  });
  const raw = { ...event(), paper: { ...event().paper, scope: b.scope } };
  expect(apply(anchored(b), raw).state.binding.mode).toBe('PAPER');
});
it('foreign public market scope cannot reuse a bound account context', () => {
  const s = anchored(),
    raw = {
      ...event(),
      paper: { ...event().paper, scope: { ...binding().scope, exchange: 'OKX' } },
    };
  expect(() => apply(s, raw)).toThrow('PAPER_EXECUTION_SCOPE');
});
it('an actual fill never implicitly releases or weakens an UNKNOWN hold', () => {
  const s = anchored();
  s.holds = [{ id: 'hold', asset: 'USDT', amount: '25', status: 'UNKNOWN', reflected: false }];
  expect(apply(s, event()).state.holds).toEqual(s.holds);
});
it('exact pending event replay after serialization cannot post money twice', () => {
  const raw = event(),
    once = apply(anchored(), raw);
  const restored = portfolio.restorePortfolio(JSON.parse(portfolio.canonical(once.state)));
  expect(() => apply(restored, raw)).toThrow('EVIDENCE_ALREADY_PENDING');
});
it('older economic time remains rejected after an accepted PAPER fill', () => {
  const s = apply(anchored(), { ...event(), timestamp: 1002 }).state;
  expect(() => apply(s, { ...event('BUY', 'b'), timestamp: 1001 })).toThrow(
    'OUT_OF_ORDER_ECONOMIC',
  );
});
it('future timestamp remains rejected even with matching context content', () => {
  expect(() => apply(anchored(), { ...event(), timestamp: 2001 })).toThrow('FUTURE_EVENT');
});
it('a PAPER fill cannot precede the initial Portfolio snapshot', () => {
  expect(() => apply(portfolio.createState(paperBinding()), event())).toThrow('NEEDS_SNAPSHOT');
});
it('input state and evidence are unchanged by pure reduction', () => {
  const s = anchored(),
    raw = event(),
    before = portfolio.canonical({ s, raw });
  apply(s, raw);
  expect(portfolio.canonical({ s, raw })).toBe(before);
});
it.each(['native', 'exchangeOrderId', 'grant', 'receipt', 'resolved', 'tenantId'])(
  'rejects caller-added %s fields instead of accepting invented authority',
  (field) => {
    expect(schema().safeParse({ ...event(), [field]: {} }).success).toBe(false);
  },
);
it.each([
  ['changed cause', { ...event(), id: 'other' }],
  ['unknown model', { ...event(), paper: { ...event().paper, modelVersion: 'unproven-v2' } }],
  ['native-shaped fill ID', { ...event(), paper: { ...event().paper, fillId: 'native-123' } }],
  [
    'non-Spot source',
    {
      ...event(),
      paper: { ...event().paper, scope: { ...binding().scope, market: 'LINEAR_PERPETUAL' } },
    },
  ],
  ['non-net position', { ...event(), positionSide: 'LONG' }],
  ['foreign bucket', { ...event(), bucket: 'CROSS' }],
  ['same assets', { ...event(), quote: 'BTC' }],
  ['numeric quantity', { ...event(), quantity: 1 }],
  ['rebate', { ...event(), fees: [{ asset: 'USDT', amount: '-0.01', quoteEquivalent: '-0.01' }] }],
  ['zero fee record', { ...event(), fees: [{ asset: 'USDT', amount: '0', quoteEquivalent: '0' }] }],
  [
    'non-quote fee',
    { ...event(), fees: [{ asset: 'BTC', amount: '0.01', quoteEquivalent: '0.01' }] },
  ],
  [
    'unproven conversion',
    { ...event(), fees: [{ asset: 'USDT', amount: '0.01', quoteEquivalent: '1' }] },
  ],
  [
    'FX shortcut',
    {
      ...event(),
      fees: [{ ...event().fees[0]!, fx: { rate: '1', asOf: 1000, sourceId: 'caller' } }],
    },
  ],
  ['duplicate fee', { ...event(), fees: [event().fees[0], event().fees[0]] }],
] as const)('rejects %s PAPER economic content', (_name, raw) => {
  expect(schema().safeParse(raw).success).toBe(false);
});
