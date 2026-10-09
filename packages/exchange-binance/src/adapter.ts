import { z } from 'zod';
import {
  accountSnapshotSchema,
  capabilityRecordSchema,
  createExchangeAdapter,
  isRuntimeInstrumentRegistry,
  operations,
  orderLookupSchema,
  type ExchangeAdapter,
  type Order,
  type RequestContext,
} from '@ctp/exchange-core';
import { createBinanceSigner, resolveBinanceBinding, type BinanceClockSample } from './auth.js';
import { boundedPort, BinanceProtocolError } from './client.js';
import { createNetworkIo, type NetworkIo } from './io.js';
import type { BinanceAdapterOptions } from './ports.js';
import {
  adapterProfile,
  binanceProfileIdSchema,
  getBinanceProfile,
  symbolSchema,
} from './profiles.js';
import { createPublicTransport } from './public-transport.js';
import { createPublicStreams } from './public-streams.js';
import { createPrivateTransport } from './private-transport.js';
import { createPrivateStreams } from './private-streams.js';
import { wireObject, wireId } from './wire.js';
import { registerBinanceCollateralOwner } from './collateral-source.js';

const port = <T>(methods: readonly string[]) =>
  z.custom<T>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      methods.every((key) => typeof Reflect.get(value, key) === 'function'),
  );
const configuration = z.strictObject({
  profileId: binanceProfileIdSchema,
  symbols: z
    .array(symbolSchema)
    .min(1)
    .max(300)
    .readonly()
    .refine(
      (value) => new Set(value).size === value.length && JSON.stringify(value).length <= 8192,
    ),
  capabilities: z.array(capabilityRecordSchema).max(1024).readonly(),
  limiter: port<BinanceAdapterOptions['limiter']>(['reserve', 'observe']),
  connection: port<NonNullable<BinanceAdapterOptions['connection']>>(['resolve']).optional(),
  credentials: port<NonNullable<BinanceAdapterOptions['credentials']>>(['resolve']).optional(),
  authorization: port<NonNullable<BinanceAdapterOptions['authorization']>>([
    'authorize',
  ]).optional(),
  sandboxAcceptance: port<NonNullable<BinanceAdapterOptions['sandboxAcceptance']>>([
    'authorize',
  ]).optional(),
  identities: port<NonNullable<BinanceAdapterOptions['identities']>>([
    'order',
    'algo',
    'fill',
  ]).optional(),
  orderAdmission: port<NonNullable<BinanceAdapterOptions['orderAdmission']>>([
    'validate',
  ]).optional(),
  registry: port<BinanceAdapterOptions['registry']>(['get', 'put']),
  now: z.custom<() => number>((value) => typeof value === 'function').optional(),
});

/** Public production factory accepts trusted server ports and an allowlisted profile only. */
export function createBinanceAdapter(options: BinanceAdapterOptions): ExchangeAdapter {
  if (!isRuntimeInstrumentRegistry(options?.registry))
    throw new Error('INVALID_BINANCE_CONFIGURATION');
  return createBinanceAdapterWithIo(options, createNetworkIo());
}

