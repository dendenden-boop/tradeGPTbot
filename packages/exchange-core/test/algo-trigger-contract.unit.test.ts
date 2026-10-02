import { createHash } from 'node:crypto';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { computeCommandHash, createExchangeAdapter } from '../src/adapter.js';
import type { AdapterTransport, ExchangeAdapter, RequestContext } from '../src/adapter.js';
import { algoChildOrderSchema, newAlgoOrderSchema, newOrderSchema } from '../src/domain.js';
import type { AlgoChildOrder, NewAlgoOrder } from '../src/domain.js';
import { operations } from '../src/operations.js';
import type { OperationInput } from '../src/operations.js';
import { createInstrumentRegistry } from '../src/registry.js';
import {
  NOW,
  account,
  capabilities,
  instrument,
  newOrder,
  operationFixtures,
  profile,
  rules,
} from './fixtures/adapter.js';

const adapters: ExchangeAdapter[] = [];
const outerTrigger = { source: 'LAST', price: '30010' } as const;
const innerTrigger = { source: 'MARK', price: '30020' } as const;
const rejected = { kind: 'DEFINITIVELY_REJECTED', error: { code: 'INVALID_REQUEST' } };

function child(type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT') {
  const limit = type === 'LIMIT' || type === 'STOP_LIMIT';
  return {
    ...newOrder,
    type,
    limitPrice: limit ? newOrder.limitPrice : null,
    timeInForce: limit ? newOrder.timeInForce : null,
    trigger: type.startsWith('STOP_') ? innerTrigger : null,
  };
}

// Reproduce a previously valid external permit without relying on the input validator.
// This ensures rejection occurs before the authorizer and transport, even for a valid hash.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

function request(command: unknown) {
  return {
    command,
    authorization: {
      ...operationFixtures.createAlgoOrder.input.authorization,
      commandHash: createHash('sha256')
        .update(canonical({ operation: 'createAlgoOrder', command, profile, account }))
        .digest('hex'),
    },
  };
}

function setup() {
  const registry = createInstrumentRegistry({ capacity: 4 });
  expect(registry.put({ instrument, rules }, NOW).ok).toBe(true);
  const authorize = vi.fn(() => Promise.resolve(true));
  const transportRequest = vi.fn<AdapterTransport['request']>(() =>
    Promise.resolve(structuredClone(operationFixtures.createAlgoOrder.output)),
  );
  const adapter = createExchangeAdapter({
    profile,
    account,
    capabilities,
    adapterVersion: 'v1',
    registry,
    transport: {
      request: transportRequest,
      subscribe: () => Promise.resolve(() => Promise.resolve()),
      disconnect: () => Promise.resolve(),
    },
    authorization: { authorize },
    now: () => NOW,
  });
  adapters.push(adapter);
  const context: RequestContext = {
    profile,
    account,
    deadline: NOW + 10_000,
    signal: new AbortController().signal,
    correlationId: 'algo-trigger-contract',
  };
  return { adapter, authorize, transportRequest, context };
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.disconnect()));
});

