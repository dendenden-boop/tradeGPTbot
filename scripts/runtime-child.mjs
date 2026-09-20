// Test-only health/lifecycle fixture. Full authenticated server is exercised with
// real services by auth runtime integration and Docker smoke, never disabled in production.
import { loadConfig } from '../packages/config/dist/index.js';
import { createLogger } from '../packages/logger/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';
import { createHealthService } from '../apps/api/dist/health.js';
import { createLifecycle } from '../apps/api/dist/lifecycle.js';

if (process.env.NODE_ENV !== 'test') {
  throw new Error('Runtime test harness requires an isolated test child');
}
const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel, environment: config.environment });
const app = buildApp({ config, logger, health: createHealthService(config) });
const lifecycle = createLifecycle({ app, config, logger, onFatal: () => process.exit(1) });
process.once('SIGTERM', () => {
  void lifecycle.stop('SIGTERM').catch(() => {
    process.exitCode = 1;
  });
});
process.once('SIGINT', () => {
  void lifecycle.stop('SIGINT').catch(() => {
    process.exitCode = 1;
  });
});
if (process.send) {
  process.on('message', (message) => {
    if (message === 'test-sigterm') {
      process.disconnect();
      process.emit('SIGTERM');
    }
  });
}
await lifecycle.start();
