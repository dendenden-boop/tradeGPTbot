import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeCommandHash, createExchangeAdapter } from '../src/adapter.js';
import type {
  AdapterTransport,
  ExchangeAdapter,
  ExchangeAdapterOptions,
  RequestContext,
} from '../src/adapter.js';
import type { Result } from '../src/errors.js';
import { operations } from '../src/operations.js';
import type {
  MutationOperation,
  Operation,
  OperationInput,
  StreamOperation,
} from '../src/operations.js';
import { createInstrumentRegistry } from '../src/registry.js';
import type { Feature } from '../src/scope.js';
import type { Subscription } from '../src/subscription.js';
import {
  NOW,
  account,
  capabilities,
  instrument,
  newOrder,
  operationFixtures,
  profile,
  rules,
  ticker,
} from './fixtures/adapter.js';

const adapters: ExchangeAdapter[] = [];
const names = Object.keys(operations) as Operation[];
const mutations = names.filter(
  (name): name is MutationOperation =>
    operations[name].kind === 'MUTATION' || operations[name].kind === 'BATCH',
);

function signed<K extends MutationOperation>(
  operation: K,
  raw: unknown = operationFixtures[operation].input,
): OperationInput<K> {
  const value = operations[operation].input.parse(raw);
  const sign = (entry: {
    authorization: typeof operationFixtures.createOrder.input.authorization;
    command: unknown;
  }) => ({
    ...entry,
    authorization: {
      ...entry.authorization,
      commandHash: computeCommandHash(operation, entry.command, {
        profile: entry.authorization.profile,
        account: entry.authorization.account,
      }),
    },
  });
  return (
    'commands' in value ? { commands: value.commands.map(sign) } : sign(value)
  ) as OperationInput<K>;
}

function fixtureInput<K extends Operation>(operation: K): OperationInput<K> {
  return (
    mutations.includes(operation as MutationOperation)
      ? signed(operation as MutationOperation)
      : operationFixtures[operation].input
  ) as OperationInput<K>;
}

function setup(options: Partial<ExchangeAdapterOptions> = {}, authorizeByDefault = true) {
  const registry = createInstrumentRegistry({ capacity: 20 });
  expect(registry.put({ instrument, rules }, NOW).ok).toBe(true);
  const clock = { value: NOW };
  const sourceClose = vi.fn(() => Promise.resolve());
  const sinks = new Map<StreamOperation, { event: (value: unknown) => void; gap: () => void }>();
  const request = vi.fn<AdapterTransport['request']>((operation) =>
    Promise.resolve(structuredClone(operationFixtures[operation].output)),
  );
  const subscribe = vi.fn<AdapterTransport['subscribe']>(
    (operation, _request, _context, event, gap) => {
      sinks.set(operation, { event, gap });
      return Promise.resolve(sourceClose);
    },
  );
  const transportDisconnect = vi.fn(() => Promise.resolve());
  const authorize = vi.fn(() => Promise.resolve(true));
  const adapter = createExchangeAdapter({
    profile,
    account,
    capabilities,
    adapterVersion: 'v1',
    registry,
    transport: { request, subscribe, disconnect: transportDisconnect },
    now: () => clock.value,
    ...(authorizeByDefault ? { authorization: { authorize } } : {}),
    ...options,
  });
  adapters.push(adapter);
  const context = (overrides: Partial<RequestContext> = {}): RequestContext => ({
    profile: adapter.profile,
    account: adapter.account,
    deadline: NOW + 10_000,
    signal: new AbortController().signal,
    correlationId: 'test-request-1',
    ...overrides,
  });
  return {
    adapter,
    context,
    clock,
    request,
    subscribe,
    sourceClose,
    sinks,
    authorize,
    registry,
    transportDisconnect,
  };
}

function invoke(
  adapter: ExchangeAdapter,
  operation: Operation,
  input: unknown,
  context: RequestContext,
): Promise<unknown> {
  // Deliberately exercise every named method, including runtime-invalid input.
  const method = adapter[operation] as (
    input: unknown,
    context: RequestContext,
  ) => Promise<unknown>;
  return method(input, context);
}
function localFailure(operation: Operation, code: string): unknown {
  if (operation === 'cancelAllOrders') return { kind: 'NOT_SENT', error: { code } };
  if (mutations.includes(operation as MutationOperation))
    return { kind: 'DEFINITIVELY_REJECTED', error: { code } };
  return { ok: false, error: { code } };
}
function unknownOutcome(operation: MutationOperation): unknown {
  const outcome = { kind: 'UNKNOWN', error: { code: 'UNKNOWN_OUTCOME' } };
  return operation === 'cancelAllOrders'
    ? {
        kind: 'RESULTS',
        outcomes: operationFixtures.cancelAllOrders.input.commands.map((entry) => ({
          commandId: entry.authorization.commandId,
          outcome,
        })),
      }
    : outcome;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
async function stream(
  value: Promise<Result<Subscription<unknown>>>,
): Promise<Subscription<unknown>> {
  const result = await value;
  if (!result.ok) throw new Error(`STREAM_NOT_STARTED_${result.error.code}`);
  return result.value;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.disconnect()));
  vi.useRealTimers();
});

