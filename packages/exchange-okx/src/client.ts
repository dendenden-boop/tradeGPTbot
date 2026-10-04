import { immutable, type AccountScope } from '@ctp/exchange-core';
import type { IoContext, NetworkIo } from './io.js';
import type { OkxEndpointProfile } from './profiles.js';
import type { OkxRateLimitPort, OkxRateRequest } from './ports.js';
import { parseWireJson, wireObject, wireArray } from './wire.js';

export class OkxProtocolError extends Error {
  constructor(
    readonly code:
      | 'ABORTED'
      | 'DEADLINE_EXCEEDED'
      | 'RATE_LIMITED'
      | 'INVALID_RESPONSE'
      | 'UNAVAILABLE'
      | 'AUTHORIZATION_REQUIRED'
      | 'UNSUPPORTED'
      | 'INVALID_REQUEST'
      | 'STALE_METADATA'
      | 'SCOPE_MISMATCH'
      | 'BUSY',
  ) {
    super(code);
  }
}
export function assertActive(context: IoContext, now: () => number): void {
  if (context.signal.aborted) throw new OkxProtocolError('ABORTED');
  if (!Number.isSafeInteger(context.deadline) || context.deadline <= now())
    throw new OkxProtocolError('DEADLINE_EXCEEDED');
}
export function boundedPort<T>(
  action: () => Promise<T>,
  context: IoContext,
  now: () => number,
): Promise<T> {
  assertActive(context, now);
  const remaining = context.deadline - now();
  if (remaining > 30_000) throw new OkxProtocolError('INVALID_REQUEST');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      if (ok) resolve(value as T);
      else reject(value instanceof OkxProtocolError ? value : new OkxProtocolError('UNAVAILABLE'));
    };
    const abort = () => finish(false, new OkxProtocolError('ABORTED'));
    const timer = setTimeout(
      () => finish(false, new OkxProtocolError('DEADLINE_EXCEEDED')),
      remaining,
    );
    context.signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve()
      .then(() => {
        assertActive(context, now);
        return action();
      })
      .then(
        (v) => finish(true, v),
        (e) => finish(false, e),
      );
    if (context.signal.aborted) abort();
  });
}

const getRoutes = new Set([
  '/api/v5/public/time',
  '/api/v5/public/instruments',
  '/api/v5/market/ticker',
  '/api/v5/market/books',
  '/api/v5/market/history-candles',
  '/api/v5/account/config',
  '/api/v5/account/balance',
  '/api/v5/account/positions',
  '/api/v5/trade/order',
  '/api/v5/trade/orders-pending',
  '/api/v5/trade/orders-history-archive',
  '/api/v5/trade/fills-history',
]);
const postRoutes = new Set([
  '/api/v5/trade/order',
  '/api/v5/trade/cancel-order',
  '/api/v5/account/set-leverage',
]);
export interface RestSpec {
  readonly path: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string | number | boolean>>;
  readonly sign?: (
    method: 'GET' | 'POST',
    path: string,
    body: string,
    context: IoContext,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly onDispatch?: () => void;
  readonly symbol?: string;
  readonly expTime?: number;
}
export interface OkxResponse {
  readonly status: number;
  readonly code: number;
  readonly data: readonly unknown[];
  readonly receivedAt: number;
}
export function createRestClient(
  endpoint: OkxEndpointProfile,
  io: NetworkIo,
  limiter: OkxRateLimitPort,
  account: AccountScope | null,
  now: () => number,
) {
  let backoffUntil = 0;
  return Object.freeze({
    async call(spec: RestSpec, context: IoContext): Promise<OkxResponse> {
      assertActive(context, now);
      if (now() < backoffUntil) throw new OkxProtocolError('RATE_LIMITED');
      const method = spec.body === undefined ? 'GET' : 'POST';
      if (
        !(method === 'GET' ? getRoutes : postRoutes).has(spec.path) ||
        (spec.expTime !== undefined &&
          (!Number.isSafeInteger(spec.expTime) ||
            spec.expTime <= now() ||
            spec.expTime > context.deadline))
      )
        throw new OkxProtocolError('INVALID_REQUEST');
      const rate: OkxRateRequest = immutable({
        profileId: endpoint.id,
        accountId: account?.externalAccountId ?? null,
        route: spec.path,
        method,
        requests: 1,
        orders: method === 'POST' ? 1 : 0,
        connectionAttempts: 0,
        controlMessages: 0,
        ...(spec.symbol === undefined ? {} : { symbol: spec.symbol }),
      });
      if ((await boundedPort(() => limiter.reserve(rate, context), context, now)) !== true)
        throw new OkxProtocolError('RATE_LIMITED');
      const url = new URL(spec.path, endpoint.rest);
      for (const [key, value] of Object.entries(spec.params ?? {})) {
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || typeof value !== 'string' || value.length > 2048)
          throw new OkxProtocolError('INVALID_REQUEST');
        url.searchParams.append(key, value);
      }
      const payload = method === 'POST' ? JSON.stringify(spec.body) : '',
        path = url.pathname + url.search;
      const headers =
        spec.sign === undefined
          ? {}
          : await boundedPort(() => spec.sign!(method, path, payload, context), context, now);
      assertActive(context, now);
      if (now() < backoffUntil) throw new OkxProtocolError('RATE_LIMITED');
      if (spec.expTime !== undefined && now() >= spec.expTime)
        throw new OkxProtocolError('DEADLINE_EXCEEDED');
      spec.onDispatch?.();
      const response = await io.request(
        {
          url,
          method,
          headers: {
            ...headers,
            ...(endpoint.demo ? { 'x-simulated-trading': '1' } : {}),
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            ...(spec.expTime === undefined ? {} : { expTime: String(spec.expTime) }),
          },
          ...(method === 'POST' ? { body: payload } : {}),
        },
        context,
      );
      const receivedAt = now();
      if (response.status === 403 || response.status === 429)
        backoffUntil = Math.max(
          backoffUntil,
          receivedAt + (response.status === 403 ? 600000 : 1000),
        );
      let raw: Record<string, unknown> | undefined, code: number | undefined;
      try {
        raw = wireObject(parseWireJson(response.body));
        if (typeof raw.code !== 'string' || !/^\d{1,6}$/.test(raw.code)) throw new Error();
        code = Number(raw.code);
        if ([50011, 50040].includes(code)) backoffUntil = Math.max(backoffUntil, receivedAt + 1000);
      } catch {
        /* Observe headers even for malformed native envelopes. */
      }
      await boundedPort(
        () => limiter.observe(rate, response.status, response.headers, context),
        context,
        now,
      );
      if (raw === undefined || code === undefined) throw new OkxProtocolError('INVALID_RESPONSE');
      try {
        return immutable({
          status: response.status,
          code,
          data: wireArray(raw.data, 10000),
          receivedAt,
        });
      } catch {
        throw new OkxProtocolError('INVALID_RESPONSE');
      }
    },
  });
}
export function readResponse(response: OkxResponse): readonly unknown[] {
  if (response.status !== 200 || response.code !== 0)
    throw new OkxProtocolError(
      response.status === 403 || response.status === 429 || [50011, 50040].includes(response.code)
        ? 'RATE_LIMITED'
        : [50103, 50104, 50105, 50106, 50110, 50111, 50113, 50114, 50119].includes(response.code)
          ? 'AUTHORIZATION_REQUIRED'
          : 'UNAVAILABLE',
    );
  return response.data;
}
