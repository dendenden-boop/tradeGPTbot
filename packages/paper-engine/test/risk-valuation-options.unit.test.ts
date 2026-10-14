import { expect, it } from 'vitest';
import { createPostgresPaperRiskValuationSource } from '../src/postgres-risk-valuation.js';
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
    await expect(
      createPostgresPaperRiskValuationSource(
        options as Parameters<typeof createPostgresPaperRiskValuationSource>[0],
      ),
    ).rejects.toThrow('PAPER_RISK_VALUATION_DATABASE_URL');
  },
);
