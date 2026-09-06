import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { Redis } from 'ioredis';
import type { AppConfig } from '@ctp/config';

export interface DependencyHealth {
  readonly status: 'ready' | 'not_ready';
  readonly dependencies: { readonly postgres: 'up' | 'down'; readonly redis: 'up' | 'down' };
}

export interface HealthService {
  check(): Promise<DependencyHealth>;
  close(): Promise<void>;
}

export interface DependencyProbe {
  check(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

interface MonitorOptions {
  postgres: DependencyProbe;
  redis: DependencyProbe;
  timeoutMs: number;
  cacheMs: number;
}

const notReady: DependencyHealth = Object.freeze({
  status: 'not_ready',
  dependencies: Object.freeze({ postgres: 'down', redis: 'down' }),
});

/** Single-flight probes, including after timeout, prevent health polling from growing work queues. */
export function createHealthMonitor(options: MonitorOptions): HealthService {
  const busy = new Set<DependencyProbe>();
  const controllers = new Set<AbortController>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let flight: Promise<DependencyHealth> | undefined;
  let cached: DependencyHealth | undefined;
  let expiresAt = 0;

  async function probe(dependency: DependencyProbe): Promise<'up' | 'down'> {
    if (closed || busy.has(dependency)) return 'down';
    busy.add(dependency);
    const controller = new AbortController();
    controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve()
      .then(() => dependency.check(controller.signal))
      .then(
        () => 'up' as const,
        () => 'down' as const,
      )
      .finally(() => {
        busy.delete(dependency);
        controllers.delete(controller);
      });
    const timeout = new Promise<'down'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('down');
      }, options.timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    check() {
      if (closed) return Promise.resolve(notReady);
      if (cached && performance.now() < expiresAt) return Promise.resolve(cached);
      if (flight) return flight;
      flight = Promise.all([probe(options.postgres), probe(options.redis)])
        .then(([postgres, redis]) => {
          if (closed) return notReady;
          cached = Object.freeze({
            status: postgres === 'up' && redis === 'up' ? 'ready' : 'not_ready',
            dependencies: Object.freeze({ postgres, redis }),
          });
          expiresAt = performance.now() + options.cacheMs;
          return cached;
        })
        .finally(() => {
          flight = undefined;
        });
      return flight;
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      cached = undefined;
      for (const controller of controllers) controller.abort();
      closePromise = Promise.allSettled([
        Promise.resolve().then(() => options.postgres.close()),
        Promise.resolve().then(() => options.redis.close()),
      ]).then((results) => {
        if (results.some((result) => result.status === 'rejected')) {
          throw new Error('HEALTH_CLOSE_FAILED');
        }
      });
      return closePromise;
    },
  };
}

function postgresProbe(config: AppConfig): DependencyProbe {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.postgresPoolMax,
    connectionTimeoutMillis: config.dependencyTimeoutMs,
    idleTimeoutMillis: 10_000,
    query_timeout: config.dependencyTimeoutMs,
    statement_timeout: config.dependencyTimeoutMs,
    application_name: 'ctp-health',
  });
  // An idle socket can fail between probes; the next real SELECT detects availability.
  pool.on('error', () => {});
  return {
    async check(signal) {
      let client: PoolClient | undefined;
      let released = false;
      const release = (destroy: boolean) => {
        if (client && !released) {
          released = true;
          client.release(destroy);
        }
      };
      const onAbort = () => {
        release(true);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        signal.throwIfAborted();
        client = await pool.connect();
        signal.throwIfAborted();
        const result = await client.query<{ ok: number }>('SELECT 1 AS ok');
        signal.throwIfAborted();
        if (result.rows[0]?.ok !== 1) throw new Error('POSTGRES_PROBE_FAILED');
      } catch {
        release(true);
        throw new Error('POSTGRES_PROBE_FAILED');
      } finally {
        signal.removeEventListener('abort', onAbort);
        release(signal.aborted);
      }
    },
    close: () => pool.end(),
  };
}

function redisProbe(config: AppConfig): DependencyProbe {
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    // PING is the readiness contract; avoid INFO permissions and hidden loading retry timers.
    enableReadyCheck: false,
    enableOfflineQueue: false,
    connectTimeout: config.dependencyTimeoutMs,
    disconnectTimeout: Math.min(100, config.dependencyTimeoutMs),
    commandTimeout: config.dependencyTimeoutMs,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    reconnectOnError: () => false,
    connectionName: 'ctp-health',
  });
  redis.on('error', () => {});
  let disconnecting = false;
  const disconnect = () => {
    if (disconnecting || redis.status === 'wait' || redis.status === 'end') return;
    disconnecting = true;
    redis.disconnect(false);
  };
  return {
    async check(signal) {
      const onAbort = disconnect;
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        signal.throwIfAborted();
        if (redis.status === 'wait' || redis.status === 'end') {
          disconnecting = false;
          await redis.connect();
        }
        signal.throwIfAborted();
        if (redis.status !== 'ready' || (await redis.ping()) !== 'PONG') {
          throw new Error('REDIS_PROBE_FAILED');
        }
        signal.throwIfAborted();
      } catch {
        disconnect();
        throw new Error('REDIS_PROBE_FAILED');
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    close() {
      if (redis.status === 'wait' || redis.status === 'end') return Promise.resolve();
      return new Promise<void>((resolve) => {
        redis.once('end', resolve);
        disconnect();
      });
    },
  };
}

export function createHealthService(config: AppConfig): HealthService {
  return createHealthMonitor({
    postgres: postgresProbe(config),
    redis: redisProbe(config),
    timeoutMs: config.dependencyTimeoutMs,
    cacheMs: config.healthCacheMs,
  });
}
