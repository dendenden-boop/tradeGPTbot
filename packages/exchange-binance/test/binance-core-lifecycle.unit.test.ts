import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  capabilityRecordSchema,
  computeCommandHash,
  createInstrumentRegistry,
  featureSchema,
  newOrderSchema,
  type RequestContext,
} from '@ctp/exchange-core';
import { createBinanceAdapterWithIo } from '../src/adapter.js';
import { createNetworkIo, type NetworkIo } from '../src/io.js';
import { adapterProfile, getBinanceProfile } from '../src/profiles.js';
import { exchangeInfo, spotSymbol } from './fixtures/public-data.js';
import { httpFixture, until } from './fixtures/io.js';

const ACCOUNT = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  connectionId: '20000000-0000-4000-8000-000000000001',
  externalAccountId: 'fixture-account',
};
const INTERNAL_ORDER_ID = '50000000-0000-4000-8000-000000000001';
const INTENT_ID = '60000000-0000-4000-8000-000000000001';
const COMMAND_ID = '30000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '40000000-0000-4000-8000-000000000001';
const EXCHANGE_ID = '9223372036854775807';
const CLIENT_ID = 'lifecycle-order-1';
const API_KEY = 'fixture_api_key';
const SECRET = 'local-fixture-secret';
const WAIT_BUDGET = 2000;
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await within(close());
});
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('LIFECYCLE_WAIT_BUDGET_EXCEEDED')), WAIT_BUDGET);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}
function orderSnapshot() {
  return {
    symbol: 'BTCUSDT',
    orderId: EXCHANGE_ID,
    orderListId: -1,
    clientOrderId: CLIENT_ID,
    price: '100.12000000',
    origQty: '0.10000000',
    executedQty: '0.00000000',
    cummulativeQuoteQty: '0.00000000',
    status: 'NEW',
    timeInForce: 'GTC',
    type: 'LIMIT',
    side: 'BUY',
    stopPrice: '0.00000000',
    icebergQty: '0.00000000',
    time: Date.now() - 10,
    updateTime: Date.now(),
    isWorking: true,
    origQuoteOrderQty: '0.00000000',
  };
}
type Behavior = 'ACCEPT' | 'LOSE_ACK' | 'HANG_HEADERS' | 'HANG_BODY' | 'UNKNOWN_RESPONSE';
async function setup(behavior: Behavior = 'ACCEPT', live = false) {
  let hangTicker = false;
  let hangHandshake = false;
  const calls: { method: string; url: URL; apiKey: string | undefined }[] = [];
  const mutations: URL[] = [];
  let orderHandler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  const server = await httpFixture((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    calls.push({
      method: request.method ?? '',
      url,
      apiKey: request.headers['x-mbx-apikey'] as string | undefined,
    });
    if (url.pathname === '/api/v3/exchangeInfo')
      return json(response, { ...exchangeInfo([spotSymbol()]), serverTime: Date.now() });
    if (url.pathname === '/api/v3/time') return json(response, { serverTime: Date.now() });
    if (url.pathname === '/api/v3/ticker/24hr') {
      if (hangTicker) {
        if (behavior === 'HANG_BODY')
          response.writeHead(200, { 'content-type': 'application/json' }).write('{');
        return;
      }
      return json(response, {
        symbol: 'BTCUSDT',
        lastPrice: '100.12000000',
        bidPrice: '100.11000000',
        askPrice: '100.13000000',
        volume: '12.34000000',
        quoteVolume: '1234.56000000',
        priceChange: '-0.01000000',
        closeTime: Date.now(),
      });
    }
    if (url.pathname === '/api/v3/order' && request.method === 'POST') {
      mutations.push(url);
      if (orderHandler) return orderHandler(request, response);
      if (behavior === 'LOSE_ACK') return request.socket.destroy();
      if (behavior === 'HANG_HEADERS') return;
      if (behavior === 'HANG_BODY') {
        response.writeHead(200, { 'content-type': 'application/json' }).write('{');
        return;
      }
      if (behavior === 'UNKNOWN_RESPONSE')
        return json(response, {
          code: -1007,
          msg: 'Timeout waiting for response; send status unknown',
        });
      return json(response, {
        symbol: 'BTCUSDT',
        orderId: EXCHANGE_ID,
        clientOrderId: CLIENT_ID,
        transactTime: Date.now(),
      });
    }
    if (url.pathname === '/api/v3/order' && request.method === 'GET')
      return json(response, orderSnapshot());
    json(response, { code: -1100, msg: 'unexpected local protocol route' }, 400);
  });
  disposers.push(() => server.close());
  const websocket = new WebSocketServer({
    server: server.server,
    perMessageDeflate: false,
    verifyClient(information, accept) {
      if (hangHandshake) {
        const socket = information.req.socket;
        // The server deliberately withholds upgrade ACK, but still consumes FIN.
        socket.on('end', () => socket.end());
        socket.resume();
      } else accept(true);
    },
  });
  const wsConnections: WebSocket[] = [];
  websocket.on('connection', (socket) => {
    socket.on('error', () => undefined);
    wsConnections.push(socket);
  });
  disposers.push(async () => {
    for (const socket of websocket.clients) socket.terminate();
    await new Promise<void>((resolve) => websocket.close(() => resolve()));
  });
  const network = createNetworkIo();
  disposers.push(() => network.close());
  let settled = 0;
  let wsSettled = 0;
  const destinations: URL[] = [];
  const wsDestinations: URL[] = [];
  const io: NetworkIo = {
    async request(input, context) {
      destinations.push(new URL(input.url));
      // Only the internal test IO bridge rewrites the resolved built-in destination.
      // No production endpoint profile, factory option, or request URL is changed.
      const local = new URL(input.url.pathname + input.url.search, server.url);
      try {
        return await network.request({ ...input, url: local }, context);
      } finally {
        settled += 1;
      }
    },
    async openSocket(url, context, onMessage, onEnd) {
      wsDestinations.push(new URL(url));
      const local = new URL(url.pathname + url.search, server.url);
      local.protocol = 'ws:';
      try {
        return await network.openSocket(local, context, onMessage, onEnd);
      } finally {
        wsSettled += 1;
      }
    },
    close: () => network.close(),
  };
  const endpoint = getBinanceProfile(live ? 'binance-spot-live-v1' : 'binance-spot-testnet-v1');
  const profile = adapterProfile(endpoint, 'fixture-credential-ref');
  const started = Date.now();
  const registry = createInstrumentRegistry({ capacity: 1, versionCapacity: 128 });
  const authorize = vi.fn(() => Promise.resolve(true));
  const sandbox = vi.fn(() => Promise.resolve(true));
  const admission = vi.fn(() => Promise.resolve(true));
  const credential = vi.fn(() =>
    Promise.resolve({ profileId: endpoint.id, account: ACCOUNT, apiKey: API_KEY, secret: SECRET }),
  );
  const reserve = vi.fn(() => Promise.resolve(true));
  const adapter = createBinanceAdapterWithIo(
    {
      profileId: endpoint.id,
      symbols: ['BTCUSDT'],
      capabilities: featureSchema.options.map((feature) =>
        capabilityRecordSchema.parse({
          profile,
          feature,
          support: 'SUPPORTED',
          implementation: 'NATIVE',
          constraints: {},
          evidenceUrl: 'https://example.test/local-contract-fixture',
          checkedAt: started - 1000,
          expiresAt: started + 60_000,
          adapterVersion: 'binance-v1',
        }),
      ),
      registry,
      limiter: { reserve, observe: () => Promise.resolve() },
      connection: {
        resolve: () => ({ account: ACCOUNT, credentialRef: 'fixture-credential-ref' }),
      },
      credentials: { resolve: credential },
      authorization: { authorize },
      sandboxAcceptance: { authorize: sandbox },
      orderAdmission: { validate: admission },
      identities: {
        order: () => ({ internalOrderId: INTERNAL_ORDER_ID, intentId: INTENT_ID }),
        algo: () => ({ internalAlgoId: '70000000-0000-4000-8000-000000000001' }),
        fill: () => ({ internalOrderId: INTERNAL_ORDER_ID }),
      },
    },
    io,
  );
  disposers.push(() => adapter.disconnect());
  const context = (milliseconds = 1500, signal = new AbortController().signal): RequestContext => ({
    profile: adapter.profile,
    account: adapter.account,
    signal,
    deadline: Date.now() + milliseconds,
    correlationId: 'binance-factory-real-io',
  });
  const symbols = await within(
    adapter.getSymbols({ cursor: null, limit: 10, queryId: 'bootstrap' }, context()),
  );
  expect(symbols).toMatchObject({ ok: true, value: { items: [{ id: 'BTCUSDT' }] } });
  await until(() => server.sockets.size === 0);
  const mutation = () => {
    const metadata = registry.get(endpoint.scope, 'BTCUSDT', Date.now());
    if (!metadata.ok) throw new Error('MISSING_BOOTSTRAPPED_METADATA');
    const command = newOrderSchema.parse({
      clientOrderId: CLIENT_ID,
      instrumentId: 'BTCUSDT',
      ruleVersion: metadata.value.rules.version,
      side: 'BUY',
      type: 'LIMIT',
      size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '0.1' },
      limitPrice: '100.12',
      timeInForce: 'GTC',
      trigger: null,
      reduceOnly: false,
    });
    const issuedAt = Date.now();
    return {
      command,
      authorization: {
        commandId: COMMAND_ID,
        dispatchAttemptId: ATTEMPT_ID,
        commandHash: computeCommandHash('createOrder', command, {
          profile: adapter.profile,
          account: ACCOUNT,
        }),
        profile: adapter.profile,
        account: ACCOUNT,
        issuedAt,
        expiresAt: issuedAt + 10_000,
      },
    };
  };
  return {
    adapter,
    context,
    mutation,
    calls,
    mutations,
    destinations,
    wsDestinations,
    wsConnections,
    sockets: server.sockets,
    authorize,
    sandbox,
    admission,
    credential,
    reserve,
    settled: () => settled,
    wsSettled: () => wsSettled,
    hangHandshake: (value: boolean) => (hangHandshake = value),
    hangTicker: (value: boolean) => (hangTicker = value),
    setOrderHandler: (handler: (request: IncomingMessage, response: ServerResponse) => void) =>
      (orderHandler = handler),
  };
}

