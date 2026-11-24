import { defineConfig } from 'vitest/config';
import native from './vitest.database.config.js';

// Opt-in only. Run against an owned database after Prisma deploy of migration 72.
export default defineConfig({
  ...native,
  test: {
    ...native.test,
    include: ['packages/database/test/fixtures/paper-postexecution-cause.diagnostic.ts'],
    testNamePattern: /^phase13 successor (?:causality|writer)/u,
  },
});
