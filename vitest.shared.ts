import { fileURLToPath } from 'node:url';

export const aliases = {
  '@ctp/config': fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
  '@ctp/logger': fileURLToPath(new URL('./packages/logger/src/index.ts', import.meta.url)),
};

export const testDefaults = {
  environment: 'node' as const,
  globals: false,
  passWithNoTests: false,
  testTimeout: 10_000,
  hookTimeout: 15_000,
  maxWorkers: 4,
};
