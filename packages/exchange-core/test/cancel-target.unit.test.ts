import { expect, it } from 'vitest';
import { operations } from '../src/operations.js';
import { operationFixtures, newOrder, NOW } from './fixtures/adapter.js';

function command() {
  return {
    instrumentId: newOrder.instrumentId,
    locator: { kind: 'EXCHANGE_ID', id: '9007199254740993' },
    target: {
      internalOrderId: '10000000-0000-4000-8000-000000000009',
      placeIntentId: '10000000-0000-4000-8000-000000000010',
      revision: '9007199254740993',
      observedAt: NOW,
      nativeUpdatedAt: NOW - 86_400_000,
      current: newOrder,
      filledQuantity: '0.001',
    },
  };
}
it('accepts a frozen CANCEL target with a fresh receipt of an unchanged old native order', () => {
  expect(
    operations.cancelOrder.input.safeParse({
      authorization: operationFixtures.cancelOrder.input.authorization,
      command: command(),
    }).success,
  ).toBe(true);
});
it.each(['INSTRUMENT', 'CLIENT_ID', 'FILLED', 'FUTURE_NATIVE', 'NUMBER_REVISION'])(
  'rejects contradictory CANCEL target %s',
  (kind) => {
    const c = command();
    if (kind === 'INSTRUMENT') c.instrumentId = 'different-instrument';
    else if (kind === 'CLIENT_ID') c.locator.kind = 'CLIENT_ID';
    else if (kind === 'FILLED') c.target.filledQuantity = newOrder.size.value;
    else if (kind === 'FUTURE_NATIVE') c.target.nativeUpdatedAt = NOW + 1;
    else Object.assign(c.target, { revision: 9007199254740992 });
    expect(
      operations.cancelOrder.input.safeParse({
        authorization: operationFixtures.cancelOrder.input.authorization,
        command: c,
      }).success,
    ).toBe(false);
  },
);
