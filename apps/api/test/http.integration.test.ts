import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AppConfig } from '@ctp/config';
import { createLogger } from '@ctp/logger';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginDrain, buildApp } from '../src/app.js';
import type { DependencyHealth, HealthService } from '../src/health.js';

const config: AppConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'info',
  databaseUrl: 'postgresql://test:test@127.0.0.1:5432/unused',
  redisUrl: 'redis://127.0.0.1:6379/0',
  dependencyTimeoutMs: 250,
  healthCacheMs: 0,
  shutdownTimeoutMs: 1_000,
  bodyLimitBytes: 1_024,
  requestTimeoutMs: 2_000,
  connectionTimeoutMs: 2_000,
  postgresPoolMax: 2,
};

const ready: DependencyHealth = {
  status: 'ready',
  dependencies: { postgres: 'up', redis: 'up' },
};

const applications: FastifyInstance[] = [];

function fixture() {
  const lines: string[] = [];
  const logger = createLogger(
    { level: 'info', environment: 'test' },
    { write: (line: string) => lines.push(line) },
  );
  const check = vi.fn<HealthService['check']>().mockResolvedValue(ready);
  const close = vi.fn<HealthService['close']>().mockResolvedValue(undefined);
  const app = buildApp({ config, logger, health: { check, close } });
  applications.push(app);
  return { app, check, close, lines };
}

