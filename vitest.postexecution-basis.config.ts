import { defineConfig } from 'vitest/config';
import native from './vitest.database.config.js';

// Uses a disposable database with migration 73 already deployed by Prisma.
export default defineConfig({
  ...native,
  test: {
    ...native.test,
    include: ['packages/database/test/fixtures/paper-postexecution-basis.diagnostic.ts'],
    testNamePattern: /^phase13 successor basis /u,
  },
});
