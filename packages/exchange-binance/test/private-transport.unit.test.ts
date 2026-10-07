import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { RequestContext, MutationOutcome } from '@ctp/exchange-core';
import { computeCommandHash } from '@ctp/exchange-core';
import { accountSnapshotSchema } from '@ctp/exchange-core';
import { createPrivateTransport } from '../src/private-transport.js';
import { createPrivateStreams } from '../src/private-streams.js';
import { createBinanceSigner } from '../src/auth.js';
import { createRestClient, BinanceProtocolError } from '../src/client.js';
import type { NetworkIo, HttpRequest } from '../src/io.js';
import { adapterProfile, getBinanceProfile } from '../src/profiles.js';
import { normalizeBinanceAdmission } from '../src/public-data.js';
import {
  ACCOUNT,
  INTERNAL_ORDER_ID,
  INTENT_ID,
  INTERNAL_ALGO_ID,
  privateRecord,
  spotAccount,
  futuresBalances,
  order,
  fill,
  position,
  newOrder,
} from './fixtures/private-data.js';
import { NOW, spotSymbol, futuresSymbol } from './fixtures/public-data.js';

type FixtureResponse = { status?: number; data?: unknown; failure?: Error };
function harness(
  futures = false,
  responses: FixtureResponse[] = [],
  clock: () => number = () => NOW,
  amend = false,
) {
  const endpoint = getBinanceProfile(
    futures ? 'binance-usdm-testnet-v1' : 'binance-spot-testnet-v1',
  );
  const binding = { profileId: endpoint.id, account: ACCOUNT, credentialRef: 'vault-fixture' };
  const calls: HttpRequest[] = [];
  const io: NetworkIo = {
    request: vi.fn((req: HttpRequest) => {
      calls.push(req);
      const response = responses.shift() ?? { data: order(futures) };
      if (response.failure) return Promise.reject(response.failure);
      return Promise.resolve({
        status: response.status ?? 200,
        headers: {},
        body: JSON.stringify(response.data),
      });
    }),
    openSocket: vi.fn(() => Promise.reject(new Error('UNUSED'))),
    close: vi.fn(() => Promise.resolve()),
  };
  const limiter = {
    reserve: vi.fn(() => Promise.resolve(true)),
    observe: vi.fn(() => Promise.resolve()),
  };
  const client = createRestClient(endpoint, io, limiter, ACCOUNT, clock);
  const credentials = {
    resolve: vi.fn(() =>
      Promise.resolve({
        profileId: endpoint.id,
        account: ACCOUNT,
        apiKey: 'fixture-key',
        secret: 'fixture-secret',
      }),
    ),
  };
  const signer = createBinanceSigner(
    endpoint,
    binding,
    credentials,
    () => ({ serverTime: NOW, sampledAt: NOW, roundTripMs: 0 }),
    clock,
  );
  const identities = {
    order: vi.fn(() => ({ internalOrderId: INTERNAL_ORDER_ID, intentId: INTENT_ID })),
    algo: vi.fn(() => ({ internalAlgoId: INTERNAL_ALGO_ID })),
    fill: vi.fn(() => ({ internalOrderId: INTERNAL_ORDER_ID })),
  };
  const orderAdmission = { validate: vi.fn(() => Promise.resolve(true)) };
  const syncTime = vi.fn(() => Promise.resolve());
  const options = {
    endpoint,
    binding,
    signer,
    client,
    record: () => privateRecord(futures),
    admission: () =>
      normalizeBinanceAdmission(
        futures ? futuresSymbol() : { ...spotSymbol(), amendAllowed: amend },
      ),
    identities,
    orderAdmission,
    now: clock,
    syncTime,
  };
  const transport = createPrivateTransport(options);
  const context: RequestContext = {
    profile: adapterProfile(endpoint, binding.credentialRef),
    account: ACCOUNT,
    signal: new AbortController().signal,
    deadline: NOW + 1000,
    correlationId: 'fixture',
  };
  function authorized(
    operation: 'createOrder' | 'cancelOrder' | 'setLeverage' | 'amendOrder',
    command: unknown,
  ) {
    return {
      command,
      authorization: {
        commandId: '66666666-6666-4666-8666-666666666666',
        dispatchAttemptId: '77777777-7777-4777-8777-777777777777',
        commandHash: computeCommandHash(operation, command, {
          profile: context.profile,
          account: ACCOUNT,
        }),
        profile: context.profile,
        account: ACCOUNT,
        issuedAt: NOW,
        expiresAt: NOW + 1000,
      },
    };
  }
  return {
    transport,
    options,
    context,
    calls,
    io,
    limiter,
    credentials,
    identities,
    orderAdmission,
    syncTime,
    authorized,
  };
}
const page = { instrumentId: 'BTCUSDT', limit: 2, cursor: null, queryId: 'q1' };
const history = { ...page, from: NOW - 1000, to: NOW };

function amendCommand() {
  return {
    semantics: 'IN_PLACE',
    identity: { exchangeOrderId: 'PRESERVED', clientOrderId: 'REPLACED' },
    locator: { instrumentId: 'BTCUSDT', locator: { kind: 'EXCHANGE_ID', id: order().orderId } },
    target: {
      internalOrderId: INTERNAL_ORDER_ID,
      placeIntentId: INTENT_ID,
      revision: '9007199254740993',
      observedAt: NOW,
      nativeUpdatedAt: NOW - 10,
      current: newOrder(),
      filledQuantity: '0.025',
    },
    replacement: {
      ...newOrder(),
      clientOrderId: 'fixture-amend-1',
      size: { kind: 'BASE_QUANTITY', value: '0.075', asset: 'BTC' },
    },
  };
}
function amendTarget() {
  return { ...order(), orderListId: '-1', icebergQty: '0', origQuoteOrderQty: '0', usedSor: false };
}
function amendAck() {
  return {
    transactTime: String(NOW),
    executionId: '9007199254740993',
    amendedOrder: {
      symbol: 'BTCUSDT',
      orderId: order().orderId,
      orderListId: '-1',
      origClientOrderId: 'fixture-order-1',
      clientOrderId: 'fixture-amend-1',
      price: '100',
      qty: '0.075',
      executedQty: '0.025',
      preventedQty: '0',
      quoteOrderQty: '0',
      status: 'PARTIALLY_FILLED',
      type: 'LIMIT',
      timeInForce: 'GTC',
      side: 'BUY',
    },
  };
}

