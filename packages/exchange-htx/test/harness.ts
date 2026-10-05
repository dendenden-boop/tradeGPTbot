import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import {
  createInstrumentRegistry,
  featureSchema,
  parseDecimal,
  computeCommandHash,
  type NewOrder,
  type RequestContext,
} from '@ctp/exchange-core';
import { createHtxAdapterWithIo } from '../src/adapter.js';
import { adapterProfile, getHtxProfile, type HtxProfileId } from '../src/profiles.js';
import type { HtxAdapterOptions, HtxRateRequest } from '../src/ports.js';
import type { HttpRequest, HttpResponse, NetworkIo, NetworkSocket, IoContext } from '../src/io.js';
import { now, spot, swap, account, identity, spotOrder, linearOrder } from './fixtures.js';
export function harness(
  profileId: HtxProfileId = 'htx-spot-live-v1',
  overrides: { [K in keyof HtxAdapterOptions]?: HtxAdapterOptions[K] | undefined } = {},
) {
  const endpoint = getHtxProfile(profileId),
    profile = adapterProfile(endpoint, 'fixture-reference'),
    symbol = endpoint.spot ? 'btcusdt' : 'BTC-USDT';
  const state: {
    time: number;
    instrument: Record<string, unknown>;
    order: Record<string, unknown>;
    orders: Record<string, unknown>[];
    fills: Record<string, unknown>[];
    uid: string;
    accountType: number;
    positionMode: string;
    route?: ((request: HttpRequest) => HttpResponse | Promise<HttpResponse>) | undefined;
    message?: (text: string) => void;
    ended?: () => void;
    controls: Record<string, unknown>[];
    socketClosed: number;
    ack: boolean;
  } = {
    time: now,
    instrument: { ...(endpoint.spot ? spot : swap) },
    order: { ...(endpoint.spot ? spotOrder : linearOrder) },
    orders: [],
    fills: [],
    uid: account.externalAccountId,
    accountType: 1,
    positionMode: 'dual_side',
    controls: [],
    socketClosed: 0,
    ack: true,
  };
  const response = (data: unknown, extras: Record<string, unknown> = {}): HttpResponse => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ status: 'ok', data, ts: state.time, ...extras }),
  });
  function native(r: HttpRequest): HttpResponse {
    const path = r.url.pathname;
    if (path === '/v1/common/timestamp') return response(state.time);
    if (path === '/api/v1/timestamp') return response(undefined);
    if (
      path === '/v1/settings/common/market-symbols' ||
      path === '/linear-swap-api/v1/swap_contract_info'
    )
      return response([state.instrument], { full: 1 });
    if (path.endsWith('/market/detail/merged'))
      return response(undefined, {
        ch: `market.${symbol}.detail.merged`,
        tick: {
          close: '50000',
          bid: ['49999', '1'],
          ask: ['50001', '1'],
          amount: '2',
          vol: '100000',
        },
      });
    if (path.endsWith('/market/depth'))
      return response(undefined, {
        ch: `market.${symbol}.depth.step0`,
        tick: { ts: state.time, version: '100', bids: [['49999', '2']], asks: [['50001', '3']] },
      });
    if (path.endsWith('/market/history/kline'))
      return response([], { ch: `market.${symbol}.kline.${r.url.searchParams.get('period')}` });
    if (path === '/v2/user/uid') return response(state.uid, { code: 200 });
    if (path === '/v1/account/accounts')
      return response([{ id: '123', type: 'spot', state: 'working' }]);
    if (path.endsWith('/balance'))
      return response({
        id: '123',
        type: 'spot',
        state: 'working',
        list: [
          { currency: 'usdt', type: 'trade', balance: '8' },
          { currency: 'usdt', type: 'frozen', balance: '2' },
        ],
      });
    if (path.endsWith('swap_unified_account_type'))
      return response({ account_type: state.accountType }, { code: 200 });
    if (path.endsWith('swap_cross_account_info'))
      return response([
        {
          margin_mode: 'cross',
          margin_account: 'USDT',
          margin_asset: 'USDT',
          position_mode: state.positionMode,
          margin_balance: '10',
          margin_static: '10',
          profit_unreal: '0',
        },
      ]);
    if (path.endsWith('swap_cross_position_info')) return response([]);
    if (path === '/v1/order/openOrders') return response(state.orders);
    if (path.endsWith('swap_cross_openorders'))
      return response({
        orders: state.orders,
        total_page: 1,
        current_page: 1,
        total_size: state.orders.length,
      });
    if (path.endsWith('swap_cross_order_info')) return response([state.order]);
    if (path.startsWith('/v1/order/orders/') && path !== '/v1/order/orders')
      return response(state.order);
    const body = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
    if (path.endsWith('matchresults'))
      return response(
        r.url.searchParams.has('from') || body.from_id !== undefined ? [] : state.fills,
        { code: endpoint.spot ? undefined : 200 },
      );
    if (path === '/v1/order/orders' || path.endsWith('swap_cross_hisorders'))
      return response(
        r.url.searchParams.has('from') || body.from_id !== undefined ? [] : state.orders,
        { code: endpoint.spot ? undefined : 200 },
      );
    throw new Error('UNEXPECTED_FIXTURE_ROUTE');
  }
  const request = vi.fn(async (r: HttpRequest) => (state.route ? state.route(r) : native(r)));
  const openSocket = vi.fn(
    async (
      _url: URL,
      _context: Parameters<NetworkIo['openSocket']>[1],
      onMessage: (text: string) => void,
      onEnd: () => void,
    ): Promise<NetworkSocket> => {
      await Promise.resolve();
      state.message = onMessage;
      state.ended = onEnd;
      return {
        async send(text) {
          await Promise.resolve();
          const x = JSON.parse(text) as Record<string, unknown>;
          state.controls.push(x);
          if (!state.ack) return;
          if (x.sub !== undefined)
            onMessage(JSON.stringify({ status: 'ok', subbed: x.sub, id: x.id, ts: state.time }));
          else if (x.action === 'req' && x.ch === 'auth')
            onMessage(JSON.stringify({ action: 'req', ch: 'auth', code: 200, data: {} }));
          else if (x.op === 'auth')
            onMessage(JSON.stringify({ op: 'auth', 'err-code': 0, data: { uid: state.uid } }));
          else if (x.action === 'sub')
            onMessage(JSON.stringify({ action: 'sub', ch: x.ch, code: 200, data: {} }));
          else if (x.op === 'sub')
            onMessage(JSON.stringify({ op: 'sub', topic: x.topic, cid: x.cid, 'err-code': 0 }));
          else if (x.req !== undefined)
            onMessage(JSON.stringify({ status: 'ok', rep: x.req, id: x.id, data: [] }));
        },
        close() {
          state.socketClosed++;
          return Promise.resolve();
        },
      };
    },
  );
  const limiter = {
    reserve: vi.fn<(request: HtxRateRequest, context: IoContext) => Promise<boolean>>(() =>
      Promise.resolve(true),
    ),
    observe: vi.fn(() => Promise.resolve()),
  };
  const permissions = {
    verify: vi.fn(() =>
      Promise.resolve({
        profileId,
        account,
        credentialRef: 'fixture-reference',
        accountMode: endpoint.spot ? ('SPOT_CASH' as const) : ('SINGLE_ASSET_CROSS_HEDGE' as const),
        canRead: true,
        canTrade: true,
        withdrawalEnabled: false,
        checkedAt: state.time,
        expiresAt: state.time + 30000,
      }),
    ),
  };
  const credentials = {
    resolve: vi.fn(() =>
      Promise.resolve({
        profileId,
        account,
        apiKey: 'fixture-key',
        secret: 'fixture-secret',
      }),
    ),
  };
  const options = {
    profileId,
    symbols: [symbol],
    capabilities: featureSchema.options.map((feature) => ({
      profile,
      feature,
      support: 'SUPPORTED' as const,
      implementation: 'NATIVE' as const,
      constraints: {},
      evidenceUrl: 'https://huobiapi.github.io/docs/spot/v1/en/',
      checkedAt: now,
      expiresAt: now + 86400000,
      adapterVersion: 'htx-v1',
    })),
    limiter,
    registry: createInstrumentRegistry({ capacity: 300 }),
    connection: {
      resolve: () => ({
        account,
        credentialRef: 'fixture-reference',
        ...(endpoint.spot ? { spotAccountId: '123' } : {}),
      }),
    },
    credentials,
    permissions,
    identities: { order: () => identity, fill: () => identity },
    now: () => state.time,
    ...overrides,
  } as HtxAdapterOptions;
  const io: NetworkIo = { request, openSocket, close: vi.fn(async () => {}) },
    adapter = createHtxAdapterWithIo(options, io);
  const context = (milliseconds = 2000): RequestContext => ({
    profile: adapter.profile,
    account: adapter.account,
    deadline: state.time + milliseconds,
    signal: new AbortController().signal,
    correlationId: randomUUID(),
  });
  const warm = async () => {
    const result = await adapter.getSymbols(
      { limit: 200, cursor: null, queryId: randomUUID() },
      context(),
    );
    if (!result.ok) throw new Error(result.error.code);
    const r = options.registry.get(endpoint.scope, symbol, state.time);
    if (!r.ok) throw new Error(r.error.code);
    return r.value;
  };
  const order = (ruleVersion: string): NewOrder => ({
    instrumentId: symbol,
    ruleVersion,
    clientOrderId: endpoint.spot ? 'Client1' : '123456',
    side: 'SELL',
    type: 'LIMIT',
    size: endpoint.spot
      ? { kind: 'BASE_QUANTITY', value: parseDecimal('0.01'), asset: 'BTC' }
      : {
          kind: 'CONTRACTS',
          value: parseDecimal('2'),
          contractSpecVersion: options.registry.get(endpoint.scope, symbol, state.time).ok
            ? (
                options.registry.get(endpoint.scope, symbol, state.time) as {
                  ok: true;
                  value: { instrument: { contract: { version: string } } };
                }
              ).value.instrument.contract.version
            : 'missing',
        },
    limitPrice: parseDecimal('50000'),
    trigger: null,
    timeInForce: 'GTC',
    reduceOnly: false,
  });
  const permit = (command: NewOrder) => ({
    command,
    authorization: {
      commandId: randomUUID(),
      commandHash: computeCommandHash('createOrder', command, { profile, account }),
      dispatchAttemptId: randomUUID(),
      profile,
      account,
      issuedAt: state.time,
      expiresAt: state.time + 1000,
    },
  });
  return {
    adapter,
    options,
    io,
    request,
    openSocket,
    limiter,
    permissions,
    credentials,
    state,
    native,
    response,
    context,
    warm,
    order,
    permit,
    emit: (raw: unknown) => state.message?.(JSON.stringify(raw)),
    symbol,
    endpoint,
  };
}
