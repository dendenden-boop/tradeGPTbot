import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHealthMonitor } from '../src/health.js';
import type { HealthService } from '../src/health.js';

const services: HealthService[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
});

function healthyProbe() {
  return { check: vi.fn(() => Promise.resolve()), close: vi.fn(() => Promise.resolve()) };
}

describe('dependency health coordination', () => {
  it('attempts both closes even when a driver throws synchronously', async () => {
    const postgres = healthyProbe();
    postgres.close.mockImplementation(() => {
      throw new Error('CANARY_CLOSE_SECRET');
    });
    const redis = healthyProbe();
    const service = createHealthMonitor({ postgres, redis, timeoutMs: 100, cacheMs: 0 });
    services.push(service);
    const closing = service.close();
    expect(service.close()).toBe(closing);
    await expect(closing).rejects.toThrow('HEALTH_CLOSE_FAILED');
    expect(redis.close).toHaveBeenCalledTimes(1);
    expect((await service.check()).status).toBe('not_ready');
  });
  it('shares concurrent checks and cached results rather than multiplying connections', async () => {
    const postgres = healthyProbe();
    const redis = healthyProbe();
    const service = createHealthMonitor({ postgres, redis, timeoutMs: 100, cacheMs: 1000 });
    services.push(service);
    const results = await Promise.all(Array.from({ length: 100 }, () => service.check()));
    expect(results.every((result) => result.status === 'ready')).toBe(true);
    await service.check();
    expect(postgres.check).toHaveBeenCalledTimes(1);
    expect(redis.check).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(results[0]?.dependencies)).toBe(true);
  });

  it('times out a non-cooperative probe without starting overlapping retries', async () => {
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const postgres = {
      check: vi.fn((input: AbortSignal) => {
        signal = input;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
      close: () => {
        finish?.();
        return Promise.resolve();
      },
    };
    const service = createHealthMonitor({
      postgres,
      redis: healthyProbe(),
      timeoutMs: 20,
      cacheMs: 0,
    });
    services.push(service);
    expect((await service.check()).dependencies).toEqual({ postgres: 'down', redis: 'up' });
    expect(signal?.aborted).toBe(true);
    await service.check();
    expect(postgres.check).toHaveBeenCalledTimes(1);
  });

  it('reports failures without exposing messages and recovers after a subsequent successful probe', async () => {
    const postgres = healthyProbe();
    const redis = healthyProbe();
    const check = vi.spyOn(redis, 'check');
    check.mockRejectedValueOnce(new Error('redis://:secret-canary@host'));
    const service = createHealthMonitor({ postgres, redis, timeoutMs: 100, cacheMs: 0 });
    services.push(service);
    expect(await service.check()).toEqual({
      status: 'not_ready',
      dependencies: { postgres: 'up', redis: 'down' },
    });
    expect((await service.check()).status).toBe('ready');
  });

  it('coalesces close, aborts probes and permanently prevents readiness after drain', async () => {
    const postgres = healthyProbe();
    const redis = healthyProbe();
    const service = createHealthMonitor({ postgres, redis, timeoutMs: 100, cacheMs: 1000 });
    services.push(service);
    await service.check();
    const firstClose = service.close();
    expect(service.close()).toBe(firstClose);
    await firstClose;
    expect((await service.check()).status).toBe('not_ready');
    expect(postgres.close).toHaveBeenCalledTimes(1);
    expect(postgres.check).toHaveBeenCalledTimes(1);
  });
});
