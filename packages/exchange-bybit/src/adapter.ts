import { z } from 'zod';
import {
  capabilityRecordSchema,
  createExchangeAdapter,
  isRuntimeInstrumentRegistry,
  immutable,
  operations,
  type ExchangeAdapter,
  type RequestContext,
} from '@ctp/exchange-core';
import { resolveBinding, createSigner, type ClockSample } from './auth.js';
import { boundedPort } from './client.js';
import { createNetworkIo, type NetworkIo } from './io.js';
import { getBybitProfile, adapterProfile, bybitProfileIdSchema, symbolSchema } from './profiles.js';
import { createPublicTransport } from './public-transport.js';
import { createPrivateTransport } from './private-transport.js';
import { createStreams } from './streams.js';
import type { BybitAdapterOptions } from './ports.js';
import { intervals } from './public-data.js';
import { wireObject } from './wire.js';

const port = <T>(methods: readonly string[]) =>
  z.custom<T>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      methods.every((key) => typeof Reflect.get(value, key) === 'function'),
  );
const configuration = z.strictObject({
  profileId: bybitProfileIdSchema,
  symbols: z
    .array(symbolSchema)
    .min(1)
    .max(300)
    .readonly()
    .refine(
      (value) => new Set(value).size === value.length && JSON.stringify(value).length <= 8192,
    ),
  capabilities: z.array(capabilityRecordSchema).max(1024).readonly(),
  limiter: port<BybitAdapterOptions['limiter']>(['reserve', 'observe']),
  connection: port<NonNullable<BybitAdapterOptions['connection']>>(['resolve']).optional(),
  credentials: port<NonNullable<BybitAdapterOptions['credentials']>>(['resolve']).optional(),
  permissions: port<NonNullable<BybitAdapterOptions['permissions']>>(['verify']).optional(),
  authorization: port<NonNullable<BybitAdapterOptions['authorization']>>(['authorize']).optional(),
  sandboxAcceptance: port<NonNullable<BybitAdapterOptions['sandboxAcceptance']>>([
    'authorize',
  ]).optional(),
  identities: port<NonNullable<BybitAdapterOptions['identities']>>(['order', 'fill']).optional(),
  orderAdmission: port<NonNullable<BybitAdapterOptions['orderAdmission']>>(['validate']).optional(),
  registry: port<BybitAdapterOptions['registry']>(['get', 'put']),
  now: z.custom<() => number>((value) => typeof value === 'function').optional(),
});
export function createBybitAdapter(options: BybitAdapterOptions): ExchangeAdapter {
  if (!isRuntimeInstrumentRegistry(options?.registry))
    throw new Error('INVALID_BYBIT_CONFIGURATION');
  return createBybitAdapterWithIo(options, createNetworkIo());
}
/** Internal assembly; deliberately excluded from production exports. */
export function createBybitAdapterWithIo(raw: BybitAdapterOptions, io: NetworkIo): ExchangeAdapter {
  let options: z.infer<typeof configuration>;
  try {
    options = configuration.parse(raw);
  } catch {
    throw new Error('INVALID_BYBIT_CONFIGURATION');
  }
  const endpoint = getBybitProfile(options.profileId),
    binding = resolveBinding(endpoint, options.connection),
    account = binding?.account ?? null,
    profile = adapterProfile(endpoint, binding?.credentialRef),
    now = options.now ?? Date.now;
  const registry = options.registry;
  const unsupported = new Set([
    'QUOTE_BUDGET_MARKET_BUY',
    'TRIGGER_ORDER',
    'STOP_LIMIT_ORDER',
    'ALGO_ORDERS',
    'OCO',
    'ATTACHED_TP_SL',
    'TRAILING_STOP',
    'CLOSE_POSITION',
    'AMEND_ORDER',
    'CHANGE_POSITION_MODE',
    ...(endpoint.category === 'spot' ? ['SET_LEVERAGE', 'REDUCE_ONLY'] : []),
  ]);
  const capabilities = options.capabilities.map((record) => ({
    ...record,
    ...(unsupported.has(record.feature) ? { support: 'UNSUPPORTED' as const } : {}),
    ...(record.feature === 'HISTORICAL_CANDLES'
      ? {
          constraints: {
            ...record.constraints,
            timeframes: Object.keys(intervals).filter(
              (tf) =>
                record.constraints.timeframes === undefined ||
                record.constraints.timeframes.includes(tf),
            ),
          },
        }
      : {}),
  }));
  const publicTransport = createPublicTransport(
    endpoint,
    options.symbols,
    registry,
    io,
    options.limiter,
    account,
    now,
  );
  let clock: ClockSample | null = null;
  async function syncTime(context: RequestContext) {
    const started = now();
    const x = operations.getServerTime.output.parse(
      await publicTransport.request('getServerTime', {}, context),
    );
    clock = immutable({
      serverTime: x.exchangeTime,
      sampledAt: x.receivedAt,
      roundTripMs: x.receivedAt - started,
    });
  }
  const signer = createSigner(
    endpoint,
    binding,
    options.credentials,
    options.permissions,
    () => clock,
    now,
  );
  const privateTransport = createPrivateTransport({
    endpoint,
    binding,
    signer,
    publicTransport,
    now,
    syncTime,
    ...(options.identities === undefined ? {} : { identities: options.identities }),
    ...(options.orderAdmission === undefined ? {} : { orderAdmission: options.orderAdmission }),
  });
  const streams = createStreams(
    endpoint,
    io,
    options.limiter,
    signer,
    privateTransport,
    syncTime,
    now,
  );
  return createExchangeAdapter({
    profile,
    account,
    capabilities,
    adapterVersion: 'bybit-v1',
    registry,
    now,
    authorization: {
      async authorize(operation, input, context) {
        if (
          endpoint.scope.environment === 'LIVE' ||
          !account ||
          !options.credentials ||
          !options.permissions ||
          !options.authorization ||
          !options.sandboxAcceptance ||
          (operation === 'createOrder' && !options.orderAdmission)
        )
          return false;
        const request = wireObject(input);
        if (
          (await boundedPort(
            () =>
              options.sandboxAcceptance!.authorize(
                endpoint.id,
                account,
                request.command ?? request.commands,
                context,
              ),
            context,
            now,
          )) !== true
        )
          return false;
        return (
          (await boundedPort(
            () => options.authorization!.authorize(operation, input, context),
            context,
            now,
          )) === true
        );
      },
    },
    transport: {
      dispatchAuthorization: ['createOrder', 'cancelOrder', 'setLeverage'],
      async request(operation, input, context, dispatchGate) {
        return operations[operation].privateOperation ||
          (operation === 'testConnection' && account !== null)
          ? privateTransport.request(operation, input, context, dispatchGate)
          : publicTransport.request(operation, input, context);
      },
      async subscribe(operation, input, context, onEvent, onGap) {
        const request = wireObject(input);
        const record =
          typeof request.instrumentId === 'string'
            ? publicTransport.record(request.instrumentId)
            : null;
        return streams.subscribe(operation, input, record, context, onEvent, onGap);
      },
      async disconnect() {
        await streams.disconnect();
        await io.close();
      },
    },
  });
}
