import { createHmac } from 'node:crypto';
import { accountScopeSchema, idSchema, immutable, type AccountScope } from '@ctp/exchange-core';
import { assertActive, BinanceProtocolError } from './client.js';
import type { IoContext } from './io.js';
import type { BinanceConnectionPort, BinanceCredentialPort } from './ports.js';
import type { BinanceEndpointProfile, BinanceProfileId } from './profiles.js';

/** Internal authority captured from the server resolver; never a request tenant hint. */
export interface BinanceBinding {
  readonly profileId: BinanceProfileId;
  readonly account: AccountScope;
  readonly credentialRef: string;
}

/**
 * Sample from the selected profile's read-only /time endpoint. sampledAt is the
 * local receipt time; roundTripMs includes the entire request/response interval.
 * No client-provided offset or timestamp establishes clock authority.
 */
export interface BinanceClockSample {
  readonly serverTime: number;
  readonly sampledAt: number;
  readonly roundTripMs: number;
}

const MAX_SAMPLE_AGE = 30_000;
const MAX_ROUND_TRIP = 1000;
const MAX_LOOKUP_TIME = 30_000;
const RECV_WINDOW = 5000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const reserved = new Set(['signature', 'timestamp', 'recvWindow', 'apiKey']);
const error = (code: ConstructorParameters<typeof BinanceProtocolError>[0]) =>
  new BinanceProtocolError(code);

function capturedBinding(endpoint: BinanceEndpointProfile, value: BinanceBinding): BinanceBinding {
  try {
    const credentialRef = value.credentialRef;
    if (
      value.profileId !== endpoint.id ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(credentialRef)
    ) {
      throw error('SCOPE_MISMATCH');
    }
    return immutable({
      profileId: endpoint.id,
      account: accountScopeSchema.parse(value.account),
      credentialRef,
    });
  } catch {
    throw error('SCOPE_MISMATCH');
  }
}

export function resolveBinanceBinding(
  endpoint: BinanceEndpointProfile,
  connection: BinanceConnectionPort | undefined,
): BinanceBinding | null {
  if (connection === undefined) return null;
  try {
    const resolved = connection.resolve(endpoint.id);
    return capturedBinding(endpoint, { ...resolved, profileId: endpoint.id });
  } catch {
    throw error('SCOPE_MISMATCH');
  }
}

function copiedParameters(params: Readonly<Record<string, string>>): Record<string, string> {
  try {
    const result: Record<string, string> = {};
    const entries = Object.entries(params);
    if (entries.length > 64) throw error('INVALID_REQUEST');
    for (const [key, value] of entries) {
      if (
        !/^[A-Za-z][A-Za-z0-9]*$/.test(key) ||
        reserved.has(key) ||
        typeof value !== 'string' ||
        value.length > 8192
      ) {
        throw error('INVALID_REQUEST');
      }
      result[key] = value;
    }
    return result;
  } catch {
    throw error('INVALID_REQUEST');
  }
}

function timestampFromSample(clock: () => BinanceClockSample | null, now: number): number {
  try {
    const sample = clock();
    if (
      sample === null ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > MAX_TIMESTAMP ||
      !Number.isSafeInteger(sample.serverTime) ||
      sample.serverTime < 0 ||
      sample.serverTime > MAX_TIMESTAMP ||
      !Number.isSafeInteger(sample.sampledAt) ||
      sample.sampledAt < 0 ||
      sample.sampledAt > now ||
      now - sample.sampledAt > MAX_SAMPLE_AGE ||
      !Number.isSafeInteger(sample.roundTripMs) ||
      sample.roundTripMs < 0 ||
      sample.roundTripMs > MAX_ROUND_TRIP
    ) {
      throw error('STALE_METADATA');
    }
    // The server timestamp was produced somewhere within the round trip. Midpoint
    // correction bounds forward uncertainty to 500 ms, below Binance's 1 s rule.
    const timestamp =
      sample.serverTime + Math.floor(sample.roundTripMs / 2) + now - sample.sampledAt;
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP)
      throw error('STALE_METADATA');
    return timestamp;
  } catch {
    throw error('STALE_METADATA');
  }
}

/** A hung trusted credential port cannot hold an adapter operation indefinitely. */
async function boundedLookup<T>(
  start: () => Promise<T>,
  context: IoContext,
  now: () => number,
): Promise<T> {
  assertActive(context, now);
  const remaining = context.deadline - now();
  if (remaining > MAX_LOOKUP_TIME) throw error('INVALID_REQUEST');
  const pending = Promise.resolve().then(start);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (
      value:
        { readonly ok: true; readonly result: T } | { readonly ok: false; readonly failure: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', aborted);
      if (value.ok) resolve(value.result);
      else reject(value.failure);
    };
    const aborted = () => finish({ ok: false, failure: error('ABORTED') });
    const timer = setTimeout(
      () => finish({ ok: false, failure: error('DEADLINE_EXCEEDED') }),
      remaining,
    );
    context.signal.addEventListener('abort', aborted, { once: true });
    // Attach both handlers even after cancellation, consuming a late rejection
    // without retaining its potentially sensitive message as an error cause.
    void pending.then(
      (result) => finish({ ok: true, result }),
      (failure: unknown) => {
        const code =
          failure instanceof BinanceProtocolError &&
          (failure.code === 'ABORTED' || failure.code === 'DEADLINE_EXCEEDED')
            ? failure.code
            : 'AUTHORIZATION_REQUIRED';
        finish({ ok: false, failure: error(code) });
      },
    );
    if (context.signal.aborted) aborted();
  });
}

