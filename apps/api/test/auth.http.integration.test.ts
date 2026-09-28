import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { AuthError, type AuthService } from '@ctp/auth';
import type { AppConfig, AuthConfig } from '@ctp/config';
import type { AuthPrincipal } from '@ctp/database';
import { createLogger } from '@ctp/logger';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginDrain, buildApp } from '../src/app.js';
import type { AuthRoutesOptions } from '../src/auth-routes.js';

const password = 'a test password long enough';
const email = 'person@example.invalid';
const sessionToken = randomBytes(32).toString('base64url');
const rotatedToken = randomBytes(32).toString('base64url');
const principal: AuthPrincipal = {
  userId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  emailNormalized: email,
  role: 'USER',
  createdAt: new Date('2026-09-14T10:00:00Z'),
  lastSeenAt: new Date('2026-09-14T10:00:00Z'),
  idleExpiresAt: new Date('2026-09-14T10:30:00Z'),
  expiresAt: new Date('2026-09-14T22:00:00Z'),
};
const baseConfig: AppConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'info',
  databaseUrl: 'postgresql://unused:unused@127.0.0.1:5432/unused',
  redisUrl: 'redis://127.0.0.1:6379/0',
  dependencyTimeoutMs: 250,
  healthCacheMs: 0,
  shutdownTimeoutMs: 1000,
  bodyLimitBytes: 4096,
  requestTimeoutMs: 2000,
  connectionTimeoutMs: 2000,
  postgresPoolMax: 2,
  trustedProxyCidrs: [],
};
const applications: FastifyInstance[] = [];

class Client {
  readonly cookies = new Map<string, string>();
  constructor(
    readonly url: string,
    readonly origin: string,
  ) {}
  async request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      csrf?: string;
      origin?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers: Record<string, string> = {
      cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...options.headers,
    };
    if (options.origin !== null) headers['origin'] = options.origin ?? this.origin;
    if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${this.url}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]!;
      const boundary = pair.indexOf('=');
      const key = pair.slice(0, boundary);
      if (/max-age=0/i.test(value)) this.cookies.delete(key);
      else this.cookies.set(key, pair.slice(boundary + 1));
    }
    return response;
  }
  async csrf() {
    const response = await this.request('/api/v1/auth/csrf', { origin: null });
    expect(response.status).toBe(200);
    return ((await response.json()) as { csrfToken: string }).csrfToken;
  }
}

async function rawRequest(
  url: string,
  headers: string[],
  payload: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL('/api/v1/auth/signup', url),
      { method: 'POST', headers },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.once('end', () => resolve({ status: response.statusCode!, text }));
        response.once('error', reject);
      },
    );
    request.once('error', reject);
    request.end(payload);
  });
}

