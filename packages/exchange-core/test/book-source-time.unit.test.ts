import { expect, it } from 'vitest';
import { normalizedFixtures } from './fixtures/domain.js';
import { orderBookSchema, tradeTickSchema } from '../src/domain.js';

it('represents a Spot depth snapshot without an exchange timestamp honestly', () => {
  const { book } = normalizedFixtures();
  const parsed = orderBookSchema.safeParse({ ...book, exchangeTime: null });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.exchangeTime).toBeNull();
});
it('does not relax execution/trade timestamp requirements', () => {
  const { tradeTick } = normalizedFixtures();
  expect(tradeTickSchema.safeParse({ ...tradeTick, exchangeTime: null }).success).toBe(false);
});