describe('stream current metadata boundary', () => {
  it.each(['metadata', 'rules'] as const)(
    'resyncs after %s replacement while subscribed',
    async (kind) => {
      const env = setup();
      const subscription = await stream(
        env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
      );
      expect(
        env.registry.put(
          {
            instrument: {
              ...instrument,
              metadataVersion: kind === 'metadata' ? 'v2' : instrument.metadataVersion,
            },
            rules: { ...rules, version: kind === 'rules' ? 'v2' : rules.version },
          },
          NOW,
        ).ok,
      ).toBe(true);
      env.sinks.get('subscribeTicker')!.event(ticker);
      expect(await subscription[Symbol.asyncIterator]().next()).toMatchObject({
        value: { kind: 'RESYNC_REQUIRED' },
      });
      expect(env.sourceClose).toHaveBeenCalledTimes(1);
    },
  );
  it('resyncs on metadata expiry earlier than capability/request expiry', async () => {
    const env = setup();
    expect(
      env.registry.put(
        {
          instrument: { ...instrument, metadataVersion: 'v2' },
          rules: { ...rules, version: 'v2', expiresAt: NOW + 100 },
        },
        NOW,
      ).ok,
    ).toBe(true);
    const subscription = await stream(
      env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
    );
    env.clock.value = NOW + 100;
    env.sinks.get('subscribeTicker')!.event(ticker);
    expect(await subscription[Symbol.asyncIterator]().next()).toMatchObject({
      value: { kind: 'RESYNC_REQUIRED' },
    });
  });
  it('resyncs if registry read authority is unavailable after stream opening', async () => {
    const reference = createInstrumentRegistry({ capacity: 1 });
    reference.put({ instrument, rules }, NOW);
    let available = true;
    const env = setup({
      registry: {
        get: (scope, id, now) =>
          available ? reference.get(scope, id, now) : { ok: false, error: { code: 'UNAVAILABLE' } },
      },
    });
    const subscription = await stream(
      env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
    );
    available = false;
    env.sinks.get('subscribeTicker')!.event(ticker);
    expect(await subscription[Symbol.asyncIterator]().next()).toMatchObject({
      value: { kind: 'RESYNC_REQUIRED' },
    });
  });
});

describe('every ExchangeAdapter named method', () => {
  it.each(names)('%s validates and returns its own typed contract', async (operation) => {
    const env = setup();
    const result = await invoke(env.adapter, operation, fixtureInput(operation), env.context());
    if (operations[operation].kind === 'STREAM') {
      const subscriptionResult = result as Result<Subscription<unknown>>;
      expect(subscriptionResult.ok).toBe(true);
      if (!subscriptionResult.ok) return;
      const subscription = subscriptionResult.value;
      const iterator = subscription[Symbol.asyncIterator]();
      env.sinks.get(operation as StreamOperation)?.event(operationFixtures[operation].output);
      expect(await iterator.next()).toEqual({
        done: false,
        value: { kind: 'DATA', data: operationFixtures[operation].output },
      });
      await subscription.unsubscribe();
      expect(env.sourceClose).toHaveBeenCalledTimes(1);
    } else if (mutations.includes(operation as MutationOperation)) {
      expect(result).toEqual(operationFixtures[operation].output);
      expect(env.authorize).toHaveBeenCalledTimes(1);
      expect(env.request).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toEqual({ ok: true, value: operationFixtures[operation].output });
      expect(env.request).toHaveBeenCalledTimes(1);
    }
  });

  it.each(names)(
    '%s rejects expanded input before authorization and transport',
    async (operation) => {
      const env = setup();
      const input = {
        ...fixtureInput(operation),
        endpointUrl: 'https://unexpected.invalid',
        apiKey: 'never-send',
      };
      expect(await invoke(env.adapter, operation, input, env.context())).toEqual(
        localFailure(operation, 'INVALID_REQUEST'),
      );
      expect(env.request).not.toHaveBeenCalled();
      expect(env.subscribe).not.toHaveBeenCalled();
      expect(env.authorize).not.toHaveBeenCalled();
    },
  );

  it.each(names)('%s rejects cross-tenant context before transport', async (operation) => {
    const env = setup();
    expect(
      await invoke(
        env.adapter,
        operation,
        fixtureInput(operation),
        env.context({ account: { ...account, tenantId: '10000000-0000-4000-8000-000000000002' } }),
      ),
    ).toEqual(localFailure(operation, 'SCOPE_MISMATCH'));
    expect(env.request).not.toHaveBeenCalled();
    expect(env.subscribe).not.toHaveBeenCalled();
  });

  it.each(names)(
    '%s treats malformed producer output according to dispatch certainty',
    async (operation) => {
      const env = setup();
      env.request.mockResolvedValue({ token: 'secret-do-not-expose' });
      const result = await invoke(env.adapter, operation, fixtureInput(operation), env.context());
      if (operations[operation].kind === 'STREAM') {
        const subscriptionResult = result as Result<Subscription<unknown>>;
        if (!subscriptionResult.ok) throw new Error('Expected stream');
        env.sinks.get(operation as StreamOperation)?.event({ token: 'secret-do-not-expose' });
        expect(await subscriptionResult.value[Symbol.asyncIterator]().next()).toEqual({
          done: false,
          value: { kind: 'RESYNC_REQUIRED', reason: 'MALFORMED' },
        });
        expect(env.sourceClose).toHaveBeenCalledTimes(1);
      } else if (mutations.includes(operation as MutationOperation)) {
        expect(result).toEqual(unknownOutcome(operation as MutationOperation));
      } else expect(result).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE' } });
      expect(JSON.stringify(result)).not.toContain('secret-do-not-expose');
    },
  );
});

