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
import { createOkxAdapterWithIo } from '../src/adapter.js';
import { adapterProfile, getOkxProfile, type OkxProfileId } from '../src/profiles.js';
import type { OkxAdapterOptions, OkxRateLimitPort } from '../src/ports.js';
import type { HttpRequest, HttpResponse, NetworkIo, NetworkSocket } from '../src/io.js';
import { nativeInstrument, nativeOrder, account, identity, now } from './fixtures.js';
export function harness(
  profileId: OkxProfileId = 'okx-spot-demo-v1',
  overrides: { [K in keyof OkxAdapterOptions]?: OkxAdapterOptions[K] | undefined } = {},
) {
  const endpoint = getOkxProfile(profileId),
    swap = endpoint.instType === 'SWAP',
    profile = adapterProfile(endpoint, 'fixture-reference'),
    symbol = swap ? 'BTC-USDT-SWAP' : 'BTC-USDT';
  const state: {
    time: number;
    instrument: Record<string, unknown>;
    config: Record<string, unknown>;
    nativeOrder: Record<string, unknown>;
    route?: ((input: HttpRequest) => Promise<HttpResponse> | HttpResponse) | undefined;
    message?: (text: string) => void;
    ended?: () => void;
    controls: Record<string, unknown>[];
    socketClosed: number;
  } = {
    time: now,
    instrument: nativeInstrument(swap),
    config: {
      uid: account.externalAccountId,
      acctLv: '2',
      posMode: 'net_mode',
      perm: 'read_only,trade',
      autoLoan: false,
      roleType: '0',
      spotRoleType: '0',
      stgyType: '0',
    },
    nativeOrder: nativeOrder(swap),
    controls: [],
    socketClosed: 0,
  };
  const response = (data: unknown, code = 0, status = 200): HttpResponse => ({
    status,
    headers: {},
    body: JSON.stringify({ code: String(code), msg: 'DO_NOT_EXPOSE', data }),
  });
  function native(input: HttpRequest): HttpResponse {
    const path = input.url.pathname;
    if (path === '/api/v5/public/time') return response([{ ts: String(state.time) }]);
    if (path === '/api/v5/public/instruments') return response([state.instrument]);
    if (path === '/api/v5/market/ticker')
      return response([
        {
          instId: symbol,
          instType: endpoint.instType,
          last: '50000',
          bidPx: '49999',
          askPx: '50001',
          vol24h: '2',
          volCcy24h: swap ? '0.02' : '100000',
          ts: String(state.time),
        },
      ]);
    if (path === '/api/v5/market/books')
      return response([
        {
          ts: String(state.time),
          seqId: 10,
          bids: [['49999', '2', '0', '1']],
          asks: [['50001', '1', '0', '1']],
        },
      ]);
    if (path === '/api/v5/market/history-candles') return response([]);
    if (path === '/api/v5/account/config') return response([state.config]);
    if (path === '/api/v5/account/balance')
      return response([
        {
          uTime: String(state.time),
          details: [{ ccy: 'USDT', cashBal: '10', availBal: '8', frozenBal: '2', liab: '0' }],
        },
      ]);
    if (path === '/api/v5/account/positions') return response([]);
    if (path === '/api/v5/trade/order' && input.method === 'POST') {
      const b = JSON.parse(input.body!) as Record<string, unknown>;
      return response([
        { ordId: String(state.nativeOrder.ordId), clOrdId: b.clOrdId, sCode: '0', sMsg: '' },
      ]);
    }
    if (path === '/api/v5/trade/order') return response([state.nativeOrder]);
    if (path === '/api/v5/trade/cancel-order')
      return response([
        {
          ordId: state.nativeOrder.ordId,
          clOrdId: state.nativeOrder.clOrdId,
          sCode: '0',
          sMsg: '',
        },
      ]);
    if (path === '/api/v5/account/set-leverage') {
      const b = JSON.parse(input.body!) as Record<string, unknown>;
      return response([{ instId: symbol, mgnMode: b.mgnMode, lever: b.lever, posSide: 'net' }]);
    }
    if (path === '/api/v5/trade/orders-pending')
      return response([{ ...state.nativeOrder, state: 'live', accFillSz: '0', avgPx: '' }]);
    if (path === '/api/v5/trade/orders-history-archive') return response([state.nativeOrder]);
    if (path === '/api/v5/trade/fills-history') return response([]);
    throw new Error('UNEXPECTED_ROUTE');
  }
  const request = vi.fn((input: HttpRequest) =>
    Promise.resolve(state.route ? state.route(input) : native(input)),
  );
  const socket: NetworkSocket = {
    send: vi.fn<NetworkSocket['send']>((text) => {
      if (text === 'ping') {
        queueMicrotask(() => state.message?.('pong'));
        return Promise.resolve();
      }
      const event = JSON.parse(text) as Record<string, unknown>;
      state.controls.push(event);
      queueMicrotask(() =>
        state.message?.(
          JSON.stringify({
            event: event.op === 'login' ? 'login' : 'subscribe',
            code: '0',
            id: event.id,
            ...(event.op === 'subscribe' ? { arg: (event.args as unknown[])[0] } : {}),
          }),
        ),
      );
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      state.socketClosed++;
      return Promise.resolve();
    }),
  };
  const openSocket = vi.fn<NetworkIo['openSocket']>((_url, _context, message, ended) => {
    state.message = message;
    state.ended = ended;
    return Promise.resolve(socket);
  });
  const io: NetworkIo = {
    request,
    openSocket,
    close: vi.fn(async () => {}),
  };
  const limiter = {
      reserve: vi.fn<OkxRateLimitPort['reserve']>(() => Promise.resolve(true)),
      observe: vi.fn<OkxRateLimitPort['observe']>(async () => {}),
    },
    admission = { validate: vi.fn(() => Promise.resolve(true)) },
    authorization = { authorize: vi.fn(() => Promise.resolve(true)) },
    sandbox = { authorize: vi.fn(() => Promise.resolve(true)) };
  const credentials = {
    resolve: vi.fn(() =>
      Promise.resolve({
        profileId,
        account,
        apiKey: 'fixture-key',
        secret: 'fixture-secret',
        passphrase: 'fixture-passphrase',
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
        canTrade: true,
        withdrawalEnabled: false,
        checkedAt: state.time,
        expiresAt: state.time + 10000,
      }),
    ),
  };
  const options = {
    profileId,
    symbols: [symbol],
    capabilities: featureSchema.options.map((feature) => ({
      profile,
      feature,
      support: 'SUPPORTED',
      implementation: 'NATIVE',
      constraints: {},
      evidenceUrl: 'https://www.okx.com/docs-v5/en/',
      checkedAt: state.time - 1,
      expiresAt: state.time + 30000,
      adapterVersion: 'okx-v1',
    })),
    limiter,
    connection: { resolve: () => ({ account, credentialRef: 'fixture-reference' }) },
    credentials,
    permissions,
    authorization,
    sandboxAcceptance: sandbox,
    orderAdmission: admission,
    identities: {
      order: () => identity,
      fill: () => ({ internalOrderId: identity.internalOrderId }),
    },
    now: () => state.time,
    ...overrides,
  } as OkxAdapterOptions;
  const adapter = createOkxAdapterWithIo(options, io);
  const context = (signal = new AbortController().signal): RequestContext => ({
    profile: adapter.profile,
    account: adapter.account,
    deadline: state.time + 5000,
    signal,
    correlationId: 'okx-contract',
  });
  const order = (version = 'INITIAL_RULES'): NewOrder => ({
    instrumentId: symbol,
    ruleVersion: version,
    clientOrderId: 'Client1',
    side: 'BUY',
    type: 'MARKET',
    size: swap
      ? { kind: 'CONTRACTS', value: parseDecimal('2'), contractSpecVersion: version }
      : { kind: 'BASE_QUANTITY', value: parseDecimal('0.01'), asset: 'BTC' },
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
    const x = await adapter.getSymbols(
      { limit: 200, cursor: null, queryId: 'metadata' },
      context(),
    );
    if (!x.ok) throw new Error(x.error.code);
    return x.value.items[0]!.metadataVersion;
  }
  function signed(input: HttpRequest) {
    return (
      input.headers?.['OK-ACCESS-SIGN'] ===
        createHmac('sha256', 'fixture-secret')
          .update(
            String(input.headers?.['OK-ACCESS-TIMESTAMP']) +
              input.method +
              input.url.pathname +
              input.url.search +
              (input.body ?? ''),
          )
          .digest('base64') && input.headers?.['OK-ACCESS-PASSPHRASE'] === 'fixture-passphrase'
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
    openSocket,
    socket,
    options,
    credentials,
    permissions,
    authorization,
    sandbox,
    admission,
    limiter,
    signed,
    symbol,
  };
}