describe('real Binance factory plus Exchange Core bounded local transport', () => {
  it('accepts a signed LIMIT mutation once through every authority boundary', async () => {
    const f = await setup();
    const result = await within(f.adapter.createOrder(f.mutation(), f.context()));
    expect(result).toMatchObject({
      kind: 'ACCEPTED',
      ack: { commandId: COMMAND_ID, status: 'ACKNOWLEDGED', exchangeId: EXCHANGE_ID },
    });
    expect(f.mutations).toHaveLength(1);
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.sandbox).toHaveBeenCalledOnce();
    expect(f.admission).toHaveBeenCalledOnce();
    const call = f.calls.find((value) => value.method === 'POST');
    expect(call?.apiKey).toBe(API_KEY);
    const params = new URLSearchParams(call?.url.search);
    const signature = params.get('signature');
    params.delete('signature');
    expect(signature).toBe(createHmac('sha256', SECRET).update(params.toString()).digest('hex'));
    expect(Object.fromEntries(params)).toMatchObject({
      symbol: 'BTCUSDT',
      type: 'LIMIT',
      newClientOrderId: CLIENT_ID,
      quantity: '0.1',
      price: '100.12',
      timeInForce: 'GTC',
    });
    expect(f.destinations.every((url) => url.origin === 'https://testnet.binance.vision')).toBe(
      true,
    );
    await until(() => f.sockets.size === 0);
  });
  it.each(['LOSE_ACK', 'UNKNOWN_RESPONSE'] as const)(
    'returns UNKNOWN for %s and reconciles by the original client ID without retry',
    async (behavior) => {
      const f = await setup(behavior);
      const result = await within(f.adapter.createOrder(f.mutation(), f.context()));
      expect(result).toMatchObject({ kind: 'UNKNOWN' });
      expect(f.mutations).toHaveLength(1);
      const recovered = await within(
        f.adapter.getOrder(
          { instrumentId: 'BTCUSDT', locator: { kind: 'CLIENT_ID', id: CLIENT_ID } },
          f.context(),
        ),
      );
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          kind: 'FOUND',
          order: {
            internalOrderId: INTERNAL_ORDER_ID,
            intentId: INTENT_ID,
            exchangeOrderId: EXCHANGE_ID,
            clientOrderId: CLIENT_ID,
          },
        },
      });
      const lookup = f.calls.find(
        (value) => value.method === 'GET' && value.url.pathname === '/api/v3/order',
      );
      expect(lookup?.url.searchParams.get('origClientOrderId')).toBe(CLIENT_ID);
      expect(f.mutations).toHaveLength(1);
      await until(() => f.sockets.size === 0);
    },
  );
  for (const stage of ['HANG_HEADERS', 'HANG_BODY'] as const) {
    it.each(['deadline', 'abort'] as const)(
      `returns UNKNOWN after ${stage} %s and releases the real socket`,
      async (mode) => {
        const f = await setup(stage);
        const controller = new AbortController();
        const before = f.settled();
        const pending = f.adapter.createOrder(
          f.mutation(),
          f.context(mode === 'deadline' ? 350 : 1500, controller.signal),
        );
        await until(() => f.mutations.length === 1);
        if (mode === 'abort') controller.abort('sensitive-reason-must-not-escape');
        expect(await within(pending)).toMatchObject({
          kind: 'UNKNOWN',
          error: { code: 'UNKNOWN_OUTCOME' },
        });
        await until(() => f.sockets.size === 0 && f.settled() > before);
        expect(f.mutations).toHaveLength(1);
        const recovered = await within(
          f.adapter.getOrder(
            { instrumentId: 'BTCUSDT', locator: { kind: 'CLIENT_ID', id: CLIENT_ID } },
            f.context(),
          ),
        );
        expect(recovered).toMatchObject({
          ok: true,
          value: {
            kind: 'FOUND',
            order: { clientOrderId: CLIENT_ID, exchangeOrderId: EXCHANGE_ID },
          },
        });
        expect(f.mutations).toHaveLength(1);
        await until(() => f.sockets.size === 0);
      },
    );
    it.each(['deadline', 'abort'] as const)(
      `releases every pending slot after 16 ticker requests in ${stage} %s`,
      async (mode) => {
        const f = await setup(stage);
        f.hangTicker(true);
        const controller = new AbortController();
        const before = f.settled();
        const pending = Array.from({ length: 16 }, () =>
          f.adapter.getTicker(
            { instrumentId: 'BTCUSDT' },
            f.context(mode === 'deadline' ? 350 : 1500, controller.signal),
          ),
        );
        await expect(
          f.adapter.getTicker({ instrumentId: 'BTCUSDT' }, f.context()),
        ).resolves.toEqual({ ok: false, error: { code: 'BUSY' } });
        await until(
          () =>
            f.calls.filter((value) => value.url.pathname === '/api/v3/ticker/24hr').length === 16,
        );
        if (mode === 'abort') controller.abort();
        const code = mode === 'deadline' ? 'DEADLINE_EXCEEDED' : 'ABORTED';
        expect(await within(Promise.all(pending))).toEqual(
          Array.from({ length: 16 }, () => ({ ok: false, error: { code } })),
        );
        await until(() => f.settled() === before + 16 && f.sockets.size === 0);
        f.hangTicker(false);
        const recovered = await within(
          Promise.all(
            Array.from({ length: 16 }, () =>
              f.adapter.getTicker({ instrumentId: 'BTCUSDT' }, f.context()),
            ),
          ),
        );
        expect(recovered.every((result) => result.ok)).toBe(true);
        await until(() => f.settled() === before + 32 && f.sockets.size === 0);
        expect(
          f.calls.filter((value) => value.url.pathname === '/api/v3/ticker/24hr'),
        ).toHaveLength(32);
      },
    );
  }
  it('refuses LIVE mutation before private signing, time synchronization, or POST', async () => {
    const f = await setup('ACCEPT', true);
    const before = f.calls.length;
    expect(await within(f.adapter.createOrder(f.mutation(), f.context()))).toEqual({
      kind: 'DEFINITIVELY_REJECTED',
      error: { code: 'LIVE_DISABLED' },
    });
    expect(f.calls).toHaveLength(before);
    expect(f.credential).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.sandbox).not.toHaveBeenCalled();
    expect(f.mutations).toHaveLength(0);
  });
  it('does not POST an already aborted or expired authorized command', async () => {
    const f = await setup();
    const controller = new AbortController();
    controller.abort();
    const before = f.calls.length;
    expect(await f.adapter.createOrder(f.mutation(), f.context(1000, controller.signal))).toEqual({
      kind: 'DEFINITIVELY_REJECTED',
      error: { code: 'ABORTED' },
    });
    expect(
      await f.adapter.createOrder(f.mutation(), { ...f.context(), deadline: Date.now() - 1 }),
    ).toEqual({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'DEADLINE_EXCEEDED' } });
    expect(f.calls).toHaveLength(before);
    expect(f.mutations).toHaveLength(0);
  });
  it.each(['abort', 'deadline', 'unsubscribe', 'disconnect'] as const)(
    'closes a real market WS after %s and emits no later DATA',
    async (mode) => {
      const f = await setup();
      const controller = new AbortController();
      const result = await within(
        f.adapter.subscribeTicker(
          { instrumentId: 'BTCUSDT' },
          f.context(mode === 'deadline' ? 350 : 1500, controller.signal),
        ),
      );
      if (!result.ok) throw new Error('LOCAL_WS_SUBSCRIPTION_REFUSED');
      const iterator = result.value[Symbol.asyncIterator]();
      await until(() => f.wsConnections.length === 1);
      const socket = f.wsConnections[0]!;
      socket.send(
        JSON.stringify({
          stream: 'btcusdt@ticker',
          data: {
            e: '24hrTicker',
            E: Date.now(),
            s: 'BTCUSDT',
            c: '100.12000000',
            b: '100.11000000',
            a: '100.13000000',
            v: '12.34000000',
            q: '1234.56000000',
            p: '-0.01000000',
          },
        }),
      );
      expect(await within(iterator.next())).toMatchObject({
        done: false,
        value: { kind: 'DATA', data: { last: { state: 'AVAILABLE', value: '100.12' } } },
      });
      if (mode === 'abort') controller.abort();
      else if (mode === 'unsubscribe') await result.value.unsubscribe();
      else if (mode === 'disconnect') await within(f.adapter.disconnect());
      const terminal = await within(iterator.next());
      expect(terminal).toMatchObject({ done: false, value: { kind: 'CLOSED' } });
      if (mode === 'abort') expect(terminal.value).toMatchObject({ reason: 'ABORTED' });
      if (mode === 'deadline') expect(terminal.value).toMatchObject({ reason: 'DEADLINE' });
      expect(await within(iterator.next())).toEqual({ done: true, value: undefined });
      await until(() => f.sockets.size === 0);
      expect(socket.readyState).toBe(socket.CLOSED);
      expect(f.wsDestinations).toHaveLength(1);
      expect(f.wsDestinations[0]?.href).toBe(
        'wss://stream.testnet.binance.vision/stream?streams=btcusdt@ticker',
      );
      expect(f.mutations).toHaveLength(0);
    },
  );
  it.each(['abort', 'deadline'] as const)(
    'releases all 16 Core and network slots after %s of hung actual WS handshakes',
    async (mode) => {
      const f = await setup();
      f.hangHandshake(true);
      const controller = new AbortController();
      const pending = Array.from({ length: 16 }, () =>
        f.adapter.subscribeTicker(
          { instrumentId: 'BTCUSDT' },
          f.context(mode === 'deadline' ? 350 : 1500, controller.signal),
        ),
      );
      await expect(
        f.adapter.subscribeTicker({ instrumentId: 'BTCUSDT' }, f.context()),
      ).resolves.toEqual({ ok: false, error: { code: 'BUSY' } });
      await until(() => f.sockets.size === 16);
      if (mode === 'abort') controller.abort();
      const results = await within(Promise.all(pending));
      expect(
        results.every(
          (result) =>
            !result.ok &&
            (mode === 'abort'
              ? result.error.code === 'ABORTED'
              : ['DEADLINE_EXCEEDED', 'UNAVAILABLE'].includes(result.error.code)),
        ),
      ).toBe(true);
      await until(() => f.wsSettled() === 16 && f.sockets.size === 0);
      expect(f.wsConnections).toHaveLength(0);
      f.hangHandshake(false);
      const recovered = await within(
        Promise.all(
          Array.from({ length: 16 }, () =>
            f.adapter.subscribeTicker({ instrumentId: 'BTCUSDT' }, f.context()),
          ),
        ),
      );
      expect(recovered.every((result) => result.ok)).toBe(true);
      await Promise.all(
        recovered.map((result) => (result.ok ? result.value.unsubscribe() : Promise.resolve())),
      );
      await until(() => f.wsSettled() === 32 && f.sockets.size === 0);
      expect(f.wsConnections).toHaveLength(16);
      expect(f.wsDestinations).toHaveLength(32);
    },
  );
  it('reports real source loss as terminal RESYNC_REQUIRED and opens no replacement connection', async () => {
    const f = await setup();
    const result = await f.adapter.subscribeTicker({ instrumentId: 'BTCUSDT' }, f.context());
    if (!result.ok) throw new Error('LOCAL_WS_SUBSCRIPTION_REFUSED');
    const iterator = result.value[Symbol.asyncIterator]();
    await until(() => f.wsConnections.length === 1);
    f.wsConnections[0]!.terminate();
    expect(await within(iterator.next())).toEqual({
      done: false,
      value: { kind: 'RESYNC_REQUIRED', reason: 'SOURCE_GAP' },
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    await until(() => f.sockets.size === 0);
    expect(f.wsDestinations).toHaveLength(1);
  });
});
