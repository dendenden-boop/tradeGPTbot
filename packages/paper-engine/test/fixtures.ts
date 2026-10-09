import {
  newOrderFixture,
  normalizedFixtures,
  NOW,
  recordFixture,
} from '../../exchange-core/test/fixtures/domain.js';
import { parseDecimal } from '@ctp/exchange-core';
export { NOW };
export function fixture() {
  const record = recordFixture();
  const native = normalizedFixtures();
  const model = {
    version: 'spot-l2-taker-v1',
    seed: '9007199254740993',
    takerFeeRate: '0.001',
    maxSlippageRate: '0',
    latencyMs: 100,
    latencyJitterMs: 0,
    participationRate: '0.5',
    maxEvidenceAgeMs: 5000,
  };
  const market = {
    now: NOW + 200,
    model,
    record,
    book: { ...native.book, receivedAt: NOW + 200, exchangeTime: NOW + 200 },
    trade: { ...native.tradeTick, quantity: '1', receivedAt: NOW + 200, exchangeTime: NOW + 200 },
  };
  const order = newOrderFixture(record, { limitPrice: parseDecimal('10.5') });
  const execution = {
    now: market.now,
    order,
    orderId: '33333333-3333-4333-8333-333333333333',
    submittedAt: NOW,
    executedQuantity: '0',
    triggeredAt: null,
  };
  return { ...market, execution };
}
export function marketFixture() {
  const { execution, ...market } = fixture();
  void execution;
  return market;
}