async function fixture(secure = false, overrides: Partial<AppConfig> = {}) {
  const service = {
    csrf: vi.fn<AuthService['csrf']>().mockResolvedValue(undefined),
    signup: vi.fn<AuthService['signup']>().mockResolvedValue(undefined),
    resendVerification: vi.fn<AuthService['resendVerification']>().mockResolvedValue(undefined),
    verifyEmail: vi.fn<AuthService['verifyEmail']>().mockResolvedValue(undefined),
    login: vi.fn<AuthService['login']>().mockResolvedValue({ token: sessionToken, principal }),
    logout: vi.fn<AuthService['logout']>().mockResolvedValue(undefined),
    forgotPassword: vi.fn<AuthService['forgotPassword']>().mockResolvedValue(undefined),
    resetPassword: vi.fn<AuthService['resetPassword']>().mockResolvedValue(undefined),
    changePassword: vi.fn<AuthService['changePassword']>().mockResolvedValue(undefined),
    authenticate: vi.fn<AuthService['authenticate']>().mockResolvedValue(principal),
    listSessions: vi.fn<AuthService['listSessions']>().mockResolvedValue([principal]),
    rotateSession: vi
      .fn<AuthService['rotateSession']>()
      .mockResolvedValue({ token: rotatedToken, principal }),
    revokeSession: vi.fn<AuthService['revokeSession']>().mockResolvedValue(undefined),
    revokeAllSessions: vi.fn<AuthService['revokeAllSessions']>().mockResolvedValue(undefined),
    ready: vi.fn<AuthService['ready']>().mockResolvedValue(undefined),
    emailReady: vi.fn<AuthService['emailReady']>().mockResolvedValue(undefined),
    close: vi.fn<AuthService['close']>().mockResolvedValue(undefined),
  };
  const readUser = vi.fn<AuthRoutesOptions['readUser']>().mockResolvedValue({
    id: principal.userId,
    emailNormalized: email,
    status: 'ACTIVE',
    role: 'USER',
    emailVerifiedAt: principal.createdAt,
  });
  const config: AuthConfig = {
    databaseAuthUrl: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    origin: secure ? 'https://app.example.invalid' : 'http://localhost:3000',
    cookieSecure: secure,
    csrfSecret: randomBytes(32).toString('hex'),
    smtp: {
      host: '127.0.0.1',
      port: 1025,
      secure: false,
      requireTls: false,
      from: 'auth@example.invalid',
    },
  };
  const logs: string[] = [];
  const logger = createLogger(
    { environment: 'test', level: 'info' },
    { write: (line: string) => logs.push(line) },
  );
  const app = buildApp({
    config: { ...baseConfig, ...overrides },
    logger,
    health: {
      check: () =>
        Promise.resolve({ status: 'ready', dependencies: { postgres: 'up', redis: 'up' } }),
      close: async () => {},
    },
    auth: { service, config, readUser },
  });
  applications.push(app);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, service, config, logs, readUser, client: new Client(url, config.origin) };
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe('authentication HTTP security over loopback sockets', () => {
  it('separates two forwarded clients behind a real trusted reverse proxy', async () => {
    const { client, service } = await fixture(false, { trustedProxyCidrs: ['127.0.0.1/32'] });
    const proxy = createServer((incoming, outgoing) => {
      // This owned edge replaces inbound forwarding data with its known client identity.
      const upstream = httpRequest(
        `${client.url}/api/v1/auth/csrf`,
        { headers: { 'x-forwarded-for': incoming.url === '/a' ? '198.51.100.1' : '198.51.100.2' } },
        (response) => {
          outgoing.writeHead(response.statusCode!, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.once('error', () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      upstream.end();
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const address = proxy.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP proxy');
      for (const path of ['/a', '/b']) {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          headers: { 'x-forwarded-for': '203.0.113.99' },
          signal: AbortSignal.timeout(3000),
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(service.csrf.mock.calls.map(([context]) => context.ip)).toEqual([
        '198.51.100.1',
        '198.51.100.2',
      ]);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('ignores forged forwarding from direct clients and proxies outside the allowlist', async () => {
    for (const trustedProxyCidrs of [[], ['192.0.2.10/32']]) {
      const { client, service } = await fixture(false, { trustedProxyCidrs });
      for (const forwarded of ['198.51.100.24', 'malformed, unknown']) {
        const response = await client.request('/api/v1/auth/csrf', {
          headers: { 'x-forwarded-for': forwarded },
        });
        expect(response.status).toBe(200);
        expect(service.csrf).toHaveBeenLastCalledWith({ ip: '127.0.0.1' });
      }
    }
  });
  it('walks trusted hops from the socket and stops at the first untrusted address', async () => {
    const { client, service } = await fixture(false, {
      trustedProxyCidrs: ['127.0.0.1/32', '10.0.0.0/8', '2001:db8:ffff::/48'],
    });
    for (const [chain, expected] of [
      ['198.51.100.7, 10.2.3.4', '198.51.100.7'],
      ['203.0.113.99, 198.51.100.8, 10.2.3.4', '198.51.100.8'],
      ['2001:0DB8:0:0:0:0:0:1, 10.2.3.4', '2001:db8::1'],
      ['2001:db8::1, 10.2.3.4', '2001:db8::1'],
      ['::ffff:c000:201, 10.2.3.4', '192.0.2.1'],
      ['::ffff:192.0.2.1, 10.2.3.4', '192.0.2.1'],
      ['2001:db8:abcd::1, 2001:0DB8:FFFF:0:0:0:0:A', '2001:db8:abcd::1'],
    ]) {
      const response = await client.request('/api/v1/auth/csrf', {
        headers: { 'x-forwarded-for': chain! },
      });
      expect(response.status).toBe(200);
      expect(service.csrf).toHaveBeenLastCalledWith({ ip: expected });
    }
  });
  it('rejects malformed, oversized and repeated forwarding from a trusted peer', async () => {
    const { client, service } = await fixture(false, { trustedProxyCidrs: ['127.0.0.1'] });
    for (const value of [
      'unknown',
      '198.51.100.1:3000',
      '[2001:db8::1]',
      'fe80::1%lo',
      '198.51.100.1,,10.2.3.4',
      '198.51.100.1,',
      Array.from({ length: 17 }, () => '198.51.100.1').join(', '),
      `198.51.100.1,${' '.repeat(1024)}10.2.3.4`,
    ]) {
      const response = await client.request('/api/v1/auth/csrf', {
        headers: { 'x-forwarded-for': value },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    }
    const response = await rawRequest(
      client.url,
      [
        'host',
        new URL(client.url).host,
        'x-forwarded-for',
        '198.51.100.1',
        'x-forwarded-for',
        '198.51.100.2',
        'origin',
        client.origin,
      ],
      '',
    );
    expect(response.status).toBe(400);
    expect(service.csrf).not.toHaveBeenCalled();
    expect(service.signup).not.toHaveBeenCalled();
  });
  it('uses the validated canonical source for login, signup and email recovery budgets', async () => {
    const { client, service } = await fixture(false, { trustedProxyCidrs: ['127.0.0.1/32'] });
    const headers = { 'x-forwarded-for': '2001:0DB8:0:0:0:0:0:1' };
    const response = await client.request('/api/v1/auth/csrf', { headers });
    expect(response.status).toBe(200);
    const csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
    for (const route of ['signup', 'forgot-password', 'resend-verification', 'login']) {
      const response = await client.request(`/api/v1/auth/${route}`, {
        method: 'POST',
        csrf,
        headers,
        body: route === 'login' || route === 'signup' ? { email, password } : { email },
      });
      expect(response.status).toBe(route === 'login' ? 200 : 202);
    }
    for (const operation of [
      service.csrf,
      service.signup,
      service.forgotPassword,
      service.resendVerification,
      service.login,
    ]) {
      expect(operation.mock.calls[0]?.[0]).toEqual({ ip: '2001:db8::1' });
    }
  });
  it('repairs malformed session cookies through a fresh preauth CSRF transition', async () => {
    const { client, service } = await fixture();
    const oldCsrf = await client.csrf();
    client.cookies.set('ctp-dev-session', 'malformed');
    expect((await client.request('/api/v1/users/me')).status).toBe(401);
    expect(
      (
        await client.request('/api/v1/auth/login', {
          method: 'POST',
          csrf: oldCsrf,
          body: { email, password },
        })
      ).status,
    ).toBe(401);
    expect(service.login).not.toHaveBeenCalled();
    const blocked = await client.request('/api/v1/auth/csrf', { origin: 'https://evil.invalid' });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.getSetCookie()).toEqual([]);
    const csrf = await client.csrf();
    expect(client.cookies.has('ctp-dev-session')).toBe(false);
    expect(
      (
        await client.request('/api/v1/auth/login', {
          method: 'POST',
          csrf: oldCsrf,
          body: { email, password },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await client.request('/api/v1/auth/login', {
          method: 'POST',
          csrf,
          body: { email, password },
        })
      ).status,
    ).toBe(200);
    expect(service.login).toHaveBeenCalledWith({ ip: '127.0.0.1' }, email, password, undefined);
  });
  it('recovers from revoked sessions and tampered preauth without trusting a repeated request ID', async () => {
    const { client, service } = await fixture();
    service.authenticate.mockRejectedValue(new AuthError('UNAUTHENTICATED'));
    client.cookies.set('ctp-dev-session', rotatedToken);
    const headers = { 'x-request-id': 'repeatable-client-correlation' };
    expect((await client.request('/api/v1/users/me', { headers })).status).toBe(401);
    const csrf = await client.csrf();
    const response = await client.request('/api/v1/auth/login', {
      method: 'POST',
      csrf,
      body: { email, password },
      headers,
    });
    expect(response.status).toBe(200);
    expect(client.cookies.get('ctp-dev-session')).toBe(sessionToken);
    expect(await response.text()).not.toContain(sessionToken);
    expect((await client.request('/api/v1/users/me', { headers })).status).toBe(401);
    client.cookies.delete('ctp-dev-session');
    client.cookies.set('ctp-dev-preauth', 'tampered-signed-cookie');
    const fresh = await client.csrf();
    expect(
      (
        await client.request('/api/v1/auth/login', {
          method: 'POST',
          csrf: fresh,
          body: { email, password },
          headers,
        })
      ).status,
    ).toBe(200);
  });
  it('reports auth-email readiness separately and recovers without altering core readiness', async () => {
    const { app, client, service, logs } = await fixture();
    service.emailReady.mockRejectedValue(new Error('smtp-secret-sentinel'));
    const failure = await client.request('/health/auth-email');
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ status: 'not_ready' });
    expect((await client.request('/health/ready')).status).toBe(200);
    service.emailReady.mockResolvedValue(undefined);
    const recovered = await client.request('/health/auth-email');
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ status: 'ready' });
    beginDrain(app);
    expect((await client.request('/health/auth-email')).status).toBe(503);
    expect(service.emailReady).toHaveBeenCalledTimes(2);
    expect(logs.join('')).not.toContain('smtp-secret-sentinel');
  });
  it('reports integer Retry-After from the actual blocking limiter window', async () => {
    const { client, service } = await fixture();
    const csrf = await client.csrf();
    for (const [milliseconds, seconds] of [
      [1, 1],
      [1000, 1],
      [1001, 2],
      [59_999, 60],
      [899_001, 900],
    ]) {
      service.login.mockRejectedValue(new AuthError('RATE_LIMITED', milliseconds));
      const response = await client.request('/api/v1/auth/login', {
        method: 'POST',
        csrf,
        body: { email, password },
      });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe(String(seconds));
      expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    }
  });
  it('keeps email readiness unavailable when drain begins during its probe', async () => {
    const { app, client, service } = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.emailReady.mockImplementation(async () => {
      entered();
      await finished;
    });
    const pending = client.request('/health/auth-email');
    await started;
    beginDrain(app);
    release();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready' });
  });
  it('issues CSRF tokens to same-origin GET fetches without Origin and never enables CORS or caching', async () => {
    const { client, service } = await fixture();
    const response = await client.request('/api/v1/auth/csrf', { origin: null });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(service.csrf).toHaveBeenCalledWith({ ip: '127.0.0.1' });
    expect(client.cookies.has('ctp-dev-csrf')).toBe(true);
    expect(client.cookies.has('ctp-dev-preauth')).toBe(true);
    expect(
      (await client.request('/api/v1/auth/csrf', { origin: 'https://evil.example.invalid' }))
        .status,
    ).toBe(403);
    expect(
      (
        await client.request('/api/v1/auth/csrf', {
          origin: null,
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
  });
  it('requires exact Origin and CSRF on every mutation before invoking authentication logic', async () => {
    const { client, service } = await fixture();
    const paths = [
      'signup',
      'resend-verification',
      'verify-email',
      'login',
      'logout',
      'forgot-password',
      'reset-password',
      'change-password',
      'session/rotate',
      'logout-all',
      `sessions/${principal.sessionId}`,
    ];
    const csrf = await client.csrf();
    for (const path of paths) {
      const method = path.startsWith('sessions/') ? 'DELETE' : 'POST';
      expect((await client.request(`/api/v1/auth/${path}`, { method })).status).toBe(403);
      expect(
        (await client.request(`/api/v1/auth/${path}`, { method, csrf, origin: null })).status,
      ).toBe(403);
      expect(
        (
          await client.request(`/api/v1/auth/${path}`, {
            method,
            csrf,
            origin: 'http://localhost:3000.evil.invalid',
          })
        ).status,
      ).toBe(403);
    }
    for (const [name, mock] of Object.entries(service))
      if (name !== 'csrf') expect(mock).not.toHaveBeenCalled();
  });
  it('accepts tokens only from x-csrf-token and rejects mismatched preauthentication identities', async () => {
    const { client, service } = await fixture();
    const first = await client.csrf();
    const second = new Client(client.url, client.origin);
    await second.csrf();
    expect(
      (
        await second.request('/api/v1/auth/signup', {
          method: 'POST',
          csrf: first,
          body: { email, password },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await client.request('/api/v1/auth/signup', {
          method: 'POST',
          body: { email, password, _csrf: first },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await client.request(`/api/v1/auth/signup?csrf=${encodeURIComponent(first)}`, {
          method: 'POST',
          body: { email, password },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await client.request('/api/v1/auth/signup', {
          method: 'POST',
          headers: { 'csrf-token': first },
          body: { email, password },
        })
      ).status,
    ).toBe(403);
    expect(service.signup).not.toHaveBeenCalled();
  });
  it('rejects signed-cookie tampering and duplicate authentication cookies', async () => {
    const { client } = await fixture();
    const csrf = await client.csrf();
    const original = client.cookies.get('ctp-dev-csrf')!;
    client.cookies.set('ctp-dev-csrf', `${original}tamper`);
    expect((await client.request('/api/v1/auth/logout', { method: 'POST', csrf })).status).toBe(
      403,
    );
    client.cookies.set('ctp-dev-csrf', original);
    expect(
      (
        await client.request('/api/v1/auth/csrf', {
          headers: { cookie: `ctp-dev-session=${sessionToken}; ctp-dev-session=${rotatedToken}` },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.request('/api/v1/auth/csrf', {
          headers: { cookie: `ctp-dev-csrf=${original}; ctp-dev-csrf=${original}` },
        })
      ).status,
    ).toBe(400);
  });
  it('rejects privilege and tenant injection instead of silently stripping fields or coercing types', async () => {
    const { client, service } = await fixture();
    const csrf = await client.csrf();
    for (const body of [
      { email, password, role: 'ADMIN' },
      { email, password, tenantId: principal.userId },
      { email: [email], password },
      { email, password: 123456789012345 },
      { email, password, _csrf: csrf },
    ]) {
      expect(
        (await client.request('/api/v1/auth/signup', { method: 'POST', csrf, body })).status,
      ).toBe(400);
    }
    expect(service.signup).not.toHaveBeenCalled();
    const accepted = await client.request('/api/v1/auth/signup', {
      method: 'POST',
      csrf,
      body: { email, password },
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ status: 'accepted' });
  });
  it('rejects repeated security headers over the socket before any account operation', async () => {
    const { client, service } = await fixture();
    const csrf = await client.csrf();
    const payload = JSON.stringify({ email, password });
    const common = [
      'host',
      new URL(client.url).host,
      'content-type',
      'application/json',
      'content-length',
      String(Buffer.byteLength(payload)),
      'cookie',
      [...client.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    ];
    for (const extra of [
      ['origin', client.origin, 'origin', client.origin, 'x-csrf-token', csrf],
      ['origin', client.origin, 'x-csrf-token', csrf, 'x-csrf-token', csrf],
      [
        'origin',
        client.origin,
        'x-csrf-token',
        csrf,
        'cookie',
        [...client.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ],
    ]) {
      const response = await rawRequest(client.url, [...common, ...extra], payload);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.text)).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    }
    expect(service.signup).not.toHaveBeenCalled();
  });
  it('bounds malformed cookies and preserves Unicode password characters in HTTP validation', async () => {
    const { client, service } = await fixture();
    expect(
      (
        await client.request('/api/v1/auth/csrf', {
          headers: { cookie: `ctp-dev-session=${'a'.repeat(43)}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await client.request('/api/v1/auth/csrf', {
          headers: { cookie: `unrelated=${'x'.repeat(4096)}` },
        })
      ).status,
    ).toBe(400);
    const csrf = await client.csrf();
    const unicode = '\u{1f511}'.repeat(128);
    expect(
      (
        await client.request('/api/v1/auth/signup', {
          method: 'POST',
          csrf,
          body: { email, password: unicode },
        })
      ).status,
    ).toBe(202);
    expect(service.signup).toHaveBeenCalledWith({ ip: '127.0.0.1' }, email, unicode);
    expect(
      (
        await client.request('/api/v1/auth/signup', {
          method: 'POST',
          csrf,
          body: { email, password: `${unicode}x` },
        })
      ).status,
    ).toBe(400);
  });
  it('keeps parser and payload failures sanitized after a valid CSRF gate', async () => {
    const { client, logs, service } = await fixture();
    const csrf = await client.csrf();
    const cookie = [...client.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    for (const [payload, expected] of [
      ['{"email":"malformed-secret",', 400],
      [JSON.stringify({ email, password: 'large-secret'.repeat(500) }), 413],
    ] as const) {
      const response = await rawRequest(
        client.url,
        [
          'host',
          new URL(client.url).host,
          'origin',
          client.origin,
          'x-csrf-token',
          csrf,
          'cookie',
          cookie,
          'content-type',
          'application/json',
          'content-length',
          String(Buffer.byteLength(payload)),
        ],
        payload,
      );
      expect(response.status).toBe(expected);
      expect(response.text).not.toContain('secret');
    }
    expect(service.signup).not.toHaveBeenCalled();
    expect(logs.join('')).not.toContain('malformed-secret');
    expect(logs.join('')).not.toContain('large-secret');
  });
  it('uses __Host secure HttpOnly cookies without Domain and never places session credentials in JSON', async () => {
    const { client } = await fixture(true);
    const csrf = await client.csrf();
    const response = await client.request('/api/v1/auth/login', {
      method: 'POST',
      csrf,
      body: { email, password },
    });
    expect(response.status).toBe(200);
    const session = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-ctp-session='))!;
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Path=/');
    expect(session).toContain(`Expires=${principal.expiresAt.toUTCString()}`);
    expect(session).not.toMatch(/Domain=/i);
    const text = await response.text();
    expect(text).not.toContain(sessionToken);
    expect(text).not.toContain(password);
    expect(text).not.toContain('emailNormalized');
  });
  it('changes CSRF identity on login, session rotation and logout', async () => {
    const { client, service } = await fixture();
    const preauthCsrf = await client.csrf();
    const login = await client.request('/api/v1/auth/login', {
      method: 'POST',
      csrf: preauthCsrf,
      body: { email, password },
    });
    const loginCsrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    expect(client.cookies.has('ctp-dev-preauth')).toBe(false);
    expect(
      (await client.request('/api/v1/auth/logout', { method: 'POST', csrf: preauthCsrf })).status,
    ).toBe(403);
    const rotate = await client.request('/api/v1/auth/session/rotate', {
      method: 'POST',
      csrf: loginCsrf,
    });
    expect(rotate.status).toBe(200);
    const rotateCsrf = ((await rotate.json()) as { csrfToken: string }).csrfToken;
    expect(service.rotateSession).toHaveBeenCalledWith({ ip: '127.0.0.1' }, sessionToken);
    expect(
      (await client.request('/api/v1/auth/logout', { method: 'POST', csrf: loginCsrf })).status,
    ).toBe(403);
    const logout = await client.request('/api/v1/auth/logout', {
      method: 'POST',
      csrf: rotateCsrf,
    });
    expect(logout.status).toBe(200);
    expect(service.logout).toHaveBeenCalledWith({ ip: '127.0.0.1' }, rotatedToken);
    expect(client.cookies.has('ctp-dev-session')).toBe(false);
    expect(client.cookies.has('ctp-dev-preauth')).toBe(true);
    expect(
      (await client.request('/api/v1/auth/logout', { method: 'POST', csrf: rotateCsrf })).status,
    ).toBe(403);
  });
  it('passes an existing session only as an opaque cookie credential to login replacement', async () => {
    const { client, service } = await fixture();
    client.cookies.set('ctp-dev-session', rotatedToken);
    const csrf = await client.csrf();
    await client.request('/api/v1/auth/login', { method: 'POST', csrf, body: { email, password } });
    expect(service.login).toHaveBeenCalledWith({ ip: '127.0.0.1' }, email, password, rotatedToken);
  });
  it('rejects ignored payloads on bodyless mutations', async () => {
    const { client, service } = await fixture();
    client.cookies.set('ctp-dev-session', sessionToken);
    const csrf = await client.csrf();
    for (const path of [
      'logout',
      'logout-all',
      'session/rotate',
      `sessions/${principal.sessionId}`,
    ]) {
      const method = path.startsWith('sessions/') ? 'DELETE' : 'POST';
      const response = await client.request(`/api/v1/auth/${path}`, {
        method,
        csrf,
        body: { tenantId: principal.userId },
      });
      expect(response.status).toBe(400);
    }
    for (const handler of [
      service.logout,
      service.revokeAllSessions,
      service.rotateSession,
      service.revokeSession,
    ])
      expect(handler).not.toHaveBeenCalled();
  });
  it('requires a valid session cookie for protected reads and ignores forged identity headers', async () => {
    const { client, service, readUser } = await fixture();
    expect((await client.request('/api/v1/users/me')).status).toBe(401);
    expect((await client.request('/api/v1/auth/sessions')).status).toBe(401);
    expect(readUser).not.toHaveBeenCalled();
    client.cookies.set('ctp-dev-session', sessionToken);
    const response = await client.request('/api/v1/users/me', {
      headers: {
        'x-user-id': rotatedToken,
        'x-tenant-id': rotatedToken,
        'x-forwarded-for': '198.51.100.24',
      },
    });
    expect(response.status).toBe(200);
    expect(service.authenticate).toHaveBeenCalledWith({ ip: '127.0.0.1' }, sessionToken);
    expect(readUser).toHaveBeenCalledWith(principal);
    expect(await response.json()).toEqual({
      user: {
        id: principal.userId,
        email,
        status: 'ACTIVE',
        role: 'USER',
        emailVerifiedAt: principal.createdAt.toISOString(),
      },
    });
    expect((await client.request(`/api/v1/users/me?tenantId=${principal.userId}`)).status).toBe(
      400,
    );
  });
  it('fails closed if the tenant lookup is stale, foreign or no longer eligible', async () => {
    const { client, readUser } = await fixture();
    client.cookies.set('ctp-dev-session', sessionToken);
    for (const override of [
      { id: principal.sessionId },
      { role: 'ADMIN' },
      { status: 'SUSPENDED' },
      { emailVerifiedAt: null },
      { emailNormalized: null },
    ]) {
      readUser.mockResolvedValue({
        id: principal.userId,
        emailNormalized: email,
        status: 'ACTIVE',
        role: 'USER',
        emailVerifiedAt: principal.createdAt,
        ...override,
      });
      expect((await client.request('/api/v1/users/me')).status).toBe(401);
    }
  });
  it('exposes session metadata only and denies cross-account session revocation', async () => {
    const { client, service } = await fixture();
    client.cookies.set('ctp-dev-session', sessionToken);
    const response = await client.request('/api/v1/auth/sessions');
    expect(await response.json()).toEqual({
      sessions: [
        {
          id: principal.sessionId,
          createdAt: principal.createdAt.toISOString(),
          lastSeenAt: principal.lastSeenAt.toISOString(),
          idleExpiresAt: principal.idleExpiresAt.toISOString(),
          expiresAt: principal.expiresAt.toISOString(),
        },
      ],
    });
    const csrf = await client.csrf();
    service.revokeSession.mockRejectedValue(new AuthError('NOT_FOUND'));
    const denied = await client.request(`/api/v1/auth/sessions/${principal.sessionId}`, {
      method: 'DELETE',
      csrf,
    });
    expect(denied.status).toBe(404);
    expect(service.revokeSession).toHaveBeenCalledWith(
      { ip: '127.0.0.1' },
      sessionToken,
      principal.sessionId,
    );
  });
  it('uses generic recovery responses and safe common error envelopes with request IDs', async () => {
    const { client, service, logs } = await fixture();
    const csrf = await client.csrf();
    for (const route of ['forgot-password', 'resend-verification']) {
      const response = await client.request(`/api/v1/auth/${route}`, {
        method: 'POST',
        csrf,
        body: { email },
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: 'accepted' });
    }
    for (const [code, status] of [
      ['UNAUTHENTICATED', 401],
      ['RATE_LIMITED', 429],
      ['SERVICE_UNAVAILABLE', 503],
    ] as const) {
      service.login.mockRejectedValue(
        new AuthError(code, code === 'RATE_LIMITED' ? 60_123 : undefined),
      );
      const response = await client.request('/api/v1/auth/login', {
        method: 'POST',
        csrf,
        body: { email, password },
        headers: { 'x-request-id': 'auth-security-test' },
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        error: { code, requestId: 'auth-security-test' },
      });
      if (code === 'RATE_LIMITED') expect(response.headers.get('retry-after')).toBe('61');
    }
    service.login.mockRejectedValue(new Error('backend-password-sentinel'));
    const failure = await client.request('/api/v1/auth/login', {
      method: 'POST',
      csrf,
      body: { email, password },
    });
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain('backend-password-sentinel');
    const output = logs.join('');
    for (const secret of [password, email, csrf, sessionToken, 'backend-password-sentinel'])
      expect(output).not.toContain(secret);
  });
  it('clears session state after reset, change-password and logout-all', async () => {
    const { client, service } = await fixture();
    for (const [path, body] of [
      ['reset-password', { token: rotatedToken, password }],
      ['change-password', { oldPassword: password, password }],
      ['logout-all', undefined],
    ] as const) {
      client.cookies.set('ctp-dev-session', sessionToken);
      const csrf = await client.csrf();
      const response = await client.request(`/api/v1/auth/${path}`, {
        method: 'POST',
        csrf,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status).toBe(200);
      expect(client.cookies.has('ctp-dev-session')).toBe(false);
    }
    expect(service.resetPassword).toHaveBeenCalledWith({ ip: '127.0.0.1' }, rotatedToken, password);
    expect(service.changePassword).toHaveBeenCalledWith(
      { ip: '127.0.0.1' },
      sessionToken,
      password,
      password,
    );
    expect(service.revokeAllSessions).toHaveBeenCalledWith({ ip: '127.0.0.1' }, sessionToken);
  });
});
