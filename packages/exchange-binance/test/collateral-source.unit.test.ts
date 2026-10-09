import { afterEach, expect, it, vi } from 'vitest';
import {
  createRuntimeInstrumentRegistry,
  createInstrumentRegistry,
  featureSchema,
  type RegistryReceipt,
  type InstrumentRecord,
  type RequestContext,
} from '@ctp/exchange-core';
import { createBinanceAdapterWithIo } from '../src/adapter.js';
import { createBinanceCollateralSource } from '../src/collateral-source.js';
import { adapterProfile, getBinanceProfile } from '../src/profiles.js';
import type { BinanceAdapterOptions } from '../src/ports.js';
import type { NetworkIo, HttpResponse, IoContext } from '../src/io.js';
import {
  ACCOUNT,
  INTERNAL_ORDER_ID,
  INTENT_ID,
  order,
  spotAccount,
} from './fixtures/private-data.js';
import { exchangeInfo, spotSymbol, SPOT_SCOPE } from './fixtures/public-data.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});
const query = {
  instrumentId: 'BTCUSDT',
  locator: { kind: 'EXCHANGE_ID' as const, id: order().orderId },
};
const native = (now: number) => ({
  ...order(),
  time: now - 100,
  updateTime: now - 10,
  orderListId: '-1',
  icebergQty: '0',
  origQuoteOrderQty: '0',
  isWorking: true,
  selfTradePreventionMode: 'NONE',
});
async function fixture(
  reference = false,
  capabilityPatch?: (input: BinanceAdapterOptions) => BinanceAdapterOptions,
) {
  const now = Date.now();
  let rows: readonly RegistryReceipt[] = [],
    revision = 0n;
  const runtime = await createRuntimeInstrumentRegistry({
    scope: SPOT_SCOPE,
    instrumentIds: ['BTCUSDT'],
    store: {
      read: () => Promise.resolve(rows),
      publish: (records: readonly InstrumentRecord[]) => {
        rows = records.map((record) => ({ record, revision: (++revision).toString() }));
        return Promise.resolve(rows);
      },
      close: async () => {},
    },
  });
  cleanup.push(runtime.close);
  const profile = adapterProfile(getBinanceProfile('binance-spot-testnet-v1'), 'fixture-vault');
  let input: BinanceAdapterOptions = {
    profileId: 'binance-spot-testnet-v1',
    symbols: ['BTCUSDT'],
    registry: reference ? createInstrumentRegistry({ capacity: 1 }) : runtime,
    now: () => Date.now(),
    capabilities: featureSchema.options.map((feature) => ({
      profile,
      feature,
      support: 'SUPPORTED',
      implementation: 'NATIVE',
      constraints: {},
      evidenceUrl: 'https://developers.binance.com/en/docs/products/spot/rest-api',
      checkedAt: now - 1000,
      expiresAt: now + 60000,
      adapterVersion: 'binance-v1',
    })),
    limiter: { reserve: () => Promise.resolve(true), observe: async () => {} },
    connection: { resolve: () => ({ account: ACCOUNT, credentialRef: 'fixture-vault' }) },
    credentials: {
      resolve: () =>
        Promise.resolve({
          profileId: 'binance-spot-testnet-v1',
          account: ACCOUNT,
          apiKey: 'fixture',
          secret: 'fixture',
        }),
    },
    identities: {
      order: () => ({ internalOrderId: INTERNAL_ORDER_ID, intentId: INTENT_ID }),
      algo: () => ({ internalAlgoId: INTERNAL_ORDER_ID }),
      fill: () => ({ internalOrderId: INTERNAL_ORDER_ID }),
    },
  };
  if (capabilityPatch) input = capabilityPatch(input);
  let intercepted: ((context: IoContext) => Promise<HttpResponse>) | undefined;
  const request = vi.fn<NetworkIo['request']>((req, context) => {
    const path = req.url.pathname;
    if (path === '/api/v3/order' && intercepted) return intercepted(context);
    const body =
      path === '/api/v3/exchangeInfo'
        ? exchangeInfo([spotSymbol()])
        : path === '/api/v3/time'
          ? { serverTime: Date.now() }
          : path === '/api/v3/order'
            ? native(now)
            : { ...spotAccount(), updateTime: Date.now() };
    return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });
  });
  const adapter = createBinanceAdapterWithIo(input, {
    request,
    openSocket: vi.fn(),
    close: async () => {},
  });
  cleanup.push(() => adapter.disconnect());
  const context: RequestContext = {
    profile: adapter.profile,
    account: adapter.account,
    signal: new AbortController().signal,
    deadline: Date.now() + 5000,
    correlationId: 'collateral-fixture',
  };
  const initialized = await adapter.getSymbols(
    { limit: 10, cursor: null, queryId: 'warm' },
    context,
  );
  expect(initialized.ok).toBe(true);
  request.mockClear();
  return {
    adapter,
    request,
    intercept: (value: typeof intercepted) => {
      intercepted = value;
    },
  };
}
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 3000 });