describe('Binance explicit native in-place AMEND transport', () => {
  it('preflights standalone native identity and sends a single signed cumulative reduction', async () => {
    const h = harness(false, [{ data: amendTarget() }, { data: amendAck() }], () => NOW, true);
    expect(
      await h.transport.request(
        'amendOrder',
        h.authorized('amendOrder', amendCommand()),
        h.context,
      ),
    ).toMatchObject({
      kind: 'ACCEPTED',
      ack: { status: 'ACKNOWLEDGED', exchangeId: order().orderId },
    });
    expect(h.calls.map((r) => [r.method, r.url.pathname])).toEqual([
      ['GET', '/api/v3/order'],
      ['PUT', '/api/v3/order/amend/keepPriority'],
    ]);
    expect(h.calls[1]!.url.searchParams.get('newQty')).toBe('0.075');
    expect(h.calls[1]!.url.searchParams.get('newClientOrderId')).toBe('fixture-amend-1');
    expect(h.calls[1]!.url.searchParams.get('orderId')).toBe(order().orderId);
    expect(h.calls[1]!.url.searchParams.has('signature')).toBe(true);
  });
  it('denies missing native amend eligibility before private I/O', async () => {
    const h = harness();
    expect(
      await h.transport.request(
        'amendOrder',
        h.authorized('amendOrder', amendCommand()),
        h.context,
      ),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'UNSUPPORTED' } });
    expect(h.calls).toHaveLength(0);
  });
  it.each([
    ['list coupling', { orderListId: '1' }],
    ['missing standalone proof', { orderListId: undefined }],
    ['iceberg', { icebergQty: '0.01' }],
    ['SOR', { usedSor: true }],
    ['trailing constraint', { trailingDelta: '10' }],
    ['native ID replacement', { orderId: '9' }],
    ['client identity replacement', { clientOrderId: 'another-order' }],
    ['partial fill before preflight', { executedQty: '0.026' }],
    ['changed native revision', { updateTime: String(NOW - 1) }],
    ['changed price', { price: '101' }],
    ['changed total quantity', { origQty: '0.09' }],
    ['terminal native order', { status: 'FILLED' }],
  ])('blocks %s before mutation dispatch', async (_name, change) => {
    const h = harness(
      false,
      [{ data: { ...amendTarget(), ...(change as object) } }],
      () => NOW,
      true,
    );
    expect(
      await h.transport.request(
        'amendOrder',
        h.authorized('amendOrder', amendCommand()),
        h.context,
      ),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED' });
    expect(h.calls.map((r) => r.method)).toEqual(['GET']);
  });
  it.each([
    ['racing fill', { executedQty: '0.026' }],
    ['native ID replaced', { orderId: '9' }],
    ['unrelated request ID', { clientOrderId: 'another-amend' }],
    ['partial quantity outcome', { qty: '0.074' }],
    ['order list', { orderListId: '1' }],
    ['terminal race', { status: 'FILLED' }],
  ])('keeps %s UNKNOWN after dispatch without retry', async (_name, change) => {
    const ack = amendAck();
    const h = harness(
      false,
      [
        { data: amendTarget() },
        { data: { ...ack, amendedOrder: { ...ack.amendedOrder, ...(change as object) } } },
      ],
      () => NOW,
      true,
    );
    expect(
      await h.transport.request(
        'amendOrder',
        h.authorized('amendOrder', amendCommand()),
        h.context,
      ),
    ).toMatchObject({ kind: 'UNKNOWN' });
    expect(h.calls.map((r) => r.method)).toEqual(['GET', 'PUT']);
  });
  it.each([
    { status: 503, data: {} },
    { status: 400, data: { code: '-1007' } },
    { status: 400, data: { code: '-2010' } },
    { failure: new Error('socket lost') },
  ])('never retries an ambiguous native mutation outcome %#', async (response) => {
    const h = harness(false, [{ data: amendTarget() }, response], () => NOW, true);
    expect(
      await h.transport.request(
        'amendOrder',
        h.authorized('amendOrder', amendCommand()),
        h.context,
      ),
    ).toMatchObject({ kind: 'UNKNOWN' });
    expect(h.calls).toHaveLength(2);
  });
  it('returns a known native parameter rejection without cancel/create fallback', async () => {
    const h = harness(
      false,
      [{ data: amendTarget() }, { status: 400, data: { code: '-1013' } }],
      () => NOW,
      true,
    );
    expect(
      await h.transport.request(
        'amendOrder',
        h.authorized('amendOrder', amendCommand()),
        h.context,
      ),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'INVALID_REQUEST' } });
    expect(h.calls.map((r) => r.method)).toEqual(['GET', 'PUT']);
  });
  it('rechecks admission after async order admission before sending a mutation', async () => {
    const h = harness(false, [{ data: amendTarget() }], () => NOW, true);
    let eligible = true;
    const transport = createPrivateTransport({
      ...h.options,
      admission: () => normalizeBinanceAdmission({ ...spotSymbol(), amendAllowed: eligible }),
    });
    h.orderAdmission.validate.mockImplementationOnce(() => {
      eligible = false;
      return Promise.resolve(true);
    });
    expect(
      await transport.request('amendOrder', h.authorized('amendOrder', amendCommand()), h.context),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'STALE_METADATA' } });
    expect(h.calls.map((r) => r.method)).toEqual(['GET']);
  });
  it('rechecks AMEND authorization expiry after async admission immediately before PUT', async () => {
    let clock = NOW;
    const h = harness(false, [{ data: amendTarget() }, { data: amendAck() }], () => clock, true);
    h.orderAdmission.validate.mockImplementationOnce(() => {
      clock = NOW + 1001;
      return Promise.resolve(true);
    });
    expect(
      await h.transport.request('amendOrder', h.authorized('amendOrder', amendCommand()), {
        ...h.context,
        deadline: NOW + 5000,
      }),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'AUTHORIZATION_REQUIRED' } });
    expect(h.calls.map((r) => r.method)).toEqual(['GET']);
  });
  it.each(['createOrder', 'cancelOrder'] as const)(
    'rechecks existing %s permit after delayed rate/signing before native dispatch',
    async (operation) => {
      let clock = NOW;
      const h = harness(false, [], () => clock);
      h.limiter.reserve.mockImplementationOnce(() => {
        clock = NOW + 1001;
        return Promise.resolve(true);
      });
      const command =
        operation === 'createOrder'
          ? newOrder()
          : { instrumentId: 'BTCUSDT', locator: { kind: 'EXCHANGE_ID', id: order().orderId } };
      expect(
        await h.transport.request(operation, h.authorized(operation, command), {
          ...h.context,
          deadline: NOW + 5000,
        }),
      ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'AUTHORIZATION_REQUIRED' } });
      expect(h.calls).toHaveLength(0);
    },
  );
  it('denies absent dynamic admission rather than inventing filter budgets', async () => {
    const h = harness(false, [], () => NOW, true);
    const { orderAdmission: _unused, ...options } = h.options;
    void _unused;
    const t = createPrivateTransport(options);
    expect(
      await t.request('amendOrder', h.authorized('amendOrder', amendCommand()), h.context),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'AUTHORIZATION_REQUIRED' } });
    expect(h.calls).toHaveLength(0);
  });
  it('does not invoke transport for a corrupted authorization hash', async () => {
    const h = harness(false, [], () => NOW, true),
      input = h.authorized('amendOrder', amendCommand());
    input.authorization.commandHash = '0'.repeat(64);
    expect(await h.transport.request('amendOrder', input, h.context)).toMatchObject({
      kind: 'DEFINITIVELY_REJECTED',
      error: { code: 'AUTHORIZATION_REQUIRED' },
    });
    expect(h.calls).toHaveLength(0);
  });
  it('rejects a target outside the trusted internal order/PLACE identity mapping', async () => {
    const h = harness(false, [], () => NOW, true);
    h.identities.order.mockReturnValueOnce({
      internalOrderId: '10000000-0000-4000-8000-000000000099',
      intentId: INTENT_ID,
    });
    expect(
      await h.transport.request(
        'amendOrder',
        h.authorized('amendOrder', amendCommand()),
        h.context,
      ),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'AUTHORIZATION_REQUIRED' } });
    expect(h.calls).toHaveLength(0);
  });
  it('bounds hung dynamic AMEND admission on abort and never sends a late mutation', async () => {
    const h = harness(false, [{ data: amendTarget() }], () => NOW, true);
    const controller = new AbortController();
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    h.orderAdmission.validate.mockImplementationOnce(() => {
      ready();
      return new Promise<boolean>(() => {});
    });
    const result = h.transport.request('amendOrder', h.authorized('amendOrder', amendCommand()), {
      ...h.context,
      signal: controller.signal,
    });
    await entered;
    controller.abort();
    expect(await result).toMatchObject({
      kind: 'DEFINITIVELY_REJECTED',
      error: { code: 'ABORTED' },
    });
    expect(h.calls.map((r) => r.method)).toEqual(['GET']);
  });
  it('bounds hung dynamic AMEND admission on deadline without dispatch', async () => {
    const h = harness(false, [{ data: amendTarget() }], () => NOW, true);
    h.orderAdmission.validate.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    expect(
      await h.transport.request('amendOrder', h.authorized('amendOrder', amendCommand()), {
        ...h.context,
        deadline: NOW + 30,
      }),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'DEADLINE_EXCEEDED' } });
    expect(h.calls.map((r) => r.method)).toEqual(['GET']);
  });
  it('does not dispatch a native AMEND on LIVE or derivatives profiles', async () => {
    for (const id of ['binance-spot-live-v1', 'binance-usdm-testnet-v1'] as const) {
      const h = harness(false, [], () => NOW, true),
        endpoint = getBinanceProfile(id);
      const binding = { ...h.options.binding, profileId: id };
      const transport = createPrivateTransport({ ...h.options, endpoint, binding });
      const context = { ...h.context, profile: adapterProfile(endpoint, binding.credentialRef) };
      expect(
        await transport.request('amendOrder', h.authorized('amendOrder', amendCommand()), context),
      ).toMatchObject({
        kind: 'DEFINITIVELY_REJECTED',
        error: { code: id.includes('live') ? 'LIVE_DISABLED' : 'UNSUPPORTED' },
      });
      expect(h.calls).toHaveLength(0);
    }
  });
  it('queries native causal amendment history after restart without resending mutation', async () => {
    const rows = [
      {
        symbol: 'BTCUSDT',
        orderId: order().orderId,
        executionId: '9007199254740993',
        origClientOrderId: 'fixture-order-1',
        newClientOrderId: 'fixture-amend-1',
        origQty: '0.1',
        newQty: '0.075',
        time: String(NOW),
      },
    ];
    const h = harness(false, [{ data: rows }], () => NOW, true);
    const restarted = createPrivateTransport(h.options);
    const proof = await restarted.reconcileAmendment(amendCommand(), h.context);
    expect(proof).toMatchObject({
      kind: 'APPLIED_EVIDENCE',
      evidence: { executionId: '9007199254740993', newQuantity: '0.075' },
    });
    expect(h.calls.map((r) => [r.method, r.url.pathname])).toEqual([
      ['GET', '/api/v3/order/amendments'],
    ]);
    expect(proof).not.toHaveProperty('finalOutcome');
  });
  it('never interprets missing database amendment history as definitive rejection', async () => {
    const h = harness(false, [{ data: [] }], () => NOW, true);
    expect(await h.transport.reconcileAmendment(amendCommand(), h.context)).toEqual({
      kind: 'INDETERMINATE',
      reason: 'NO_CAUSAL_EVIDENCE',
    });
    expect(h.calls).toHaveLength(1);
  });
});

