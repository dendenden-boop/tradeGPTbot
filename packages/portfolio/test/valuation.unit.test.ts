import { expect, it } from 'vitest';
import { valuePortfolio } from '../src/valuation.js';
import { createState, reducePortfolio } from '../src/accounting.js';
import { binding, snapshot, fill, context } from './fixtures.js';
const fresh = () => reducePortfolio(createState(binding()), snapshot(), context).state;
const prices = [
  {
    asset: 'BTC',
    quote: 'USDT',
    price: '100',
    kind: 'LAST' as const,
    asOf: 1000,
    sourceId: 'btc-price',
    fresh: true,
  },
  {
    asset: 'BNB',
    quote: 'USDT',
    price: '10',
    kind: 'LAST' as const,
    asOf: 1000,
    sourceId: 'bnb-price',
    fresh: true,
  },
];
it('values only currency-converted balances without double counting positions', () => {
  const s = reducePortfolio(fresh(), fill(), context).state;
  const v = valuePortfolio([s], prices, { quote: 'USDT', now: 1000, reconciledAfterRestart: true });
  expect(v.total).toBe('1010');
  expect(v.complete).toBe(true);
});
it('keeps partial estimate visible but complete total null for stale or missing price', () => {
  const v = valuePortfolio([fresh()], [], {
    quote: 'USDT',
    now: 1000,
    reconciledAfterRestart: true,
  });
  expect(v.total).toBeNull();
  expect(v.partialValue).toBe('1000');
  expect(v.complete).toBe(false);
  const s = reducePortfolio(fresh(), fill(), context).state;
  const stale = valuePortfolio(
    [s],
    prices.map((p) => ({ ...p, fresh: false })),
    { quote: 'USDT', now: 1000, reconciledAfterRestart: true },
  );
  expect(stale.total).toBeNull();
  expect(stale.estimate).toBe('1010');
});
it('marks old balances and restart stale even when price is fresh', () => {
  expect(
    valuePortfolio([fresh()], prices, { quote: 'USDT', now: 20000, reconciledAfterRestart: true })
      .total,
  ).toBeNull();
  expect(
    valuePortfolio([fresh()], prices, { quote: 'USDT', now: 1000, reconciledAfterRestart: false })
      .total,
  ).toBeNull();
});
it('subtracts only unreflected holds and surfaces UNKNOWN separately', () => {
  const s = fresh();
  s.holds = [
    { id: 'h1', asset: 'USDT', amount: '50', status: 'RESERVED', reflected: true },
    { id: 'h2', asset: 'USDT', amount: '100', status: 'UNKNOWN', reflected: false },
  ];
  const v = valuePortfolio([s], prices, { quote: 'USDT', now: 1000, reconciledAfterRestart: true });
  expect(v.accounts[0]?.balances.find((b) => b.asset === 'USDT')?.spendable).toBe('900');
  expect(v.accounts[0]?.unknownCommitments).toBe(true);
});
it('requires MARK for derivative PnL and does not add notional to equity', () => {
  const s = reducePortfolio(
    reducePortfolio(createState(binding('LINEAR_PERPETUAL')), snapshot(), context).state,
    fill(),
    context,
  ).state;
  const v = valuePortfolio([s], prices, { quote: 'USDT', now: 1000, reconciledAfterRestart: true });
  expect(v.accounts[0]?.positions[0]?.unrealizedGross).toBeNull();
  expect(v.total).toBeNull();
  const mark = prices.map((p) => ({
    ...p,
    kind: 'MARK' as const,
    price: p.asset === 'BTC' ? '120' : p.price,
    scope: s.binding.scope,
    instrumentId: `${p.asset}USDT`,
  }));
  const m = valuePortfolio([s], [...prices, ...mark], {
    quote: 'USDT',
    now: 1000,
    reconciledAfterRestart: true,
  });
  expect(m.accounts[0]?.positions[0]?.unrealizedGross).toBe('20');
  expect(m.total).toBe('1030');
});
it('does not fabricate unknown basis PnL or fee-converted net', () => {
  const s = reducePortfolio(
    fresh(),
    fill({ fees: [{ asset: 'BNB', amount: '0.01', quoteEquivalent: null }] }),
    context,
  ).state;
  expect(
    valuePortfolio([s], prices, { quote: 'USDT', now: 1000, reconciledAfterRestart: true })
      .accounts[0]?.positions[0]?.netRealized,
  ).toBeNull();
});
it('refuses mixed modes, owners, duplicate wallets and conflicting price evidence', () => {
  const s = fresh();
  expect(() =>
    valuePortfolio([s, s], prices, { quote: 'USDT', now: 1000, reconciledAfterRestart: true }),
  ).toThrow('DUPLICATE_WALLET');
  const other = structuredClone(s);
  other.binding.mode = 'PAPER';
  other.binding.connectionId = null;
  other.binding.walletId = 'paper';
  expect(() =>
    valuePortfolio([s, other], prices, { quote: 'USDT', now: 1000, reconciledAfterRestart: true }),
  ).toThrow('MIXED_PORTFOLIO_SCOPE');
  expect(() =>
    valuePortfolio([s], [...prices, prices[0]!], {
      quote: 'USDT',
      now: 1000,
      reconciledAfterRestart: true,
    }),
  ).toThrow('AMBIGUOUS_PRICE');
});
