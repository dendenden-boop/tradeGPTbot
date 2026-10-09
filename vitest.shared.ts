import { fileURLToPath } from 'node:url';

export const aliases = {
  '@ctp/paper-engine/configuration': fileURLToPath(
    new URL('./packages/paper-engine/src/configuration.ts', import.meta.url),
  ),
  '@ctp/paper-engine': fileURLToPath(
    new URL('./packages/paper-engine/src/index.ts', import.meta.url),
  ),
  '@ctp/risk-engine': fileURLToPath(
    new URL('./packages/risk-engine/src/index.ts', import.meta.url),
  ),
  '@ctp/order-engine': fileURLToPath(
    new URL('./packages/order-engine/src/index.ts', import.meta.url),
  ),
  '@ctp/portfolio': fileURLToPath(new URL('./packages/portfolio/src/index.ts', import.meta.url)),
  '@ctp/exchange-binance/market-data': fileURLToPath(
    new URL('./packages/exchange-binance/src/market-data.ts', import.meta.url),
  ),
  '@ctp/exchange-bybit/market-data': fileURLToPath(
    new URL('./packages/exchange-bybit/src/market-data.ts', import.meta.url),
  ),
  '@ctp/exchange-okx/market-data': fileURLToPath(
    new URL('./packages/exchange-okx/src/market-data.ts', import.meta.url),
  ),
  '@ctp/exchange-htx/market-data': fileURLToPath(
    new URL('./packages/exchange-htx/src/market-data.ts', import.meta.url),
  ),
  '@ctp/market-data': fileURLToPath(
    new URL('./packages/market-data/src/index.ts', import.meta.url),
  ),
  '@ctp/exchange-htx': fileURLToPath(
    new URL('./packages/exchange-htx/src/index.ts', import.meta.url),
  ),
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
