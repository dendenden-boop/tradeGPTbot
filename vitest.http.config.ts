import { defineConfig } from 'vitest/config';
import { aliases, testDefaults } from './vitest.shared.js';

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    ...testDefaults,
    include: ['apps/**/http.integration.test.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: 'test-results/http.json' },
  },
});
