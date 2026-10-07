import { describe, expect, it } from 'vitest';
import { operations } from '../src/operations.js';
import { computeCommandHash } from '../src/adapter.js';
import { profile, account } from './fixtures/adapter.js';
import { newOrder, operationFixtures, NOW } from './fixtures/adapter.js';

describe('explicit native AMEND admission contract', () => {
  it('rejects an unclassified replacement without target revision/fill evidence', () => {
    const legacy = {
      authorization: operationFixtures.amendOrder.input.authorization,
      command: {
        locator: { instrumentId: newOrder.instrumentId, locator: { kind: 'EXCHANGE_ID', id: '9' } },
        replacement: { ...newOrder, clientOrderId: 'amend-1' },
      },
    };
    expect(operations.amendOrder.input.safeParse(legacy).success).toBe(false);
  });
  it('admits explicit in-place cumulative quantity with lossless durable revision', () => {
    const command = {
      semantics: 'IN_PLACE',
      identity: { exchangeOrderId: 'PRESERVED', clientOrderId: 'REPLACED' },
      locator: { instrumentId: newOrder.instrumentId, locator: { kind: 'EXCHANGE_ID', id: '9' } },
      target: {
        internalOrderId: '10000000-0000-4000-8000-000000000009',
        placeIntentId: '10000000-0000-4000-8000-000000000010',
        revision: '9007199254740993',
        observedAt: NOW,
        nativeUpdatedAt: NOW - 100,
        current: newOrder,
        filledQuantity: '0.001',
      },
      replacement: {
        ...newOrder,
        clientOrderId: 'amend-1',
        size: { ...newOrder.size, value: '0.009' },
      },
    };
    expect(
      operations.amendOrder.input.safeParse({
        authorization: operationFixtures.amendOrder.input.authorization,
        command,
      }).success,
    ).toBe(true);
  });
  const command = () => structuredClone(operationFixtures.amendOrder.input.command);
  it.each([
    ['cancel/replace', () => ({ ...command(), semantics: 'CANCEL_REPLACE' })],
    [
      'changing exchange ID',
      () => ({
        ...command(),
        identity: { exchangeOrderId: 'REPLACED', clientOrderId: 'REPLACED' },
      }),
    ],
    [
      'unproved target revision',
      () => ({ ...command(), target: { ...command().target, revision: '01' } }),
    ],
    [
      'JS Number revision',
      () => ({
        ...command(),
        target: { ...command().target, revision: Number('9007199254740993') },
      }),
    ],
    [
      'side change',
      () => ({ ...command(), replacement: { ...command().replacement, side: 'SELL' } }),
    ],
    [
      'instrument change',
      () => ({ ...command(), replacement: { ...command().replacement, instrumentId: 'ETHUSDT' } }),
    ],
    [
      'asset change',
      () => ({
        ...command(),
        replacement: {
          ...command().replacement,
          size: { kind: 'BASE_QUANTITY', asset: 'ETH', value: '0.009' },
        },
      }),
    ],
    [
      'reduce-only change',
      () => ({ ...command(), replacement: { ...command().replacement, reduceOnly: true } }),
    ],
    [
      'time-in-force change',
      () => ({ ...command(), replacement: { ...command().replacement, timeInForce: 'IOC' } }),
    ],
    [
      'cumulative target at filled floor',
      () => ({
        ...command(),
        replacement: {
          ...command().replacement,
          size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '0.005' },
        },
      }),
    ],
    [
      'cumulative target below filled floor',
      () => ({
        ...command(),
        replacement: {
          ...command().replacement,
          size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '0.004' },
        },
      }),
    ],
    [
      'current target already filled',
      () => ({ ...command(), target: { ...command().target, filledQuantity: '0.01' } }),
    ],
    [
      'ambiguous reused client ID',
      () => ({
        ...command(),
        replacement: {
          ...command().replacement,
          clientOrderId: command().target.current.clientOrderId,
        },
      }),
    ],
    [
      'quote budget',
      () => ({
        ...command(),
        target: {
          ...command().target,
          current: {
            ...newOrder,
            type: 'MARKET',
            limitPrice: null,
            timeInForce: null,
            size: { kind: 'QUOTE_BUDGET', value: '10', asset: 'USDT' },
          },
        },
        replacement: {
          ...newOrder,
          type: 'MARKET',
          clientOrderId: 'amend-market',
          limitPrice: null,
          timeInForce: null,
          size: { kind: 'QUOTE_BUDGET', value: '9', asset: 'USDT' },
        },
      }),
    ],
    [
      'future native clock',
      () => ({ ...command(), target: { ...command().target, nativeUpdatedAt: NOW + 1 } }),
    ],
  ])('rejects %s', (_name, candidate) => {
    expect(
      operations.amendOrder.input.shape.command.safeParse((candidate as () => unknown)()).success,
    ).toBe(false);
  });
  it('binds durable target revision, place identity and fill evidence into permanent command hash', () => {
    const c = command();
    const hash = (v: unknown) => computeCommandHash('amendOrder', v, { profile, account });
    const original = hash(c);
    for (const target of [
      { ...c.target, revision: '9007199254740993' },
      { ...c.target, placeIntentId: '10000000-0000-4000-8000-000000000099' },
      { ...c.target, filledQuantity: '0.006' },
    ])
      expect(hash({ ...c, target })).not.toBe(original);
    expect(hash(structuredClone(c))).toBe(original);
    expect(c.target.current).toEqual(newOrder);
  });
});
