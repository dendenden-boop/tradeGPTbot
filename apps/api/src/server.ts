import { ConfigError, loadConfig, loadAuthConfig } from '@ctp/config';
import {
  createAuthService,
  createAuthMailer,
  createAuthLimiter,
  createPasswordHasher,
} from '@ctp/auth';
import { createAuthDatabase, createDatabase } from '@ctp/database';
import { createLogger, safeError } from '@ctp/logger';
import { buildApp } from './app.js';
import { createHealthService } from './health.js';
import { createLifecycle, type ShutdownReason } from './lifecycle.js';

// This logger is safe even when configuration cannot be parsed.
let logger = createLogger({ level: 'info', environment: 'production' });

async function main(): Promise<void> {
  // No clients, sockets, or pools are constructed until all configuration is valid.
  const config = loadConfig(process.env);
  const authConfig = loadAuthConfig(process.env, config);
  logger = createLogger({ level: config.logLevel, environment: config.environment });
  const resources: Array<{ close(): Promise<void> }> = [];
  const composition = await (async () => {
    try {
      const runtime = await createDatabase({
        connectionString: config.databaseUrl,
        environment: config.environment,
      });
      resources.push(runtime);
      const repository = await createAuthDatabase({
        connectionString: authConfig.databaseAuthUrl,
        environment: config.environment,
      });
      resources.push(repository);
      const hasher = await createPasswordHasher();
      resources.push(hasher);
      const mailer = createAuthMailer({ origin: authConfig.origin, smtp: authConfig.smtp });
      resources.push(mailer);
      const limiter = createAuthLimiter(config.redisUrl);
      resources.push(limiter);
      await Promise.all([runtime.ready(), repository.ready(), mailer.ready(), limiter.ready()]);
      const service = createAuthService({
        repository,
        hasher,
        mailer,
        limiter,
        csrfSecret: authConfig.csrfSecret,
        onMailFailure: () =>
          logger.error(
            { event: 'auth_mail_delivery_failed' },
            'Authentication email delivery failed',
          ),
      });
      const health = createHealthService(config, {
        async check(signal) {
          signal.throwIfAborted();
          await Promise.all([runtime.ready(), repository.ready()]);
          signal.throwIfAborted();
        },
        // Application ownership closes these pools after health polling stops.
        close: () => Promise.resolve(),
      });
      resources.push(health);
      const app = buildApp({
        config,
        logger,
        health,
        closeRuntime: () => runtime.close(),
        auth: {
          config: authConfig,
          service,
          readUser: (principal) =>
            runtime.withTenant(principal.userId, (transaction) =>
              transaction.user.findUniqueOrThrow({
                where: { id: principal.userId },
                select: {
                  id: true,
                  emailNormalized: true,
                  status: true,
                  role: true,
                  emailVerifiedAt: true,
                },
              }),
            ),
        },
      });
      return { app };
    } catch {
      await Promise.allSettled(
        resources.map((resource) => Promise.resolve().then(() => resource.close())),
      );
      throw new Error('AUTH_STARTUP_FAILED');
    }
  })();
  const { app } = composition;
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
