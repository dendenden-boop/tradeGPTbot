import { createHmac } from 'node:crypto';
import { accountScopeSchema, immutable, type AccountScope } from '@ctp/exchange-core';
import { z } from 'zod';
import { assertActive, boundedPort, BybitProtocolError } from './client.js';
import type { IoContext } from './io.js';
import type { BybitEndpointProfile } from './profiles.js';
import type { BybitConnectionPort, BybitCredentialPort, BybitPermissionPort } from './ports.js';

export function signRest(key: string, secret: string, timestamp: number, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}${key}5000${payload}`).digest('hex');
}
export function signWs(secret: string, expires: number): string {
  return createHmac('sha256', secret).update(`GET/realtime${expires}`).digest('hex');
}
export interface BybitBinding {
  readonly account: AccountScope;
  readonly credentialRef: string;
}
export interface ClockSample {
  readonly serverTime: number;
  readonly sampledAt: number;
  readonly roundTripMs: number;
}
export function resolveBinding(
  endpoint: BybitEndpointProfile,
  port: BybitConnectionPort | undefined,
): BybitBinding | null {
  if (port === undefined) return null;
  try {
    const x = port.resolve(endpoint.id);
    return immutable({
      account: accountScopeSchema.parse(x.account),
      credentialRef: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
        .parse(x.credentialRef),
    });
  } catch {
    throw new BybitProtocolError('SCOPE_MISMATCH');
  }
}
const equalAccount = (a: AccountScope, b: AccountScope) =>
  a.tenantId === b.tenantId &&
  a.connectionId === b.connectionId &&
  a.externalAccountId === b.externalAccountId;
export function createSigner(
  endpoint: BybitEndpointProfile,
  binding: BybitBinding | null,
  credentials: BybitCredentialPort | undefined,
  permissions: BybitPermissionPort | undefined,
  clock: () => ClockSample | null,
  now: () => number,
) {
  async function permission(context: IoContext) {
    if (!binding || !permissions) throw new BybitProtocolError('AUTHORIZATION_REQUIRED');
    const x = await boundedPort(
      () => permissions.verify(endpoint.id, binding.account, binding.credentialRef, context),
      context,
      now,
    );
    try {
      const a = accountScopeSchema.parse(x.account);
      if (
        x.profileId !== endpoint.id ||
        x.credentialRef !== binding.credentialRef ||
        !equalAccount(a, binding.account) ||
        x.canRead !== true ||
        typeof x.canTrade !== 'boolean' ||
        x.withdrawalEnabled !== false ||
        !Number.isSafeInteger(x.checkedAt) ||
        !Number.isSafeInteger(x.expiresAt) ||
        x.checkedAt > now() ||
        now() - x.checkedAt > 30_000 ||
        x.expiresAt <= now() ||
        x.expiresAt - x.checkedAt > 30_000
      )
        throw new Error();
      return immutable({ ...x, account: a });
    } catch {
      throw new BybitProtocolError('AUTHORIZATION_REQUIRED');
    }
  }
  function timestamp() {
    const x = clock();
    const time = now();
    if (
      !x ||
      !Number.isSafeInteger(time) ||
      !Number.isSafeInteger(x.serverTime) ||
      !Number.isSafeInteger(x.sampledAt) ||
      !Number.isSafeInteger(x.roundTripMs) ||
      x.roundTripMs < 0 ||
      x.roundTripMs > 1000 ||
      x.sampledAt > time ||
      time - x.sampledAt > 30_000
    )
      throw new BybitProtocolError('STALE_METADATA');
    const offset = x.serverTime + x.roundTripMs / 2 - x.sampledAt;
    if (Math.abs(offset) > 500) throw new BybitProtocolError('STALE_METADATA');
    return Math.floor(time + offset);
  }
  async function material(context: IoContext) {
    if (!binding || !credentials) throw new BybitProtocolError('AUTHORIZATION_REQUIRED');
    const x = await boundedPort(
      () => credentials.resolve(binding.credentialRef, endpoint.id, binding.account, context),
      context,
      now,
    );
    try {
      if (
        x.profileId !== endpoint.id ||
        !equalAccount(accountScopeSchema.parse(x.account), binding.account) ||
        !/^[A-Za-z0-9_-]{8,256}$/.test(x.apiKey) ||
        !/^[A-Za-z0-9_-]{8,256}$/.test(x.secret)
      )
        throw new Error();
      assertActive(context, now);
      return { apiKey: x.apiKey, secret: x.secret };
    } catch {
      throw new BybitProtocolError('SCOPE_MISMATCH');
    }
  }
  return Object.freeze({
    permission,
    async rest(payload: string, context: IoContext) {
      const proof = await permission(context);
      const x = await material(context);
      if (now() >= proof.expiresAt || now() - proof.checkedAt > 30_000)
        throw new BybitProtocolError('AUTHORIZATION_REQUIRED');
      const t = timestamp();
      return {
        'X-BAPI-API-KEY': x.apiKey,
        'X-BAPI-TIMESTAMP': String(t),
        'X-BAPI-RECV-WINDOW': '5000',
        'X-BAPI-SIGN': signRest(x.apiKey, x.secret, t, payload),
      };
    },
    async ws(context: IoContext) {
      const proof = await permission(context);
      const x = await material(context);
      if (now() >= proof.expiresAt || now() - proof.checkedAt > 30_000)
        throw new BybitProtocolError('AUTHORIZATION_REQUIRED');
      const expires = timestamp() + 5000;
      return [x.apiKey, expires, signWs(x.secret, expires)] as const;
    },
  });
}
export type BybitSigner = ReturnType<typeof createSigner>;
