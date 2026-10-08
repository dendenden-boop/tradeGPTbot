import { defineConfig } from 'vitest/config';
import { aliases, testDefaults } from './vitest.shared.js';

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    ...testDefaults,
    include: ['packages/database/test/risk-lifecycle-upgrade.acceptance.test.ts'],
    maxWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 30000,
    reporters: ['default', 'json'],
    outputFile: { json: 'test-results/risk-lifecycle-upgrade-tests.json' },
  },
});
