import type { AppConfig } from '@ctp/config';
import { createLogger } from '@ctp/logger';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { HealthService } from '../src/health.js';
import { createLifecycle } from '../src/lifecycle.js';

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

const applications: FastifyInstance[] = [];

function fixture(overrides: Partial<AppConfig> = {}) {
  const lines: string[] = [];
  const logger = createLogger(
    { level: 'info', environment: 'test' },
    { write: (line: string) => lines.push(line) },
  );
  const close = vi.fn<HealthService['close']>().mockResolvedValue(undefined);
  const appConfig = { ...config, ...overrides };
  const app = buildApp({
    config: appConfig,
    logger,
    health: {
      check: () =>
        Promise.resolve({
          status: 'ready',
          dependencies: { postgres: 'up', redis: 'up' },
        }),
      close,
    },
  });
  applications.push(app);
  const onFatal = vi.fn();
  const lifecycle = createLifecycle({ app, config: appConfig, logger, onFatal });
  return { app, close, onFatal, lifecycle, lines };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close().catch(() => undefined)));
});

describe('API lifecycle', () => {
  it('coalesces concurrent starts and repeated stops, then rejects restart', async () => {
    const { app, close, lifecycle, onFatal } = fixture();
    const firstStart = lifecycle.start();
    expect(lifecycle.start()).toBe(firstStart);
    const address = await firstStart;
    expect((await fetch(`${address}/health/live`)).status).toBe(200);
    const firstStop = lifecycle.stop('SIGTERM');
    expect(lifecycle.stop('SIGINT')).toBe(firstStop);
    await firstStop;
    await lifecycle.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(app.server.listening).toBe(false);
    expect(onFatal).not.toHaveBeenCalled();
    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'LIFECYCLE_STOPPED' });
  });

  it('closes a constructed application even when stop precedes start', async () => {
    const { close, lifecycle } = fixture();
    await lifecycle.stop();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'LIFECYCLE_STOPPED' });
  });

  it('allows an in-flight request to complete while refusing new connections', async () => {
    const { app, close, lifecycle } = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    app.get('/test/slow', async () => {
      entered.resolve();
      await release.promise;
      return { completed: true };
    });
    const address = await lifecycle.start();
    const pending = fetch(`${address}/test/slow`);
    await entered.promise;
    const stopping = lifecycle.stop();
    try {
      await expect.poll(() => app.server.listening).toBe(false);
      expect(close).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: true });
    await stopping;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes pools and sanitizes a bind failure', async () => {
    const owner = fixture();
    await owner.lifecycle.start();
    const bound = owner.app.server.address();
    if (!bound || typeof bound === 'string') throw new Error('Expected a TCP address');
    const duplicate = fixture({ port: bound.port });
    await expect(duplicate.lifecycle.start()).rejects.toMatchObject({ code: 'STARTUP_FAILED' });
    expect(duplicate.close).toHaveBeenCalledTimes(1);
    expect(duplicate.app.server.listening).toBe(false);
    expect(duplicate.lines.join('')).not.toContain('postgresql://');
    expect(duplicate.lines.join('')).not.toContain('stack');
  });

  it('reports and bounds a hanging dependency close without an unhandled late rejection', async () => {
    const { close, lifecycle, onFatal, app, lines } = fixture({ shutdownTimeoutMs: 40 });
    const release = deferred<void>();
    close.mockImplementation(() => release.promise);
    await lifecycle.start();
    const started = performance.now();
    const stopping = lifecycle.stop();
    await expect(stopping).rejects.toMatchObject({ code: 'SHUTDOWN_TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(onFatal).toHaveBeenCalledExactlyOnceWith('SHUTDOWN_TIMEOUT');
    expect(app.server.listening).toBe(false);
    expect(lines.join('')).toContain('SHUTDOWN_TIMEOUT');
    release.resolve();
    await app.close();
  });

  it('sanitizes dependency-close failures and invokes the fatal policy once', async () => {
    const { close, lifecycle, onFatal, lines } = fixture();
    close.mockRejectedValue(new Error('sentinel-CREDENTIAL-close'));
    await lifecycle.start();
    const first = lifecycle.stop();
    expect(lifecycle.stop()).toBe(first);
    await expect(first).rejects.toMatchObject({ code: 'SHUTDOWN_FAILED' });
    expect(onFatal).toHaveBeenCalledExactlyOnceWith('SHUTDOWN_FAILED');
    expect(lines.join('')).not.toContain('sentinel-CREDENTIAL-close');
  });
});
