import { immutable, type AccountScope } from '@ctp/exchange-core';
import type { IoContext, NetworkIo } from './io.js';
import type { HtxEndpointProfile } from './profiles.js';
import type { HtxRateLimitPort, HtxRateRequest } from './ports.js';
import { parseWireJson, wireObject, wireInteger } from './wire.js';

export class HtxProtocolError extends Error {
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

const spotGet = new Set([
  '/v1/common/timestamp',
  '/v1/settings/common/market-symbols',
  '/market/detail/merged',
  '/market/depth',
  '/v2/user/uid',
  '/v1/account/accounts',
  '/v1/order/openOrders',
  '/v1/order/orders/getClientOrder',
  '/v1/order/orders',
  '/v1/order/matchresults',
]);
const linearGet = new Set([
  '/api/v1/timestamp',
  '/linear-swap-api/v1/swap_contract_info',
  '/linear-swap-ex/market/detail/merged',
  '/linear-swap-ex/market/depth',
  '/linear-swap-ex/market/history/kline',
  '/linear-swap-api/v3/swap_unified_account_type',
]);
const linearPostRead = new Set([
  '/linear-swap-api/v1/swap_cross_account_info',
  '/linear-swap-api/v1/swap_cross_position_info',
  '/linear-swap-api/v1/swap_cross_order_info',
  '/linear-swap-api/v1/swap_cross_openorders',
  '/linear-swap-api/v3/swap_cross_hisorders',
  '/linear-swap-api/v3/swap_cross_matchresults',
]);
export interface RestSpec {
  readonly path: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string | number>>;
  readonly sign?: (
    method: 'GET' | 'POST',
    host: string,
    path: string,
    params: Readonly<Record<string, string>>,
    context: IoContext,
  ) => Promise<string>;
  readonly symbol?: string;
  /** Fixed official UID bridge for the same native key; never a caller destination. */
  readonly identity?: boolean;
}
export interface HtxResponse {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly receivedAt: number;
}
export function createRestClient(
  endpoint: HtxEndpointProfile,
  io: NetworkIo,
  limiter: HtxRateLimitPort,
  account: AccountScope | null,
  now: () => number,
) {
  let backoffUntil = 0;
  return Object.freeze({
    async call(spec: RestSpec, context: IoContext): Promise<HtxResponse> {
      assertActive(context, now);
      if (now() < backoffUntil) throw new HtxProtocolError('RATE_LIMITED');
      const method = spec.body === undefined ? 'GET' : 'POST';
      const identity = spec.identity === true;
      const valid = identity
        ? method === 'GET' && spec.path === '/v2/user/uid' && spec.sign !== undefined
        : endpoint.spot
          ? method === 'GET' &&
            (spotGet.has(spec.path) ||
              /^\/v1\/account\/accounts\/\d{1,30}\/balance$/.test(spec.path) ||
              /^\/v1\/order\/orders\/\d{1,30}$/.test(spec.path))
          : method === 'GET'
            ? linearGet.has(spec.path)
            : linearPostRead.has(spec.path);
      if (!valid) throw new HtxProtocolError('INVALID_REQUEST');
      const rate: HtxRateRequest = immutable({
        profileId: endpoint.id,
        accountId: spec.sign === undefined ? null : (account?.externalAccountId ?? null),
        route: identity ? 'api.huobi.pro/v2/user/uid' : spec.path,
        method,
        requests: 1,
        orders: 0,
        connectionAttempts: 0,
        controlMessages: 0,
        ...(spec.symbol === undefined ? {} : { symbol: spec.symbol }),
      });
      if ((await boundedPort(() => limiter.reserve(rate, context), context, now)) !== true)
        throw new HtxProtocolError('RATE_LIMITED');
      const params = spec.params ?? {};
      if (Object.keys(params).length > 16) throw new HtxProtocolError('INVALID_REQUEST');
      for (const [key, value] of Object.entries(params))
        if (
          !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) ||
          typeof value !== 'string' ||
          value.length > 2048 ||
          ['Signature', 'AccessKeyId', 'Timestamp', 'SignatureMethod', 'SignatureVersion'].includes(
            key,
          )
        )
          throw new HtxProtocolError('INVALID_REQUEST');
      const url = new URL(spec.path, identity ? 'https://api.huobi.pro' : endpoint.rest);
      url.search =
        spec.sign === undefined
          ? new URLSearchParams(params).toString()
          : await boundedPort(
              () => spec.sign!(method, url.hostname, spec.path, params, context),
              context,
              now,
            );
      assertActive(context, now);
      if (now() < backoffUntil) throw new HtxProtocolError('RATE_LIMITED');
      const response = await io.request(
          {
            url,
            method,
            ...(method === 'POST'
              ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec.body) }
              : {}),
          },
          context,
        ),
        receivedAt = now();
      if ([403, 429].includes(response.status))
        backoffUntil = Math.max(
          backoffUntil,
          receivedAt + (response.status === 403 ? 600000 : 1000),
        );
      let raw: Record<string, unknown> | undefined;
      try {
        raw = wireObject(parseWireJson(response.body));
        if (
          ['too-many-requests', 'api-request-limit'].includes(String(raw['err-code'])) ||
          String(raw.err_code) === '1032'
        )
          backoffUntil = Math.max(backoffUntil, receivedAt + 1000);
      } catch {
        /* Headers still enter the shared budget on malformed responses. */
      }
      await boundedPort(
        () => limiter.observe(rate, response.status, response.headers, context),
        context,
        now,
      );
      if (response.status === 403 || response.status === 429 || now() < backoffUntil)
        throw new HtxProtocolError('RATE_LIMITED');
      if (response.status !== 200) throw new HtxProtocolError('UNAVAILABLE');
      if (!raw) throw new HtxProtocolError('INVALID_RESPONSE');
      if (raw.status === 'maintain') throw new HtxProtocolError('UNAVAILABLE');
      if (raw.status !== undefined && raw.status !== 'ok' && raw.status !== 'error')
        throw new HtxProtocolError('INVALID_RESPONSE');
      if (
        raw.status !== undefined &&
        raw.code !== undefined &&
        (raw.status === 'ok') !== (wireInteger(raw.code) === 200)
      )
        throw new HtxProtocolError('INVALID_RESPONSE');
      const ok = raw.status === 'ok' || (raw.code !== undefined && wireInteger(raw.code) === 200);
      if (!ok) {
        if (raw.status === undefined && raw.code === undefined)
          throw new HtxProtocolError('INVALID_RESPONSE');
        const code = String(raw['err-code'] ?? raw.err_code ?? raw.code);
        if (
          [
            'base-record-invalid',
            'order-orderstate-error',
            'order-not-found',
            '1061',
            '1062',
          ].includes(code)
        )
          throw new HtxProtocolError('UNAVAILABLE');
        throw new HtxProtocolError(
          code.includes('signature') ||
            code.includes('access-key') ||
            [
              '403',
              '1253',
              '12001',
              '12002',
              '12003',
              '12004',
              '12005',
              '12006',
              '12007',
              '12008',
              '12009',
            ].includes(code)
            ? 'AUTHORIZATION_REQUIRED'
            : 'UNAVAILABLE',
        );
      }
      return immutable({ raw, receivedAt });
    },
  });
}
export function readResponse(response: HtxResponse): unknown {
  if (!Object.hasOwn(response.raw, 'data')) throw new HtxProtocolError('INVALID_RESPONSE');
  return response.raw.data;
}
export function assertActive(context: IoContext, now: () => number): void {
  if (context.signal.aborted) throw new HtxProtocolError('ABORTED');
  if (!Number.isSafeInteger(context.deadline) || context.deadline <= now())
    throw new HtxProtocolError('DEADLINE_EXCEEDED');
}
export function boundedPort<T>(
  action: () => Promise<T>,
  context: IoContext,
  now: () => number,
): Promise<T> {
  assertActive(context, now);
  const remaining = context.deadline - now();
  if (remaining > 30_000) throw new HtxProtocolError('INVALID_REQUEST');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      if (ok) resolve(value as T);
      else reject(value instanceof HtxProtocolError ? value : new HtxProtocolError('UNAVAILABLE'));
    };
    const abort = () => finish(false, new HtxProtocolError('ABORTED'));
    const timer = setTimeout(
      () => finish(false, new HtxProtocolError('DEADLINE_EXCEEDED')),
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
