import { expect, it } from 'vitest';
import { balanceSchema } from '../src/domain.js';

it('preserves a futures wallet and available balance without inventing free/locked', () => {
  const balance = {
    asset: 'USDT',
    free: null,
    locked: null,
    total: '100',
    availableToTrade: { state: 'AVAILABLE', value: '120' },
  };
  const parsed = balanceSchema.safeParse(balance);
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data).toEqual(balance);
});

it('continues to require canonical values when free/locked are provided', () => {
  const balance = {
    asset: 'USDT',
    free: '100',
    locked: '0',
    total: '100',
    availableToTrade: { state: 'AVAILABLE', value: '100' },
  };
  expect(balanceSchema.safeParse(balance).success).toBe(true);
  for (const locked of ['-1', '0.0', 0, undefined])
    expect(balanceSchema.safeParse({ ...balance, locked }).success).toBe(false);
  expect(balanceSchema.safeParse({ ...balance, free: undefined }).success).toBe(false);
});
