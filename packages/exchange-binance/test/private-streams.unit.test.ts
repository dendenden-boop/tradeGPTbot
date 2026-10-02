import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AccountSnapshot,
  InstrumentRecord,
  Order,
  Position,
  RequestContext,
  StreamOperation,
} from '@ctp/exchange-core';
import { createBinanceSigner } from '../src/auth.js';
import { createRestClient } from '../src/client.js';
import { createNetworkIo, type NetworkIo, type NetworkSocket } from '../src/io.js';
import {
  normalizeFuturesBalances,
  normalizeOrder,
  normalizePositionV2,
  normalizeSpotAccount,
} from '../src/private-data.js';
import { createPrivateStreams } from '../src/private-streams.js';
import { adapterProfile, getBinanceProfile } from '../src/profiles.js';
import { normalizeExchangeInfo } from '../src/public-data.js';
import {
  ACCOUNT,
  INTERNAL_ORDER_ID,
  INTENT_ID,
  futuresBalances,
  order,
  position,
  spotAccount,
} from './fixtures/private-data.js';
import { NOW, exchangeInfo, futuresSymbol, spotSymbol } from './fixtures/public-data.js';
import { until, wsFixture } from './fixtures/io.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});

function setup(futures = false, actualTime = false) {
  const endpoint = getBinanceProfile(futures ? 'binance-usdm-live-v1' : 'binance-spot-testnet-v1');
  const record = normalizeExchangeInfo(
    exchangeInfo([futures ? futuresSymbol() : spotSymbol()]),
    endpoint.scope,
    NOW,
  )[0] as InstrumentRecord;
  let clock = actualTime ? Date.now() : NOW;
  const now = actualTime ? Date.now : () => clock;
  const controller = new AbortController();
  const context: RequestContext = {
    profile: adapterProfile(endpoint, 'fixture-vault'),
    account: ACCOUNT,
    deadline: now() + 20000,
    signal: controller.signal,
    correlationId: 'private-request',
  };
  let receive: ((text: string) => void) | undefined;
  let ended: (() => void) | undefined;
  let automaticAck = true;
  let listenKey = 'fixture-listen-key';
  const close = vi.fn(() => Promise.resolve());
  const send = vi.fn((text: string) => {
    const frame: unknown = JSON.parse(text);
    if (automaticAck && frame !== null && typeof frame === 'object' && 'id' in frame)
      receive?.(JSON.stringify({ id: frame.id, status: 200, result: { subscriptionId: 0 } }));
    return Promise.resolve();
  });
  const socket: NetworkSocket = { close, send };
  const open = vi.fn<NetworkIo['openSocket']>((_url, _context, onMessage, onEnd) => {
    receive = onMessage;
    ended = onEnd;
    return Promise.resolve(socket);
  });
  const request = vi.fn<NetworkIo['request']>(() =>
    Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({ listenKey }),
    }),
  );
  const io: NetworkIo = { request, openSocket: open, close: vi.fn(() => Promise.resolve()) };
  const reserve = vi.fn(() => Promise.resolve(true));
  const observe = vi.fn(() => Promise.resolve());
  const limiter = { reserve, observe };
  const credentials = {
    resolve: vi.fn(() =>
      Promise.resolve({
        profileId: endpoint.id,
        account: ACCOUNT,
        apiKey: 'fixture-api-key',
        secret: 'fixture-secret',
      }),
    ),
  };
  const signer = createBinanceSigner(
    endpoint,
    { profileId: endpoint.id, account: ACCOUNT, credentialRef: 'fixture-vault' },
    credentials,
    () => ({ serverTime: now(), sampledAt: now(), roundTripMs: 0 }),
    now,
  );
  const syncTime = vi.fn(() => Promise.resolve());
  const normalizedOrder = normalizeOrder(order(futures), record, ACCOUNT, {
    order: () => ({ internalOrderId: INTERNAL_ORDER_ID, intentId: INTENT_ID }),
    fill: () => ({ internalOrderId: INTERNAL_ORDER_ID }),
    algo: () => ({ internalAlgoId: '55555555-5555-4555-8555-555555555555' }),
  });
  const balances = futures
    ? normalizeFuturesBalances(futuresBalances(), endpoint.scope, ACCOUNT, NOW)
    : normalizeSpotAccount(spotAccount(), endpoint.scope, ACCOUNT, NOW);
  const normalizedPosition = futures ? normalizePositionV2(position(), record, ACCOUNT) : undefined;
  const snapshotOrders = vi.fn<(...args: unknown[]) => Promise<readonly Order[]>>(() =>
    Promise.resolve([normalizedOrder]),
  );
  const snapshotBalances = vi.fn<(...args: unknown[]) => Promise<AccountSnapshot>>(() =>
    Promise.resolve(balances),
  );
  const snapshotPositions = vi.fn<(...args: unknown[]) => Promise<readonly Position[]>>(() =>
    Promise.resolve(normalizedPosition ? [normalizedPosition] : []),
  );
  const options = {
    endpoint,
    io,
    limiter,
    signer,
    account: ACCOUNT,
    now,
    syncTime,
    rest: createRestClient(endpoint, io, limiter, ACCOUNT, now),
    snapshotOrders,
    snapshotBalances,
    snapshotPositions,
  };
  const streams = createPrivateStreams(options);
  cleanup.push(() => streams.disconnect());
  const events: unknown[] = [];
  const gap = vi.fn();
  const subscribe = (
    operation: StreamOperation = 'subscribePrivateOrders',
    input: unknown = { instrumentId: record.instrument.id },
  ) =>
    streams.subscribe(
      operation,
      input,
      operation === 'subscribeBalances' ? null : record,
      context,
      (event) => events.push(event),
      gap,
    );
  const push = (event: unknown, subscriptionId = 0) =>
    receive?.(JSON.stringify(futures ? event : { subscriptionId, event }));
  return {
    endpoint,
    record,
    context,
    controller,
    options,
    streams,
    io,
    open,
    send,
    close,
    request,
    limiter,
    credentials,
    syncTime,
    snapshotOrders,
    snapshotBalances,
    snapshotPositions,
    normalizedOrder,
    balances,
    normalizedPosition,
    events,
    gap,
    subscribe,
    push,
    raw: (text: string) => receive?.(text),
    end: () => ended?.(),
    automaticAck: (value: boolean) => {
      automaticAck = value;
    },
    listenKey: (value: string) => {
      listenKey = value;
    },
    clock: (value: number) => {
      clock = value;
    },
  };
}