/**
 * Internal signer. The public composition root accepts only server ports and a
 * built-in profile, never raw credentials or a caller-selected endpoint.
 * HMAC-only credentials are resolved afresh per operation and never cached here.
 *
 * Primary contracts checked 2026-10-01:
 * https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md
 * https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-api.md
 * https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info
 */
export function createBinanceSigner(
  endpoint: BinanceEndpointProfile,
  binding: BinanceBinding | null,
  credentials: BinanceCredentialPort | undefined,
  clock: () => BinanceClockSample | null,
  now: () => number,
) {
  const authority = binding === null ? null : capturedBinding(endpoint, binding);
  let resolveCredentials: BinanceCredentialPort['resolve'] | undefined;
  try {
    resolveCredentials = credentials?.resolve.bind(credentials);
  } catch {
    throw error('AUTHORIZATION_REQUIRED');
  }

  const credential = async (context: IoContext) => {
    assertActive(context, now);
    if (authority === null || resolveCredentials === undefined)
      throw error('AUTHORIZATION_REQUIRED');
    const start = () =>
      Promise.resolve()
        .then(() => {
          assertActive(context, now);
          return resolveCredentials(
            authority.credentialRef,
            endpoint.id,
            authority.account,
            context,
          );
        })
        .catch((failure: unknown) => {
          if (
            failure instanceof BinanceProtocolError &&
            (failure.code === 'ABORTED' || failure.code === 'DEADLINE_EXCEEDED')
          )
            throw error(failure.code);
          throw error('AUTHORIZATION_REQUIRED');
        });
    const resolved = await boundedLookup(start, context, now);
    assertActive(context, now);
    try {
      const account = accountScopeSchema.parse(resolved.account);
      if (
        resolved.profileId !== endpoint.id ||
        account.tenantId !== authority.account.tenantId ||
        account.connectionId !== authority.account.connectionId ||
        account.externalAccountId !== authority.account.externalAccountId
      ) {
        throw error('SCOPE_MISMATCH');
      }
      const apiKey = resolved.apiKey;
      const secret = resolved.secret;
      if (
        typeof apiKey !== 'string' ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(apiKey) ||
        typeof secret !== 'string' ||
        secret.length < 1 ||
        secret.length > 1024 ||
        /[\p{Cc}\p{Cs}]/u.test(secret)
      ) {
        throw error('AUTHORIZATION_REQUIRED');
      }
      return { apiKey, secret };
    } catch (failure) {
      if (failure instanceof BinanceProtocolError && failure.code === 'SCOPE_MISMATCH')
        throw error('SCOPE_MISMATCH');
      throw error('AUTHORIZATION_REQUIRED');
    }
  };

  return Object.freeze({
    async signRest(params: Readonly<Record<string, string>>, context: IoContext) {
      const unsigned = copiedParameters(params);
      const resolved = await credential(context);
      const timestamp = timestampFromSample(clock, now());
      const wire = { ...unsigned, recvWindow: String(RECV_WINDOW), timestamp: String(timestamp) };
      // The client uses this same URLSearchParams insertion order and encoding.
      // Keep all parameters in the query; mixed query/body signing is excluded.
      const signature = createHmac('sha256', resolved.secret)
        .update(new URLSearchParams(wire).toString())
        .digest('hex');
      assertActive(context, now);
      return immutable({
        params: { ...wire, signature },
        headers: { 'X-MBX-APIKEY': resolved.apiKey },
      });
    },
    async spotSubscription(id: string, context: IoContext) {
      if (endpoint.scope.market !== 'SPOT') throw error('UNSUPPORTED');
      if (!idSchema.safeParse(id).success) throw error('INVALID_REQUEST');
      const resolved = await credential(context);
      const timestamp = timestampFromSample(clock, now());
      const params = { apiKey: resolved.apiKey, recvWindow: RECV_WINDOW, timestamp };
      // Unlike REST, Binance WS signs parameters sorted by their ASCII names.
      const payload = Object.entries(params)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('&');
      const signature = createHmac('sha256', resolved.secret).update(payload).digest('hex');
      assertActive(context, now);
      return immutable({
        id,
        method: 'userDataStream.subscribe.signature' as const,
        params: { ...params, signature },
      });
    },
    async apiKeyHeaders(context: IoContext) {
      const resolved = await credential(context);
      assertActive(context, now);
      return immutable({ 'X-MBX-APIKEY': resolved.apiKey });
    },
  });
}

export type BinanceSigner = ReturnType<typeof createBinanceSigner>;