describe('authorization and capability boundaries', () => {
  it.each(['unknown', 'constructor', '__proto__'])(
    'rejects invalid operation names safely: %s',
    async (operation) => {
      const env = setup();
      expect(await env.adapter.execute(operation as Operation, {}, env.context())).toEqual({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
      expect(env.request).not.toHaveBeenCalled();
    },
  );
  it('exposes immutable independent configuration and denies mutations without the durable authorization port', async () => {
    const rawCapabilities = structuredClone(capabilities);
    const env = setup({ capabilities: rawCapabilities }, false);
    expect(Object.isFrozen(env.adapter)).toBe(true);
    expect(Object.isFrozen(env.adapter.profile)).toBe(true);
    expect(Object.isFrozen(env.adapter.account)).toBe(true);
    expect(Object.isFrozen(env.adapter.capabilities)).toBe(true);
    rawCapabilities.length = 0;
    expect(env.adapter.capabilities.length).toBe(capabilities.length);
    expect(await env.adapter.createOrder(signed('createOrder'), env.context())).toEqual(
      localFailure('createOrder', 'AUTHORIZATION_REQUIRED'),
    );
    expect(env.request).not.toHaveBeenCalled();
  });

  it.each(mutations)('%s is locally disabled for LIVE', async (operation) => {
    const env = setup({ profile: { ...profile, environment: 'LIVE' } });
    expect(await invoke(env.adapter, operation, fixtureInput(operation), env.context())).toEqual(
      localFailure(operation, 'LIVE_DISABLED'),
    );
    expect(env.request).not.toHaveBeenCalled();
    expect(env.authorize).not.toHaveBeenCalled();
  });

  it('binds the canonical validated command to operation, profile and account', async () => {
    const env = setup();
    const command = fixtureInput('createOrder');
    expect(
      computeCommandHash(
        'createOrder',
        { ...newOrder, size: { ...newOrder.size } },
        { account, profile },
      ),
    ).toBe(command.authorization.commandHash);
    expect(
      computeCommandHash('createOrder', newOrder, {
        profile: { ...profile, region: 'EU' },
        account,
      }),
    ).not.toBe(command.authorization.commandHash);
    expect(
      computeCommandHash('createOrder', newOrder, {
        profile,
        account: { ...account, externalAccountId: 'another-account' },
      }),
    ).not.toBe(command.authorization.commandHash);
    expect(() =>
      computeCommandHash(
        'createOrder',
        { ...newOrder, price: 'ignored-extra' },
        { profile, account },
      ),
    ).toThrow('INVALID_COMMAND_HASH_INPUT');
    expect(
      await env.adapter.createOrder(
        {
          ...command,
          command: { ...command.command, clientOrderId: 'changed-after-authorization' },
        },
        env.context(),
      ),
    ).toEqual(localFailure('createOrder', 'AUTHORIZATION_REQUIRED'));
    expect(env.request).not.toHaveBeenCalled();
  });

  it.each([
    { issuedAt: NOW + 1, expiresAt: NOW + 5000 },
    { issuedAt: NOW - 5000, expiresAt: NOW },
  ])('requires a currently valid permit %j', async (window) => {
    const env = setup();
    const input = signed('createOrder');
    expect(
      await env.adapter.createOrder(
        { ...input, authorization: { ...input.authorization, ...window } },
        env.context(),
      ),
    ).toEqual(localFailure('createOrder', 'AUTHORIZATION_REQUIRED'));
    expect(env.request).not.toHaveBeenCalled();
  });

  it.each([
    [{ support: 'UNSUPPORTED' }, 'UNSUPPORTED'],
    [{ support: 'UNVERIFIED' }, 'UNVERIFIED'],
    [{ expiresAt: NOW }, 'STALE_CAPABILITY'],
    [{ adapterVersion: 'v2' }, 'STALE_CAPABILITY'],
    [{ profile: { ...profile, environment: 'DEMO' } }, 'UNVERIFIED'],
    [{ constraints: { instrumentIds: ['ETHUSDT'] } }, 'UNSUPPORTED'],
    [{ constraints: { timeframes: ['1m'] } }, 'UNSUPPORTED'],
    [{ implementation: 'SYNTHETIC' }, 'UNSUPPORTED'],
  ])('checks explicit capability evidence before dispatch: %j', async (change, code) => {
    const env = setup({
      capabilities: capabilities.map((record) =>
        record.feature === 'PUBLIC_READ' ? { ...record, ...change } : record,
      ),
    });
    expect(await env.adapter.getTicker(operationFixtures.getTicker.input, env.context())).toEqual({
      ok: false,
      error: { code },
    });
    expect(env.request).not.toHaveBeenCalled();
  });

  it('does not infer unknown capabilities or pick an optimistic duplicate', async () => {
    for (const records of [
      [],
      [...capabilities, ...capabilities.filter((record) => record.feature === 'PUBLIC_READ')],
    ]) {
      const env = setup({ capabilities: records });
      expect(await env.adapter.getTicker(operationFixtures.getTicker.input, env.context())).toEqual(
        { ok: false, error: { code: 'UNVERIFIED' } },
      );
      expect(env.request).not.toHaveBeenCalled();
    }
  });

  it('selects LIMIT_ORDER independently from MARKET_ORDER and requires client-ID lookup evidence', async () => {
    const env = setup({
      capabilities: capabilities.filter(
        (record) =>
          !(['MARKET_ORDER', 'ORDER_LOOKUP_BY_CLIENT_ID'] as Feature[]).includes(record.feature),
      ),
    });
    expect(await env.adapter.createOrder(signed('createOrder'), env.context())).toEqual(
      operationFixtures.createOrder.output,
    );
    expect(
      await env.adapter.getOrder(
        { instrumentId: instrument.id, locator: { kind: 'CLIENT_ID', id: 'client-order-1' } },
        env.context(),
      ),
    ).toEqual({ ok: false, error: { code: 'UNVERIFIED' } });
    expect(env.request).toHaveBeenCalledTimes(1);
  });

  it.each(['CANCEL_ORDER', 'CANCEL_ALL_ORDERS', 'AMEND_ORDER', 'ALGO_ORDERS'] as const)(
    'requires the dedicated %s evidence',
    async (feature) => {
      const operation = (
        {
          CANCEL_ORDER: 'cancelOrder',
          CANCEL_ALL_ORDERS: 'cancelAllOrders',
          AMEND_ORDER: 'amendOrder',
          ALGO_ORDERS: 'createAlgoOrder',
        } as const
      )[feature];
      const env = setup({
        capabilities: capabilities.filter((record) => record.feature !== feature),
      });
      expect(await invoke(env.adapter, operation, fixtureInput(operation), env.context())).toEqual(
        localFailure(operation, 'UNVERIFIED'),
      );
      expect(env.request).not.toHaveBeenCalled();
    },
  );

  it('requires quote-budget and trigger features for their actual command semantics', async () => {
    const base = operationFixtures.createOrder.input;
    for (const [feature, command] of [
      [
        'QUOTE_BUDGET_MARKET_BUY',
        {
          ...newOrder,
          type: 'MARKET',
          size: { kind: 'QUOTE_BUDGET', value: '100', asset: 'USDT' },
          limitPrice: null,
          timeInForce: null,
        },
      ],
      [
        'TRIGGER_ORDER',
        { ...newOrder, type: 'STOP_LIMIT', trigger: { source: 'LAST', price: '30000.05' } },
      ],
      [
        'STOP_LIMIT_ORDER',
        { ...newOrder, type: 'STOP_LIMIT', trigger: { source: 'LAST', price: '30000.05' } },
      ],
      ['REDUCE_ONLY', { ...newOrder, reduceOnly: true }],
    ] as const) {
      const env = setup({
        capabilities: capabilities.filter((record) => record.feature !== feature),
      });
      const input = signed('createOrder', { ...base, command });
      expect(await env.adapter.createOrder(input, env.context())).toEqual(
        localFailure('createOrder', 'UNVERIFIED'),
      );
      expect(env.request).not.toHaveBeenCalled();
    }
  });

  it.each(['capability', 'metadata', 'permit', 'deadline'] as const)(
    'rechecks %s after async authorization before dispatch',
    async (boundary) => {
      const shortExpiry = NOW + 5;
      const env = setup({
        capabilities:
          boundary === 'capability'
            ? capabilities.map((record) => ({ ...record, expiresAt: shortExpiry }))
            : capabilities,
      });
      if (boundary === 'metadata')
        expect(
          env.registry.put(
            {
              instrument,
              rules: { ...rules, version: 'v2', effectiveAt: NOW, expiresAt: shortExpiry },
            },
            NOW,
          ).ok,
        ).toBe(true);
      const raw = operationFixtures.createOrder.input;
      const input = signed('createOrder', {
        ...raw,
        authorization: {
          ...raw.authorization,
          ...(boundary === 'permit' ? { expiresAt: shortExpiry } : {}),
        },
        command: { ...raw.command, ...(boundary === 'metadata' ? { ruleVersion: 'v2' } : {}) },
      });
      env.authorize.mockImplementation(() => {
        env.clock.value = shortExpiry;
        return Promise.resolve(true);
      });
      const result = await env.adapter.createOrder(
        input,
        env.context({ deadline: boundary === 'deadline' ? shortExpiry : NOW + 10_000 }),
      );
      const code = {
        capability: 'STALE_CAPABILITY',
        metadata: 'STALE_METADATA',
        permit: 'AUTHORIZATION_REQUIRED',
        deadline: 'DEADLINE_EXCEEDED',
      }[boundary];
      expect(result).toEqual(localFailure('createOrder', code));
      expect(env.authorize).toHaveBeenCalledTimes(1);
      expect(env.request).not.toHaveBeenCalled();
    },
  );

  it('validates instrument rules for placement and replacement before authorization', async () => {
    const env = setup();
    for (const operation of ['createOrder', 'amendOrder'] as const) {
      const raw = operationFixtures[operation].input;
      const badOrder = {
        ...newOrder,
        size: { kind: 'BASE_QUANTITY', value: '0.0001', asset: 'BTC' },
      };
      const command =
        operation === 'createOrder'
          ? badOrder
          : {
              ...operationFixtures.amendOrder.input.command,
              target: { ...operationFixtures.amendOrder.input.command.target, filledQuantity: '0' },
              replacement: { ...badOrder, clientOrderId: 'client-amend-bad-rules' },
            };
      expect(
        await invoke(env.adapter, operation, signed(operation, { ...raw, command }), env.context()),
      ).toEqual(localFailure(operation, 'INVALID_REQUEST'));
    }
    expect(env.request).not.toHaveBeenCalled();
    expect(env.authorize).not.toHaveBeenCalled();
  });
  it.each(['STALE', 'FUTURE'] as const)(
    'blocks %s AMEND target observation before authorization',
    async (kind) => {
      const env = setup(),
        raw = operationFixtures.amendOrder.input;
      const at = kind === 'STALE' ? NOW - 5001 : NOW + 1;
      const input = signed('amendOrder', {
        ...raw,
        command: {
          ...raw.command,
          target: { ...raw.command.target, observedAt: at, nativeUpdatedAt: at - 1 },
        },
      });
      expect(await env.adapter.amendOrder(input, env.context())).toEqual(
        localFailure('amendOrder', 'STALE_METADATA'),
      );
      expect(env.authorize).not.toHaveBeenCalled();
      expect(env.request).not.toHaveBeenCalled();
    },
  );

  it.each(['30000.03', '1000000.05'])(
    'validates the independent algo trigger against instrument price rules: %s',
    async (price) => {
      const env = setup();
      const raw = operationFixtures.createAlgoOrder.input;
      const input = signed('createAlgoOrder', {
        ...raw,
        command: { ...raw.command, trigger: { ...raw.command.trigger, price } },
      });
      expect(await env.adapter.createAlgoOrder(input, env.context())).toEqual(
        localFailure('createAlgoOrder', 'INVALID_REQUEST'),
      );
      expect(env.request).not.toHaveBeenCalled();
    },
  );
});

describe('response identity, pages and cursors', () => {
  it.each([
    ['getHistoricalCandles', 'openTime'],
    ['getTrades', 'exchangeTime'],
    ['getOrderHistory', 'createdAt'],
    ['getAlgoHistory', 'updatedAt'],
  ] as const)(
    'filters %s by %s in the half-open requested history window',
    async (operation, field) => {
      const env = setup();
      const original = operationFixtures[operation];
      const first = original.output.items[0];
      if (!first) throw new Error('Missing history fixture');
      const timestamp = (first as unknown as Record<string, number>)[field];
      if (timestamp === undefined) throw new Error('Missing history timestamp');
      env.request.mockResolvedValue(original.output);
      expect(
        await invoke(
          env.adapter,
          operation,
          { ...original.input, from: timestamp, to: timestamp + 1 },
          env.context(),
        ),
      ).toMatchObject({ ok: true });
      expect(
        await invoke(
          env.adapter,
          operation,
          { ...original.input, from: timestamp - 1, to: timestamp },
          env.context(),
        ),
      ).toEqual({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
      expect(
        await invoke(
          env.adapter,
          operation,
          { ...original.input, from: timestamp + 1, to: timestamp + 2 },
          env.context(),
        ),
      ).toEqual({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    },
  );

  it.each(['CANCELED', 'REJECTED', 'EXPIRED', 'UNKNOWN'] as const)(
    'does not expose %s orders as known open orders',
    async (status) => {
      const env = setup();
      const output = operationFixtures.getOpenOrders.output;
      const first = output.items[0];
      if (!first) throw new Error('Missing order');
      env.request.mockResolvedValue({ ...output, items: [{ ...first, status }] });
      expect(
        await env.adapter.getOpenOrders(operationFixtures.getOpenOrders.input, env.context()),
      ).toEqual({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    },
  );
  it.each([
    { ...ticker, scope: { ...ticker.scope, environment: 'LIVE' } },
    { ...ticker, instrumentId: 'ETHUSDT' },
  ])('rejects a valid DTO from a different market scope or instrument', async (output) => {
    const env = setup();
    env.request.mockResolvedValue(output);
    expect(await env.adapter.getTicker(operationFixtures.getTicker.input, env.context())).toEqual({
      ok: false,
      error: { code: 'SCOPE_MISMATCH' },
    });
  });

  it('binds nested accounts, timeframe, queryId and page size', async () => {
    const env = setup();
    const orders = operationFixtures.getOpenOrders.output;
    const first = orders.items[0];
    if (!first) throw new Error('Missing fixture');
    env.request.mockResolvedValue({
      ...orders,
      items: [{ ...first, account: { ...account, externalAccountId: 'someone-else' } }],
    });
    expect(
      await env.adapter.getOpenOrders(operationFixtures.getOpenOrders.input, env.context()),
    ).toEqual({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    env.request.mockResolvedValue({ ...orders, queryId: 'other-query' });
    expect(
      await env.adapter.getOpenOrders(operationFixtures.getOpenOrders.input, env.context()),
    ).toEqual({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    env.request.mockResolvedValue({ ...orders, items: [first, first] });
    expect(
      await env.adapter.getOpenOrders(
        { ...operationFixtures.getOpenOrders.input, limit: 1 },
        env.context(),
      ),
    ).toEqual({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    env.request.mockResolvedValue(operationFixtures.getHistoricalCandles.output);
    expect(
      await env.adapter.getHistoricalCandles(
        { ...operationFixtures.getHistoricalCandles.input, timeframe: '5m' },
        env.context(),
      ),
    ).toEqual({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
  });

  it('encodes raw page cursors and accepts them only for the same adapter and exact filters', async () => {
    const env = setup();
    const input = operationFixtures.getSymbols.input;
    env.request.mockResolvedValue({
      ...operationFixtures.getSymbols.output,
      nextCursor: 'producer-cursor-1',
    });
    const first = await env.adapter.getSymbols(input, env.context());
    if (!first.ok || !first.value.nextCursor) throw new Error('Missing encoded cursor');
    const cursor = first.value.nextCursor;
    expect(operations.getSymbols.output.safeParse(first.value).success).toBe(true);
    expect(cursor).not.toBe('producer-cursor-1');
    expect(await env.adapter.getSymbols({ ...input, cursor }, env.context())).toMatchObject({
      ok: true,
    });
    expect(env.request.mock.calls.at(-1)?.[1]).toEqual({ ...input, cursor: 'producer-cursor-1' });
    for (const invalid of [
      { ...input, cursor: `${cursor}x` },
      { ...input, cursor, queryId: 'query-2' },
      { ...input, cursor, limit: 1 },
    ]) {
      expect(await env.adapter.getSymbols(invalid, env.context())).toEqual({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    }
    const other = setup();
    expect(await other.adapter.getSymbols({ ...input, cursor }, other.context())).toEqual({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(other.request).not.toHaveBeenCalled();
    expect(env.request).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized producer cursor before encoding the public page', async () => {
    const env = setup();
    env.request.mockResolvedValue({
      ...operationFixtures.getSymbols.output,
      nextCursor: 'a'.repeat(129),
    });
    expect(await env.adapter.getSymbols(operationFixtures.getSymbols.input, env.context())).toEqual(
      {
        ok: false,
        error: { code: 'INVALID_RESPONSE' },
      },
    );
  });

  it('does not confuse an ACK with a fill and binds it to the permit command ID', async () => {
    const env = setup();
    const output = operationFixtures.createOrder.output;
    if (output.kind !== 'ACCEPTED') throw new Error('Missing ack');
    env.request.mockResolvedValue({
      ...output,
      ack: { ...output.ack, commandId: '30000000-0000-4000-8000-000000000099' },
    });
    expect(await env.adapter.createOrder(signed('createOrder'), env.context())).toEqual(
      unknownOutcome('createOrder'),
    );
    env.request.mockResolvedValue({ ...output, ack: { ...output.ack, status: 'FILLED' } });
    expect(await env.adapter.createOrder(signed('createOrder'), env.context())).toEqual(
      unknownOutcome('createOrder'),
    );
  });

  it('keeps a distinct outcome for each dispatched batch command, including failures', async () => {
    const env = setup();
    const batch = operationFixtures.cancelAllOrders.output;
    if (batch.kind !== 'RESULTS') throw new Error('Missing batch');
    const [first, second] = batch.outcomes;
    if (!first || !second) throw new Error('Missing outcomes');
    const mixed = {
      kind: 'RESULTS',
      outcomes: [
        first,
        { ...second, outcome: { kind: 'DEFINITIVELY_REJECTED', error: { code: 'NOT_FOUND' } } },
      ],
    };
    env.request.mockResolvedValue(mixed);
    expect(await env.adapter.cancelAllOrders(signed('cancelAllOrders'), env.context())).toEqual(
      mixed,
    );
    for (const invalid of [
      { ...batch, outcomes: [first] },
      { ...batch, outcomes: [first, first] },
      { kind: 'NOT_SENT', error: { code: 'UNAVAILABLE' } },
    ]) {
      env.request.mockResolvedValue(invalid);
      expect(await env.adapter.cancelAllOrders(signed('cancelAllOrders'), env.context())).toEqual(
        unknownOutcome('cancelAllOrders'),
      );
    }
    env.request.mockRejectedValue(new Error('secret raw response'));
    expect(await env.adapter.cancelAllOrders(signed('cancelAllOrders'), env.context())).toEqual(
      unknownOutcome('cancelAllOrders'),
    );
  });
});

describe('bounded lifecycle and dispatch certainty', () => {
  it('rejects invalid or already aborted deadlines before transport', async () => {
    const env = setup();
    const controller = new AbortController();
    controller.abort();
    for (const [context, code] of [
      [env.context({ deadline: NOW }), 'DEADLINE_EXCEEDED'],
      [env.context({ deadline: NOW + 30_001 }), 'INVALID_REQUEST'],
      [env.context({ signal: controller.signal }), 'ABORTED'],
    ] as const) {
      expect(await env.adapter.getTicker(operationFixtures.getTicker.input, context)).toEqual({
        ok: false,
        error: { code },
      });
    }
    expect(env.request).not.toHaveBeenCalled();
  });

  it('holds all 16 pending slots after caller timeout until underlying work actually settles', async () => {
    vi.useFakeTimers();
    const env = setup();
    const pending = Array.from({ length: 16 }, () => deferred<unknown>());
    for (const task of pending) env.request.mockImplementationOnce(() => task.promise);
    const calls = pending.map(() =>
      env.adapter.getTicker(operationFixtures.getTicker.input, env.context({ deadline: NOW + 5 })),
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(await Promise.all(calls)).toEqual(
      pending.map(() => ({ ok: false, error: { code: 'DEADLINE_EXCEEDED' } })),
    );
    expect(await env.adapter.getTicker(operationFixtures.getTicker.input, env.context())).toEqual({
      ok: false,
      error: { code: 'BUSY' },
    });
    expect(env.request).toHaveBeenCalledTimes(16);
    pending[0]?.reject(new Error('late-secret-error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      await env.adapter.getTicker(operationFixtures.getTicker.input, env.context()),
    ).toMatchObject({ ok: true });
    for (const task of pending.slice(1)) task.resolve(ticker);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('never dispatches after authorization times out, and observes its eventual rejection', async () => {
    vi.useFakeTimers();
    const env = setup();
    const authorization = deferred<boolean>();
    env.authorize.mockImplementation(() => authorization.promise);
    const operation = env.adapter.createOrder(
      signed('createOrder'),
      env.context({ deadline: NOW + 5 }),
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(await operation).toEqual(localFailure('createOrder', 'DEADLINE_EXCEEDED'));
    authorization.reject(new Error('authorization-late-secret'));
    await vi.advanceTimersByTimeAsync(0);
    expect(env.request).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'abort', 'throw'] as const)(
    'returns UNKNOWN after mutation dispatch on %s without retry',
    async (failureMode) => {
      vi.useFakeTimers();
      const env = setup();
      const task = deferred<unknown>();
      const controller = new AbortController();
      env.request.mockImplementation(() => task.promise);
      const operation = env.adapter.createOrder(
        signed('createOrder'),
        env.context({ deadline: NOW + 5, signal: controller.signal }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(env.request).toHaveBeenCalledTimes(1);
      if (failureMode === 'timeout') await vi.advanceTimersByTimeAsync(5);
      if (failureMode === 'abort') controller.abort();
      if (failureMode === 'throw') task.reject(new Error('secret-response'));
      expect(await operation).toEqual(unknownOutcome('createOrder'));
      task.resolve(operationFixtures.createOrder.output);
      await vi.advanceTimersByTimeAsync(0);
      expect(env.request).toHaveBeenCalledTimes(1);
    },
  );

  it('sanitizes thrown transport data and disconnects once while aborting pending work', async () => {
    const env = setup();
    env.request.mockRejectedValue({ code: 'RATE_LIMITED', retryAfterMs: 20, secret: 'raw-body' });
    expect(await env.adapter.getTicker(operationFixtures.getTicker.input, env.context())).toEqual({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
    const task = deferred<unknown>();
    env.request.mockImplementation(() => task.promise);
    const call = env.adapter.getTicker(operationFixtures.getTicker.input, env.context());
    const first = env.adapter.disconnect();
    const second = env.adapter.disconnect();
    expect(first).toBe(second);
    await first;
    expect(await call).toEqual({ ok: false, error: { code: 'CLOSED' } });
    task.reject(new Error('late-secret'));
    expect(env.transportDisconnect).toHaveBeenCalledTimes(1);
    expect(await env.adapter.getTicker(operationFixtures.getTicker.input, env.context())).toEqual({
      ok: false,
      error: { code: 'CLOSED' },
    });
  });
});

describe('stream lifecycle', () => {
  it.each(['scope', 'gap', 'overflow'] as const)(
    'terminates %s with RESYNC_REQUIRED and closes the source',
    async (reason) => {
      const env = setup();
      const subscription = await stream(
        env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
      );
      const sink = env.sinks.get('subscribeTicker');
      if (!sink) throw new Error('Missing source');
      if (reason === 'scope') sink.event({ ...ticker, instrumentId: 'ETHUSDT' });
      if (reason === 'gap') sink.gap();
      if (reason === 'overflow') for (let i = 0; i < 65; i++) sink.event(ticker);
      expect(await subscription[Symbol.asyncIterator]().next()).toMatchObject({
        value: {
          kind: 'RESYNC_REQUIRED',
          reason: { scope: 'MALFORMED', gap: 'SOURCE_GAP', overflow: 'OVERFLOW' }[reason],
        },
      });
      expect(env.sourceClose).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds streams at 16 and releases their slots on unsubscribe', async () => {
    const env = setup();
    const subscriptions = await Promise.all(
      Array.from({ length: 16 }, () =>
        stream(env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context())),
      ),
    );
    expect(
      await env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
    ).toEqual({ ok: false, error: { code: 'BUSY' } });
    await subscriptions[0]?.unsubscribe();
    expect(
      await env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
    ).toMatchObject({ ok: true });
    expect(env.subscribe).toHaveBeenCalledTimes(17);
  });

  it('holds stream slots while source unsubscribe promises remain unresolved', async () => {
    const env = setup();
    const closing = deferred<void>();
    env.sourceClose.mockImplementation(() => closing.promise);
    const subscriptions = await Promise.all(
      Array.from({ length: 16 }, () =>
        stream(env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context())),
      ),
    );
    await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
    expect(
      await env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
    ).toEqual({ ok: false, error: { code: 'BUSY' } });
    closing.resolve();
    await Promise.resolve();
    expect(
      await env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
    ).toMatchObject({ ok: true });
  });

  it('closes at capability expiry even without an active consumer', async () => {
    vi.useFakeTimers();
    const env = setup({
      capabilities: capabilities.map((record) => ({ ...record, expiresAt: NOW + 5 })),
    });
    const subscription = await stream(
      env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(env.sourceClose).toHaveBeenCalledTimes(1);
    expect(subscription.health().status).toBe('CLOSED');
  });

  it('closes a source returned after its handshake was already aborted', async () => {
    const env = setup();
    const handshake = deferred<() => Promise<void>>();
    const controller = new AbortController();
    env.subscribe.mockImplementation(() => handshake.promise);
    const operation = env.adapter.subscribeTicker(
      operationFixtures.subscribeTicker.input,
      env.context({ signal: controller.signal }),
    );
    controller.abort();
    expect(await operation).toEqual({ ok: false, error: { code: 'ABORTED' } });
    handshake.resolve(env.sourceClose);
    await Promise.resolve();
    await Promise.resolve();
    expect(env.sourceClose).toHaveBeenCalledTimes(1);
  });

  it('aborts an unresolved handshake at capability expiry and closes its eventual source once', async () => {
    vi.useFakeTimers();
    const env = setup({
      capabilities: capabilities.map((record) => ({ ...record, expiresAt: NOW + 5 })),
    });
    const handshake = deferred<() => Promise<void>>();
    env.subscribe.mockImplementation(() => handshake.promise);
    const operation = env.adapter.subscribeTicker(
      operationFixtures.subscribeTicker.input,
      env.context(),
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(env.subscribe.mock.calls[0]?.[2].signal.aborted).toBe(true);
    handshake.resolve(env.sourceClose);
    await operation;
    expect(env.sourceClose).toHaveBeenCalledTimes(1);
  });

  it('closes sources when the caller aborts, iterator returns, or adapter disconnects', async () => {
    const env = setup();
    const controller = new AbortController();
    const first = await stream(
      env.adapter.subscribeTicker(
        operationFixtures.subscribeTicker.input,
        env.context({ signal: controller.signal }),
      ),
    );
    controller.abort();
    expect(first.health().status).toBe('CLOSED');
    const second = await stream(
      env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
    );
    await second[Symbol.asyncIterator]().return?.();
    const third = await stream(
      env.adapter.subscribeTicker(operationFixtures.subscribeTicker.input, env.context()),
    );
    await env.adapter.disconnect();
    expect(third.health().status).toBe('CLOSED');
    expect(env.sourceClose).toHaveBeenCalledTimes(3);
  });
});
