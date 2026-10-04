import { z } from 'zod';
import {
  capabilityRecordSchema,
  createExchangeAdapter,
  immutable,
  operations,
  type ExchangeAdapter,
  type RequestContext,
} from '@ctp/exchange-core';
import { resolveBinding, createSigner, type ClockSample } from './auth.js';
import { boundedPort } from './client.js';
import { createNetworkIo, type NetworkIo } from './io.js';
import { getOkxProfile, adapterProfile, okxProfileIdSchema, symbolSchema } from './profiles.js';
import { createPublicTransport } from './public-transport.js';
import { createPrivateTransport } from './private-transport.js';
import { createStreams } from './streams.js';
import type { OkxAdapterOptions } from './ports.js';
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
  profileId: okxProfileIdSchema,
  symbols: z
    .array(symbolSchema)
    .min(1)
    .max(300)
    .readonly()
    .refine(
      (value) => new Set(value).size === value.length && JSON.stringify(value).length <= 8192,
    ),
  capabilities: z.array(capabilityRecordSchema).max(1024).readonly(),
  limiter: port<OkxAdapterOptions['limiter']>(['reserve', 'observe']),
  connection: port<NonNullable<OkxAdapterOptions['connection']>>(['resolve']).optional(),
  credentials: port<NonNullable<OkxAdapterOptions['credentials']>>(['resolve']).optional(),
  permissions: port<NonNullable<OkxAdapterOptions['permissions']>>(['verify']).optional(),
  authorization: port<NonNullable<OkxAdapterOptions['authorization']>>(['authorize']).optional(),
  sandboxAcceptance: port<NonNullable<OkxAdapterOptions['sandboxAcceptance']>>([
    'authorize',
  ]).optional(),
  identities: port<NonNullable<OkxAdapterOptions['identities']>>(['order', 'fill']).optional(),
  orderAdmission: port<NonNullable<OkxAdapterOptions['orderAdmission']>>(['validate']).optional(),
  registry: port<OkxAdapterOptions['registry']>(['get', 'put']),
  tradeMode: z.enum(['cross', 'isolated']).optional(),
  now: z.custom<() => number>((value) => typeof value === 'function').optional(),
});
export function createOkxAdapter(options: OkxAdapterOptions): ExchangeAdapter {
  return createOkxAdapterWithIo(options, createNetworkIo());
}
/** Internal test assembly is deliberately excluded from package exports. */
export function createOkxAdapterWithIo(raw: OkxAdapterOptions, io: NetworkIo): ExchangeAdapter {
  let options: z.infer<typeof configuration>;
  try {
    options = configuration.parse(raw);
  } catch {
    throw new Error('INVALID_OKX_CONFIGURATION');
  }
  const endpoint = getOkxProfile(options.profileId),
    binding = resolveBinding(endpoint, options.connection),
    account = binding?.account ?? null,
    profile = adapterProfile(endpoint, binding?.credentialRef),
    now = options.now ?? Date.now;
  if (options.symbols.some((symbol) => symbol.endsWith('-SWAP') !== (endpoint.instType === 'SWAP')))
    throw new Error('INVALID_OKX_CONFIGURATION');
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
    ...(endpoint.instType === 'SPOT' ? ['SET_LEVERAGE', 'REDUCE_ONLY'] : []),
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
    const started = now(),
      x = operations.getServerTime.output.parse(
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
    ),
    privateTransport = createPrivateTransport({
      endpoint,
      binding,
      signer,
      publicTransport,
      now,
      syncTime,
      ...(options.identities === undefined ? {} : { identities: options.identities }),
      ...(options.orderAdmission === undefined ? {} : { orderAdmission: options.orderAdmission }),
      ...(options.tradeMode === undefined ? {} : { tradeMode: options.tradeMode }),
    }),
    streams = createStreams(
      endpoint,
      io,
      options.limiter,
      signer,
      privateTransport,
      syncTime,
      now,
      publicTransport.record,
    );
  return createExchangeAdapter({
    profile,
    account,
    capabilities,
    adapterVersion: 'okx-v1',
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
        if (
          (await boundedPort(
            () => options.authorization!.authorize(operation, input, context),
            context,
            now,
          )) !== true
        )
          return false;
        const request = wireObject(input);
        return (
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
          )) === true
        );
      },
    },
    transport: {
      async request(operation, input, context) {
        return operations[operation].privateOperation ||
          (operation === 'testConnection' && account !== null)
          ? privateTransport.request(operation, input, context)
          : publicTransport.request(operation, input, context);
      },
      async subscribe(operation, input, context, onEvent, onGap) {
        const request = wireObject(input),
          record =
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
