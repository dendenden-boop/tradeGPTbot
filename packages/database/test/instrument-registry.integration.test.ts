import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { createPostgresInstrumentRegistry } from '@ctp/market-data';
import {
  instrumentRecordSchema,
  type InstrumentRecord,
  type MarketScope,
} from '@ctp/exchange-core';
import { instrument, rules } from '../../exchange-core/test/fixtures/adapter.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('Registry tests require isolated runner');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('Missing isolated registry variable');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const publisher = new Pool({
  connectionString: required('DATABASE_INSTRUMENT_REGISTRY_URL'),
  max: 2,
  query_timeout: 5000,
});
const handles: Awaited<ReturnType<typeof createPostgresInstrumentRegistry>>[] = [];
afterAll(async () => {
  await Promise.all(handles.splice(0).map((r) => r.close()));
  await publisher.end();
  await admin.end();
});
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
function scoped(): MarketScope {
  return { ...instrument.scope, region: randomUUID() };
}
function record(
  scope: MarketScope,
  version = 'v1',
  id = 'BTCUSDT',
  at = Date.now() - 1000,
): InstrumentRecord {
  return instrumentRecordSchema.parse({
    instrument: { ...instrument, scope, id, exchangeSymbol: id, metadataVersion: version },
    rules: { ...rules, scope, instrumentId: id, version, effectiveAt: at, expiresAt: at + 3600000 },
  });
}
async function open(scope: MarketScope, ids = ['BTCUSDT']) {
  let r: Awaited<ReturnType<typeof createPostgresInstrumentRegistry>>;
  try {
    r = await createPostgresInstrumentRegistry({
      connectionString: required('DATABASE_INSTRUMENT_REGISTRY_URL'),
      environment: 'test',
      scope,
      instrumentIds: ids,
    });
  } catch (cause) {
    if (!(cause instanceof Error) || cause.message !== 'REGISTRY_RECOVERY_FAILED') throw cause;
    // Diagnose native recovery failures without retrying or granting readiness.
    const started = performance.now();
    let diagnostic: string;
    try {
      const result = await publisher.query<{ result: unknown[] }>(
        'SELECT ctp_registry.read_current($1::jsonb,$2::jsonb) AS result',
        [JSON.stringify(scope), JSON.stringify(ids)],
      );
      diagnostic = `ROWS_${result.rows[0]?.result.length}_MS_${Math.ceil(performance.now() - started)}`;
    } catch (error) {
      diagnostic = error instanceof Error && 'code' in error ? String(error.code) : 'READ_FAILED';
    }
    throw new Error(`REGISTRY_NATIVE_RECOVERY_${diagnostic}`, { cause });
  }
  handles.push(r);
  return r;
}
async function current(scope: MarketScope, id = 'BTCUSDT') {
  return (
    await admin.query<{ revision: string; record: InstrumentRecord }>(
      'SELECT revision::text,record FROM ctp_registry.current_record WHERE scope=$1::jsonb AND id=$2',
      [JSON.stringify(scope), id],
    )
  ).rows[0];
}
it('300 instruments survive 180 atomic refreshes, >100k permanent versions and restart with bounded process state', async () => {
  const scope = scoped(),
    ids = Array.from({ length: 300 }, (_, i) => `A${i}USDT`),
    at = Date.now() - 1000;
  let registry = await open(scope, ids);
  for (let refresh = 0; refresh < 180; refresh++) {
    const batch = ids.map((id) => record(scope, `refresh-${refresh}`, id, at));
    const result = await registry.putBatch(batch, Date.now(), io());
    if (!result.ok) throw new Error(`REGISTRY_REFRESH_${refresh}_${result.error.code}`);
    expect(result.value).toHaveLength(300);
    expect(registry.health().retained).toBe(300);
    if (refresh === 89) {
      const recovery = await publisher.connect();
      try {
        for (const planMode of ['force_custom_plan', 'force_generic_plan'] as const) {
          await recovery.query('BEGIN');
          await recovery.query(`SET LOCAL plan_cache_mode='${planMode}'`);
          // Both SQL plans must fit the existing one-second physical recovery
          // deadline without depending on a favorable background ANALYZE.
          await recovery.query("SET LOCAL statement_timeout='900ms'");
          const recovered = await recovery.query<{ result: unknown[] }>(
            'SELECT ctp_registry.read_current($1::jsonb,$2::jsonb) AS result',
            [JSON.stringify(scope), JSON.stringify(ids)],
          );
          expect(recovered.rows[0]?.result).toHaveLength(300);
          await recovery.query('COMMIT');
        }
      } finally {
        await recovery.query('ROLLBACK').catch(() => {});
        recovery.release();
      }
      await registry.close();
      registry = await open(scope, ids);
    }
  }
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_registry.version_history WHERE scope=$1::jsonb',
        [JSON.stringify(scope)],
      )
    ).rows[0]!.n,
  ).toBe(108000);
  expect((await current(scope, ids[0]))?.revision).toBe('180');
  await registry.close();
  registry = await open(scope, ids);
  expect(await registry.readCurrent(scope, ids[0]!, Date.now(), io())).toMatchObject({
    ok: true,
    value: { rules: { version: 'refresh-179' } },
  });
  expect(
    await registry.put(record(scope, 'refresh-0', ids[0], at), Date.now(), io()),
  ).toMatchObject({ ok: false });
  expect((await current(scope, ids[0]))?.revision).toBe('180');
}, 120000);
it.each(['instrument', 'rules'] as const)(
  'rejects independent %s A→B→A reuse after process restart',
  async (kind) => {
    const scope = scoped(),
      at = Date.now() - 1000,
      a = record(scope, 'A', 'BTCUSDT', at),
      b = record(scope, 'B', 'BTCUSDT', at);
    const registry = await open(scope);
    expect(await registry.put(a, Date.now(), io())).toMatchObject({ ok: true });
    expect(await registry.put(b, Date.now(), io())).toMatchObject({ ok: true });
    await registry.close();
    const restart = await open(scope);
    const reuse = kind === 'rules' ? { ...b, rules: a.rules } : { ...b, instrument: a.instrument };
    expect(await restart.put(reuse, Date.now(), io())).toMatchObject({ ok: false });
    expect((await current(scope))?.revision).toBe('2');
    expect((await current(scope))?.record.rules.version).toBe('B');
  },
);
it.each(['record', 'version'] as const)(
  'bounded recovery rejects inconsistent immutable %s history',
  async (kind) => {
    const scope = scoped(),
      registry = await open(scope),
      original = record(scope),
      inconsistent = { ...original, rules: { ...original.rules, tickSize: '0.1' } };
    expect(await registry.put(original, Date.now(), io())).toMatchObject({ ok: true });
    const transaction = await admin.connect();
    try {
      await transaction.query('BEGIN');
      await transaction.query(
        'INSERT INTO ctp_registry.record_revision(scope,id,revision,previous_revision,record) VALUES($1::jsonb,$2,2,1,$3::jsonb)',
        [
          JSON.stringify(scope),
          original.instrument.id,
          JSON.stringify(kind === 'version' ? inconsistent : original),
        ],
      );
      await transaction.query(
        'UPDATE ctp_registry.current_record SET record=$3::jsonb,revision=$4 WHERE scope=$1::jsonb AND id=$2',
        [JSON.stringify(scope), original.instrument.id, JSON.stringify(inconsistent), 2],
      );
      await expect(
        transaction.query('SELECT ctp_registry.read_current($1::jsonb,$2::jsonb)', [
          JSON.stringify(scope),
          JSON.stringify([original.instrument.id]),
        ]),
      ).rejects.toThrow('REGISTRY_HISTORY_INCOMPLETE');
    } finally {
      await transaction.query('ROLLBACK');
      transaction.release();
    }
    expect(await current(scope)).toEqual({ revision: '1', record: original });
    await registry.close();
    const restart = await open(scope);
    expect(
      await restart.readCurrent(scope, original.instrument.id, Date.now(), io()),
    ).toMatchObject({
      ok: true,
      value: original,
    });
  },
);
it('serializes concurrent exact duplicates across independent writers without duplicate history or revision growth', async () => {
  const scope = scoped(),
    a = record(scope),
    left = await open(scope),
    right = await open(scope);
  const results = await Promise.all([
    left.put(a, Date.now(), io()),
    right.put(a, Date.now(), io()),
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect((await current(scope))?.revision).toBe('1');
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_registry.version_history WHERE scope=$1::jsonb',
        [JSON.stringify(scope)],
      )
    ).rows[0]!.n,
  ).toBe(2);
});
it('serializes competing replacement writers and returns the authoritative durable head', async () => {
  const scope = scoped(),
    at = Date.now() - 1000,
    left = await open(scope),
    right = await open(scope);
  await left.put(record(scope, 'A', 'BTCUSDT', at), Date.now(), io());
  const results = await Promise.all([
    left.put(record(scope, 'B', 'BTCUSDT', at), Date.now(), io()),
    right.put(record(scope, 'C', 'BTCUSDT', at), Date.now(), io()),
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  const head = await current(scope);
  expect(head?.revision).toBe('3');
  expect(await left.readCurrent(scope, 'BTCUSDT', Date.now(), io())).toMatchObject({
    ok: true,
    value: head?.record,
  });
  expect(await right.readCurrent(scope, 'BTCUSDT', Date.now(), io())).toMatchObject({
    ok: true,
    value: head?.record,
  });
});
it('rolls back all current/history changes when a later member of an atomic refresh reuses a version', async () => {
  const scope = scoped(),
    at = Date.now() - 1000,
    registry = await open(scope, ['AAA', 'BTCUSDT']);
  const a = record(scope, 'A', 'BTCUSDT', at),
    b = record(scope, 'B', 'BTCUSDT', at);
  await registry.put(a, Date.now(), io());
  await registry.put(b, Date.now(), io());
  expect(
    await registry.putBatch([record(scope, 'new', 'AAA', at), a], Date.now(), io()),
  ).toMatchObject({ ok: false });
  expect(await current(scope, 'AAA')).toBeUndefined();
  expect((await current(scope))?.revision).toBe('2');
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_registry.version_history WHERE scope=$1::jsonb AND id=$2',
        [JSON.stringify(scope), 'AAA'],
      )
    ).rows[0]!.n,
  ).toBe(0);
});
it('forbids mutation/deletion of permanent history even for the table owner', async () => {
  const scope = scoped(),
    registry = await open(scope);
  await registry.put(record(scope), Date.now(), io());
  await expect(
    admin.query('DELETE FROM ctp_registry.version_history WHERE scope=$1::jsonb', [
      JSON.stringify(scope),
    ]),
  ).rejects.toThrow(/immutable/i);
  await expect(
    admin.query("UPDATE ctp_registry.version_history SET version='old' WHERE scope=$1::jsonb", [
      JSON.stringify(scope),
    ]),
  ).rejects.toThrow(/immutable/i);
});