function orderEvent(futures = false, symbol = 'BTCUSDT', transactionTime = NOW - 20) {
  const fields = {
    s: symbol,
    i: '9223372036854775807',
    c: 'fixture-order-1',
    X: 'PARTIALLY_FILLED',
  };
  return futures
    ? {
        e: 'ORDER_TRADE_UPDATE',
        E: NOW - 10,
        T: transactionTime,
        o: { ...fields, T: transactionTime, ps: 'BOTH' },
      }
    : { e: 'executionReport', E: NOW - 10, T: transactionTime, ...fields };
}
const spotBalanceEvent = (transactionTime = NOW - 20) => ({
  e: 'outboundAccountPosition',
  E: NOW - 10,
  u: transactionTime,
  B: [{ a: 'BTC', f: '0.00000001', l: '0.00000000' }],
});
const accountEvent = (symbol = 'BTCUSDT', transactionTime = NOW - 20) => ({
  e: 'ACCOUNT_UPDATE',
  E: NOW - 10,
  T: transactionTime,
  a: {
    m: 'ORDER',
    B: [{ a: 'USDT', wb: '100.12', cw: '90.12', bc: '0' }],
    P: [
      {
        s: symbol,
        ps: 'BOTH',
        pa: '-0.025',
        ep: '100',
        cr: '0',
        up: '0.0025',
        mt: 'cross',
        iw: '0',
      },
    ],
  },
});

