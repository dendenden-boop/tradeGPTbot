import { createHmac } from 'node:crypto';
import {
  accountScopeSchema,
  accountInfoSchema,
  immutable,
  type AccountScope,
  type MarketScope,
} from '@ctp/exchange-core';
import { z } from 'zod';
import { assertActive, boundedPort, OkxProtocolError } from './client.js';
import type { IoContext } from './io.js';
import type { OkxEndpointProfile } from './profiles.js';
import type { OkxConnectionPort, OkxCredentialPort, OkxPermissionPort } from './ports.js';
import { wireArray, wireObject } from './wire.js';

export function signRest(
  secret: string,
  timestamp: string,
  method: 'GET' | 'POST',
  path: string,
  body: string,
): string {
  return createHmac('sha256', secret)
    .update(timestamp + method + path + body)
    .digest('base64');
}
export function signWs(secret: string, timestamp: string): string {
  return createHmac('sha256', secret)
    .update(timestamp + 'GET/users/self/verify')
    .digest('base64');
}
export interface OkxBinding {
  readonly account: AccountScope;
  readonly credentialRef: string;
}
export interface ClockSample {
  readonly serverTime: number;
  readonly sampledAt: number;
  readonly roundTripMs: number;
}
export function resolveBinding(
  endpoint: OkxEndpointProfile,
  port: OkxConnectionPort | undefined,
): OkxBinding | null {
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
    throw new OkxProtocolError('SCOPE_MISMATCH');
  }
}
const equalAccount = (a: AccountScope, b: AccountScope) =>
  a.tenantId === b.tenantId &&
  a.connectionId === b.connectionId &&
  a.externalAccountId === b.externalAccountId;
export function verifyAccountConfiguration(
  raw: unknown,
  account: AccountScope,
  scope: MarketScope,
  checkedAt: number,
) {
  const rows = wireArray(raw, 1);
  if (rows.length !== 1) throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
  const x = wireObject(rows[0]);
  const permissions = typeof x.perm === 'string' ? x.perm.split(',') : [];
  if (
    x.uid !== account.externalAccountId ||
    x.acctLv !== '2' ||
    x.posMode !== 'net_mode' ||
    x.autoLoan !== false ||
    x.roleType !== '0' ||
    x.spotRoleType !== '0' ||
    x.stgyType !== '0' ||
    !permissions.includes('read_only') ||
    new Set(permissions).size !== permissions.length ||
    permissions.some((p) => !['read_only', 'trade'].includes(p))
  )
    throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
  return immutable(
    accountInfoSchema.parse({
      account,
      scope,
      accountMode: 'FUTURES_MODE_NET',
      permissions: permissions.includes('trade') ? ['READ', 'TRADE'] : ['READ'],
      positionMode: 'ONE_WAY',
      checkedAt,
    }),
  );
}
export function createSigner(
  endpoint: OkxEndpointProfile,
  binding: OkxBinding | null,
  credentials: OkxCredentialPort | undefined,
  permissions: OkxPermissionPort | undefined,
  clock: () => ClockSample | null,
  now: () => number,
) {
  async function permission(context: IoContext) {
    if (!binding || !permissions) throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
    const x = await boundedPort(
      () => permissions.verify(endpoint.id, binding.account, binding.credentialRef, context),
      context,
      now,
    );
    if (
      x.profileId !== endpoint.id ||
      x.credentialRef !== binding.credentialRef ||
      !equalAccount(accountScopeSchema.parse(x.account), binding.account) ||
      x.canRead !== true ||
      typeof x.canTrade !== 'boolean' ||
      x.withdrawalEnabled !== false ||
      !Number.isSafeInteger(x.checkedAt) ||
      !Number.isSafeInteger(x.expiresAt) ||
      x.checkedAt > now() ||
      now() - x.checkedAt > 30000 ||
      x.expiresAt <= now() ||
      x.expiresAt - x.checkedAt > 30000
    )
      throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
    return immutable(x);
  }
  function timestamp() {
    const x = clock(),
      t = now();
    if (
      !x ||
      !Number.isSafeInteger(t) ||
      !Number.isSafeInteger(x.serverTime) ||
      !Number.isSafeInteger(x.sampledAt) ||
      !Number.isSafeInteger(x.roundTripMs) ||
      x.roundTripMs < 0 ||
      x.roundTripMs > 1000 ||
      x.sampledAt > t ||
      t - x.sampledAt > 30000
    )
      throw new OkxProtocolError('STALE_METADATA');
    const offset = x.serverTime + x.roundTripMs / 2 - x.sampledAt;
    if (Math.abs(offset) > 500) throw new OkxProtocolError('STALE_METADATA');
    return Math.floor(t + offset);
  }
  async function material(context: IoContext) {
    if (!binding || !credentials) throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
    const x = await boundedPort(
      () => credentials.resolve(binding.credentialRef, endpoint.id, binding.account, context),
      context,
      now,
    );
    if (
      x.profileId !== endpoint.id ||
      !equalAccount(accountScopeSchema.parse(x.account), binding.account) ||
      typeof x.apiKey !== 'string' ||
      !/^[A-Za-z0-9_-]{8,256}$/.test(x.apiKey) ||
      typeof x.secret !== 'string' ||
      !/^[A-Za-z0-9_-]{8,256}$/.test(x.secret) ||
      typeof x.passphrase !== 'string' ||
      !/^[\x21-\x7e]{8,64}$/.test(x.passphrase)
    )
      throw new OkxProtocolError('SCOPE_MISMATCH');
    assertActive(context, now);
    return { apiKey: x.apiKey, secret: x.secret, passphrase: x.passphrase };
  }
  return Object.freeze({
    permission,
    async rest(method: 'GET' | 'POST', path: string, body: string, context: IoContext) {
      const proof = await permission(context),
        x = await material(context);
      if (
        (method === 'POST' && !proof.canTrade) ||
        now() >= proof.expiresAt ||
        now() - proof.checkedAt > 30000
      )
        throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
      const t = new Date(timestamp()).toISOString();
      return {
        'OK-ACCESS-KEY': x.apiKey,
        'OK-ACCESS-TIMESTAMP': t,
        'OK-ACCESS-PASSPHRASE': x.passphrase,
        'OK-ACCESS-SIGN': signRest(x.secret, t, method, path, body),
      };
    },
    async ws(context: IoContext) {
      const proof = await permission(context),
        x = await material(context);
      if (now() >= proof.expiresAt || now() - proof.checkedAt > 30000)
        throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
      const t = String(Math.floor(timestamp() / 1000));
      return {
        apiKey: x.apiKey,
        passphrase: x.passphrase,
        timestamp: t,
        sign: signWs(x.secret, t),
      };
    },
  });
}
export type OkxSigner = ReturnType<typeof createSigner>;