it('recovers an uncertain native COMMIT without a second publication/history effect after response loss and restart', async () => {
  const scope = scoped(),
    a = record(scope),
    proxy = await registryCommitProxy(required('DATABASE_INSTRUMENT_REGISTRY_URL'));
  let registry: Awaited<ReturnType<typeof createPostgresInstrumentRegistry>> | undefined;
  try {
    registry = await createPostgresInstrumentRegistry({
      connectionString: proxy.connectionString,
      environment: 'test',
      scope,
      instrumentIds: ['BTCUSDT'],
    });
    proxy.arm();
    expect(await registry.put(a, Date.now(), io())).toMatchObject({ ok: false });
    expect(proxy.dropped()).toBe(1);
    expect((await current(scope))?.revision).toBe('1');
    await registry.close();
    registry = undefined;
    const restart = await open(scope);
    expect(await restart.put(a, Date.now(), io())).toMatchObject({ ok: true });
    expect((await current(scope))?.revision).toBe('1');
    expect(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int n FROM ctp_registry.version_history WHERE scope=$1::jsonb',
          [JSON.stringify(scope)],
        )
      ).rows[0]!.n,
    ).toBe(2);
  } finally {
    await registry?.close();
    await proxy.close();
  }
});

it.each([
  'numeric-money',
  'unknown-constraint',
  'invalid-units',
  'invalid-quantity',
  'duplicate-order-types',
  'conflicting-price-precision',
] as const)(
  'SQL rejects %s without trusting a caller that bypasses the TypeScript publisher',
  async (kind) => {
    const scope = scoped(),
      a = record(scope);
    const raw = JSON.parse(JSON.stringify(a)) as {
      instrument: Record<string, unknown>;
      rules: Record<string, unknown>;
    };
    if (kind === 'numeric-money') raw.rules['tickSize'] = 0.05;
    if (kind === 'unknown-constraint') raw.rules['newConstraint'] = '1';
    if (kind === 'invalid-units') raw.instrument['settlementAsset'] = 'BTC';
    if (kind === 'invalid-quantity') raw.rules['minQuantity'] = '0';
    if (kind === 'duplicate-order-types') raw.rules['orderTypes'] = ['LIMIT', 'LIMIT'];
    if (kind === 'conflicting-price-precision') raw.rules['pricePrecision'] = 0;
    await expect(
      publisher.query('SELECT ctp_registry.publish($1::jsonb,$2::jsonb)', [
        JSON.stringify(scope),
        JSON.stringify([raw]),
      ]),
    ).rejects.toThrow('REGISTRY_INPUT');
    expect(await current(scope)).toBeUndefined();
  },
);
it.each(['abort', 'deadline'] as const)(
  'physically tears down %s while a native PostgreSQL publication waits on a scope lock',
  async (kind) => {
    const scope = scoped(),
      registry = await open(scope),
      locker = await admin.connect(),
      controller = new AbortController();
    try {
      await locker.query('BEGIN');
      await locker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('ctp:registry:'||$1::jsonb::text,0))",
        [JSON.stringify(scope)],
      );
      const pending = registry.put(
        record(scope),
        Date.now(),
        io(controller.signal, kind === 'deadline' ? 150 : 2500),
      );
      const role = new URL(required('DATABASE_INSTRUMENT_REGISTRY_URL')).username;
      for (let i = 0; i < 30; i++) {
        const active = (
          await admin.query<{ n: number }>(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1 AND query LIKE 'SELECT ctp_registry.publish(%' AND state='active'",
            [role],
          )
        ).rows[0]!.n;
        if (active === 1) break;
        await wait(5);
      }
      if (kind === 'abort') controller.abort();
      expect(await pending).toMatchObject({ ok: false });
      for (let i = 0; i < 30; i++) {
        const active = (
          await admin.query<{ n: number }>(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1 AND query LIKE 'SELECT ctp_registry.publish(%' AND state='active'",
            [role],
          )
        ).rows[0]!.n;
        if (active === 0) break;
        await wait(5);
      }
      expect(
        (
          await admin.query<{ n: number }>(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1 AND query LIKE 'SELECT ctp_registry.publish(%' AND state='active'",
            [role],
          )
        ).rows[0]!.n,
      ).toBe(0);
      expect(await current(scope)).toBeUndefined();
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await registry.close();
    }
  },
);
it.each([
  'SELECT ON ctp_registry.current_record',
  'UPDATE(record) ON ctp_registry.current_record',
  'EXECUTE ON FUNCTION ctp_risk.read_global()',
  'EXECUTE ON FUNCTION ctp_registry.valid_scope(jsonb)',
] as const)('rejects extra %s authority at startup', async (privilege) => {
  const role = new URL(required('DATABASE_INSTRUMENT_REGISTRY_URL')).username;
  if (!/^[a-z0-9_]+$/.test(role)) throw new Error('Unexpected role');
  await admin.query(`GRANT ${privilege} TO "${role}"`);
  try {
    await expect(open(scoped())).rejects.toThrow('REGISTRY_ROLE_UNSAFE');
  } finally {
    await admin.query(`REVOKE ${privilege} FROM "${role}"`);
  }
});
it('grants only public metadata functions and no direct credential/order/financial access', async () => {
  for (const table of [
    'ctp_registry.current_record',
    'ctp_registry.version_history',
    'public.encrypted_credential',
    'public.risk_reservation',
    'public.submission_attempt',
    'public.ledger_transaction',
    'ctp_portfolio.book',
  ])
    await expect(publisher.query(`SELECT * FROM ${table} LIMIT 0`)).rejects.toThrow(
      /permission denied/,
    );
  const role = (await publisher.query<{ name: string }>('SELECT current_user AS name')).rows[0]!
    .name;
  const privileges = (
    await admin.query<{ name: string }>(
      "SELECT f.proname AS name FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='ctp_registry' AND has_function_privilege($1,f.oid,'EXECUTE') ORDER BY f.proname",
      [role],
    )
  ).rows;
  expect(privileges.map((r) => r.name)).toEqual(['publish', 'read_current']);
});
