import { expect, it } from 'vitest';
import { createPostgresPaperRiskLossSource } from '../src/postgres-risk-loss.js';
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
      createPostgresPaperRiskLossSource(
        options as Parameters<typeof createPostgresPaperRiskLossSource>[0],
      ),
    ).rejects.toThrow('PAPER_RISK_LOSS_DATABASE_URL');
  },
);
