import { beforeEach, expect, it, vi } from 'vitest';
import * as portfolio from '../src/index.js';
import { binding } from './fixtures.js';
const fake = vi.hoisted(() => ({ connections: 0, queries: [] as string[] }));
vi.mock('@ctp/exchange-core', async (original) => {
  const actual = await original<typeof import('@ctp/exchange-core')>();
  return {
    ...actual,
    createPostgresConnections: () => ({
      stream: undefined,
      connect() {
        fake.connections++;
        return Promise.resolve({
          query(sql: string) {
            fake.queries.push(sql);
            return Promise.resolve({
              rows: sql.includes('AS safe FROM pg_roles') ? [{ safe: true }] : [],
            });
          },
          release() {},
        });
      },
      close() {
        return Promise.resolve();
      },
    }),
  };
});
vi.mock('pg', async (original) => {
  const actual = await original<typeof import('pg')>();
  return {
    ...actual,
    Pool: class {
      on() {
        return this;
      }
      end() {
        return Promise.resolve();
      }
    },
  };
});
beforeEach(() => {
  fake.connections = 0;
  fake.queries = [];
});
it.each(['PAPER', 'TESTNET', 'DEMO', 'LIVE'] as const)(
  'public Portfolio store rejects PAPER fill in %s without any operation SQL',
  async (mode) => {
    const schema = (portfolio as unknown as Record<string, unknown>)['paperFillEventSchema'];
    expect(schema, 'PAPER_FILL_SCHEMA_MISSING').toBeDefined();
    const b = portfolio.bindingSchema.parse({
      ...binding(),
      mode,
      connectionId: mode === 'PAPER' ? null : binding().connectionId,
      scope: { ...binding().scope, environment: mode === 'PAPER' ? 'TESTNET' : mode },
    });
    const fillId = 'paper-' + 'a'.repeat(64);
    const e = portfolio.eventSchema.parse({
      type: 'PAPER_FILL',
      id: 'paper-fill:' + fillId,
      timestamp: 1000,
      internalOrderId: '44444444-4444-4444-8444-444444444444',
      instrumentId: 'BTCUSDT',
      metadataVersion: 'metadata1',
      ruleVersion: 'rules1',
      base: 'BTC',
      quote: 'USDT',
      positionSide: 'NET',
      bucket: 'SPOT',
      side: 'BUY',
      quantity: '1',
      price: '10',
      fees: [],
      paper: { fillId, modelVersion: 'spot-l2-taker-v1', scope: b.scope },
    });
    // Protocol fixture proves early rejection only; its mocked startup flag is
    // deliberately not evidence of actual PostgreSQL role privileges.
    const store = await portfolio.createPostgresPortfolioStore({
      connectionString: 'postgresql://fixture:private@127.0.0.1/portfolio',
      environment: 'test',
    });
    try {
      const before = { connections: fake.connections, queries: [...fake.queries] };
      expect(() =>
        store.apply(b, e, 0, { signal: new AbortController().signal, deadline: Date.now() + 1000 }),
      ).toThrow(mode === 'PAPER' ? 'PORTFOLIO_BINDING_DENIED' : 'PAPER_EXECUTION_PROOF_REQUIRED');
      expect(fake.connections).toBe(before.connections);
      expect(fake.queries).toEqual(before.queries);
    } finally {
      await store.close();
    }
  },
);
