import { immutable, type AccountScope } from '@ctp/exchange-core';
import type { IoContext, NetworkIo } from './io.js';
import type { BybitEndpointProfile } from './profiles.js';
import type { BybitRateLimitPort, BybitRateRequest } from './ports.js';
import { parseWireJson, wireObject, wireInteger } from './wire.js';

export class BybitProtocolError extends Error {
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
  if (context.signal.aborted) throw new BybitProtocolError('ABORTED');
  if (!Number.isSafeInteger(context.deadline) || context.deadline <= now())
    throw new BybitProtocolError('DEADLINE_EXCEEDED');
}
export function boundedPort<T>(
  action: () => Promise<T>,
  context: IoContext,
  now: () => number,
): Promise<T> {
  assertActive(context, now);
  const remaining = context.deadline - now();
  if (remaining > 30_000) throw new BybitProtocolError('INVALID_REQUEST');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      if (ok) resolve(value as T);
      else
        reject(value instanceof BybitProtocolError ? value : new BybitProtocolError('UNAVAILABLE'));
    };
    const abort = () => finish(false, new BybitProtocolError('ABORTED'));
    const timer = setTimeout(
      () => finish(false, new BybitProtocolError('DEADLINE_EXCEEDED')),
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
const routes = new Set([
  '/v5/market/time',
  '/v5/market/instruments-info',
  '/v5/market/tickers',
  '/v5/market/orderbook',
  '/v5/market/kline',
  '/v5/account/info',
  '/v5/account/wallet-balance',
  '/v5/position/list',
  '/v5/order/realtime',
  '/v5/order/history',
  '/v5/execution/list',
  '/v5/order/create',
  '/v5/order/cancel',
  '/v5/position/set-leverage',
]);
export interface RestSpec {
  readonly path: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string | number | boolean>>;
  readonly sign?: (
    payload: string,
    context: IoContext,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly onDispatch?: () => void;
  readonly symbol?: string;
}
export interface BybitResponse {
  readonly status: number;
  readonly code: number;
  readonly result: Readonly<Record<string, unknown>>;
  readonly exchangeTime: number;
  readonly receivedAt: number;
}
export function createRestClient(
  endpoint: BybitEndpointProfile,
  io: NetworkIo,
  limiter: BybitRateLimitPort,
  account: AccountScope | null,
  now: () => number,
) {
  let backoffUntil = 0;
  return Object.freeze({
    async call(spec: RestSpec, context: IoContext): Promise<BybitResponse> {
      assertActive(context, now);
      if (now() < backoffUntil) throw new BybitProtocolError('RATE_LIMITED');
      if (
        !routes.has(spec.path) ||
        (spec.body !== undefined) !==
          ['/v5/order/create', '/v5/order/cancel', '/v5/position/set-leverage'].includes(spec.path)
      )
        throw new BybitProtocolError('INVALID_REQUEST');
      const method = spec.body === undefined ? 'GET' : 'POST';
      const rate: BybitRateRequest = immutable({
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
        throw new BybitProtocolError('RATE_LIMITED');
      const url = new URL(spec.path, endpoint.rest);
      for (const [key, value] of Object.entries(spec.params ?? {})) {
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || typeof value !== 'string' || value.length > 2048)
          throw new BybitProtocolError('INVALID_REQUEST');
        url.searchParams.append(key, value);
      }
      const payload =
        spec.body === undefined ? url.searchParams.toString() : JSON.stringify(spec.body);
      const headers =
        spec.sign === undefined
          ? {}
          : await boundedPort(() => spec.sign!(payload, context), context, now);
      assertActive(context, now);
      if (now() < backoffUntil) throw new BybitProtocolError('RATE_LIMITED');
      spec.onDispatch?.();
      const response = await io.request(
        {
          url,
          method,
          headers: {
            ...headers,
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          },
          ...(method === 'POST' ? { body: payload } : {}),
        },
        context,
      );
      const receivedAt = now();
      if (response.status === 403 || response.status === 429) {
        backoffUntil = Math.max(
          backoffUntil,
          receivedAt + (response.status === 403 ? 600_000 : 1000),
        );
      }
      let raw: Record<string, unknown> | undefined;
      let code: number | undefined;
      try {
        raw = wireObject(parseWireJson(response.body));
        if (typeof raw.retCode !== 'string' || !/^-?\d{1,6}$/.test(raw.retCode))
          throw new BybitProtocolError('INVALID_RESPONSE');
        code = Number(raw.retCode);
        if (response.status === 403 || response.status === 429 || code === 10006) {
          const reset = response.headers['x-bapi-limit-reset-timestamp'];
          const resetAt = reset && /^\d{1,16}$/.test(reset) ? Number(reset) : 0;
          backoffUntil = Math.max(
            backoffUntil,
            receivedAt + (response.status === 403 ? 600_000 : 1000),
            Math.min(receivedAt + 86_400_000, resetAt),
          );
        }
      } catch {
        // Even malformed responses must update shared observed headers.
      }
      await boundedPort(
        () => limiter.observe(rate, response.status, response.headers, context),
        context,
        now,
      );
      if (raw === undefined || code === undefined) throw new BybitProtocolError('INVALID_RESPONSE');
      try {
        return immutable({
          status: response.status,
          code,
          result: wireObject(raw.result),
          exchangeTime: wireInteger(raw.time),
          receivedAt,
        });
      } catch {
        throw new BybitProtocolError('INVALID_RESPONSE');
      }
    },
  });
}
export function readResponse(response: BybitResponse): Readonly<Record<string, unknown>> {
  if (response.status !== 200 || response.code !== 0)
    throw new BybitProtocolError(
      response.status === 403 || response.status === 429 || response.code === 10006
        ? 'RATE_LIMITED'
        : [10003, 10004, 10005, 10007].includes(response.code)
          ? 'AUTHORIZATION_REQUIRED'
          : 'UNAVAILABLE',
    );
  return response.result;
}
