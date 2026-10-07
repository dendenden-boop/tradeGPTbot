import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { canonical, createState, createPostgresPortfolioStore } from '@ctp/portfolio';
import { binding } from '../../portfolio/test/fixtures.js';
import { createPostgresMarketStore } from '../src/postgres-store.js';
const wire = vi.hoisted(() => ({
  abort: null as AbortController | null,
  state: '',
  releases: [] as boolean[],
}));
vi.mock('pg', () => ({
  Pool: class {
    on() {
      return this;
    }
    end() {
      return Promise.resolve();
    }
    connect() {
      return Promise.resolve({
        once() {},
        query(sql: string) {
          if (sql === 'COMMIT') wire.abort?.abort();
          if (sql.includes('AS safe')) return Promise.resolve({ rows: [{ safe: true }] });
          if (sql.includes('SELECT a.exchange,a.region'))
            return Promise.resolve({
              rows: [{ exchange: 'BINANCE', region: 'global', external: 'native-account' }],
            });
          if (sql.startsWith('SELECT id,revision,state,state_hash'))
            return Promise.resolve({
              rows: [
                {
                  id: '11111111-1111-4111-8111-111111111111',
                  revision: '0',
                  state: wire.state,
                  state_hash: createHash('sha256').update(wire.state).digest(),
                },
              ],
            });
          return Promise.resolve({ rows: [] });
        },
        release(destroy = false) {
          wire.releases.push(destroy);
        },
      });
    }
  },
}));
beforeEach(() => {
  wire.abort = null;
  wire.releases = [];
  wire.state = canonical(createState(binding()));
});
it.each(['market', 'portfolio'] as const)(
  '%s publishes no successful result when caller aborts while COMMIT settles',
  async (kind) => {
    const options = {
      connectionString: 'postgresql://fixture:fixture@127.0.0.1/fixture',
      environment: 'test' as const,
    };
    const store =
      kind === 'market'
        ? await createPostgresMarketStore(options)
        : await createPostgresPortfolioStore(options);
    const controller = new AbortController();
    wire.abort = controller;
    const io = { signal: controller.signal, deadline: Date.now() + 1000 };
    try {
      const result = await (
        'events' in store && kind === 'market'
          ? (store as Awaited<ReturnType<typeof createPostgresMarketStore>>).events(
              'fixture',
              1,
              io,
            )
          : (store as Awaited<ReturnType<typeof createPostgresPortfolioStore>>).read(binding(), io)
      ).then(
        () => 'SUCCESS',
        () => 'ABORTED',
      );
      expect(result).toBe('ABORTED');
      expect(wire.releases.at(-1)).toBe(true);
    } finally {
      await store.close();
    }
  },
);
