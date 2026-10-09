import { immutable, type AccountScope } from '@ctp/exchange-core';
import type { HttpRequest, IoContext, NetworkIo } from './io.js';
import type { BinanceEndpointProfile } from './profiles.js';
import type { BinanceRateLimitPort, BinanceRateRequest } from './ports.js';
import { parseWireJson } from './wire.js';

export class BinanceProtocolError extends Error {
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
      | 'SCOPE_MISMATCH',
  ) {
    super(code);
  }
}
export interface RestSpec {
  readonly path: string;
  readonly method?: HttpRequest['method'];
  readonly params?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly weight: number;
  readonly orders?: number;
  readonly symbol?: string;
  /** Internal observation only; invoked immediately before handing bytes to network IO. */
  readonly onDispatch?: () => void;
  /** Internal signing stage, after rate admission so timestamps cannot age in a queue. */
  readonly prepare?: (context: IoContext) => Promise<{
    readonly params: Readonly<Record<string, string>>;
    readonly headers: Readonly<Record<string, string>>;
  }>;
  /** Final durable authority after signing/limiter/read-only preparation, before HTTP handoff. */
  readonly beforeDispatch?: () => Promise<boolean>;
}
export interface BinanceResponse {
  readonly status: number;
  readonly data: unknown;
  readonly code: string | null;
  readonly receivedAt: number;
}
export function assertActive(context: IoContext, now: () => number): void {
  if (context.signal.aborted) throw new BinanceProtocolError('ABORTED');
  if (!Number.isSafeInteger(context.deadline) || context.deadline <= now())
    throw new BinanceProtocolError('DEADLINE_EXCEEDED');
}
/** Bound server ports too: a cancelled late admission must never initiate I/O. */
export function boundedPort<T>(
  action: () => Promise<T>,
  context: IoContext,
  now: () => number,
): Promise<T> {
  assertActive(context, now);
  const remaining = context.deadline - now();
  if (remaining > 30_000) throw new BinanceProtocolError('INVALID_REQUEST');
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', aborted);
      if (ok) resolve(value as T);
      else
        reject(
          value instanceof BinanceProtocolError ? value : new BinanceProtocolError('UNAVAILABLE'),
        );
    };
    const aborted = () => finish(false, new BinanceProtocolError('ABORTED'));
    const timer = setTimeout(
      () => finish(false, new BinanceProtocolError('DEADLINE_EXCEEDED')),
      remaining,
    );
    context.signal.addEventListener('abort', aborted, { once: true });
    void Promise.resolve()
      .then(() => {
        assertActive(context, now);
        return action();
      })
      .then(
        (value) => finish(true, value),
        (error) => finish(false, error),
      );
    if (context.signal.aborted) aborted();
  });
}
export function createRestClient(
  endpoint: BinanceEndpointProfile,
  io: NetworkIo,
  limiter: BinanceRateLimitPort,
  account: AccountScope | null,
  now: () => number,
) {
  const reserve = limiter.reserve.bind(limiter),
    observe = limiter.observe.bind(limiter);
  let backoffUntil = 0;
  return Object.freeze({
    async call(spec: RestSpec, context: IoContext): Promise<BinanceResponse> {
      assertActive(context, now);
      if (now() < backoffUntil) throw new BinanceProtocolError('RATE_LIMITED');
      const prefix = endpoint.scope.market === 'SPOT' ? '/api/v3/' : '/fapi/';
      if (
        !spec.path.startsWith(prefix) ||
        (!/^\/(?:api\/v3|fapi\/v[123])\/[A-Za-z]+(?:\/[A-Za-z0-9]+)?$/.test(spec.path) &&
          spec.path !== '/api/v3/order/amend/keepPriority')
      )
        throw new BinanceProtocolError('INVALID_REQUEST');
      const admission: BinanceRateRequest = immutable({
        profileId: endpoint.id,
        accountId: account?.externalAccountId ?? null,
        route: spec.path,
        method: spec.method ?? 'GET',
        weight: spec.weight,
        orders: spec.orders ?? 0,
        connectionAttempts: 0,
        controlMessages: 0,
        ...(spec.symbol === undefined ? {} : { symbol: spec.symbol }),
      });
      if ((await boundedPort(() => reserve(admission, context), context, now)) !== true)
        throw new BinanceProtocolError('RATE_LIMITED');
      assertActive(context, now);
      const prepared =
        spec.prepare === undefined
          ? null
          : await boundedPort(() => spec.prepare!(context), context, now);
      assertActive(context, now);
      const params = prepared?.params ?? spec.params;
      const requestHeaders = prepared?.headers ?? spec.headers;
      const url = new URL(spec.path, endpoint.rest);
      if (params)
        for (const [key, value] of Object.entries(params)) {
          if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || value.length > 8192)
            throw new BinanceProtocolError('INVALID_REQUEST');
          url.searchParams.append(key, value);
        }
      assertActive(context, now);
      if (spec.beforeDispatch && (await boundedPort(spec.beforeDispatch, context, now)) !== true)
        throw new BinanceProtocolError('AUTHORIZATION_REQUIRED');
      assertActive(context, now);
      spec.onDispatch?.();
      const response = await io.request(
        {
          url,
          method: spec.method ?? 'GET',
          ...(requestHeaders === undefined ? {} : { headers: requestHeaders }),
          ...(spec.body === undefined ? {} : { body: spec.body }),
        },
        context,
      );
      const receivedAt = now();
      const headers = Object.fromEntries(
        Object.entries(response.headers).filter(([key]) =>
          /^(?:x-mbx-used-weight(?:-\d+[smhd])?|x-mbx-order-count-\d+[smhd]|retry-after)$/i.test(
            key,
          ),
        ),
      );
      if (response.status === 429 || response.status === 418) {
        const raw = headers['retry-after'];
        const seconds = raw && /^\d{1,6}$/.test(raw) ? Number(raw) : 60;
        backoffUntil = receivedAt + Math.min(86_400, Math.max(1, seconds)) * 1000;
      }
      await boundedPort(
        () => observe(admission, response.status, immutable(headers), context),
        context,
        now,
      );
      // A CDN/proxy may return HTML for 418/429. Status alone remains rate evidence.
      const data =
        response.status === 429 || response.status === 418 ? null : parseWireJson(response.body);
      const code =
        data !== null &&
        typeof data === 'object' &&
        !Array.isArray(data) &&
        'code' in data &&
        typeof data.code === 'string' &&
        /^-\d{1,6}$/.test(data.code)
          ? data.code
          : null;
      return { status: response.status, data, code, receivedAt };
    },
  });
}
export type BinanceRestClient = ReturnType<typeof createRestClient>;
export function readResponse(response: BinanceResponse): unknown {
  if (response.status === 429 || response.status === 418)
    throw new BinanceProtocolError('RATE_LIMITED');
  if (response.status < 200 || response.status >= 300 || response.code !== null)
    throw new BinanceProtocolError('UNAVAILABLE');
  return response.data;
}
