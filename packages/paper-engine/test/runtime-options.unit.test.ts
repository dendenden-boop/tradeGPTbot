import { expect, it } from 'vitest';
import {
  createPostgresPaperRuntimeObservations,
  createPostgresPaperRuntimeSource,
} from '../src/postgres-runtime.js';
for (const open of [createPostgresPaperRuntimeObservations, createPostgresPaperRuntimeSource])
  it.each([
    { connectionString: 'https://caller.invalid', environment: 'test' },
    { connectionString: 'postgresql://user:pass@remote.invalid/db', environment: 'test' },
    {
      connectionString: 'postgresql://user:pass@127.0.0.1/db?sslmode=disable',
      environment: 'production',
    },
    { connectionString: 'postgresql://user:pass@127.0.0.1/db', environment: 'test', now: () => 1 },
    { connectionString: 'postgresql://user:pass@127.0.0.1/db', environment: 'test', prices: [] },
    { connectionString: 'postgresql://user:pass@127.0.0.1/db', environment: 'test', inventory: {} },
  ])(
    'caller source/deployment override is rejected before physical database I/O %#',
    async (options) => {
      await expect(open(options as Parameters<typeof open>[0])).rejects.toThrow(
        'PAPER_RUNTIME_DATABASE_URL',
      );
    },
  );
