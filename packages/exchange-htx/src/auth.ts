import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { accountScopeSchema, immutable, type AccountScope } from '@ctp/exchange-core';
import { assertActive, boundedPort, HtxProtocolError } from './client.js';
import type { IoContext } from './io.js';
import type { HtxEndpointProfile } from './profiles.js';
import type { HtxConnectionPort, HtxCredentialPort, HtxPermissionPort } from './ports.js';
const encode = (v: string) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export function canonicalQuery(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encode(k)}=${encode(params[k]!)}`)
    .join('&');
}
export function signQuery(
  secret: string,
  method: 'GET' | 'POST',
  host: string,
  path: string,
  params: Readonly<Record<string, string>>,
): string {
  return createHmac('sha256', secret)
    .update(`${method}\n${host.toLowerCase()}\n${path}\n${canonicalQuery(params)}`)
    .digest('base64');
}
const timestamp = (t: number) => new Date(t).toISOString().slice(0, 19);
export function signPrivateWs(
  endpoint: HtxEndpointProfile,
  key: string,
  secret: string,
  t: number,
): Readonly<Record<string, unknown>> {
  const url = new URL(endpoint.privateWs);
  if (endpoint.spot) {
    const params = {
      accessKey: key,
      signatureMethod: 'HmacSHA256',
      signatureVersion: '2.1',
      timestamp: timestamp(t),
    };
    return immutable({
      action: 'req',
      ch: 'auth',
      params: {
        ...params,
        authType: 'api',
        signature: signQuery(secret, 'GET', url.hostname, url.pathname, params),
      },
    });
  }
  const params = {
    AccessKeyId: key,
    SignatureMethod: 'HmacSHA256',
    SignatureVersion: '2',
    Timestamp: timestamp(t),
  };
  return immutable({
    op: 'auth',
    type: 'api',
    ...params,
    Signature: signQuery(secret, 'GET', url.hostname, url.pathname, params),
  });
}
export interface HtxBinding {
  readonly account: AccountScope;
  readonly credentialRef: string;
  readonly spotAccountId?: string;
}
export interface ClockSample {
  readonly serverTime: number;
  readonly sampledAt: number;
  readonly roundTripMs: number;
}
export function resolveBinding(
  endpoint: HtxEndpointProfile,
  port: HtxConnectionPort | undefined,
): HtxBinding | null {
  if (!port) return null;
  try {
    const x = port.resolve(endpoint.id),
      account = accountScopeSchema.parse(x.account);
    if (!/^\d{1,30}$/.test(account.externalAccountId)) throw new Error();
    const credentialRef = z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      .parse(x.credentialRef);
    if (
      endpoint.spot &&
      (typeof x.spotAccountId !== 'string' || !/^\d{1,30}$/.test(x.spotAccountId))
    )
      throw new Error();
    if (!endpoint.spot && x.spotAccountId !== undefined) throw new Error();
    return immutable({
      account,
      credentialRef,
      ...(endpoint.spot ? { spotAccountId: x.spotAccountId! } : {}),
    });
  } catch {
    throw new HtxProtocolError('SCOPE_MISMATCH');
  }
}
const same = (a: AccountScope, b: AccountScope) =>
  a.tenantId === b.tenantId &&
  a.connectionId === b.connectionId &&
  a.externalAccountId === b.externalAccountId;
export function createSigner(
  endpoint: HtxEndpointProfile,
  binding: HtxBinding | null,
  credentials: HtxCredentialPort | undefined,
  permissions: HtxPermissionPort | undefined,
  clock: () => ClockSample | null,
  now: () => number,
) {
  async function permission(context: IoContext) {
    if (!binding || !permissions) throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
    const x = await boundedPort(
      () => permissions.verify(endpoint.id, binding.account, binding.credentialRef, context),
      context,
      now,
    );
    if (
      x.profileId !== endpoint.id ||
      x.credentialRef !== binding.credentialRef ||
      !same(accountScopeSchema.parse(x.account), binding.account) ||
      x.accountMode !== (endpoint.spot ? 'SPOT_CASH' : 'SINGLE_ASSET_CROSS_HEDGE') ||
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
      throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
    return immutable(x);
  }
  function signedTime() {
    const x = clock(),
      t = now();
    if (
      !x ||
      ![t, x.serverTime, x.sampledAt, x.roundTripMs].every(Number.isSafeInteger) ||
      x.roundTripMs < 0 ||
      x.roundTripMs > 1000 ||
      x.sampledAt > t ||
      t - x.sampledAt > 30000
    )
      throw new HtxProtocolError('STALE_METADATA');
    const offset = x.serverTime + x.roundTripMs / 2 - x.sampledAt;
    if (Math.abs(offset) > 500) throw new HtxProtocolError('STALE_METADATA');
    return Math.floor(t + offset);
  }
  async function material(context: IoContext) {
    if (!binding || !credentials) throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
    const x = await boundedPort(
      () => credentials.resolve(binding.credentialRef, endpoint.id, binding.account, context),
      context,
      now,
    );
    if (
      x.profileId !== endpoint.id ||
      !same(accountScopeSchema.parse(x.account), binding.account) ||
      typeof x.apiKey !== 'string' ||
      !/^[A-Za-z0-9_-]{8,256}$/.test(x.apiKey) ||
      typeof x.secret !== 'string' ||
      !/^[A-Za-z0-9_-]{8,256}$/.test(x.secret)
    )
      throw new HtxProtocolError('SCOPE_MISMATCH');
    assertActive(context, now);
    return { key: x.apiKey, secret: x.secret };
  }
  return Object.freeze({
    permission,
    async rest(
      method: 'GET' | 'POST',
      host: string,
      path: string,
      params: Readonly<Record<string, string>>,
      context: IoContext,
    ) {
      const proof = await permission(context),
        x = await material(context);
      if (now() >= proof.expiresAt || now() - proof.checkedAt > 30000)
        throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
      const p = {
        ...params,
        AccessKeyId: x.key,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp(signedTime()),
      };
      return canonicalQuery(p) + '&Signature=' + encode(signQuery(x.secret, method, host, path, p));
    },
    async ws(context: IoContext) {
      const proof = await permission(context),
        x = await material(context);
      if (now() >= proof.expiresAt || now() - proof.checkedAt > 30000)
        throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
      return signPrivateWs(endpoint, x.key, x.secret, signedTime());
    },
  });
}
export type HtxSigner = ReturnType<typeof createSigner>;
