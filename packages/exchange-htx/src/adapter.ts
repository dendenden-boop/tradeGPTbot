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
import { createNetworkIo, type NetworkIo } from './io.js';
import {
  adapterProfile,
  getHtxProfile,
  htxProfileIdSchema,
  spotSymbolSchema,
  linearSymbolSchema,
} from './profiles.js';
import { resolveBinding, createSigner, type ClockSample } from './auth.js';
import { createPublicTransport } from './public-transport.js';
import { createPrivateTransport } from './private-transport.js';
import { createStreams } from './streams.js';
import { intervals } from './public-data.js';
import type { HtxAdapterOptions } from './ports.js';
const port = <T>(methods: readonly string[]) =>
  z.custom<T>(
    (x) =>
      x !== null &&
      typeof x === 'object' &&
      methods.every((key) => typeof Reflect.get(x, key) === 'function'),
  );
const configuration = z.strictObject({
  profileId: htxProfileIdSchema,
  symbols: z
    .array(z.string())
    .min(1)
    .max(300)
    .readonly()
    .refine((x) => new Set(x).size === x.length && JSON.stringify(x).length <= 8192),
  capabilities: z.array(capabilityRecordSchema).max(1024).readonly(),
  limiter: port<HtxAdapterOptions['limiter']>(['reserve', 'observe']),
  registry: port<HtxAdapterOptions['registry']>(['get', 'put']),
  connection: port<NonNullable<HtxAdapterOptions['connection']>>(['resolve']).optional(),
  credentials: port<NonNullable<HtxAdapterOptions['credentials']>>(['resolve']).optional(),
  permissions: port<NonNullable<HtxAdapterOptions['permissions']>>(['verify']).optional(),
  identities: port<NonNullable<HtxAdapterOptions['identities']>>(['order', 'fill']).optional(),
  now: z.custom<() => number>((x) => typeof x === 'function').optional(),
});
export function createHtxAdapter(options: HtxAdapterOptions): ExchangeAdapter {
  if (!isRuntimeInstrumentRegistry(options?.registry)) throw new Error('INVALID_HTX_CONFIGURATION');
  return createHtxAdapterWithIo(options, createNetworkIo());
}
/** Internal fixture/loopback assembly is excluded from package exports. */
export function createHtxAdapterWithIo(raw: HtxAdapterOptions, io: NetworkIo): ExchangeAdapter {
  let options: z.infer<typeof configuration>;
  try {
    options = configuration.parse(raw);
    const schema = options.profileId === 'htx-spot-live-v1' ? spotSymbolSchema : linearSymbolSchema;
    for (const s of options.symbols) schema.parse(s);
  } catch {
    throw new Error('INVALID_HTX_CONFIGURATION');
  }
  const endpoint = getHtxProfile(options.profileId),
    binding = resolveBinding(endpoint, options.connection),
    account = binding?.account ?? null,
    profile = adapterProfile(endpoint, binding?.credentialRef),
    now = options.now ?? Date.now;
  const supported = new Set([
    'PUBLIC_READ',
    'PUBLIC_STREAM',
    'PRIVATE_STREAM',
    'ACCOUNT_READ',
    'ORDER_READ',
    'ORDER_LOOKUP_BY_CLIENT_ID',
    'HISTORICAL_CANDLES',
  ]);
  const capabilities = options.capabilities.map((record) => ({
    ...record,
    ...(supported.has(record.feature) ? {} : { support: 'UNSUPPORTED' as const }),
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
  const pub = createPublicTransport(
    endpoint,
    options.symbols,
    options.registry,
    io,
    options.limiter,
    account,
    now,
  );
  let clock: ClockSample | null = null;
  async function syncTime(context: RequestContext) {
    const started = now(),
      sample = operations.getServerTime.output.parse(
        await pub.request('getServerTime', {}, context),
      );
    clock = immutable({
      serverTime: sample.exchangeTime,
      sampledAt: sample.receivedAt,
      roundTripMs: sample.receivedAt - started,
    });
  }
  const signer = createSigner(
      endpoint,
      binding,
      options.credentials,
      options.permissions,
      () => clock,
      now,
    ),
    priv = createPrivateTransport(
      endpoint,
      binding,
      signer,
      pub,
      options.identities,
      syncTime,
      now,
    ),
    streams = createStreams(endpoint, io, options.limiter, signer, priv, now, pub.record, account);
  return createExchangeAdapter({
    profile,
    account,
    capabilities,
    registry: options.registry,
    adapterVersion: 'htx-v1',
    now,
    authorization: {
      authorize() {
        return Promise.resolve(false);
      },
    },
    transport: {
      async request(operation, input, context) {
        return operations[operation].privateOperation ||
          (operation === 'testConnection' && account !== null)
          ? priv.request(operation, input, context)
          : pub.request(operation, input, context);
      },
      async subscribe(operation, input, context, onEvent, onGap) {
        return streams.subscribe(operation, input, context, onEvent, onGap);
      },
      async disconnect() {
        await streams.disconnect();
        await io.close();
      },
    },
  });
}
