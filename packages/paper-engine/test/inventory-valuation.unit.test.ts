import { expect, it } from 'vitest';
import * as candidate from '../src/index.js';
import { valuePortfolio } from '@ctp/portfolio';
import { parseDecimal } from '@ctp/exchange-core';
import { decodePaperRiskPortfolioSource } from '../src/risk-portfolio-domain.js';
import { riskPortfolioFixture, uuid } from './risk-portfolio-fixtures.js';

function input(count = 2) {
  const wire = riskPortfolioFixture(count);
  const inventory = decodePaperRiskPortfolioSource(wire, wire.owner, 200000);
  return {
    now: 200000,
    maxEvidenceAgeMs: 5000,
    inventory,
    quote: 'USDT',
    prices: inventory.accounts.map((a) => ({
      accountId: a.state.binding.accountId,
      asset: 'BTC',
      quote: 'USDT',
      price: '2',
      kind: 'LAST' as const,
      asOf: 200000,
      sourceId: 'public-btc-usdt',
      scope: a.state.binding.scope,
    })),
  };
}
function calculate(raw: unknown) {
  const fn = (candidate as unknown as Record<string, unknown>)['calculatePaperInventoryValuation'];
  expect(typeof fn, 'PAPER_INVENTORY_VALUATION_MISSING').toBe('function');
  return (
    fn as (v: unknown) => {
      kind: string;
      equity: string;
      validUntil: number;
      accounts: readonly { accountId: string; equity: string; snapshotAt: number }[];
      assets: readonly { asset: string; value: string }[];
    }
  )(raw);
}
it('fresh complete PAPER capture values historical seed without renewing native snapshot time', () => {
  const f = input();
  const old = valuePortfolio(
    f.inventory.accounts.map((a) => a.state),
    f.prices.slice(0, 1).map(({ accountId: omitted, ...p }) => {
      void omitted;
      return { ...p, fresh: true };
    }),
    { quote: f.quote, now: f.now, reconciledAfterRestart: true },
  );
  expect(old.complete).toBe(false);
  const r = calculate(f);
  expect(r.kind).toBe('PAPER_INVENTORY_VALUATION_CALCULATION');
  expect(r.equity).toBe('18014398509481986.000000000000000004');
  expect(r.accounts.map((a) => a.snapshotAt)).toEqual([2000, 2000]);
  expect(r.assets).toEqual([
    { asset: 'BTC', value: '0.000000000000000004' },
    { asset: 'USDT', value: '18014398509481986' },
  ]);
  expect(f.inventory.accounts[0]!.state.snapshotAt).toBe(2000);
  expect(Object.isFrozen(r)).toBe(true);
  for (const name of ['grant', 'certificate', 'reservationId', 'complete', 'riskDecision'])
    expect(r).not.toHaveProperty(name);
});
it('100 complete accounts are all valued exactly once without Number rounding', () => {
  const r = calculate(input(100));
  expect(r.accounts).toHaveLength(100);
  expect(r.equity).toBe('900719925474099300.0000000000000002');
});
it('exclusive freshness deadline includes every price and current capture', () => {
  const f = input();
  for (const p of f.prices) p.asOf -= 10;
  expect(calculate(f).validUntil).toBe(204991);
});
it('deterministic calculation survives JSON roundtrip and leaves original inventory unchanged', () => {
  const f = input(),
    before = JSON.stringify(f);
  expect(calculate(JSON.parse(before))).toEqual(calculate(f));
  expect(JSON.stringify(f)).toBe(before);
});
it('valuation currency uses identity without a fabricated quote price', () => {
  const f = input();
  const r = calculate(f);
  expect(r.assets.find((a) => a.asset === 'USDT')?.value).toBe('18014398509481986');
});
const invalid: readonly [string, (f: ReturnType<typeof input>) => unknown][] = [
  ['missing sibling price', (f) => ({ ...f, prices: f.prices.slice(0, 1) })],
  ['duplicate price', (f) => ({ ...f, prices: [...f.prices, f.prices[0]] })],
  [
    'conflicting same native price across accounts',
    (f) => ({ ...f, prices: f.prices.map((p, i) => ({ ...p, price: i ? '3' : '2' })) }),
  ],
  ['future price', (f) => ({ ...f, prices: f.prices.map((p) => ({ ...p, asOf: f.now + 1 })) })],
  ['stale price', (f) => ({ ...f, prices: f.prices.map((p) => ({ ...p, asOf: f.now - 5001 })) })],
  [
    'wrong source region',
    (f) => ({
      ...f,
      prices: f.prices.map((p) => ({ ...p, scope: { ...p.scope, region: 'other' } })),
    }),
  ],
  [
    'wrong source environment',
    (f) => ({
      ...f,
      prices: f.prices.map((p) => ({ ...p, scope: { ...p.scope, environment: 'TESTNET' } })),
    }),
  ],
  ['wrong quote', (f) => ({ ...f, prices: f.prices.map((p) => ({ ...p, quote: 'USD' })) })],
  [
    'foreign account',
    (f) => ({ ...f, prices: f.prices.map((p) => ({ ...p, accountId: uuid(99) })) }),
  ],
  ['unused price', (f) => ({ ...f, prices: [...f.prices, { ...f.prices[0], asset: 'ETH' }] })],
  [
    'invented quote price',
    (f) => ({ ...f, prices: [...f.prices, { ...f.prices[0], asset: 'USDT', price: '1' }] }),
  ],
  [
    'MARK instead of Spot LAST',
    (f) => ({ ...f, prices: f.prices.map((p) => ({ ...p, kind: 'MARK' })) }),
  ],
  ['zero price', (f) => ({ ...f, prices: f.prices.map((p) => ({ ...p, price: '0' })) })],
  ['noncanonical price', (f) => ({ ...f, prices: f.prices.map((p) => ({ ...p, price: '2.0' })) })],
  [
    'stale current inventory',
    (f) => ({
      ...f,
      now: f.now + 5001,
      prices: f.prices.map((p) => ({ ...p, asOf: f.now + 5001 })),
    }),
  ],
  ['future current inventory', (f) => ({ ...f, now: f.now - 1 })],
  [
    'subset of complete accounts',
    (f) => ({ ...f, inventory: { ...f.inventory, accounts: f.inventory.accounts.slice(0, 1) } }),
  ],
  [
    'duplicate inventory identity',
    (f) => ({
      ...f,
      inventory: {
        ...f.inventory,
        accountIds: [f.inventory.accountIds[0], f.inventory.accountIds[0]],
      },
    }),
  ],
  [
    'foreign tenant',
    (f) => ({
      ...f,
      inventory: { ...f.inventory, owner: { ...f.inventory.owner, tenantId: uuid(99) } },
    }),
  ],
  ['unsupported valuation currency', (f) => ({ ...f, quote: 'USD' })],
  ['invented certificate', (f) => ({ ...f, certificate: 'trusted' })],
  ['caller credentials', (f) => ({ ...f, credentials: { apiKey: 'not-trusted' } })],
  [
    'unknown price constraint',
    (f) => ({ ...f, prices: f.prices.map((p) => ({ ...p, maximum: '3' })) }),
  ],
  [
    'subscale product cannot silently round down',
    (f) => ({ ...f, prices: f.prices.map((p) => ({ ...p, price: '0.1' })) }),
  ],
  [
    'out-of-range price',
    (f) => ({
      ...f,
      prices: f.prices.map((p) => ({ ...p, price: '1000000000000000000000000000000' })),
    }),
  ],
];
it.each(invalid)('%s rejects the whole valuation', (_name, mutate) => {
  expect(() => calculate(mutate(input()))).toThrow(/PAPER_VALUATION_/);
});
it('changed balance cannot be adopted from a forged current state', () => {
  const f = structuredClone(input());
  f.inventory.accounts[0]!.state.balances[0]!.total = '1';
  expect(() => calculate(f)).toThrow(/PAPER_VALUATION_/);
});
it('active hold cannot be valued as a pristine funded book', () => {
  const f = structuredClone(input());
  f.inventory.accounts[0]!.state.holds.push({
    id: 'hold-1',
    asset: 'USDT',
    amount: '1',
    status: 'UNKNOWN',
    reflected: false,
  });
  expect(() => calculate(f)).toThrow(/PAPER_VALUATION_/);
});
it('aggregate arithmetic overflow fails closed without clipping a legitimate seed', () => {
  const f = structuredClone(input());
  for (const a of f.inventory.accounts) {
    a.origin.funding.funding.balances.find((b) => b.asset === 'BTC')!.amount =
      parseDecimal('99999999999999999999');
    for (const state of [a.state, a.origin.state]) {
      const b = state.balances.find((b) => b.asset === 'BTC')!;
      b.total = b.free = b.available = '99999999999999999999';
    }
  }
  for (const p of f.prices) p.price = '999999999999999999999999999999';
  expect(() => calculate(f)).toThrow('PAPER_VALUATION_ARITHMETIC');
});
