import type { AppConfig } from '@ctp/config';
import { safeError } from '@ctp/logger';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { beginDrain } from './app.js';

export type ShutdownReason =
  | 'manual'
  | 'SIGTERM'
  | 'SIGINT'
  | 'startup_failure'
  | 'uncaught_exception'
  | 'unhandled_rejection';

type LifecycleCode =
  'STARTUP_FAILED' | 'LIFECYCLE_STOPPED' | 'SHUTDOWN_TIMEOUT' | 'SHUTDOWN_FAILED';
export type ShutdownFailureCode = Extract<LifecycleCode, 'SHUTDOWN_TIMEOUT' | 'SHUTDOWN_FAILED'>;

export class LifecycleError extends Error {
  constructor(readonly code: LifecycleCode) {
    super(code);
    this.name = 'LifecycleError';
  }
}

export interface Lifecycle {
  start(): Promise<string>;
  stop(reason?: ShutdownReason): Promise<void>;
}

export interface LifecycleOptions {
  app: FastifyInstance;
  config: AppConfig;
  logger: Logger;
  /** The process entry point terminates on failure; tests can observe it without exiting. */
  onFatal?: (code: ShutdownFailureCode) => void;
}

export function createLifecycle({ app, config, logger, onFatal }: LifecycleOptions): Lifecycle {
  let startPromise: Promise<string> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;

  function stop(reason: ShutdownReason = 'manual'): Promise<void> {
    if (stopPromise) return stopPromise;
    stopping = true;
    beginDrain(app);
    logger.info({ event: 'api_stopping', reason }, 'API stopping');

    stopPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new LifecycleError('SHUTDOWN_TIMEOUT')),
          Math.min(config.shutdownTimeoutMs, 10_000),
        );
      });
      try {
        await Promise.race([Promise.resolve().then(() => app.close()), deadline]);
        logger.info({ event: 'api_stopped' }, 'API stopped');
      } catch (error) {
        app.server.closeAllConnections();
        const code =
          error instanceof LifecycleError && error.code === 'SHUTDOWN_TIMEOUT'
            ? 'SHUTDOWN_TIMEOUT'
            : 'SHUTDOWN_FAILED';
        logger.error({ event: 'api_stop_failed', code }, 'API shutdown failed');
        onFatal?.(code);
        throw new LifecycleError(code);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return stopPromise;
  }

  function start(): Promise<string> {
    if (stopping) return Promise.reject(new LifecycleError('LIFECYCLE_STOPPED'));
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        const address = await app.listen({ host: config.host, port: config.port });
        if (stopping) throw new LifecycleError('LIFECYCLE_STOPPED');
        logger.info({ event: 'api_started', port: config.port }, 'API started');
        return address;
      } catch (error) {
        logger.error({ event: 'api_start_failed', error: safeError(error) }, 'API startup failed');
        try {
          await stop('startup_failure');
        } catch {
          // stop already reports the failure and invokes the composition root's fatal policy.
        }
        throw new LifecycleError('STARTUP_FAILED');
      }
    })();
    return startPromise;
  }

  return { start, stop };
}