async function listen(app: FastifyInstance) {
  return app.listen({ host: config.host, port: 0 });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe('HTTP bootstrap over real loopback sockets', () => {
  it('serves liveness without probing and readiness only when both dependencies are healthy', async () => {
    const { app, check } = fixture();
    const address = await listen(app);
    const live = await fetch(`${address}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    expect(check).not.toHaveBeenCalled();

    const success = await fetch(`${address}/health/ready`);
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual(ready);

    check.mockResolvedValue({
      status: 'not_ready',
      dependencies: { postgres: 'up', redis: 'down' },
    });
    const failed = await fetch(`${address}/health/ready`);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      status: 'not_ready',
      dependencies: { postgres: 'up', redis: 'down' },
    });
    check.mockResolvedValue(ready);
    expect((await fetch(`${address}/health/ready`)).status).toBe(200);
  });

  it('handles a throwing probe and strips extra dependency fields from responses', async () => {
    const { app, check, lines } = fixture();
    const sentinel = 'sentinel-CREDENTIAL-probe';
    check.mockRejectedValueOnce(new Error(sentinel));
    const address = await listen(app);
    const failed = await fetch(`${address}/health/ready`);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      status: 'not_ready',
      dependencies: { postgres: 'down', redis: 'down' },
    });
    const extended = { ...ready, databaseUrl: sentinel, stack: sentinel };
    check.mockResolvedValue(extended);
    const recovered = await fetch(`${address}/health/ready`);
    expect(await recovered.json()).toEqual(ready);
    expect(lines.join('')).not.toContain(sentinel);
  });

  it('returns safe headers, correlates request IDs, and emits one completion per request', async () => {
    const { app, lines } = fixture();
    const address = await listen(app);
    const clientId = 'A'.repeat(64);
    const response = await fetch(`${address}/health/live`, {
      headers: { 'x-request-id': clientId },
    });
    await response.text();
    expect(response.headers.get('x-request-id')).toBe(clientId);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const entries = lines
      .flatMap((line) => line.trim().split('\n'))
      .map((line): unknown => JSON.parse(line));
    const completion = entries.filter(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        'event' in entry &&
        entry.event === 'http_request_completed',
    );
    expect(completion).toHaveLength(1);
    expect(completion[0]).toMatchObject({
      requestId: clientId,
      method: 'GET',
      route: '/health/live',
      statusCode: 200,
    });
  });

  it.each(['A'.repeat(65), 'request/secret', 'request with spaces', 'one,two'])(
    'replaces an untrusted request ID (%s)',
    async (requestId) => {
      const { app, lines } = fixture();
      const address = await listen(app);
      const response = await fetch(`${address}/health/live`, {
        headers: { 'x-request-id': requestId },
      });
      await response.text();
      const assigned = response.headers.get('x-request-id');
      expect(assigned).toMatch(/^[a-zA-Z0-9-]{1,64}$/);
      expect(assigned).not.toBe(requestId);
      expect(lines.join('')).not.toContain(requestId);
    },
  );

  it('sanitizes malformed JSON, oversized bodies, unknown routes, and handler exceptions', async () => {
    const { app, lines } = fixture();
    const sentinel = 'sentinel-CREDENTIAL-13';
    app.post('/test/body', (_request, reply) => reply.send({ accepted: true }));
    app.get('/test/throw', () => {
      return Promise.reject(
        new Error(`postgresql://user:${sentinel}@host/database`, {
          cause: { authorization: sentinel, body: sentinel },
        }),
      );
    });
    const address = await listen(app);
    const cases = [
      {
        url: '/test/body',
        method: 'POST',
        body: `{"secret":"${sentinel}`,
        status: 400,
        code: 'BAD_REQUEST',
      },
      {
        url: '/test/body',
        method: 'POST',
        body: JSON.stringify({ secret: sentinel.repeat(100) }),
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
      },
      {
        url: `/unknown/${sentinel}?apiKey=${sentinel}`,
        method: 'GET',
        status: 404,
        code: 'NOT_FOUND',
      },
      {
        url: `/test/throw?password=${sentinel}`,
        method: 'GET',
        status: 500,
        code: 'INTERNAL_ERROR',
      },
    ];
    for (const [index, item] of cases.entries()) {
      const requestId = `error-case-${String(index)}`;
      const response = await fetch(`${address}${item.url}`, {
        method: item.method,
        headers: {
          'content-type': 'application/json',
          'x-request-id': requestId,
          authorization: `Bearer ${sentinel}`,
          cookie: `session=${sentinel}`,
        },
        ...('body' in item ? { body: item.body } : {}),
      });
      expect(response.status).toBe(item.status);
      const body = await response.text();
      const parsed: unknown = JSON.parse(body);
      expect(parsed).toMatchObject({ error: { code: item.code, requestId } });
      expect(response.headers.get('x-request-id')).toBe(requestId);
      expect(body).not.toContain(sentinel);
      expect(body).not.toContain('stack');
    }
    expect(lines.join('')).not.toContain(sentinel);
    expect(lines.filter((line) => line.includes('http_request_completed'))).toHaveLength(
      cases.length,
    );
  });

  it('rejects prototype poisoning and unsupported content types', async () => {
    const { app } = fixture();
    app.post('/test/body', (_request, reply) => reply.send({ accepted: true }));
    const address = await listen(app);
    const poisoned = await fetch(`${address}/test/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"__proto__":{"polluted":true}}',
    });
    expect(poisoned.status).toBe(400);
    const unsupported = await fetch(`${address}/test/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'unused',
    });
    expect(unsupported.status).toBe(415);
  });

  it('sanitizes malformed URL components before route hooks run', async () => {
    const { app, lines } = fixture();
    const address = await listen(app);
    const sentinel = 'sentinel-CREDENTIAL-router';
    const requestId = 'malformed-url-case';
    // node:http preserves the invalid percent escape in the raw request target.
    const response = await new Promise<{
      status: number | undefined;
      headers: IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const request = httpRequest(
        address,
        {
          path: `/${sentinel}/%zz?token=${sentinel}`,
          headers: { 'x-request-id': requestId, authorization: `Bearer ${sentinel}` },
        },
        (incoming) => {
          let body = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk: string) => {
            body += chunk;
          });
          incoming.once('error', reject);
          incoming.once('end', () =>
            resolve({ status: incoming.statusCode, headers: incoming.headers, body }),
          );
        },
      );
      request.once('error', reject);
      request.end();
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body) as unknown).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Invalid request', requestId },
    });
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).not.toContain(sentinel);
    expect(lines.join('')).not.toContain(sentinel);
    expect(lines.filter((line) => line.includes('http_request_completed'))).toHaveLength(1);
  });

  it('makes draining readiness false immediately, including a probe already in flight', async () => {
    const { app, check } = fixture();
    const entered = deferred<void>();
    const probe = deferred<DependencyHealth>();
    check.mockImplementation(() => {
      entered.resolve();
      return probe.promise;
    });
    const address = await listen(app);
    const pending = fetch(`${address}/health/ready`);
    await entered.promise;
    beginDrain(app);
    const drained = await fetch(`${address}/health/ready`);
    expect(drained.status).toBe(503);
    expect(await drained.json()).toMatchObject({ status: 'not_ready' });
    expect(check).toHaveBeenCalledTimes(1);
    probe.resolve(ready);
    expect((await pending).status).toBe(503);
    expect((await fetch(`${address}/health/live`)).status).toBe(200);
  });

  it('survives a client disconnect and a subsequent handler rejection', async () => {
    const { app, lines } = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const finished = deferred<void>();
    app.get('/test/disconnect', async () => {
      entered.resolve();
      await release.promise;
      finished.resolve();
      throw new Error('sentinel-CREDENTIAL-disconnect');
    });
    const address = await listen(app);
    const request = httpRequest(`${address}/test/disconnect`);
    const closed = new Promise<void>((resolve) => {
      request.on('error', () => undefined);
      request.on('close', resolve);
    });
    request.end();
    await entered.promise;
    request.destroy();
    await closed;
    release.resolve();
    await finished.promise;
    const live = await fetch(`${address}/health/live`);
    expect(live.status).toBe(200);
    await live.text();
    expect(lines.join('')).not.toContain('sentinel-CREDENTIAL-disconnect');
  });

  it('registers no financial, authentication, or mutation endpoints', async () => {
    const { app } = fixture();
    const address = await listen(app);
    for (const path of [
      '/orders',
      '/withdrawals',
      '/auth/login',
      '/paper/orders',
      '/health/live',
    ]) {
      const response = await fetch(`${address}${path}`, { method: 'POST' });
      expect(response.status).toBe(404);
      await response.text();
    }
  });
});
