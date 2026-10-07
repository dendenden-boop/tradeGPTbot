import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresMarketStore,
  createCandleState,
  applyTrade,
  applyCoverage,
  feedKey,
  type MarketStore,
  type MarketEvent,
} from '@ctp/market-data';
import { scope, tick } from '../../market-data/test/fixtures.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('Market DB tests require the isolated runner');
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error('Missing isolated market DB variable');
  return value;
}
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 2,
  query_timeout: 5000,
});
const context = (signal = new AbortController().signal, milliseconds = 2000) => ({
  signal,
  deadline: Date.now() + milliseconds,
});
let store: MarketStore;
beforeAll(async () => {
  store = await createPostgresMarketStore({
    connectionString: required('DATABASE_INGEST_URL'),
    environment: 'test',
  });
});
afterAll(async () => {
  await store?.close();
  await admin.end();
});
const partition = async () => {
  const id = randomUUID(),
    key = feedKey(scope, id),
    owner = randomUUID();
  return {
    id,
    key,
    owner,
    row: await store.acquire(key, owner, createCandleState(scope, id, 0), context()),
  };
};
it('recovers the committed native checkpoint/outbox after actual COMMIT response loss without resending a mutation', async () => {
  const p = await partition(),
    state = structuredClone(p.row.state);
  applyTrade(state, tick('commit-loss', 1, p.id));
  applyCoverage(state, {
    from: 0,
    to: 30000,
    cursor: 'commit-loss',
    evidence: 'RECONCILED_TRADES',
  });
  const event: MarketEvent = {
    id: randomUUID(),
    key: p.key,
    type: 'CANDLE_CLOSED',
    bar: state.bars[0]!,
    reason: null,
  };
  const proxy = await registryCommitProxy(required('DATABASE_INGEST_URL'), 'MARKET');
  let viaProxy: MarketStore | undefined;
  try {
    viaProxy = await createPostgresMarketStore({
      connectionString: proxy.connectionString,
      environment: 'test',
    });
    proxy.arm();
    await expect(
      viaProxy.commit(p.key, p.owner, p.row, state, [event], context()),
    ).rejects.toThrow();
    expect(proxy.dropped()).toBe(1);
    await viaProxy.close();
    viaProxy = undefined;
    const restart = await createPostgresMarketStore({
      connectionString: required('DATABASE_INGEST_URL'),
      environment: 'test',
    });
    try {
      const recovered = await restart.acquire(p.key, p.owner, p.row.state, context());
      expect(recovered.version).toBe(p.row.version + 1);
      expect(recovered.state).toEqual(state);
      expect(await restart.events(p.key, 200, context())).toEqual([event]);
    } finally {
      await restart.close();
    }
  } finally {
    await viaProxy?.close();
    await proxy.close();
  }
});
describe('real PostgreSQL market persistence', () => {
  it('rejects a different archived payload with the same immutable revision', async () => {
    const p = await partition(),
      state = structuredClone(p.row.state);
    applyTrade(state, tick('1', 1, p.id));
    applyCoverage(state, {
      from: 0,
      to: 30000,
      cursor: 'checkpoint',
      evidence: 'RECONCILED_TRADES',
    });
    const event: MarketEvent = {
      id: randomUUID(),
      key: p.key,
      type: 'CANDLE_CLOSED',
      bar: state.bars[0]!,
      reason: null,
    };
    const committed = await store.commit(p.key, p.owner, p.row, state, [event], context());
    const changed = { ...event, id: randomUUID(), bar: { ...event.bar!, baseVolume: '999' } };
    await expect(
      store.commit(p.key, p.owner, committed, state, [changed], context()),
    ).rejects.toThrow();
    expect((await store.acquire(p.key, p.owner, p.row.state, context())).version).toBe(
      committed.version,
    );
  });
  it('rejects migration/admin and API/auth identities', async () => {
    for (const name of ['DATABASE_MIGRATION_URL', 'DATABASE_RUNTIME_URL', 'DATABASE_AUTH_URL'])
      await expect(
        createPostgresMarketStore({ connectionString: required(name), environment: 'test' }),
      ).rejects.toThrow('MARKET_DATABASE_ROLE_UNSAFE');
  });
  it('atomically commits state, native identity, checkpoint, candle and outbox', async () => {
    const p = await partition(),
      state = structuredClone(p.row.state);
    applyTrade(state, tick('1', 1, p.id));
    applyCoverage(state, {
      from: 0,
      to: 30000,
      cursor: 'checkpoint',
      evidence: 'RECONCILED_TRADES',
    });
    const event: MarketEvent = {
      id: randomUUID(),
      key: p.key,
      type: 'CANDLE_CLOSED',
      bar: state.bars[0]!,
      reason: null,
    };
    const committed = await store.commit(p.key, p.owner, p.row, state, [event], context());
    expect(committed.version).toBe(1);
    expect(committed.state.cursor).toBe('checkpoint');
    expect(await store.events(p.key, 10, context())).toEqual([event]);
    const result = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM ctp_market.bar WHERE key=$1',
      [p.key],
    );
    expect(result.rows[0]?.n).toBe(1);
    await store.acknowledge(p.key, [event.id], context());
    expect(await store.events(p.key, 10, context())).toEqual([]);
  });
  it('fences A→B→A owners after restart without forgetting applied trade IDs', async () => {
    const p = await partition(),
      state = structuredClone(p.row.state);
    applyTrade(state, tick('1', 1, p.id));
    const a = await store.commit(p.key, p.owner, p.row, state, [], context());
    await store.release(p.key, p.owner, a.epoch, context());
    const ownerB = randomUUID(),
      b = await store.acquire(p.key, ownerB, createCandleState(scope, p.id, 0), context());
    expect(BigInt(b.epoch)).toBeGreaterThan(BigInt(a.epoch));
    expect(applyTrade(b.state, tick('1', 1, p.id))).toBe('DUPLICATE');
    await expect(store.commit(p.key, p.owner, a, state, [], context())).rejects.toThrow();
    await store.release(p.key, ownerB, b.epoch, context());
    const a2 = await store.acquire(p.key, p.owner, createCandleState(scope, p.id, 0), context());
    expect(BigInt(a2.epoch)).toBeGreaterThan(BigInt(b.epoch));
    await expect(store.commit(p.key, ownerB, b, state, [], context())).rejects.toThrow();
  });
  it('allows only one concurrent checkpoint CAS', async () => {
    const p = await partition();
    const results = await Promise.allSettled([
      store.commit(p.key, p.owner, p.row, p.row.state, [], context()),
      store.commit(p.key, p.owner, p.row, p.row.state, [], context()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('rolls back state/checkpoint if outbox insertion fails', async () => {
    const p = await partition(),
      event: MarketEvent = {
        id: randomUUID(),
        key: p.key,
        type: 'MARKET_GAP',
        bar: null,
        reason: 'SOURCE_GAP',
      };
    const saved = await store.commit(p.key, p.owner, p.row, p.row.state, [event], context());
    const candidate = structuredClone(saved.state);
    applyTrade(candidate, tick('1', 1, p.id));
    await expect(
      store.commit(p.key, p.owner, saved, candidate, [event], context()),
    ).rejects.toThrow();
    const restored = await store.acquire(p.key, p.owner, p.row.state, context());
    expect(restored.version).toBe(saved.version);
    expect(restored.state.seen).toHaveLength(0);
  });
  it.each(['deadline', 'abort'] as const)(
    'destroys a PostgreSQL query blocked on a lock after %s and frees its connection',
    async (mode) => {
      const p = await partition(),
        lock = await admin.connect();
      await lock.query('BEGIN');
      await lock.query('UPDATE ctp_market.partition SET version=version WHERE key=$1', [p.key]);
      const controller = new AbortController(),
        started = Date.now();
      const pending = store.commit(
        p.key,
        p.owner,
        p.row,
        p.row.state,
        [],
        context(controller.signal, 150),
      );
      const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 30) : undefined;
      try {
        await expect(pending).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(1000);
      } finally {
        clearTimeout(timer);
        await lock.query('ROLLBACK');
        lock.release();
      }
      expect((await store.commit(p.key, p.owner, p.row, p.row.state, [], context())).version).toBe(
        1,
      );
    },
  );
  it('has database-enforced checkpoint integrity and no tenant/financial privileges', async () => {
    const p = await partition();
    await expect(
      admin.query('UPDATE ctp_market.partition SET state_hash=$2 WHERE key=$1', [
        p.key,
        Buffer.alloc(32),
      ]),
    ).rejects.toThrow();
    const ingest = new Pool({ connectionString: required('DATABASE_INGEST_URL'), max: 1 }),
      api = new Pool({ connectionString: required('DATABASE_RUNTIME_URL'), max: 1 });
    try {
      for (const table of ['encrypted_credential', 'ledger_entry', 'order_intent'])
        await expect(ingest.query(`SELECT * FROM public.${table} LIMIT 0`)).rejects.toThrow();
      await expect(api.query('SELECT * FROM ctp_market.partition LIMIT 0')).rejects.toThrow();
      await expect(
        api.query('INSERT INTO ctp_market.event(id,key,payload) VALUES($1,$2,$3)', [
          randomUUID(),
          p.key,
          '{}',
        ]),
      ).rejects.toThrow();
    } finally {
      await ingest.end();
      await api.end();
    }
  });
});