it('requires the actual runtime adapter owner, rejecting reference and copied assemblies', async () => {
  const h = await fixture();
  expect(() => createBinanceCollateralSource({ ...h.adapter })).toThrow(
    'INVALID_BINANCE_COLLATERAL_SOURCE',
  );
  const r = await fixture(true);
  expect(() => createBinanceCollateralSource(r.adapter)).toThrow(
    'INVALID_BINANCE_COLLATERAL_SOURCE',
  );
});
it('collects only signed reads without a mutation authorizer or transport permit', async () => {
  const h = await fixture(),
    source = createBinanceCollateralSource(h.adapter);
  cleanup.push(source.close);
  const proof = await source.collect(query, io());
  expect(proof.account).toEqual(ACCOUNT);
  expect(proof.after.order.internalOrderId).toBe(INTERNAL_ORDER_ID);
  expect(proof.before.sourceHash).toBe(proof.after.sourceHash);
  expect(h.request.mock.calls.every(([req]) => req.method === 'GET')).toBe(true);
  expect(
    h.request.mock.calls.map(([req]) => req.url.pathname).filter((path) => path !== '/api/v3/time'),
  ).toEqual(['/api/v3/account', '/api/v3/order', '/api/v3/account', '/api/v3/order']);
});
it.each(['UNSUPPORTED', 'EXPIRED', 'SYNTHETIC', 'WRONG_INSTRUMENT'] as const)(
  'refuses %s ORDER_READ evidence before any private I/O',
  async (kind) => {
    const h = await fixture(false, (input) => ({
      ...input,
      capabilities: input.capabilities.map((c) =>
        c.feature !== 'ORDER_READ'
          ? c
          : {
              ...c,
              ...(kind === 'UNSUPPORTED' ? { support: 'UNSUPPORTED' as const } : {}),
              ...(kind === 'EXPIRED'
                ? { checkedAt: Date.now() - 2000, expiresAt: Date.now() - 1000 }
                : {}),
              ...(kind === 'SYNTHETIC' ? { implementation: 'SYNTHETIC' as const } : {}),
              ...(kind === 'WRONG_INSTRUMENT'
                ? { constraints: { instrumentIds: ['ETHUSDT'] } }
                : {}),
            },
      ),
    }));
    const source = createBinanceCollateralSource(h.adapter);
    cleanup.push(source.close);
    await expect(source.collect(query, io())).rejects.toThrow('UNSUPPORTED');
    expect(h.request).not.toHaveBeenCalled();
  },
);
it('shares its pending slot and waits for actual aborted HTTP settlement before reusing it', async () => {
  const h = await fixture(),
    a = createBinanceCollateralSource(h.adapter),
    b = createBinanceCollateralSource(h.adapter);
  cleanup.push(a.close, b.close);
  let entered!: () => void,
    reject!: (reason: Error) => void,
    aborted = false;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.intercept(
    (context) =>
      new Promise((_, fail) => {
        reject = fail;
        context.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
          },
          { once: true },
        );
        entered();
      }),
  );
  const controller = new AbortController();
  const pending = a.collect(query, { signal: controller.signal, deadline: Date.now() + 3000 });
  const rejected = expect(pending).rejects.toThrow('BINANCE_COLLATERAL_ABORTED');
  await started;
  controller.abort();
  await expect(b.collect(query, io())).rejects.toThrow('BINANCE_COLLATERAL_BUSY');
  expect(aborted).toBe(true);
  let closed = false;
  const closing = a.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  reject(new Error('RAW_SECRET_SHOULD_NOT_ESCAPE'));
  await rejected;
  await closing;
  h.intercept(undefined);
  expect((await b.collect(query, io())).account).toEqual(ACCOUNT);
  await expect(a.collect(query, io())).rejects.toThrow('BINANCE_COLLATERAL_BUSY');
});
it('rejects client locators and caller scope/deadline fields before network I/O', async () => {
  const h = await fixture(),
    source = createBinanceCollateralSource(h.adapter);
  cleanup.push(source.close);
  await expect(source.collect({ ...query, tenantId: ACCOUNT.tenantId }, io())).rejects.toThrow();
  await expect(
    source.collect({ ...query, locator: { kind: 'CLIENT_ID', id: 'test' } }, io()),
  ).rejects.toThrow('INVALID_BINANCE_COLLATERAL_SOURCE');
  await expect(
    source.collect(query, { ...io(), profile: h.adapter.profile } as ReturnType<typeof io>),
  ).rejects.toThrow('INVALID_BINANCE_COLLATERAL_SOURCE');
  expect(h.request).not.toHaveBeenCalled();
});
