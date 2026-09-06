import { ConfigError, loadConfig } from '@ctp/config';
import { createLogger, safeError } from '@ctp/logger';
import { buildApp } from './app.js';
import { createHealthService } from './health.js';
import { createLifecycle, type ShutdownReason } from './lifecycle.js';

// This logger is safe even when configuration cannot be parsed.
let logger = createLogger({ level: 'info', environment: 'production' });

async function main(): Promise<void> {
  // No clients, sockets, or pools are constructed until all configuration is valid.
  const config = loadConfig(process.env);
  logger = createLogger({ level: config.logLevel, environment: config.environment });
  const health = createHealthService(config);
  const app = buildApp({ config, logger, health });
  const lifecycle = createLifecycle({
    app,
    config,
    logger,
    onFatal() {
      process.exitCode = 1;
      logger.flush();
      // A failed close may retain live sockets. Only this failure path forces exit.
      process.exit(1);
    },
  });

  const detach = () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInterrupt);
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };

  const shutdown = (reason: ShutdownReason) => {
    void lifecycle
      .stop(reason)
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(() => {
        detach();
        logger.flush();
      });
  };
  const onTerm = () => shutdown('SIGTERM');
  const onInterrupt = () => shutdown('SIGINT');
  const onException = (error: Error) => {
    logger.fatal({ event: 'uncaught_exception', error: safeError(error) }, 'Fatal process error');
    process.exitCode = 1;
    shutdown('uncaught_exception');
  };
  const onRejection = (error: unknown) => {
    logger.fatal({ event: 'unhandled_rejection', error: safeError(error) }, 'Fatal process error');
    process.exitCode = 1;
    shutdown('unhandled_rejection');
  };

  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInterrupt);
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);

  try {
    await lifecycle.start();
  } catch (error) {
    detach();
    throw error;
  }
}

try {
  await main();
} catch (error) {
  logger.fatal(
    {
      event: 'startup_failed',
      error: safeError(error),
      ...(error instanceof ConfigError ? { invalidFields: error.fields } : {}),
    },
    'Startup failed',
  );
  process.exitCode = 1;
  logger.flush();
}