describe('private stream authenticated session lifecycle', () => {
  it('uses modern Spot signature subscription and waits for the matching ACK', async () => {
    const f = setup();
    const unsubscribe = await f.subscribe();
    expect(f.syncTime).toHaveBeenCalledTimes(1);
    expect(f.open.mock.calls[0]?.[0].href).toBe('wss://ws-api.testnet.binance.vision/ws-api/v3');
    const sent: unknown = JSON.parse(f.send.mock.calls[0]?.[0] ?? '{}');
    expect(sent).toMatchObject({
      id: f.context.correlationId,
      method: 'userDataStream.subscribe.signature',
      params: { apiKey: 'fixture-api-key', recvWindow: 5000 },
    });
    expect(JSON.stringify(sent)).not.toContain('fixture-secret');
    expect(f.events).toEqual([]);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.limiter.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'WS',
        route: '/ws-api/v3',
        weight: 2,
        connectionAttempts: 1,
      }),
      expect.anything(),
    );
    expect(f.limiter.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'userDataStream.subscribe.signature',
        weight: 2,
        controlMessages: 1,
      }),
      expect.anything(),
    );
    await unsubscribe();
    await unsubscribe();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('uses the current routed USD-M private endpoint and API-key listenKey lifecycle', async () => {
    const f = setup(true);
    const unsubscribe = await f.subscribe();
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      headers: { 'X-MBX-APIKEY': 'fixture-api-key' },
    });
    expect(f.request.mock.calls[0]?.[0].url.href).toBe(
      'https://fapi.binance.com/fapi/v1/listenKey',
    );
    expect(f.open.mock.calls[0]?.[0].href).toBe(
      'wss://fstream.binance.com/private/ws/fixture-listen-key',
    );
    expect(f.send).not.toHaveBeenCalled();
    await unsubscribe();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('signs Spot subscription after slow connection and control admission with a fresh timestamp', async () => {
    const f = setup();
    f.limiter.reserve.mockImplementationOnce(() => {
      f.clock(NOW + 6000);
      return Promise.resolve(true);
    });
    const unsubscribe = await f.subscribe();
    const sent: unknown = JSON.parse(f.send.mock.calls[0]?.[0] ?? '{}');
    expect(sent).toMatchObject({ params: { timestamp: NOW + 6000 } });
    expect(f.credentials.resolve).toHaveBeenCalledTimes(2);
    await unsubscribe();
  });
  it('refuses an unverified USD-M sandbox route before credentials or network I/O', async () => {
    const f = setup(true);
    const endpoint = getBinanceProfile('binance-usdm-testnet-v1');
    const streams = createPrivateStreams({ ...f.options, endpoint });
    await expect(
      streams.subscribe(
        'subscribePrivateOrders',
        { instrumentId: 'BTCUSDT' },
        f.record,
        { ...f.context, profile: adapterProfile(endpoint, 'fixture-vault') },
        () => {},
        f.gap,
      ),
    ).rejects.toThrow('UNSUPPORTED');
    expect(f.credentials.resolve).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
  it.each(['subscribeAlgoOrders', 'subscribeTicker'] as const)(
    'refuses an unsupported private source %s',
    async (operation) => {
      const f = setup();
      await expect(f.subscribe(operation)).rejects.toThrow('UNSUPPORTED');
      expect(f.open).not.toHaveBeenCalled();
    },
  );
  it('refuses Spot positions and missing snapshot support before dispatch', async () => {
    const f = setup();
    await expect(f.subscribe('subscribePositions')).rejects.toThrow('UNSUPPORTED');
    const streams = createPrivateStreams({ ...f.options, snapshotOrders: undefined });
    await expect(
      streams.subscribe(
        'subscribePrivateOrders',
        { instrumentId: 'BTCUSDT' },
        f.record,
        f.context,
        () => {},
        f.gap,
      ),
    ).rejects.toThrow('UNSUPPORTED');
    expect(f.open).not.toHaveBeenCalled();
  });
  it('rejects context account/profile/instrument disagreement before I/O', async () => {
    const f = setup();
    await expect(
      f.streams.subscribe(
        'subscribePrivateOrders',
        { instrumentId: 'BTCUSDT' },
        f.record,
        { ...f.context, account: { ...ACCOUNT, externalAccountId: 'other' } },
        () => {},
        f.gap,
      ),
    ).rejects.toThrow('SCOPE_MISMATCH');
    await expect(
      f.subscribe('subscribePrivateOrders', { instrumentId: 'ETHUSDT' }),
    ).rejects.toThrow('SCOPE_MISMATCH');
    expect(f.open).not.toHaveBeenCalled();
  });
  it('checks pre-abort and elapsed deadline before credentials and I/O', async () => {
    const f = setup();
    f.controller.abort('sensitive-reason');
    await expect(f.subscribe()).rejects.toThrow('ABORTED');
    expect(f.open).not.toHaveBeenCalled();
    expect(f.credentials.resolve).not.toHaveBeenCalled();
    const expired = setup();
    expired.clock(expired.context.deadline);
    await expect(expired.subscribe()).rejects.toThrow('DEADLINE_EXCEEDED');
    expect(expired.open).not.toHaveBeenCalled();
  });
  it.each([
    ['wrong-id', 200],
    ['private-request', 401],
    ['private-request', 429],
    ['private-request', 500],
  ] as const)(
    'refuses a failed or uncorrelated Spot ACK %s/%s without raw message leakage',
    async (id, status) => {
      const f = setup();
      f.automaticAck(false);
      const pending = f.subscribe();
      const check = expect(pending).rejects.toThrow(
        status === 429
          ? 'RATE_LIMITED'
          : id !== 'private-request'
            ? 'INVALID_RESPONSE'
            : 'AUTHORIZATION_REQUIRED',
      );
      await until(() => f.send.mock.calls.length > 0);
      f.raw(JSON.stringify({ id, status, error: { code: -2015, msg: 'fixture-secret' } }));
      await check;
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(f.events).toEqual([]);
    },
  );
  it('aborts a hung Spot ACK and closes its underlying socket', async () => {
    const f = setup();
    f.automaticAck(false);
    const pending = f.subscribe();
    const check = expect(pending).rejects.toThrow('ABORTED');
    await until(() => f.send.mock.calls.length > 0);
    f.controller.abort();
    await check;
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('observes successful WS rate counters through the trusted coordinator', async () => {
    const f = setup();
    f.automaticAck(false);
    const pending = f.subscribe();
    await until(() => f.send.mock.calls.length > 0);
    f.raw(
      JSON.stringify({
        id: f.context.correlationId,
        status: 200,
        result: { subscriptionId: 0 },
        rateLimits: [
          { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, count: 12 },
          { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, count: 2 },
        ],
      }),
    );
    const unsubscribe = await pending;
    expect(f.limiter.observe).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'userDataStream.subscribe.signature' }),
      200,
      { 'x-mbx-used-weight-1m': '12', 'x-mbx-order-count-10s': '2' },
      expect.anything(),
    );
    await unsubscribe();
  });
  it('observes a rate-limit ACK and retryAfter before closing without retry', async () => {
    const f = setup();
    f.automaticAck(false);
    const pending = f.subscribe();
    const check = expect(pending).rejects.toThrow('RATE_LIMITED');
    await until(() => f.send.mock.calls.length > 0);
    f.raw(
      JSON.stringify({
        id: f.context.correlationId,
        status: 429,
        error: { code: -1003, msg: 'fixture-secret', data: { retryAfter: NOW + 60000 } },
      }),
    );
    await check;
    expect(f.limiter.observe).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'userDataStream.subscribe.signature' }),
      429,
      { 'retry-after': '60' },
      expect.anything(),
    );
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('refuses private subscription without captured server account authority', async () => {
    const f = setup();
    const streams = createPrivateStreams({ ...f.options, account: null });
    await expect(
      streams.subscribe(
        'subscribePrivateOrders',
        { instrumentId: 'BTCUSDT' },
        f.record,
        f.context,
        () => {},
        f.gap,
      ),
    ).rejects.toThrow('AUTHORIZATION_REQUIRED');
    expect(f.credentials.resolve).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
  it('terminates a real underlying websocket when its signed subscription ACK hangs', async () => {
    const fixture = await wsFixture();
    cleanup.push(() => fixture.close());
    const network = createNetworkIo();
    cleanup.push(() => network.close());
    const f = setup(false, true);
    f.automaticAck(false);
    const io: NetworkIo = {
      request: network.request.bind(network),
      close: network.close.bind(network),
      openSocket: (_url, context, onMessage, onEnd) =>
        network.openSocket(fixture.url, context, onMessage, onEnd),
    };
    const streams = createPrivateStreams({ ...f.options, io });
    cleanup.push(() => streams.disconnect());
    const pending = streams.subscribe(
      'subscribePrivateOrders',
      { instrumentId: 'BTCUSDT' },
      f.record,
      f.context,
      () => {},
      f.gap,
    );
    const check = expect(pending).rejects.toThrow('ABORTED');
    await until(() => fixture.ws.clients.size === 1);
    const started = Date.now();
    f.controller.abort();
    await check;
    await until(() => fixture.ws.clients.size === 0);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('expires a hung ACK at a bounded deadline', async () => {
    const f = setup(false, true);
    f.automaticAck(false);
    const limited = { ...f.context, deadline: Date.now() + 40 };
    await expect(
      f.streams.subscribe(
        'subscribePrivateOrders',
        { instrumentId: 'BTCUSDT' },
        f.record,
        limited,
        () => {},
        f.gap,
      ),
    ).rejects.toThrow('DEADLINE_EXCEEDED');
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('cancels a hung limiter and prevents late admission from opening a socket', async () => {
    const f = setup();
    let admit: (value: boolean) => void = () => {};
    f.limiter.reserve.mockImplementation(
      () =>
        new Promise((resolve) => {
          admit = resolve;
        }),
    );
    const pending = f.subscribe();
    const check = expect(pending).rejects.toThrow('ABORTED');
    await until(() => f.limiter.reserve.mock.calls.length > 0);
    f.controller.abort();
    await check;
    admit(true);
    await Promise.resolve();
    expect(f.open).not.toHaveBeenCalled();
  });
  it('cancels a hung clock synchronization before opening a socket', async () => {
    const f = setup();
    f.syncTime.mockImplementation(() => new Promise(() => {}));
    const pending = f.subscribe();
    const check = expect(pending).rejects.toThrow('ABORTED');
    await until(() => f.syncTime.mock.calls.length > 0);
    f.controller.abort();
    await check;
    expect(f.open).not.toHaveBeenCalled();
  });
  it.each(['../escape', 'https://user-url', 'key?tenant=x', 'key\nheader'])(
    'rejects an unsafe exchange listenKey %s',
    async (key) => {
      const f = setup(true);
      f.listenKey(key);
      await expect(f.subscribe()).rejects.toThrow('INVALID_RESPONSE');
      expect(f.open).not.toHaveBeenCalled();
    },
  );
  it('disconnects all sources idempotently and prohibits new subscriptions', async () => {
    const f = setup();
    await f.subscribe();
    await f.streams.disconnect();
    await f.streams.disconnect();
    expect(f.close).toHaveBeenCalledTimes(1);
    await expect(f.subscribe()).rejects.toThrow('UNAVAILABLE');
  });
});

describe('private stream dirty notifications and authoritative snapshots', () => {
  it.each([false, true])(
    'fetches the exact changed order, including terminal orders (USD-M=%s)',
    async (futures) => {
      const f = setup(futures);
      const unsubscribe = await f.subscribe();
      f.push(orderEvent(futures));
      await until(() => f.events.length === 1);
      expect(f.snapshotOrders).toHaveBeenCalledWith(
        expect.objectContaining({ e: futures ? 'ORDER_TRADE_UPDATE' : 'executionReport' }),
        { instrumentId: 'BTCUSDT' },
        expect.objectContaining({ account: ACCOUNT }),
      );
      expect(f.events).toEqual([f.normalizedOrder]);
      await unsubscribe();
    },
  );
  it('does not apply a Spot balance delta as a full account snapshot', async () => {
    const f = setup();
    const unsubscribe = await f.subscribe('subscribeBalances', {});
    f.push(spotBalanceEvent());
    await until(() => f.events.length === 1);
    expect(f.events).toEqual([f.balances]);
    expect(f.balances.balances.length).toBe(2);
    await unsubscribe();
  });
  it.each(['balanceUpdate', 'externalLockUpdate'])(
    'refreshes complete balances after %s',
    async (e) => {
      const f = setup();
      const unsubscribe = await f.subscribe('subscribeBalances', {});
      f.push({ e, E: NOW - 10, T: NOW - 20, a: 'BTC', d: '1' });
      await until(() => f.events.length === 1);
      expect(f.events).toEqual([f.balances]);
      await unsubscribe();
    },
  );
  it.each(['subscribeBalances', 'subscribePositions'] as const)(
    'refreshes USD-M %s from complete fields rather than partial ACCOUNT_UPDATE',
    async (operation) => {
      const f = setup(true);
      const unsubscribe = await f.subscribe(
        operation,
        operation === 'subscribeBalances' ? {} : { instrumentId: 'BTCUSDT' },
      );
      f.push(accountEvent());
      await until(() => f.events.length === 1);
      expect(f.events).toEqual([
        operation === 'subscribeBalances' ? f.balances : f.normalizedPosition,
      ]);
      await unsubscribe();
    },
  );
  it.each([false, true])(
    'ignores another instrument without calling target snapshot (USD-M=%s)',
    async (futures) => {
      const f = setup(futures);
      const unsubscribe = await f.subscribe();
      f.push(orderEvent(futures, 'ETHUSDT'));
      await Promise.resolve();
      expect(f.snapshotOrders).not.toHaveBeenCalled();
      expect(f.events).toEqual([]);
      expect(f.gap).not.toHaveBeenCalled();
      await unsubscribe();
    },
  );
  it('ignores another position symbol without fetching or emitting a target position', async () => {
    const f = setup(true);
    const unsubscribe = await f.subscribe('subscribePositions');
    f.push(accountEvent('ETHUSDT'));
    await Promise.resolve();
    expect(f.snapshotPositions).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    await unsubscribe();
  });
  it('deduplicates exact reports and rejects an earlier report as a terminal gap', async () => {
    const f = setup();
    await f.subscribe();
    const event = orderEvent();
    f.push(event);
    f.push(event);
    await until(() => f.events.length === 1);
    expect(f.snapshotOrders).toHaveBeenCalledTimes(1);
    f.push({ ...event, E: NOW - 30, T: NOW - 40 });
    await until(() => f.gap.mock.calls.length === 1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('serializes snapshot requests and terminates on bounded queue overflow', async () => {
    const f = setup();
    let resume: (value: readonly Order[]) => void = () => {};
    f.snapshotOrders.mockImplementation(
      () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    );
    await f.subscribe();
    for (let n = 0; n < 18; n++) f.push({ ...orderEvent(), E: NOW + n, T: NOW + n });
    await until(() => f.gap.mock.calls.length === 1);
    expect(f.snapshotOrders).toHaveBeenCalledTimes(1);
    resume([f.normalizedOrder]);
    await Promise.resolve();
    expect(f.events).toEqual([]);
  });
  it.each(['stale', 'foreign-account', 'foreign-instrument', 'foreign-order', 'empty'] as const)(
    'terminates instead of emitting non-authoritative %s order data',
    async (problem) => {
      const f = setup();
      const changed = {
        ...f.normalizedOrder,
        ...(problem === 'stale'
          ? { updatedAt: NOW - 30 }
          : problem === 'foreign-account'
            ? { account: { ...ACCOUNT, externalAccountId: 'foreign' } }
            : problem === 'foreign-instrument'
              ? { instrumentId: 'ETHUSDT' }
              : problem === 'foreign-order'
                ? { exchangeOrderId: '1234' }
                : {}),
      };
      f.snapshotOrders.mockResolvedValue(problem === 'empty' ? [] : [changed]);
      await f.subscribe();
      f.push(orderEvent());
      await until(() => f.gap.mock.calls.length === 1);
      expect(f.events).toEqual([]);
    },
  );
  it('terminates when account snapshot is older than the balance notification', async () => {
    const f = setup();
    f.snapshotBalances.mockResolvedValue({ ...f.balances, asOf: NOW - 30 });
    await f.subscribe('subscribeBalances', {});
    f.push(spotBalanceEvent());
    await until(() => f.gap.mock.calls.length === 1);
    expect(f.events).toEqual([]);
  });
  it('terminates when a position has no evidence at or after the changed transaction', async () => {
    const f = setup(true);
    if (!f.normalizedPosition) throw new Error('MISSING_FIXTURE');
    f.snapshotPositions.mockResolvedValue([{ ...f.normalizedPosition, updatedAt: NOW - 30 }]);
    await f.subscribe('subscribePositions');
    f.push(accountEvent());
    await until(() => f.gap.mock.calls.length === 1);
    expect(f.events).toEqual([]);
  });
  it('terminates on a failed snapshot and does not expose its raw error', async () => {
    const f = setup();
    f.snapshotOrders.mockRejectedValue(new Error('fixture-secret'));
    await f.subscribe();
    f.push(orderEvent());
    await until(() => f.gap.mock.calls.length === 1);
    expect(f.events).toEqual([]);
    expect(f.gap.mock.calls).toEqual([[]]);
  });
  it.each([
    'bad-json',
    'wrong-subscription',
    'unknown-event',
    'invalid-id',
    'source-terminated',
  ] as const)('terminates on source integrity failure %s', async (problem) => {
    const f = setup();
    await f.subscribe();
    if (problem === 'bad-json') f.raw('{fixture-secret');
    else if (problem === 'wrong-subscription') f.push(orderEvent(), 1);
    else if (problem === 'unknown-event') f.push({ e: 'unrecognized', E: NOW });
    else if (problem === 'invalid-id') f.push({ ...orderEvent(), i: '1e10' });
    else f.push({ e: 'eventStreamTerminated', E: NOW });
    await until(() => f.gap.mock.calls.length === 1);
    expect(f.events).toEqual([]);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('requires fresh subscription after listenKey expiry and never reconnects itself', async () => {
    const f = setup(true);
    await f.subscribe();
    f.push({ e: 'listenKeyExpired', E: NOW, listenKey: 'fixture-listen-key' });
    await until(() => f.gap.mock.calls.length === 1);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([]);
  });
  it('terminates when source connection ends and does not retry', async () => {
    const f = setup();
    await f.subscribe();
    f.end();
    await until(() => f.gap.mock.calls.length === 1);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
