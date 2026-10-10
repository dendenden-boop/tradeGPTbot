import { expect, it } from 'vitest';
import { paperFundingSchema } from '../src/funding-domain.js';

const request = () => ({
  id: '44444444-4444-4444-8444-444444444444',
  configurationId: '33333333-3333-4333-8333-333333333333',
  owner: {
    tenantId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    mode: 'PAPER',
  },
  balances: [
    { asset: 'BTC', amount: '0.000000000000000001' },
    { asset: 'USDT', amount: '9007199254740993' },
  ],
});
it('keeps exact multi-asset seed amounts without number conversion or FX guessing', () => {
  expect(paperFundingSchema.parse(request())).toEqual(request());
});
it.each([
  '0',
  '-1',
  '1.0',
  '01',
  '1e3',
  '1\n',
  '100000000000000000000',
  '0.0000000000000000001',
  10,
])('rejects nonpositive/noncanonical/out-of-range amount %#', (amount) => {
  expect(
    paperFundingSchema.safeParse({ ...request(), balances: [{ asset: 'USDT', amount }] }).success,
  ).toBe(false);
});
it.each(['LIVE', 'TESTNET', 'DEMO', null])('refuses native owner %s', (mode) => {
  const r = request();
  expect(paperFundingSchema.safeParse({ ...r, owner: { ...r.owner, mode } }).success).toBe(false);
});
it.each([
  'resetEpoch',
  'initialCapital',
  'credentials',
  'grant',
  'connectionId',
  'url',
  'tenantId',
])('refuses extra authority %s', (key) => {
  expect(paperFundingSchema.safeParse({ ...request(), [key]: 'untrusted' }).success).toBe(false);
});
it.each(
  [
    [],
    [
      { asset: 'USDT', amount: '1' },
      { asset: 'BTC', amount: '1' },
    ],
    [
      { asset: 'USDT', amount: '1' },
      { asset: 'USDT', amount: '1' },
    ],
    [{ asset: 'usdt', amount: '1' }],
    [{ asset: 'USDT\n', amount: '1' }],
    [{ asset: 'A'.repeat(33), amount: '1' }],
    [{ asset: 'USDT', amount: '1', bucket: 'EQUITY' }],
    Array.from({ length: 33 }, (_, n) => ({
      asset: `A${String(n).padStart(2, '0')}`,
      amount: '1',
    })),
  ].map((balances) => ({ balances })),
)('rejects ambiguous/unknown/unbounded asset inventory %#', ({ balances }) => {
  expect(paperFundingSchema.safeParse({ ...request(), balances }).success).toBe(false);
});