/** Testable internal assembly; not exported by the production package entrypoint. */
export function createBinanceAdapterWithIo(
  raw: BinanceAdapterOptions,
  io: NetworkIo,
): ExchangeAdapter {
  let options: z.infer<typeof configuration>;
  try {
    options = configuration.parse(raw);
  } catch {
    throw new Error('INVALID_BINANCE_CONFIGURATION');
  }
  const endpoint = getBinanceProfile(options.profileId);
  const binding = resolveBinanceBinding(endpoint, options.connection);
  const account = binding?.account ?? null;
  // This profile has native quantity-reduction semantics. Evidence never substitutes
  // for the server's durable Order/Risk permit, owned identity and dynamic admission.
  const nativeAmend =
    endpoint.id === 'binance-spot-testnet-v1' &&
    account !== null &&
    options.credentials !== undefined &&
    options.authorization !== undefined &&
    options.sandboxAcceptance !== undefined &&
    options.identities !== undefined &&
    options.orderAdmission !== undefined;
  // Evidence can restrict support; it cannot enable a protocol the adapter lacks.
  const unsupported = new Set([
    'OCO',
    'ATTACHED_TP_SL',
    'TRAILING_STOP',
    'CLOSE_POSITION',
    ...(!nativeAmend ? ['AMEND_ORDER'] : []),
    'CHANGE_POSITION_MODE',
    'ALGO_ORDERS',
    'QUOTE_BUDGET_MARKET_BUY',
    ...(endpoint.scope.market === 'SPOT'
      ? ['SET_LEVERAGE', 'REDUCE_ONLY']
      : ['TRIGGER_ORDER', 'STOP_LIMIT_ORDER']),
    ...(!endpoint.privateWsVerified ? ['PRIVATE_STREAM'] : []),
  ]);
  const nativeTimeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
  const capabilities = options.capabilities.map((record) => ({
    ...record,
    ...(unsupported.has(record.feature) ||
    (record.feature === 'AMEND_ORDER' && record.implementation !== 'NATIVE')
      ? { support: 'UNSUPPORTED' as const }
      : {}),
    ...(record.feature === 'HISTORICAL_CANDLES'
      ? {
          constraints: {
            ...record.constraints,
            timeframes: nativeTimeframes.filter(
              (value) =>
                record.constraints.timeframes === undefined ||
                record.constraints.timeframes.includes(value),
            ),
          },
        }
      : {}),
  }));
  const profile = adapterProfile(endpoint, binding?.credentialRef);
  const now = options.now ?? Date.now;
  const registry = options.registry;
  const publicTransport = createPublicTransport(
    endpoint,
    options.symbols,
    registry,
    io,
    options.limiter,
    account,
    now,
  );
  const publicStreams = createPublicStreams(endpoint, io, options.limiter, now);
  let clock: BinanceClockSample | null = null;
  const syncTime = async (context: RequestContext) => {
    const started = now();
    const result = operations.getServerTime.output.parse(
      await publicTransport.request('getServerTime', {}, context),
    );
    clock = Object.freeze({
      serverTime: result.exchangeTime,
      sampledAt: result.receivedAt,
      roundTripMs: result.receivedAt - started,
    });
  };
  const signer = createBinanceSigner(endpoint, binding, options.credentials, () => clock, now);
  const privateTransport = createPrivateTransport({
    endpoint,
    binding,
    signer,
    client: publicTransport.client,
    record: publicTransport.record,
    admission: publicTransport.admission,
    now,
    syncTime,
    ...(options.identities === undefined ? {} : { identities: options.identities }),
    ...(options.orderAdmission === undefined ? {} : { orderAdmission: options.orderAdmission }),
  });
  const privateStreams = createPrivateStreams({
    endpoint,
    io,
    limiter: options.limiter,
    rest: publicTransport.client,
    signer,
    account,
    now,
    syncTime,
    async snapshotOrders(
      event: Readonly<Record<string, unknown>>,
      input: { instrumentId: string },
      context: RequestContext,
    ): Promise<readonly Order[]> {
      const value = endpoint.scope.market === 'SPOT' ? event : wireObject(event.o);
      const id = wireId(value.i);
      const result = orderLookupSchema.parse(
        await privateTransport.request(
          'getOrder',
          { instrumentId: input.instrumentId, locator: { kind: 'EXCHANGE_ID', id } },
          context,
        ),
      );
      if (result.kind !== 'FOUND') throw new BinanceProtocolError('UNAVAILABLE');
      return [result.order];
    },
    async snapshotBalances(event: Readonly<Record<string, unknown>>, context: RequestContext) {
      return accountSnapshotSchema.parse(await privateTransport.refreshBalances(event, context));
    },
    async snapshotPositions(
      _event: Readonly<Record<string, unknown>>,
      input: { instrumentId: string },
      context: RequestContext,
    ) {
      const result = operations.getPositions.output.parse(
        await privateTransport.request(
          'getPositions',
          {
            instrumentId: input.instrumentId,
            limit: 200,
            cursor: null,
            queryId: 'private-stream-refresh',
          },
          context,
        ),
      );
      if (result.nextCursor !== null) throw new BinanceProtocolError('UNAVAILABLE');
      return result.items;
    },
  });
  const authorize = options.authorization?.authorize.bind(options.authorization);
  const sandbox = options.sandboxAcceptance?.authorize.bind(options.sandboxAcceptance);
  const adapter = createExchangeAdapter({
    profile,
    account,
    capabilities,
    adapterVersion: 'binance-v1',
    registry,
    now,
    authorization: {
      async authorize(operation, input, context) {
        if (
          endpoint.scope.environment === 'LIVE' ||
          account === null ||
          authorize === undefined ||
          sandbox === undefined ||
          options.credentials === undefined
        )
          return false;
        if (operation === 'createOrder' && options.orderAdmission === undefined) return false;
        const command = wireObject(input).command ?? wireObject(input).commands;
        if (
          (await boundedPort(
            () => sandbox(endpoint.id, account, command, context),
            context,
            now,
          )) !== true
        )
          return false;
        // Finish sandbox checks before consuming the one-use durable final permit.
        return (
          (await boundedPort(() => authorize(operation, input, context), context, now)) === true
        );
      },
    },
    transport: {
      dispatchAuthorization: ['createOrder', 'cancelOrder', 'amendOrder', 'setLeverage'],
      async request(operation, input, context, dispatchGate) {
        if (
          operations[operation].privateOperation ||
          (operation === 'testConnection' && account !== null)
        )
          return privateTransport.request(operation, input, context, dispatchGate);
        return publicTransport.request(operation, input, context);
      },
      async subscribe(operation, input, context, onEvent, onGap) {
        const request = wireObject(input);
        const record =
          typeof request.instrumentId === 'string'
            ? publicTransport.record(request.instrumentId)
            : null;
        if (operations[operation].privateOperation)
          return privateStreams.subscribe(operation, input, record, context, onEvent, onGap);
        if (record === null) throw new BinanceProtocolError('INVALID_REQUEST');
        return publicStreams.subscribe(operation, input, record, context, onEvent, onGap);
      },
      async disconnect() {
        await Promise.allSettled([publicStreams.disconnect(), privateStreams.disconnect()]);
        await io.close();
      },
    },
  });
  registerBinanceCollateralOwner(adapter, {
    runtime: isRuntimeInstrumentRegistry(registry),
    readable:
      account !== null && options.credentials !== undefined && options.identities !== undefined,
    now,
    collect: privateTransport.collateralEvidence,
  });
  return adapter;
}
