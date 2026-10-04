import { createHmac, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import {
  computeCommandHash,
  featureSchema,
  parseDecimal,
  type Authorization,
  type NewOrder,
  type OperationInput,
  type MutationOperation,
  type RequestContext,
} from '@ctp/exchange-core';
import { createBybitAdapterWithIo } from '../src/adapter.js';
import { adapterProfile, getBybitProfile, type BybitProfileId } from '../src/profiles.js';
import type { BybitAdapterOptions, BybitRateLimitPort } from '../src/ports.js';
import type { HttpRequest, HttpResponse, NetworkIo, NetworkSocket } from '../src/io.js';
import { nativeInstrument, nativeOrder, account, now } from './fixtures.js';

export function harness(
  profileId: BybitProfileId = 'bybit-spot-testnet-v1',
  overrides: Partial<BybitAdapterOptions> = {},
) {
  const endpoint = getBybitProfile(profileId),
    linear = endpoint.category === 'linear',
    profile = adapterProfile(endpoint, 'fixture-reference');
  const state: {
    time: number;
    instrument: Record<string, unknown>;
    margin: string;
    uta: number;
    positionIdx: number;
    readonly: boolean;
    permissionWithdrawal: boolean;
    nativeOrder: Record<string, unknown>;
    route?: ((input: HttpRequest) => Promise<HttpResponse> | HttpResponse) | undefined;
    message?: (text: string) => void;
    ended?: () => void;
    controls: Record<string, unknown>[];
    socketClosed: number;
  } = {
    time: now,
    instrument: nativeInstrument(linear),
    margin: 'REGULAR_MARGIN',
    uta: 5,
    positionIdx: 0,
    readonly: false,
    permissionWithdrawal: false,
    nativeOrder: nativeOrder(linear),
    controls: [],
    socketClosed: 0,
  };
  const response = (result: unknown, code = 0, status = 200): HttpResponse => ({
    status,
    headers: {
      'x-bapi-limit': '10',
      'x-bapi-limit-status': '9',
      'x-bapi-limit-reset-timestamp': String(state.time),
    },
    body: JSON.stringify({
      retCode: code,
      retMsg: 'DO_NOT_EXPOSE_PRIVATE_MESSAGE',
      result,
      time: state.time,
    }),
  });
  const request = vi.fn(async (input: HttpRequest): Promise<HttpResponse> => {
    if (state.route) {
      const result = await state.route(input);
      return result;
    }
    return native(input);
  });
  function native(input: HttpRequest): HttpResponse {
    switch (input.url.pathname) {
      case '/v5/market/time':
        return response({ timeSecond: String(Math.floor(state.time / 1000)) });
      case '/v5/market/instruments-info':
        return response({
          category: endpoint.category,
          list: [state.instrument],
          nextPageCursor: '',
        });
      case '/v5/market/tickers':
        return response({
          category: endpoint.category,
          list: [
            {
              symbol: 'BTCUSDT',
              lastPrice: '50000',
              bid1Price: '49999',
              ask1Price: '50001',
              volume24h: '1',
              turnover24h: '50000',
            },
          ],
        });
      case '/v5/market/orderbook':
        return response({
          s: 'BTCUSDT',
          u: 1,
          seq: 1,
          ts: state.time,
          b: [['49999', '1']],
          a: [['50001', '1']],
        });
      case '/v5/market/kline':
        return response({ category: endpoint.category, symbol: 'BTCUSDT', list: [] });
      case '/v5/account/info':
        return response({
          unifiedMarginStatus: state.uta,
          marginMode: state.margin,
          spotHedgingStatus: 'OFF',
          isMasterTrader: false,
        });
      case '/v5/account/wallet-balance':
        return response({
          list: [
            {
              accountType: 'UNIFIED',
              coin: [{ coin: 'USDT', walletBalance: '10', spotBorrow: '0', locked: '0' }],
            },
          ],
        });
      case '/v5/position/list':
        return response({
          category: 'linear',
          nextPageCursor: '',
          list: [
            {
              symbol: 'BTCUSDT',
              positionIdx: state.positionIdx,
              side: '',
              size: '0',
              avgPrice: '0',
              leverage: '10',
              liqPrice: '',
              updatedTime: String(state.time),
            },
          ],
        });
      case '/v5/order/create': {
        const body = JSON.parse(input.body ?? '{}') as Record<string, unknown>;
        return response({ orderId: 'native-order-1', orderLinkId: body.orderLinkId });
      }
      case '/v5/order/cancel':
        return response({ orderId: 'native-order-1', orderLinkId: state.nativeOrder.orderLinkId });
      case '/v5/position/set-leverage':
        return response({});
      case '/v5/order/realtime':
      case '/v5/order/history':
        return response({
          category: endpoint.category,
          list: [state.nativeOrder],
          nextPageCursor: '',
        });
      case '/v5/execution/list':
        return response({ category: endpoint.category, list: [], nextPageCursor: '' });
      default:
        throw new Error('UNEXPECTED_ROUTE');
    }
  }
  const socket: NetworkSocket = {
    send: vi.fn<NetworkSocket['send']>((text) => {
      const event = JSON.parse(text) as Record<string, unknown>;
      state.controls.push(event);
      queueMicrotask(() =>
        state.message?.(JSON.stringify({ op: event.op, success: true, req_id: event.req_id })),
      );
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      state.socketClosed++;
      return Promise.resolve();
    }),
  };
  const io: NetworkIo = {
    request,
    openSocket: vi.fn<NetworkIo['openSocket']>((_url, _context, message, ended) => {
      state.message = message;
      state.ended = ended;
      return Promise.resolve(socket);
    }),
    close: vi.fn(() => Promise.resolve()),
  };
  const limiter = {
    reserve: vi.fn<BybitRateLimitPort['reserve']>(() => Promise.resolve(true)),
    observe: vi.fn<BybitRateLimitPort['observe']>(() => Promise.resolve()),
  };
  const admission = { validate: vi.fn(() => Promise.resolve(true)) };
  const authorization = { authorize: vi.fn(() => Promise.resolve(true)) };
  const sandbox = { authorize: vi.fn(() => Promise.resolve(true)) };
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
  const permissions = {
    verify: vi.fn(() =>
      Promise.resolve({
        profileId,
        account,
        credentialRef: 'fixture-reference',
        canRead: true,
        canTrade: !state.readonly,
        withdrawalEnabled: state.permissionWithdrawal,
        checkedAt: state.time,
        expiresAt: state.time + 10_000,
      }),
    ),
  };
  const options: BybitAdapterOptions = {
    profileId,
    symbols: ['BTCUSDT'],
    capabilities: featureSchema.options.map((feature) => ({
      profile,
      feature,
      support: 'SUPPORTED',
      implementation: 'NATIVE',
      constraints: {},
      evidenceUrl: 'https://bybit-exchange.github.io/docs/v5/guide',
      checkedAt: state.time - 1,
      expiresAt: state.time + 30_000,
      adapterVersion: 'bybit-v1',
    })),
    limiter,
    connection: { resolve: () => ({ account, credentialRef: 'fixture-reference' }) },
    credentials,
    permissions,
    authorization,
    sandboxAcceptance: sandbox,
    orderAdmission: admission,
    identities: {
      order: () => ({
        internalOrderId: '33333333-3333-4333-8333-333333333333',
        intentId: '44444444-4444-4444-8444-444444444444',
      }),
      fill: () => ({ internalOrderId: '33333333-3333-4333-8333-333333333333' }),
    },
    now: () => state.time,
    ...overrides,
  };
  const adapter = createBybitAdapterWithIo(options, io);
  const context = (signal = new AbortController().signal): RequestContext => ({
    profile: adapter.profile,
    account: adapter.account,
    deadline: state.time + 5000,
    signal,
    correlationId: 'bybit-contract',
  });
  const order = (): NewOrder => ({
    instrumentId: 'BTCUSDT',
    ruleVersion: 'INITIAL_RULES',
    clientOrderId: 'client-1',
    side: 'BUY',
    type: 'MARKET',
    size: { kind: 'BASE_QUANTITY', value: parseDecimal('0.01'), asset: 'BTC' },
    limitPrice: null,
    trigger: null,
    timeInForce: null,
    reduceOnly: false,
  });
  const permit = <K extends MutationOperation>(
    operation: K,
    command: OperationInput<K> extends { command: infer C } ? C : never,
  ): { authorization: Authorization; command: typeof command } => ({
    authorization: {
      commandId: randomUUID(),
      dispatchAttemptId: randomUUID(),
      commandHash: computeCommandHash(operation, command, { profile: adapter.profile, account }),
      profile: adapter.profile,
      account,
      issuedAt: state.time,
      expiresAt: state.time + 5000,
    },
    command,
  });
  async function warm() {
    const result = await adapter.getSymbols(
      { limit: 200, cursor: null, queryId: 'metadata' },
      context(),
    );
    if (!result.ok) throw new Error(result.error.code);
    const instrument = result.value.items[0];
    if (!instrument) throw new Error('MISSING_INSTRUMENT');
    return instrument.metadataVersion;
  }
  function signed(input: HttpRequest) {
    const timestamp = input.headers?.['X-BAPI-TIMESTAMP'];
    const payload = input.method === 'GET' ? input.url.searchParams.toString() : (input.body ?? '');
    return (
      input.headers?.['X-BAPI-SIGN'] ===
      createHmac('sha256', 'fixture-secret')
        .update(`${timestamp}fixture-key5000${payload}`)
        .digest('hex')
    );
  }
  return {
    adapter,
    state,
    context,
    order,
    permit,
    warm,
    response,
    native,
    request,
    io,
    socket,
    options,
    credentials,
    permissions,
    authorization,
    sandbox,
    admission,
    limiter,
    signed,
  };
}
