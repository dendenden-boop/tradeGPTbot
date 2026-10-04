import { fileURLToPath } from 'node:url';

export const aliases = {
  '@ctp/exchange-okx': fileURLToPath(
    new URL('./packages/exchange-okx/src/index.ts', import.meta.url),
  ),
  '@ctp/exchange-bybit': fileURLToPath(
    new URL('./packages/exchange-bybit/src/index.ts', import.meta.url),
  ),
  '@ctp/exchange-binance': fileURLToPath(
    new URL('./packages/exchange-binance/src/index.ts', import.meta.url),
  ),
  '@ctp/exchange-core': fileURLToPath(
    new URL('./packages/exchange-core/src/index.ts', import.meta.url),
  ),
  '@ctp/auth': fileURLToPath(new URL('./packages/auth/src/index.ts', import.meta.url)),
  '@ctp/config': fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
  '@ctp/logger': fileURLToPath(new URL('./packages/logger/src/index.ts', import.meta.url)),
  '@ctp/database': fileURLToPath(new URL('./packages/database/src/index.ts', import.meta.url)),
};

export const testDefaults = {
  environment: 'node' as const,
  globals: false,
  passWithNoTests: false,
  testTimeout: 10_000,
  hookTimeout: 15_000,
  maxWorkers: 4,
};
