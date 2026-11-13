import { beforeEach, expect, it, vi } from 'vitest';
// BEGIN PAPER HISTORICAL INVENTORY FIXTURE
const fixture = vi.hoisted(() => ({ count: 68, cloned: 0, inspections: [] }));
// END PAPER HISTORICAL INVENTORY FIXTURE
vi.mock('./owned-native-secondary.mjs', () => ({
  inspectOwnedPostgres: async (project, port) => {
    fixture.inspections.push([project, port]);
    return { project, port, containerId: port === 34001 ? 'a'.repeat(64) : 'b'.repeat(64) };
  },
}));
vi.mock('./native-cluster-actors.mjs', () => ({
  nativeActorRegistrations: vi.fn(),
  cloneNativeClusterActors: async () => {
    fixture.cloned++;
    throw Error('TEST_ONLY_ACTOR_CLONE_BOUNDARY');
  },
  nativeRoleCatalogHash: vi.fn(),
}));
vi.mock('./native-cluster-isolation.mjs', () => ({
  secondaryNativeProject: (project) => project + '-secondary',
  createNativeClusterIsolation: vi.fn(),
}));
import { bootstrapNativeCluster } from './native-cluster-bootstrap.mjs';

// BEGIN PAPER HISTORICAL INVENTORY RESET
beforeEach(() => Object.assign(fixture, { count: 68, cloned: 0, inspections: [] }));
// END PAPER HISTORICAL INVENTORY RESET
function run(budget = 10000) {
  const project = 'ctp-integration-900-aabbcc112233',
    secondary = { project: project + '-secondary', port: 34002, containerId: 'b'.repeat(64) },
    migrated = [],
    observed = [],
    closed = [];
  const promise = bootstrapNativeCluster({
    project,
    env: {
      CTP_TEST_SECONDARY_PROJECT: secondary.project,
      CTP_TEST_SECONDARY_POSTGRES_PORT: String(secondary.port),
      CTP_TEST_SECONDARY_IDENTITY: JSON.stringify(secondary),
    },
    nativeEnv: { DATABASE_MIGRATION_URL: 'postgresql://fixture:private@127.0.0.1:34001/ctp_test' },
    databases: Array.from({ length: 9 }, (_, n) => 'ctp_p2_fixture' + n + '_aabbcc112233'),
    primaryAdmin: {},
    connect: (url) => ({
      async query(sql) {
        if (sql.startsWith('SELECT count(*)::int n FROM _prisma_migrations')) {
          expect(sql).toContain('finished_at IS NOT NULL AND rolled_back_at IS NULL');
          observed.push(new URL(url).pathname);
          return { rows: [{ n: fixture.count }] };
        }
        return { rows: [] };
      },
      async end() {
        closed.push(new URL(url).pathname);
      },
    }),
    run: async (_node, args, options) => {
      expect(args.slice(1, 3)).toEqual(['migrate', 'deploy']);
      expect(options.timeoutMs).toBe(budget);
      migrated.push(new URL(options.env.DATABASE_MIGRATION_URL).pathname);
    },
    prisma: 'fixture-prisma',
    config: 'fixture-config',
    secrets: [],
    remainingMs: () => budget,
  });
  return { promise, migrated, observed, closed };
}
// BEGIN PAPER HISTORICAL INVENTORY TITLE
it('checks migration68 in all four secondary ledgers before starting actor cloning', async () => {
  // END PAPER HISTORICAL INVENTORY TITLE
  const f = run();
  await expect(f.promise).rejects.toThrow('TEST_ONLY_ACTOR_CLONE_BOUNDARY');
  expect(f.migrated).toHaveLength(4);
  expect(f.observed).toEqual(f.migrated);
  expect(f.closed).toEqual(f.migrated);
  expect(fixture.cloned).toBe(1);
});
// BEGIN PAPER HISTORICAL INVENTORY STALE
it('rejects a secondary ledger still at published67 before cloning any actor', async () => {
  fixture.count = 67;
  // END PAPER HISTORICAL INVENTORY STALE
  const f = run();
  await expect(f.promise).rejects.toThrow();
  expect(f.migrated).toHaveLength(1);
  expect(f.closed).toEqual(f.migrated);
  expect(fixture.cloned).toBe(0);
});
it('cannot mint a fresh migration budget after the shared window expires', async () => {
  const f = run(0);
  await expect(f.promise).rejects.toThrow();
  expect(f.migrated).toEqual([]);
  expect(f.observed).toEqual([]);
  expect(fixture.cloned).toBe(0);
});