describe('createAlgoOrder has one outer trigger and an immediate child', () => {
  it('narrows the shared command and adapter input types to an immediate child', () => {
    expectTypeOf<AlgoChildOrder['type']>().toEqualTypeOf<'MARKET' | 'LIMIT'>();
    expectTypeOf<AlgoChildOrder['trigger']>().toEqualTypeOf<null>();
    expectTypeOf<NewAlgoOrder['order']>().toEqualTypeOf<AlgoChildOrder>();
    expectTypeOf<OperationInput<'createAlgoOrder'>['command']>().toEqualTypeOf<NewAlgoOrder>();
    expect(algoChildOrderSchema.parse(child('LIMIT')).type).toBe('LIMIT');
    expect(newAlgoOrderSchema.parse(operationFixtures.createAlgoOrder.input.command)).toEqual(
      operationFixtures.createAlgoOrder.input.command,
    );
  });

  it.each(['STOP_MARKET', 'STOP_LIMIT'] as const)(
    'rejects %s at the shared algo command schema',
    (type) => {
      const command = { order: child(type), clientAlgoId: 'client-algo-1', trigger: outerTrigger };
      expect(operations.createAlgoOrder.input.safeParse(request(command)).success).toBe(false);
    },
  );

  it.each(['STOP_MARKET', 'STOP_LIMIT'] as const)(
    'retains standalone %s but rejects it as an algo child before authorization or dispatch',
    async (type) => {
      const order = child(type);
      const command = { order, clientAlgoId: 'client-algo-1', trigger: outerTrigger };
      const input = request(command);
      const env = setup();
      expect(newOrderSchema.safeParse(order).success).toBe(true);
      await expect(
        env.adapter.createAlgoOrder(input as OperationInput<'createAlgoOrder'>, env.context),
      ).resolves.toEqual(rejected);
      expect(env.authorize).not.toHaveBeenCalled();
      expect(env.transportRequest).not.toHaveBeenCalled();
    },
  );

  it.each(['STOP_MARKET', 'STOP_LIMIT'] as const)(
    'refuses a command hash for an ambiguous %s child',
    (type) => {
      const command = {
        order: child(type),
        clientAlgoId: 'client-algo-1',
        trigger: outerTrigger,
      };
      expect(() => computeCommandHash('createAlgoOrder', command, { profile, account })).toThrow(
        'INVALID_COMMAND_HASH_INPUT',
      );
    },
  );

  it.each(['MARKET', 'LIMIT'] as const)(
    'rejects a trigger on an immediate %s child before authorization or dispatch',
    async (type) => {
      const command = {
        order: { ...child(type), trigger: innerTrigger },
        clientAlgoId: 'client-algo-1',
        trigger: outerTrigger,
      };
      const input = request(command);
      const env = setup();
      expect(operations.createAlgoOrder.input.safeParse(input).success).toBe(false);
      expect(() => computeCommandHash('createAlgoOrder', command, { profile, account })).toThrow(
        'INVALID_COMMAND_HASH_INPUT',
      );
      await expect(
        env.adapter.createAlgoOrder(input as OperationInput<'createAlgoOrder'>, env.context),
      ).resolves.toEqual(rejected);
      expect(env.authorize).not.toHaveBeenCalled();
      expect(env.transportRequest).not.toHaveBeenCalled();
    },
  );

  for (const type of ['MARKET', 'LIMIT'] as const) {
    it.each(['LAST', 'MARK', 'INDEX'] as const)(
      `accepts one %s outer trigger for ${type} and preserves its command hash`,
      async (source) => {
        const command = {
          order: child(type),
          clientAlgoId: 'client-algo-1',
          trigger: { ...outerTrigger, source },
        };
        const input = request(command);
        const env = setup();
        const parsed = operations.createAlgoOrder.input.parse(input);
        expect(parsed.command).toEqual(command);
        expect(computeCommandHash('createAlgoOrder', command, { profile, account })).toBe(
          input.authorization.commandHash,
        );
        await expect(env.adapter.createAlgoOrder(parsed, env.context)).resolves.toEqual(
          operationFixtures.createAlgoOrder.output,
        );
        expect(env.authorize).toHaveBeenCalledOnce();
        expect(env.transportRequest).toHaveBeenCalledOnce();
        expect(env.transportRequest.mock.calls[0]?.[1]).toEqual(input);
      },
    );
  }

  it.each([
    { ...child('LIMIT'), limitPrice: null },
    { ...child('LIMIT'), timeInForce: null },
    { ...child('MARKET'), limitPrice: '30000.05' },
    { ...child('MARKET'), timeInForce: 'GTC' },
    { ...child('LIMIT'), size: { kind: 'QUOTE_BUDGET', value: '100', asset: 'USDT' } },
    {
      ...child('MARKET'),
      side: 'SELL',
      size: { kind: 'QUOTE_BUDGET', value: '100', asset: 'USDT' },
    },
    { ...child('LIMIT'), unrecognized: true },
  ])('retains the child order consistency and strict object checks (%#)', (order) => {
    const command = { order, clientAlgoId: 'client-algo-1', trigger: outerTrigger };
    expect(operations.createAlgoOrder.input.safeParse(request(command)).success).toBe(false);
  });
});