describe('Binance signed private reads', () => {
  it('refreshBalances requires every changed futures asset to be present and current', async () => {
    const event = {
      e: 'ACCOUNT_UPDATE',
      E: NOW,
      T: NOW - 10,
      a: { B: [{ a: 'USDT', wb: '100.12', cw: '90.12', bc: '0' }] },
    };
    const h = harness(true, [{ data: futuresBalances() }]);
    expect(await h.transport.refreshBalances(event, h.context)).toMatchObject({
      balances: [{ free: null, locked: null, total: '100.12' }],
      asOf: NOW - 10,
    });
  });
  it.each(['STALE', 'MISSING'] as const)(
    'rejects %s changed asset despite unrelated newer wallet row',
    async (failure) => {
      const event = { e: 'ACCOUNT_UPDATE', E: NOW, T: NOW - 10, a: { B: [{ a: 'USDT' }] } };
      const unrelated = { ...futuresBalances()[0]!, asset: 'BTC', updateTime: String(NOW - 5) };
      const rows =
        failure === 'STALE'
          ? [{ ...futuresBalances()[0]!, updateTime: String(NOW - 20) }, unrelated]
          : [unrelated];
      const h = harness(true, [{ data: rows }]);
      await expect(h.transport.refreshBalances(event, h.context)).rejects.toThrow(
        'INVALID_RESPONSE',
      );
    },
  );
  it('uses complete Spot account clock and changed asset presence for refresh', async () => {
    const event = {
      e: 'outboundAccountPosition',
      E: NOW,
      u: NOW - 10,
      B: [{ a: 'USDT', f: '100.12', l: '2.34' }],
    };
    const h = harness(false, [
      { data: spotAccount() },
      { data: { ...spotAccount(), updateTime: String(NOW - 20) } },
      { data: spotAccount() },
    ]);
    expect(await h.transport.refreshBalances(event, h.context)).toMatchObject({ asOf: NOW - 10 });
    await expect(h.transport.refreshBalances(event, h.context)).rejects.toThrow('INVALID_RESPONSE');
    await expect(
      h.transport.refreshBalances({ ...event, B: [{ a: 'ETH', f: '1', l: '0' }] }, h.context),
    ).rejects.toThrow('INVALID_RESPONSE');
  });
  it('does not emit a stale changed-asset balance masked by an unrelated fresh asset', async () => {
    const rows = [
      { ...futuresBalances()[0]!, updateTime: String(NOW - 20) },
      {
        ...futuresBalances()[0]!,
        asset: 'BTC',
        balance: '0.1',
        availableBalance: '0.1',
        updateTime: String(NOW - 5),
      },
    ];
    const h = harness(true, [{ data: { listenKey: 'fixture-listen-key' } }, { data: rows }]);
    let receive: (text: string) => void = () => {
      throw new Error('NOT_OPEN');
    };
    const streams = createPrivateStreams({
      endpoint: { ...h.options.endpoint, privateWsVerified: true },
      io: {
        ...h.io,
        openSocket: (_url, _context, onMessage) => {
          receive = onMessage;
          return Promise.resolve({ send: () => Promise.resolve(), close: () => Promise.resolve() });
        },
      },
      limiter: h.limiter,
      rest: h.options.client,
      signer: h.options.signer,
      account: ACCOUNT,
      now: () => NOW,
      syncTime: h.syncTime,
      snapshotBalances: async (event, context) =>
        accountSnapshotSchema.parse(await h.transport.refreshBalances(event, context)),
    });
    const onEvent = vi.fn(),
      onGap = vi.fn();
    const close = await streams.subscribe('subscribeBalances', {}, null, h.context, onEvent, onGap);
    receive(
      JSON.stringify({
        e: 'ACCOUNT_UPDATE',
        E: NOW,
        T: NOW - 10,
        a: { B: [{ a: 'USDT', wb: '100.12', cw: '90.12', bc: '0' }], P: [] },
      }),
    );
    try {
      await vi.waitFor(() => expect(onGap).toHaveBeenCalledTimes(1), { timeout: 300 });
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      await close();
      await streams.disconnect();
    }
  });
  it('bound testConnection authenticates through a read-only account request', async () => {
    const h = harness(false, [{ data: spotAccount() }]);
    expect(await h.transport.request('testConnection', {}, h.context)).toEqual({
      authenticated: true,
      canRead: true,
      canTrade: true,
      checkedAt: NOW,
    });
    expect(h.calls.map((c) => c.url.pathname)).toEqual(['/api/v3/account']);
    expect(h.calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('reads Spot info and balances under server binding', async () => {
    const h = harness(false, [{ data: spotAccount() }, { data: spotAccount() }]);
    expect(await h.transport.request('getAccountInfo', {}, h.context)).toMatchObject({
      account: ACCOUNT,
      accountMode: 'SPOT',
    });
    expect(await h.transport.request('getBalances', {}, h.context)).toMatchObject({
      balances: [{ total: '102.46' }, { total: '0.00000001' }],
    });
    expect(
      h.calls.every(
        (c) =>
          c.url.origin === 'https://testnet.binance.vision' &&
          c.headers?.['X-MBX-APIKEY'] === 'fixture-key' &&
          c.url.searchParams.has('signature'),
      ),
    ).toBe(true);
  });
  it('uses genuine futures ONE_WAY config and reported balance fields', async () => {
    const h = harness(true, [
      { data: { canTrade: true, multiAssetsMargin: false } },
      { data: { dualSidePosition: false } },
      { data: futuresBalances() },
    ]);
    expect(await h.transport.request('getAccountInfo', {}, h.context)).toMatchObject({
      accountMode: 'ONE_WAY',
    });
    expect(await h.transport.request('getBalances', {}, h.context)).toMatchObject({
      balances: [{ free: null, locked: null, total: '100.12' }],
    });
    expect(h.calls.map((c) => c.url.pathname)).toEqual([
      '/fapi/v2/account',
      '/fapi/v1/positionSide/dual',
      '/fapi/v3/balance',
    ]);
  });
  it('rejects HEDGE account instead of pretending ONE_WAY', async () => {
    const h = harness(true, [
      { data: { canTrade: true, multiAssetsMargin: false } },
      { data: { dualSidePosition: true } },
    ]);
    await expect(h.transport.request('getAccountInfo', {}, h.context)).rejects.toThrow(
      'INVALID_RESPONSE',
    );
  });
  it('Spot positions are a genuine empty not applicable page with zero I/O', async () => {
    const h = harness();
    expect(await h.transport.request('getPositions', page, h.context)).toEqual({
      items: [],
      nextCursor: null,
      queryId: 'q1',
    });
    expect(h.calls).toHaveLength(0);
  });
  it('uses V2 observed position fields and rejects foreign responses', async () => {
    const h = harness(true, [
      { data: [position()] },
      { data: [{ ...position(), symbol: 'ETHUSDT' }] },
    ]);
    expect(await h.transport.request('getPositions', page, h.context)).toMatchObject({
      items: [{ quantity: '-0.025', leverage: '5' }],
    });
    await expect(
      h.transport.request('getPositions', { ...page, queryId: 'q2' }, h.context),
    ).rejects.toThrow('INVALID_RESPONSE');
  });
  it('lookup notfound never becomes authoritative absence', async () => {
    const h = harness(false, [{ status: 400, data: { code: -2013, msg: 'secret-marker' } }]);
    expect(
      await h.transport.request(
        'getOrder',
        { instrumentId: 'BTCUSDT', locator: { kind: 'CLIENT_ID', id: 'fixture-order-1' } },
        h.context,
      ),
    ).toEqual({ kind: 'INDETERMINATE', reason: 'NOT_AUTHORITATIVE' });
  });
  it('lookup rejects a different client ID in success response', async () => {
    const h = harness(false, [{ data: { ...order(), clientOrderId: 'other-id' } }]);
    await expect(
      h.transport.request(
        'getOrder',
        { instrumentId: 'BTCUSDT', locator: { kind: 'CLIENT_ID', id: 'fixture-order-1' } },
        h.context,
      ),
    ).rejects.toThrow('INVALID_RESPONSE');
  });
  it('lookup FOUND resolves trusted identity', async () => {
    const h = harness();
    expect(
      await h.transport.request(
        'getOrder',
        { instrumentId: 'BTCUSDT', locator: { kind: 'EXCHANGE_ID', id: '9223372036854775807' } },
        h.context,
      ),
    ).toMatchObject({ kind: 'FOUND', order: { internalOrderId: INTERNAL_ORDER_ID } });
  });
  it('rejects tenant hints that differ from server binding before signing', async () => {
    const h = harness();
    await expect(
      h.transport.request(
        'getBalances',
        {},
        { ...h.context, account: { ...ACCOUNT, tenantId: '88888888-8888-4888-8888-888888888888' } },
      ),
    ).rejects.toThrow('SCOPE_MISMATCH');
    expect(h.calls).toHaveLength(0);
  });
});

describe('bounded scoped immutable private pagination', () => {
  it.each([false, true])(
    'releases only fully consumed snapshots before TTL for futures=%s',
    async (futures) => {
      const rows = ['1', '2', '3'].map((id) => ({ ...fill(futures), id }));
      const h = harness(
        futures,
        Array.from({ length: 50 }, () => ({ data: rows })),
      );
      const query = { ...history, limit: 1 };
      const first = (await h.transport.request('getTrades', query, h.context)) as {
        nextCursor: string;
      };
      expect(first.nextCursor).toEqual(expect.any(String));
      let retainedCursor = '';
      for (let index = 1; index < 16; index++) {
        const retained = (await h.transport.request(
          'getTrades',
          { ...query, queryId: `retained-${index}` },
          h.context,
        )) as { nextCursor: string };
        if (index === 1) retainedCursor = retained.nextCursor;
      }
      const second = (await h.transport.request(
        'getTrades',
        { ...query, cursor: first.nextCursor },
        h.context,
      )) as { nextCursor: string };
      expect(second.nextCursor).toEqual(expect.any(String));
      await expect(
        h.transport.request('getTrades', { ...query, queryId: 'overflow' }, h.context),
      ).rejects.toThrow('BUSY');
      const last = await h.transport.request(
        'getTrades',
        { ...query, cursor: second.nextCursor },
        h.context,
      );
      expect(last).toMatchObject({ items: [{ fillId: '3' }], nextCursor: null });
      // Reuse one freed slot repeatedly without changing the clock or evicting
      // any of the 15 other live snapshots.
      for (let index = 0; index < 24; index++) {
        const freshQuery = { ...query, queryId: `fresh-${index}` };
        const fresh = (await h.transport.request('getTrades', freshQuery, h.context)) as {
          nextCursor: string;
        };
        const middle = (await h.transport.request(
          'getTrades',
          { ...freshQuery, cursor: fresh.nextCursor },
          h.context,
        )) as { nextCursor: string };
        expect(
          await h.transport.request(
            'getTrades',
            { ...freshQuery, cursor: middle.nextCursor },
            h.context,
          ),
        ).toMatchObject({ items: [{ fillId: '3' }], nextCursor: null });
      }
      const resumed = (await h.transport.request(
        'getTrades',
        { ...query, queryId: 'retained-1', cursor: retainedCursor },
        h.context,
      )) as { nextCursor: string };
      expect(resumed).toMatchObject({ items: [{ fillId: '2' }] });
      expect(resumed.nextCursor).toEqual(expect.any(String));
      await expect(
        h.transport.request('getTrades', { ...query, cursor: first.nextCursor }, h.context),
      ).rejects.toThrow('INVALID_REQUEST');
    },
  );
  it('expires a snapshot without inventing a fresh source timestamp', async () => {
    const h = harness(false, [
      {
        data: [
          { ...fill(), id: '1' },
          { ...fill(), id: '2' },
        ],
      },
    ]);
    let time = NOW;
    const transport = createPrivateTransport({ ...h.options, now: () => time });
    const first = (await transport.request('getTrades', { ...history, limit: 1 }, h.context)) as {
      nextCursor: string;
    };
    time += 300_000;
    await expect(
      transport.request(
        'getTrades',
        { ...history, limit: 1, cursor: first.nextCursor },
        { ...h.context, deadline: time + 1000 },
      ),
    ).rejects.toThrow('STALE_METADATA');
    expect(h.calls).toHaveLength(1);
  });
  it('refuses a seventeenth retained snapshot instead of evicting live cursors', async () => {
    const rows = [
      { ...fill(), id: '1' },
      { ...fill(), id: '2' },
    ];
    const h = harness(
      false,
      Array.from({ length: 17 }, () => ({ data: rows })),
    );
    const first = (await h.transport.request('getTrades', { ...history, limit: 1 }, h.context)) as {
      nextCursor: string;
    };
    for (let index = 1; index < 16; index++)
      await h.transport.request(
        'getTrades',
        { ...history, limit: 1, queryId: `q${index + 1}` },
        h.context,
      );
    await expect(
      h.transport.request('getTrades', { ...history, limit: 1, queryId: 'q17' }, h.context),
    ).rejects.toThrow('BUSY');
    expect(
      await h.transport.request(
        'getTrades',
        { ...history, limit: 1, cursor: first.nextCursor },
        h.context,
      ),
    ).toMatchObject({ items: [{ fillId: '2' }], nextCursor: null });
  });
  it('paginates same-millisecond fills without dropping any identity', async () => {
    const rows = ['9007199254740995', '9007199254740993', '9007199254740994'].map((id) => ({
      ...fill(),
      id,
    }));
    const h = harness(false, [{ data: rows }]);
    const first = (await h.transport.request('getTrades', { ...history, limit: 1 }, h.context)) as {
      items: { fillId: string }[];
      nextCursor: string;
    };
    const second = (await h.transport.request(
      'getTrades',
      { ...history, limit: 1, cursor: first.nextCursor },
      h.context,
    )) as { items: { fillId: string }[]; nextCursor: string };
    const third = (await h.transport.request(
      'getTrades',
      { ...history, limit: 1, cursor: second.nextCursor },
      h.context,
    )) as { items: { fillId: string }[]; nextCursor: null };
    expect([...first.items, ...second.items, ...third.items].map((x) => x.fillId)).toEqual([
      '9007199254740993',
      '9007199254740994',
      '9007199254740995',
    ]);
    expect(third.nextCursor).toBeNull();
    expect(h.calls).toHaveLength(1);
    expect(h.identities.fill).toHaveBeenCalledWith(ACCOUNT, 'BTCUSDT', '9223372036854775807');
  });
  it('uses [from,to) transport boundaries and ignores no raw records', async () => {
    const h = harness(false, [{ data: [order()] }]);
    await h.transport.request('getOrderHistory', history, h.context);
    expect(h.calls[0]?.url.searchParams.get('endTime')).toBe(String(NOW - 1));
    expect(h.calls[0]?.url.searchParams.get('limit')).toBe('1000');
  });
  it('binds raw continuation to exact query including page size', async () => {
    const h = harness(false, [
      {
        data: [
          { ...fill(), id: '1' },
          { ...fill(), id: '2' },
        ],
      },
    ]);
    const first = (await h.transport.request('getTrades', { ...history, limit: 1 }, h.context)) as {
      nextCursor: string;
    };
    await expect(
      h.transport.request(
        'getTrades',
        { ...history, limit: 2, cursor: first.nextCursor },
        h.context,
      ),
    ).rejects.toThrow('INVALID_REQUEST');
    expect(h.calls).toHaveLength(1);
  });
  it('fails closed when a 1000 item response can be truncated', async () => {
    const h = harness(false, [
      { data: Array.from({ length: 1000 }, (_, n) => ({ ...fill(), id: String(n) })) },
    ]);
    await expect(h.transport.request('getTrades', history, h.context)).rejects.toThrow('BUSY');
  });
  it('rejects duplicate fill/order IDs and out of window records', async () => {
    const h = harness(false, [
      { data: [fill(), fill()] },
      { data: [{ ...order(), time: String(NOW) }] },
    ]);
    await expect(h.transport.request('getTrades', history, h.context)).rejects.toThrow(
      'INVALID_RESPONSE',
    );
    await expect(h.transport.request('getOrderHistory', history, h.context)).rejects.toThrow(
      'INVALID_RESPONSE',
    );
  });
  it.each([false, true])('enforces exchange query window for futures=%s', async (futures) => {
    const h = harness(futures);
    const max = (futures ? 7 : 1) * 86_400_000;
    await expect(
      h.transport.request('getTrades', { ...history, from: NOW - max - 1 }, h.context),
    ).rejects.toThrow('INVALID_REQUEST');
    expect(h.calls).toHaveLength(0);
  });
  it('does not dispatch empty history window', async () => {
    const h = harness();
    expect(await h.transport.request('getTrades', { ...history, from: NOW }, h.context)).toEqual({
      items: [],
      nextCursor: null,
      queryId: 'q1',
    });
    expect(h.calls).toHaveLength(0);
  });
});

describe('mutation dispatch and UNKNOWN contract', () => {
  it('signs after a delayed rate reservation with a fresh exchange timestamp', async () => {
    let time = NOW;
    const h = harness(
      false,
      [{ data: { symbol: 'BTCUSDT', orderId: '1', clientOrderId: 'fixture-order-1' } }],
      () => time,
    );
    h.limiter.reserve.mockImplementation(() => {
      time += 6000;
      return Promise.resolve(true);
    });
    const input = h.authorized('createOrder', newOrder());
    input.authorization.expiresAt = NOW + 10_000;
    expect(
      await h.transport.request('createOrder', input, {
        ...h.context,
        deadline: NOW + 20_000,
      }),
    ).toMatchObject({ kind: 'ACCEPTED' });
    const query = new URLSearchParams(h.calls[0]!.url.search);
    expect(query.get('timestamp')).toBe(String(NOW + 6000));
    const signature = query.get('signature');
    query.delete('signature');
    expect(signature).toBe(
      createHmac('sha256', 'fixture-secret').update(query.toString()).digest('hex'),
    );
    expect(h.calls).toHaveLength(1);
  });
  it('rechecks metadata expiry after an asynchronous risk admission', async () => {
    const h = harness();
    let time = NOW;
    const initial = h.options.record();
    const record = {
      ...initial,
      rules: { ...initial.rules, effectiveAt: NOW - 59_990, expiresAt: NOW + 10 },
    };
    h.orderAdmission.validate.mockImplementation(() => {
      time += 11;
      return Promise.resolve(true);
    });
    const transport = createPrivateTransport({
      ...h.options,
      now: () => time,
      record: () => record,
    });
    expect(
      await transport.request('createOrder', h.authorized('createOrder', newOrder()), h.context),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'STALE_METADATA' } });
    expect(h.calls).toHaveLength(0);
  });
  it('rechecks an updated rule version immediately before dispatch', async () => {
    const h = harness();
    const initial = h.options.record();
    let changed = false;
    h.orderAdmission.validate.mockImplementation(() => {
      changed = true;
      return Promise.resolve(true);
    });
    const transport = createPrivateTransport({
      ...h.options,
      record: () =>
        changed
          ? {
              ...initial,
              instrument: { ...initial.instrument, metadataVersion: 'new-metadata' },
              rules: { ...initial.rules, version: 'new-rules' },
            }
          : initial,
    });
    expect(
      await transport.request('createOrder', h.authorized('createOrder', newOrder()), h.context),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'STALE_METADATA' } });
    expect(h.calls).toHaveLength(0);
  });
  it('bounded hung risk admission settles without sending an order', async () => {
    const h = harness();
    h.orderAdmission.validate.mockImplementation(() => new Promise<boolean>(() => {}));
    expect(
      await h.transport.request('createOrder', h.authorized('createOrder', newOrder()), {
        ...h.context,
        deadline: NOW + 20,
      }),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'DEADLINE_EXCEEDED' } });
    expect(h.calls).toHaveLength(0);
  });
  it('late risk approval after abort never dispatches', async () => {
    const h = harness();
    let approve: (value: boolean) => void = () => {
      throw new Error('NOT_READY');
    };
    h.orderAdmission.validate.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = h.transport.request('createOrder', h.authorized('createOrder', newOrder()), {
      ...h.context,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(h.orderAdmission.validate).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await pending).toMatchObject({
      kind: 'DEFINITIVELY_REJECTED',
      error: { code: 'ABORTED' },
    });
    approve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.calls).toHaveLength(0);
  });
  it.each([
    { clientOrderId: 'foreign' },
    { orderId: '-1' },
    { orderId: '9007199254740992', clientOrderId: undefined },
  ])('invalid successful ACK %j remains UNKNOWN', async (patch) => {
    const h = harness(false, [
      { data: { symbol: 'BTCUSDT', orderId: '1', clientOrderId: 'fixture-order-1', ...patch } },
    ]);
    expect(
      await h.transport.request('createOrder', h.authorized('createOrder', newOrder()), h.context),
    ).toMatchObject({ kind: 'UNKNOWN', error: { code: 'INVALID_RESPONSE' } });
    expect(h.calls).toHaveLength(1);
  });
  it('accepts a valid ACK but does not claim a fill', async () => {
    const h = harness(false, [
      {
        data: {
          symbol: 'BTCUSDT',
          clientOrderId: 'fixture-order-1',
          orderId: '9223372036854775807',
          transactTime: String(NOW),
        },
      },
    ]);
    const result = (await h.transport.request(
      'createOrder',
      h.authorized('createOrder', newOrder()),
      h.context,
    )) as MutationOutcome;
    expect(result).toMatchObject({
      kind: 'ACCEPTED',
      ack: { status: 'ACKNOWLEDGED', exchangeId: '9223372036854775807' },
    });
    expect(h.calls).toHaveLength(1);
    expect(h.orderAdmission.validate).toHaveBeenCalledTimes(1);
  });
  it('requires complete trusted filter evidence before new risk', async () => {
    const h = harness();
    h.orderAdmission.validate.mockResolvedValue(false);
    const result = await h.transport.request(
      'createOrder',
      h.authorized('createOrder', newOrder()),
      h.context,
    );
    expect(result).toMatchObject({
      kind: 'DEFINITIVELY_REJECTED',
      error: { code: 'AUTHORIZATION_REQUIRED' },
    });
    expect(h.calls).toHaveLength(0);
  });
  it('missing filter evidence port denies create', async () => {
    const h = harness();
    const { orderAdmission: _unused, ...options } = h.options;
    void _unused;
    const transport = createPrivateTransport(options);
    expect(
      await transport.request('createOrder', h.authorized('createOrder', newOrder()), h.context),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED' });
    expect(h.calls).toHaveLength(0);
  });
  it('unknown exchange filters independently deny new risk even with approved port', async () => {
    const h = harness();
    const a = h.options.admission();
    const transport = createPrivateTransport({
      ...h.options,
      admission: () => ({ ...a, unsupportedFilters: ['NEW_EXCHANGE_FILTER'] }),
    });
    expect(
      await transport.request('createOrder', h.authorized('createOrder', newOrder()), h.context),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'UNSUPPORTED' } });
    expect(h.calls).toHaveLength(0);
  });
  it.each([false, true])(
    'known filter with an unknown constraint independently denies new risk for futures=%s',
    async (futures) => {
      const h = harness(
        futures,
        futures
          ? [
              { data: { canTrade: true, multiAssetsMargin: false } },
              { data: { dualSidePosition: false } },
              { data: order(true) },
            ]
          : [{ data: order() }],
      );
      const source = futures ? futuresSymbol() : spotSymbol();
      const transport = createPrivateTransport({
        ...h.options,
        admission: () =>
          normalizeBinanceAdmission({
            ...source,
            filters: source.filters.map((filter) =>
              filter.filterType === 'PRICE_FILTER'
                ? { ...filter, futurePriceConstraint: '0.05' }
                : filter,
            ),
          }),
      });
      expect(
        await transport.request(
          'createOrder',
          h.authorized('createOrder', newOrder(futures)),
          h.context,
        ),
      ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'UNSUPPORTED' } });
      expect(h.orderAdmission.validate).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);
    },
  );
  it('enforces market lot step separately from ordinary lot step', async () => {
    const h = harness(true);
    const input = {
      ...newOrder(true),
      type: 'MARKET' as const,
      limitPrice: null,
      timeInForce: null,
      size: {
        kind: 'BASE_QUANTITY' as const,
        value: '0.003' as ReturnType<typeof newOrder>['size']['value'],
        asset: 'BTC',
      },
    };
    expect(
      await h.transport.request('createOrder', h.authorized('createOrder', input), h.context),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'INVALID_REQUEST' } });
    expect(h.calls).toHaveLength(0);
    expect(h.orderAdmission.validate).not.toHaveBeenCalled();
  });
  it('LIVE remains disabled even in the internal helper', async () => {
    const h = harness();
    const endpoint = getBinanceProfile('binance-spot-live-v1');
    const transport = createPrivateTransport({ ...h.options, endpoint });
    expect(
      await transport.request('createOrder', h.authorized('createOrder', newOrder()), h.context),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'LIVE_DISABLED' } });
    expect(h.calls).toHaveLength(0);
  });
  it('predispatch aborted request causes zero operation', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    expect(
      await h.transport.request('createOrder', h.authorized('createOrder', newOrder()), {
        ...h.context,
        signal: controller.signal,
      }),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'ABORTED' } });
    expect(h.calls).toHaveLength(0);
  });
  it('predispatch limiter rejection remains definitive', async () => {
    const h = harness();
    h.limiter.reserve.mockResolvedValue(false);
    expect(
      await h.transport.request('createOrder', h.authorized('createOrder', newOrder()), h.context),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'RATE_LIMITED' } });
    expect(h.calls).toHaveLength(0);
  });
  it.each([500, 502, 503, 504])(
    'postdispatch HTTP %s is UNKNOWN and never retried',
    async (status) => {
      const h = harness(false, [{ status, data: { code: -1000, msg: 'secret-marker' } }]);
      expect(
        await h.transport.request(
          'createOrder',
          h.authorized('createOrder', newOrder()),
          h.context,
        ),
      ).toMatchObject({ kind: 'UNKNOWN' });
      expect(h.calls).toHaveLength(1);
    },
  );
  it.each([-1006, -1007, -2010])('ambiguous Binance code %s is UNKNOWN', async (code) => {
    const h = harness(false, [{ status: 400, data: { code, msg: 'secret-marker' } }]);
    expect(
      await h.transport.request('createOrder', h.authorized('createOrder', newOrder()), h.context),
    ).toMatchObject({ kind: 'UNKNOWN' });
    expect(h.calls).toHaveLength(1);
  });
  it.each(['ABORTED', 'DEADLINE_EXCEEDED', 'UNAVAILABLE'] as const)(
    'postdispatch %s is UNKNOWN',
    async (code) => {
      const h = harness(false, [{ failure: new BinanceProtocolError(code) }]);
      expect(
        await h.transport.request(
          'createOrder',
          h.authorized('createOrder', newOrder()),
          h.context,
        ),
      ).toMatchObject({ kind: 'UNKNOWN' });
      expect(h.calls).toHaveLength(1);
    },
  );
  it('server known filter rejection is definitive and sanitized', async () => {
    const h = harness(false, [{ status: 400, data: { code: -1013, msg: 'secret-marker' } }]);
    const result = await h.transport.request(
      'createOrder',
      h.authorized('createOrder', newOrder()),
      h.context,
    );
    expect(result).toEqual({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(result)).not.toContain('secret-marker');
  });
  it('mismatched successful ACK is UNKNOWN after dispatch', async () => {
    const h = harness(false, [
      { data: { symbol: 'ETHUSDT', clientOrderId: 'fixture-order-1', orderId: '1' } },
    ]);
    expect(
      await h.transport.request('createOrder', h.authorized('createOrder', newOrder()), h.context),
    ).toMatchObject({ kind: 'UNKNOWN', error: { code: 'INVALID_RESPONSE' } });
    expect(h.calls).toHaveLength(1);
  });
  it('cancels only explicit locator, requiring no new-risk admission', async () => {
    const h = harness(false, [
      {
        data: {
          symbol: 'BTCUSDT',
          orderId: '9223372036854775807',
          origClientOrderId: 'fixture-order-1',
          clientOrderId: 'cancel-generated',
          status: 'CANCELED',
        },
      },
    ]);
    expect(
      await h.transport.request(
        'cancelOrder',
        h.authorized('cancelOrder', {
          instrumentId: 'BTCUSDT',
          locator: { kind: 'CLIENT_ID', id: 'fixture-order-1' },
        }),
        h.context,
      ),
    ).toMatchObject({ kind: 'ACCEPTED' });
    expect(h.calls[0]?.method).toBe('DELETE');
    expect(h.calls[0]?.url.pathname).toBe('/api/v3/order');
    expect(h.orderAdmission.validate).not.toHaveBeenCalled();
  });
  it('batch cancellation preserves individual outcomes without broad cancel-all endpoint', async () => {
    const h = harness(false, [
      { data: { symbol: 'BTCUSDT', orderId: '1', clientOrderId: 'first', status: 'CANCELED' } },
      { status: 500, data: { code: -1000 } },
    ]);
    const commands = ['1', '2'].map((id) =>
      h.authorized('cancelOrder', {
        instrumentId: 'BTCUSDT',
        locator: { kind: 'EXCHANGE_ID', id },
      }),
    );
    const result = (await h.transport.request('cancelAllOrders', { commands }, h.context)) as {
      kind: string;
      outcomes: { outcome: MutationOutcome }[];
    };
    expect(result.outcomes.map((x) => x.outcome.kind)).toEqual(['ACCEPTED', 'UNKNOWN']);
    expect(h.calls.every((c) => c.url.pathname === '/api/v3/order' && c.method === 'DELETE')).toBe(
      true,
    );
    expect(h.calls).toHaveLength(2);
  });
  it('validates futures leverage and genuine account mode before mutation', async () => {
    const h = harness(true, [
      { data: { canTrade: true, multiAssetsMargin: false } },
      { data: { dualSidePosition: false } },
      { data: { symbol: 'BTCUSDT', leverage: '5', maxNotionalValue: '100000' } },
    ]);
    expect(
      await h.transport.request(
        'setLeverage',
        h.authorized('setLeverage', { instrumentId: 'BTCUSDT', leverage: '5' }),
        h.context,
      ),
    ).toMatchObject({ kind: 'ACCEPTED', ack: { exchangeId: null } });
    expect(h.calls[2]?.url.pathname).toBe('/fapi/v1/leverage');
  });
  it.each(['0', '1.5', '126'])('rejects invalid leverage %s before dispatch', async (leverage) => {
    const h = harness(true);
    const input = {
      command: { instrumentId: 'BTCUSDT', leverage },
      authorization: h.authorized('setLeverage', { instrumentId: 'BTCUSDT', leverage: '5' })
        .authorization,
    };
    expect(await h.transport.request('setLeverage', input, h.context)).toMatchObject({
      kind: 'DEFINITIVELY_REJECTED',
      error: { code: 'INVALID_REQUEST' },
    });
    expect(h.calls).toHaveLength(0);
  });
});
