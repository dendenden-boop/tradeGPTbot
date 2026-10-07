import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { postgresHandshakeFixture } from './fixtures/postgres-handshake.js';
import { createPostgresPolicies } from '../../risk-engine/src/postgres-policies.js';
import { createPostgresControls } from '../../risk-engine/src/postgres-controls.js';
import { createPostgresLossJournal } from '../../risk-engine/src/postgres-loss-journal.js';
import { createPostgresRiskPortfolioReader } from '../../risk-engine/src/postgres-portfolio-source.js';
import { createPostgresMarketStore } from '../../market-data/src/postgres-store.js';
import { createPostgresMarketSnapshots } from '../../market-data/src/postgres-snapshots.js';
import { createPostgresPortfolioStore } from '../../portfolio/src/postgres-store.js';
import { createPostgresOrderStore } from '../../order-engine/src/postgres-store.js';
import { binding } from '../../portfolio/test/fixtures.js';
import { state } from '../../order-engine/test/fixtures.js';
import { scope } from './fixtures/adapter.js';
type Io = { signal: AbortSignal; deadline: number };
type Options = { connectionString: string; environment: 'test' };
type Port = { close(): Promise<void>; request(io: Io): Promise<unknown> };
const tenantId = '11111111-1111-4111-8111-111111111111';
const cases: readonly [string, (options: Options) => Promise<Port>][] = [
  [
    'risk-policy',
    async (options) => {
      const p = await createPostgresPolicies({ ...options, authority: 'USER' });
      return { close: () => p.close(), request: (io) => p.read(tenantId, 'TESTNET', io) };
    },
  ],
  [
    'risk-controls',
    async (options) => {
      const p = await createPostgresControls({ ...options, authority: 'TENANT' });
      return { close: () => p.close(), request: (io) => p.read(tenantId, io) };
    },
  ],
  [
    'risk-loss',
    async (options) => {
      const p = await createPostgresLossJournal(options);
      return {
        close: () => p.close(),
        request: (io) => p.read({ tenantId, mode: 'TESTNET', valuationAsset: 'USDT' }, 0, io),
      };
    },
  ],
  [
    'risk-portfolio',
    async (options) => {
      const p = await createPostgresRiskPortfolioReader(options);
      return {
        close: () => p.close(),
        request: (io) =>
          p.read(
            {
              tenantId,
              mode: 'TESTNET',
              targetAccountId: binding().accountId,
              maxEvidenceAgeMs: 5000,
            },
            io,
          ),
      };
    },
  ],
  [
    'market-store',
    async (options) => {
      const p = await createPostgresMarketStore(options);
      return { close: () => p.close(), request: (io) => p.events('fixture', 1, io) };
    },
  ],
  [
    'market-snapshots',
    async (options) => {
      const p = await createPostgresMarketSnapshots(options);
      return {
        close: () => p.close(),
        request: (io) =>
          p.read(
            { scope, instrumentId: 'BTCUSDT', dbInstrumentId: tenantId, dbRuleId: tenantId },
            io,
          ),
      };
    },
  ],
  [
    'portfolio-store',
    async (options) => {
      const p = await createPostgresPortfolioStore(options);
      return { close: () => p.close(), request: (io) => p.read(binding(), io) };
    },
  ],
  [
    'order-store',
    async (options) => {
      const p = await createPostgresOrderStore(options);
      const s = state();
      return { close: () => p.close(), request: (io) => p.read(s.binding, s.id, io) };
    },
  ],
];
for (const [name, open] of cases) {
  it.each(['abort', 'deadline'] as const)(
    `${name} physically settles %s during reconnect handshake`,
    async (kind) => {
      const fixture = await postgresHandshakeFixture();
      let port: Port | undefined;
      try {
        port = await open({ connectionString: fixture.connectionString, environment: 'test' });
        fixture.disconnect();
        await wait(50);
        const controller = new AbortController();
        let settled = false;
        const pending = port
          .request({
            signal: controller.signal,
            deadline: Date.now() + (kind === 'deadline' ? 80 : 2500),
          })
          .then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
        for (let i = 0; i < 20 && fixture.sockets.size === 0; i++) await wait(5);
        expect(fixture.sockets.size).toBe(1);
        if (kind === 'abort') controller.abort();
        await wait(350);
        expect({ settled, sockets: fixture.sockets.size }).toEqual({ settled: true, sockets: 0 });
        await pending;
      } finally {
        fixture.disconnect();
        await port?.close();
        await fixture.close();
      }
    },
  );
}
