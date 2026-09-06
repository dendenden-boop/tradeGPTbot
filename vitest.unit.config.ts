import { defineConfig } from 'vitest/config';
import { aliases, testDefaults } from './vitest.shared.js';

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    ...testDefaults,
    include: ['packages/**/*.unit.test.ts', 'apps/**/*.unit.test.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: 'test-results/unit.json' },
  },
});
