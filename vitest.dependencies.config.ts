import { defineConfig } from 'vitest/config';
import { aliases, testDefaults } from './vitest.shared.js';

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    ...testDefaults,
    include: ['tests/dependencies.integration.test.ts'],
    fileParallelism: false,
  },
});
