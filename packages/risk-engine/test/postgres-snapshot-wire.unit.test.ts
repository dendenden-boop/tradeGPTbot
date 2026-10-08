/* eslint-disable @typescript-eslint/require-await -- Deterministic SQL wire fixtures have no network. */
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
interface Wire {
  safe: boolean;
  raw: unknown;
  certificate: unknown;
  queries: string[];
  values: unknown[][];
  failCommit: boolean;
  hang: boolean;
  reject: (() => void) | null;
  destroy: number;
  ended: number;
}
const wire = vi.hoisted<Wire>(() => ({
  safe: true,
  raw: null,
  certificate: null,
  queries: [],
  values: [],
  failCommit: false,
  hang: false,
  reject: null,
  destroy: 0,
  ended: 0,
}));
vi.mock('pg', () => ({
  Pool: class {
    on() {
      return this;
    }
    async end() {
      wire.ended++;
    }
    async connect() {
      let released = false;
      return {
        on() {},
        once() {},
        async query(sql: string, values: unknown[] = []) {
          wire.queries.push(sql);
          wire.values.push(values);
          if (sql.includes('AS safe')) return { rows: [{ safe: wire.safe }] };
          if (sql.includes('capture_sources')) {
            if (wire.hang)
              await new Promise<void>((_, reject) => {
                wire.reject = () => reject(new Error('wire lost credential=private'));
              });
            return { rows: [{ result: wire.raw }] };
          }
          if (sql.includes('next_identity'))
            return {
              rows: [{ result: { id: '44444444-4444-4444-8444-444444444444', revision: '1' } }],
            };
          if (sql.includes('insert_certificate'))
            wire.certificate = JSON.parse(String(values[1])) as unknown;
          if (sql.includes('read_certificate')) return { rows: [{ result: wire.certificate }] };
          if (sql === 'COMMIT' && wire.failCommit)
            throw new Error('ambiguous COMMIT credential=private');
          return { rows: [] };
        },
        release(destroy = false) {
          if (released) throw new Error('DOUBLE_RELEASE');
          released = true;
          if (destroy) {
            wire.destroy++;
            wire.reject?.();
          }
        },
      };
    }
  },
}));
import { createPostgresRiskSnapshotStore } from '../src/postgres-snapshot.js';
import { createRiskSnapshotCoordinator } from '../src/coordinator.js';
import { captureFixture } from './snapshot-fixtures.js';
const options = {
  connectionString: 'postgresql://certifier:private@127.0.0.1/isolated',
  environment: 'test' as const,
};
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
beforeEach(() => {
  wire.safe = true;
  wire.raw = null;
  wire.certificate = null;
  wire.queries = [];
  wire.values = [];
  wire.failCommit = false;
  wire.hang = false;
  wire.reject = null;
  wire.destroy = 0;
  wire.ended = 0;
});
it('captures fixed durable sources and persists the exact certificate after GLOBAL and tenant locks before known COMMIT', async () => {
  const f = captureFixture();
  wire.raw = f.raw;
  const store = await createPostgresRiskSnapshotStore(options);
  const c = await createRiskSnapshotCoordinator({ store, now: () => f.now }).certify(f.key, io());
  const queries = wire.queries.slice(
    wire.queries.lastIndexOf('BEGIN ISOLATION LEVEL READ COMMITTED'),
  );
  expect(queries[1]).toContain('set_config');
  expect(queries[2]).toContain('pg_advisory_xact_lock_shared');
  expect(queries[3]).toContain('pg_advisory_xact_lock(');
  expect(queries[4]).toContain('capture_sources');
  expect(queries.at(-1)).toBe('COMMIT');
  expect(c.id).toBe('44444444-4444-4444-8444-444444444444');
  expect(c.projection.sources).toHaveLength(9);
  expect(wire.certificate).toEqual(c);
  expect(c).not.toHaveProperty('decisionId');
  await store.close();
  const reopened = await createPostgresRiskSnapshotStore(options);
  expect(
    await createRiskSnapshotCoordinator({ store: reopened, now: () => f.now }).readCurrent(
      f.key,
      io(),
    ),
  ).toEqual(c);
  await reopened.close();
});
it('uncertain COMMIT returns no certified value or grant', async () => {
  const f = captureFixture();
  wire.raw = f.raw;
  const store = await createPostgresRiskSnapshotStore(options);
  wire.failCommit = true;
  await expect(
    createRiskSnapshotCoordinator({ store, now: () => f.now }).certify(f.key, io()),
  ).rejects.toThrow('RISK_SNAPSHOT_STORE_FAILED');
  await store.close();
});
it.each(['ABORT', 'DEADLINE'] as const)(
  'physically settles hung capture on %s and restores the bounded pool',
  async (kind) => {
    const f = captureFixture();
    wire.raw = f.raw;
    const store = await createPostgresRiskSnapshotStore(options);
    wire.hang = true;
    const controller = new AbortController();
    const started = Date.now();
    const pending = createRiskSnapshotCoordinator({ store, now: () => f.now }).certify(
      f.key,
      io(controller.signal, kind === 'DEADLINE' ? 50 : 2500),
    );
    const refused = expect(pending).rejects.toThrow('RISK_SNAPSHOT_ABORTED');
    if (kind === 'ABORT') {
      while (!wire.reject) await new Promise((r) => setTimeout(r, 1));
      controller.abort();
    }
    await refused;
    expect(Date.now() - started).toBeLessThan(500);
    expect(wire.destroy).toBe(1);
    wire.hang = false;
    wire.reject = null;
    expect(
      await createRiskSnapshotCoordinator({ store, now: () => f.now }).certify(f.key, io()),
    ).toHaveProperty('id');
    await store.close();
  },
);
it('rejects a new identity abandoned without its immutable certificate before COMMIT', async () => {
  const f = captureFixture();
  const store = await createPostgresRiskSnapshotStore(options);
  wire.queries = [];
  await expect(store.transaction(f.key, io(), async (tx) => tx.nextIdentity())).rejects.toThrow(
    'RISK_SNAPSHOT_UNPERSISTED_IDENTITY',
  );
  expect(wire.queries).not.toContain('COMMIT');
  await store.close();
});
it('requires a durable immutable intent scope without bypassing to a caller source', async () => {
  const f = captureFixture();
  const store = await createPostgresRiskSnapshotStore(options);
  const { intentId: omitted, ...key } = f.key;
  void omitted;
  wire.queries = [];
  await expect(store.transaction(key, io(), async (tx) => tx.read())).rejects.toThrow(
    'RISK_SNAPSHOT_INTENT_REQUIRED',
  );
  expect(wire.queries).toEqual([]);
  await store.close();
});
it('rejects a certificate from another allocated identity', async () => {
  const f = captureFixture();
  wire.raw = f.raw;
  const store = await createPostgresRiskSnapshotStore(options);
  const c = await createRiskSnapshotCoordinator({ store, now: () => f.now }).certify(f.key, io());
  await expect(
    store.transaction(f.key, io(), async (tx) => {
      await tx.nextIdentity();
      await tx.insert({ ...c, id: randomUUID() });
    }),
  ).rejects.toThrow('RISK_SNAPSHOT_INSERT_CONFLICT');
  await store.close();
});
it('rejects unsafe catalog authority before capture', async () => {
  wire.safe = false;
  await expect(createPostgresRiskSnapshotStore(options)).rejects.toThrow(
    'RISK_SNAPSHOT_ROLE_UNSAFE',
  );
  expect(wire.queries.some((q) => q.includes('capture_sources(') && !q.includes('AS safe'))).toBe(
    false,
  );
  expect(wire.ended).toBe(1);
});
it.each([
  'https://127.0.0.1/isolated',
  'postgresql://certifier:private@remote.invalid/isolated',
  'postgresql://certifier:private@127.0.0.1/isolated?options=unsafe',
])('rejects non-server-controlled database options %s', async (connectionString) => {
  await expect(createPostgresRiskSnapshotStore({ ...options, connectionString })).rejects.toThrow(
    'RISK_SNAPSHOT_DATABASE_URL',
  );
  expect(wire.queries).toEqual([]);
});
