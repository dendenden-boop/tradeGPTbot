import { setTimeout as wait } from 'node:timers/promises';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
} from '@ctp/paper-engine/configuration';
import {
  createPostgresPaperRuntimeObservations,
  createPostgresPaperRuntimeSource,
  createPostgresPaperRuntimeCollector,
  createPostgresPaperRuntimeWorker,
  createUnavailablePaperRuntimeProbe,
  paperRuntimeDependencies,
  type PaperRuntimePublication,
  type PaperRuntimeProbe,
  type PaperRuntimeProbes,
} from '@ctp/paper-engine/runtime';
import type { PaperOwner } from '@ctp/paper-engine/configuration';
import { fixture as modelFixture } from '../../paper-engine/test/fixtures.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_PAPER_RUNTIME_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_PAPER_RUNTIME_VARIABLE_REQUIRED');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await admin.end();
});
async function observer(connectionString = required('DATABASE_PAPER_RUNTIME_OBSERVER_URL')) {
  const h = await createPostgresPaperRuntimeObservations({
    connectionString,
    environment: 'test',
  });
  handles.push(h);
  return h;
}
async function reader(connectionString = required('DATABASE_PAPER_RUNTIME_READER_URL')) {
  const h = await createPostgresPaperRuntimeSource({
    connectionString,
    environment: 'test',
  });
  handles.push(h);
  return h;
}
async function fixture(age = 5000) {
  const c = paperConfigurationSchema.parse({
    id: randomUUID(),
    owner: { tenantId: randomUUID(), accountId: randomUUID(), mode: 'PAPER' },
    source: { exchange: 'BINANCE', market: 'SPOT', environment: 'LIVE', region: 'global' },
    valuationAsset: 'USDT',
    model: { ...modelFixture().model, maxEvidenceAgeMs: age },
  });
  await admin.query(
    `INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,'ACTIVE',now(),now())`,
    [c.owner.tenantId, c.owner.tenantId + '@example.invalid'],
  );
  await admin.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,'BINANCE','PAPER',$3,'global','SIMULATED','ACTIVE','paper-runtime-test',now())`,
    [c.owner.accountId, c.owner.tenantId, 'paper:' + c.owner.accountId],
  );
  const config = await createPostgresPaperConfiguration({
    connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
    environment: 'test',
  });
  try {
    await config.register(c, io());
  } finally {
    await config.close();
  }
  const writer = await observer(),
    context = await writer.context(c.owner, io());
  await wait(5);
  const health = Object.fromEntries(
    paperRuntimeDependencies.map((k) => [
      k,
      { sourceId: k + ':probe:1', asOf: Date.now(), status: 'HEALTHY' },
    ]),
  ) as PaperRuntimePublication['observation']['health'];
  const publication: PaperRuntimePublication = {
    id: randomUUID(),
    expectedRevision: '0',
    observation: {
      owner: c.owner,
      configurationId: c.id,
      configurationHash: context.configurationHash,
      permissionEpoch: context.current.permissionEpoch,
      userSessionEpoch: context.current.userSessionEpoch,
      accountVersion: context.current.accountVersion,
      health,
    },
  };
  return { c, writer, context, publication };
}
it('native successive publications advance revision 1 to 2 and survive producer/reader restart', async () => {
  const f = await fixture();
  const first = await f.writer.publish(f.publication, io());
  expect(first.revision).toBe('1');
  const second: PaperRuntimePublication = {
    ...structuredClone(f.publication),
    id: randomUUID(),
    expectedRevision: '1',
  };
  for (const key of paperRuntimeDependencies) second.observation.health[key].asOf = Date.now();
  const receipt = await f.writer.publish(second, io());
  expect(receipt.revision).toBe('2');
  await f.writer.close();
  const restarted = await observer();
  expect(await restarted.head(f.c.owner, io())).toEqual({ ...receipt, replayed: true });
  const source = await reader();
  expect((await source.read(f.c.owner, io())).reference.id).toBe(second.id);
});

function next(p: PaperRuntimePublication, revision = '1') {
  return { ...structuredClone(p), id: randomUUID(), expectedRevision: revision };
}
async function effects(tenantId: string) {
  const result: Record<string, number> = {};
  for (const table of [
    'ledger_transaction',
    'order_intent',
    'order',
    'risk_decision',
    'risk_reservation',
    'paper_account',
  ])
    result[table] = (
      await admin.query<{ n: number }>(
        `SELECT count(*)::int n FROM public."${table}" WHERE "tenantId"=$1`,
        [tenantId],
      )
    ).rows[0]!.n;
  return result;
}
it('missing head returns no health defaults or financial effects', async () => {
  const f = await fixture(),
    source = await reader();
  expect(await f.writer.head(f.c.owner, io())).toBeNull();
  expect(await f.writer.find(f.publication, io())).toBeNull();
  await expect(source.read(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_MISSING');
  expect(Object.values(await effects(f.c.owner.tenantId))).toEqual([0, 0, 0, 0, 0, 0]);
});
it('concurrent exact publication commits once and restart returns permanent original receipt', async () => {
  const f = await fixture(),
    before = await effects(f.c.owner.tenantId);
  const results = await Promise.all([
    f.writer.publish(f.publication, io()),
    f.writer.publish(f.publication, io()),
  ]);
  expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
  expect({ ...results[0], replayed: true }).toEqual({ ...results[1], replayed: true });
  await f.writer.close();
  const restarted = await observer();
  expect(await restarted.find(f.publication, io())).toEqual({ ...results[0], replayed: true });
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_paper.runtime_observation WHERE tenant_id=$1',
        [f.c.owner.tenantId],
      )
    ).rows[0]?.n,
  ).toBe(1);
});
it('concurrent distinct IDs with one CAS admit one winner without automatic retry', async () => {
  const f = await fixture(),
    other = next(f.publication, '0');
  const results = await Promise.allSettled([
    f.writer.publish(f.publication, io()),
    f.writer.publish(other, io()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((r) => r.status === 'rejected');
  expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
    message: 'PAPER_RUNTIME_CONFLICT',
  });
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_paper.runtime_observation WHERE tenant_id=$1',
        [f.c.owner.tenantId],
      )
    ).rows[0]?.n,
  ).toBe(1);
});
it('historical exact replay after a newer negative head does not move head or renew facts', async () => {
  const f = await fixture(),
    a = await f.writer.publish(f.publication, io());
  const b = next(f.publication);
  await wait(2);
  b.observation.health.executor = {
    sourceId: 'executor:probe:2',
    asOf: Date.now(),
    status: 'FAILED',
  };
  const current = await f.writer.publish(b, io());
  expect(await f.writer.publish(f.publication, io())).toEqual({ ...a, replayed: true });
  expect(await f.writer.head(f.c.owner, io())).toEqual({ ...current, replayed: true });
  const source = await (await reader()).read(f.c.owner, io());
  expect(source.reference.id).toBe(b.id);
  expect(source.blockedBy).toEqual(['executor']);
});
it('same permanent ID with conflicting semantics rejects publish and exact reconciliation', async () => {
  const f = await fixture(),
    a = await f.writer.publish(f.publication, io()),
    changed = structuredClone(f.publication);
  changed.observation.health.database.status = 'UNKNOWN';
  await expect(f.writer.publish(changed, io())).rejects.toThrow('PAPER_RUNTIME_CONFLICT');
  await expect(f.writer.find(changed, io())).rejects.toThrow('PAPER_RUNTIME_CONFLICT');
  expect(await f.writer.head(f.c.owner, io())).toEqual({ ...a, replayed: true });
});
it.each(['configurationId', 'configurationHash'] as const)(
  'new %s conflict cannot bypass the sealed configuration',
  async (key) => {
    const f = await fixture();
    f.publication.observation[key] = key === 'configurationId' ? randomUUID() : '0'.repeat(64);
    await expect(f.writer.publish(f.publication, io())).rejects.toThrow('PAPER_RUNTIME_CONFLICT');
    expect(await f.writer.head(f.c.owner, io())).toBeNull();
  },
);
it.each(['permissionEpoch', 'userSessionEpoch', 'accountVersion'] as const)(
  'current %s replacement invalidates health while retaining original receipt',
  async (key) => {
    const f = await fixture(),
      a = await f.writer.publish(f.publication, io()),
      source = await reader();
    if (key === 'userSessionEpoch')
      await admin.query('UPDATE public."user" SET "sessionEpoch"="sessionEpoch"+1 WHERE id=$1', [
        f.c.owner.tenantId,
      ]);
    else {
      const column = key === 'accountVersion' ? 'version' : 'permissionEpoch';
      await admin.query(
        `UPDATE public.exchange_account SET "${column}"="${column}"+1 WHERE id=$1`,
        [f.c.owner.accountId],
      );
    }
    await expect(source.read(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_EPOCH');
    expect(await f.writer.find(f.publication, io())).toEqual({ ...a, replayed: true });
    expect(await f.writer.publish(f.publication, io())).toEqual({ ...a, replayed: true });
    const stale = next(f.publication);
    await expect(f.writer.publish(stale, io())).rejects.toThrow('PAPER_RUNTIME_EPOCH');
    const context = await f.writer.context(f.c.owner, io());
    Object.assign(stale.observation, {
      permissionEpoch: context.current.permissionEpoch,
      userSessionEpoch: context.current.userSessionEpoch,
      accountVersion: context.current.accountVersion,
    });
    for (const key of paperRuntimeDependencies) stale.observation.health[key].asOf = Date.now();
    const b = await f.writer.publish(stale, io());
    expect((await source.read(f.c.owner, io())).reference.id).toBe(b.id);
  },
);
it('current BIGINT permission and INTEGER session boundaries remain lossless after restart', async () => {
  const f = await fixture();
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"=9007199254740993,version=version+1 WHERE id=$1',
    [f.c.owner.accountId],
  );
  await admin.query('UPDATE public."user" SET "sessionEpoch"=2147483647 WHERE id=$1', [
    f.c.owner.tenantId,
  ]);
  await f.writer.close();
  const writer = await observer(),
    context = await writer.context(f.c.owner, io());
  expect(context.current.permissionEpoch).toBe('9007199254740993');
  expect(context.current.userSessionEpoch).toBe('2147483647');
  Object.assign(f.publication.observation, {
    permissionEpoch: context.current.permissionEpoch,
    userSessionEpoch: context.current.userSessionEpoch,
    accountVersion: context.current.accountVersion,
  });
  await writer.publish(f.publication, io());
  expect((await (await reader()).read(f.c.owner, io())).current).toEqual(context.current);
});
it.each(['regression', 'equal-conflict'] as const)(
  '%s fact cannot replace a newer head',
  async (kind) => {
    const f = await fixture(),
      a = await f.writer.publish(f.publication, io()),
      b = next(f.publication);
    if (kind === 'regression') b.observation.health.publicMarket.asOf--;
    else b.observation.health.publicMarket.status = 'FAILED';
    await expect(f.writer.publish(b, io())).rejects.toThrow('PAPER_RUNTIME_ORDERING');
    expect(await f.writer.head(f.c.owner, io())).toEqual({ ...a, replayed: true });
  },
);
it('equal identical facts can advance the journal without renewing independent validity', async () => {
  const f = await fixture(),
    source = await reader();
  await f.writer.publish(f.publication, io());
  const before = await source.read(f.c.owner, io());
  await f.writer.publish(next(f.publication), io());
  const after = await source.read(f.c.owner, io());
  expect(after.validUntil).toBe(before.validUntil);
  expect(after.reference.revision).toBe('2');
});
it.each(['FAILED', 'UNKNOWN'] as const)(
  '%s current dependency remains explicit after restart, with no HEALTHY fallback',
  async (status) => {
    const f = await fixture();
    await f.writer.publish(f.publication, io());
    const p = next(f.publication);
    await wait(2);
    p.observation.health.executor = { sourceId: 'executor:probe:2', asOf: Date.now(), status };
    await f.writer.publish(p, io());
    const h = await reader(),
      result = await h.read(f.c.owner, io());
    expect(result.health.executor.status).toBe(status);
    expect(result.blockedBy).toEqual(['executor']);
    for (const key of ['grant', 'ready', 'certificate', 'capabilities', 'permit'])
      expect(key in result).toBe(false);
  },
);
it('expired facts fail closed after restart but remain permanently reconcilable without renewal', async () => {
  const f = await fixture(1000),
    receipt = await f.writer.publish(f.publication, io());
  await wait(1050);
  await expect((await reader()).read(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_STALE');
  await f.writer.close();
  const h = await observer();
  expect(await h.find(f.publication, io())).toEqual({ ...receipt, replayed: true });
  expect(await h.publish(f.publication, io())).toEqual({ ...receipt, replayed: true });
  await expect(h.publish(next(f.publication), io())).rejects.toThrow('PAPER_RUNTIME_STALE');
});
it('future timestamps cannot be published even when all health statuses are positive', async () => {
  const f = await fixture();
  f.publication.observation.health.clock.asOf = Date.now() + 60000;
  await expect(f.writer.publish(f.publication, io())).rejects.toThrow('PAPER_RUNTIME_STALE');
  expect(await f.writer.head(f.c.owner, io())).toBeNull();
});
it.each(['account', 'user'] as const)(
  'current inactive %s revokes collector and reader access',
  async (kind) => {
    const f = await fixture();
    await f.writer.publish(f.publication, io());
    if (kind === 'account')
      await admin.query(
        "UPDATE public.exchange_account SET status='DISABLED',version=version+1 WHERE id=$1",
        [f.c.owner.accountId],
      );
    else
      await admin.query('UPDATE public."user" SET status=\'SUSPENDED\' WHERE id=$1', [
        f.c.owner.tenantId,
      ]);
    await expect(f.writer.context(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_OWNERSHIP');
    await expect((await reader()).read(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_OWNERSHIP');
  },
);
it('foreign account owner cannot read or publish another tenant runtime facts', async () => {
  const a = await fixture(),
    b = await fixture();
  await a.writer.publish(a.publication, io());
  const foreign = { ...a.c.owner, tenantId: b.c.owner.tenantId };
  await expect((await reader()).read(foreign, io())).rejects.toThrow('PAPER_RUNTIME_MISSING');
  const p = next(a.publication);
  p.observation.owner = foreign;
  await expect(b.writer.publish(p, io())).rejects.toThrow('PAPER_RUNTIME_MISSING');
});
it.each(['observer', 'reader'] as const)(
  '%s has only fixed RPC authority, without financial/table/helper access',
  async (kind) => {
    const f = await fixture(),
      pool = new Pool({
        connectionString: required(
          kind === 'observer'
            ? 'DATABASE_PAPER_RUNTIME_OBSERVER_URL'
            : 'DATABASE_PAPER_RUNTIME_READER_URL',
        ),
      });
    try {
      const result = (
        await pool.query<{ helper: boolean; table: boolean; financial: boolean }>(`SELECT
      has_function_privilege(current_user,'ctp_paper.runtime_context(jsonb)','EXECUTE') helper,
      has_table_privilege(current_user,(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ctp_paper' AND c.relname='runtime_observation'),'SELECT,INSERT,UPDATE,DELETE') "table",
      has_schema_privilege(current_user,'ctp_admission','USAGE') financial`)
      ).rows[0];
      expect(result).toEqual({ helper: false, table: false, financial: false });
      await expect(
        pool.query('SELECT ctp_paper.runtime_context($1::jsonb)', [JSON.stringify(f.c.owner)]),
      ).rejects.toThrow(/permission denied/u);
      await expect(pool.query('INSERT INTO public.order_intent DEFAULT VALUES')).rejects.toThrow(
        /permission denied/u,
      );
    } finally {
      await pool.end();
    }
  },
);
it('removed observer context grant is rejected at startup and by an already-open publisher', async () => {
  const f = await fixture();
  await admin.query(
    'REVOKE EXECUTE ON FUNCTION ctp_paper.read_runtime_observation_context(jsonb) FROM ctp_paper_runtime_observer',
  );
  try {
    await expect(observer()).rejects.toThrow('PAPER_RUNTIME_ROLE_UNSAFE');
    await expect(f.writer.publish(f.publication, io())).rejects.toThrow(
      'PAPER_RUNTIME_ROLE_UNSAFE',
    );
  } finally {
    await admin.query(
      'GRANT EXECUTE ON FUNCTION ctp_paper.read_runtime_observation_context(jsonb) TO ctp_paper_runtime_observer',
    );
  }
});
it('SQL boundary rejects unknown limiting fact fields without relying on TypeScript parsing', async () => {
  const f = await fixture(),
    pool = new Pool({ connectionString: required('DATABASE_PAPER_RUNTIME_OBSERVER_URL') }),
    p = await pool.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    const payload = {
      ...f.publication,
      observation: {
        ...f.publication.observation,
        health: {
          ...f.publication.observation.health,
          executor: { ...f.publication.observation.health.executor, unknownConstraint: true },
        },
      },
    };
    await expect(
      p.query('SELECT ctp_paper.publish_runtime_observation($1::text)', [JSON.stringify(payload)]),
    ).rejects.toThrow('PAPER_RUNTIME_INPUT');
  } finally {
    await p.query('ROLLBACK');
    p.release();
    await pool.end();
  }
});
it.each(['runtime_observation', 'runtime_observation_seal', 'runtime_observation_head'] as const)(
  '%s is FORCE RLS, immutable against regression/deletion and not truncatable',
  async (table) => {
    const f = await fixture(),
      a = await f.writer.publish(f.publication, io()),
      p = await admin.connect();
    try {
      expect(
        (
          await p.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
            `SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ctp_paper.${table}'::regclass`,
          )
        ).rows[0],
      ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      for (const sql of [
        `UPDATE ctp_paper.${table} SET revision=revision WHERE id=$1`,
        `DELETE FROM ctp_paper.${table} WHERE id=$1`,
        `TRUNCATE ctp_paper.${table}`,
      ]) {
        await p.query('BEGIN');
        await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
        await expect(p.query(sql, sql.includes('$1') ? [a.id] : [])).rejects.toThrow();
        await p.query('ROLLBACK');
      }
    } finally {
      await p.query('ROLLBACK');
      p.release();
    }
    expect(await f.writer.head(f.c.owner, io())).toEqual({ ...a, replayed: true });
  },
);
it('independent seal corruption is rejected on read, replay and restart lookup', async () => {
  const f = await fixture(),
    a = await f.writer.publish(f.publication, io()),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query(
      'ALTER TABLE ctp_paper.runtime_observation_seal DISABLE TRIGGER paper_runtime_seal_immutable',
    );
    await p.query('UPDATE ctp_paper.runtime_observation_seal SET hash=$2 WHERE id=$1', [
      a.id,
      Buffer.alloc(32, 42),
    ]);
    await p.query(
      'ALTER TABLE ctp_paper.runtime_observation_seal ENABLE TRIGGER paper_runtime_seal_immutable',
    );
    await p.query('COMMIT');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  await expect((await reader()).read(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_CORRUPT');
  await expect(f.writer.publish(f.publication, io())).rejects.toThrow('PAPER_RUNTIME_CORRUPT');
  await f.writer.close();
  await expect((await observer()).find(f.publication, io())).rejects.toThrow(
    'PAPER_RUNTIME_CORRUPT',
  );
});
it.each(['abort', 'deadline'] as const)(
  '%s destroys a physically blocked publication, releases its slot and leaves no event',
  async (kind) => {
    const f = await fixture(),
      p = await admin.connect(),
      controller = new AbortController();
    try {
      await p.query('BEGIN');
      await p.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
        f.c.owner.accountId,
      ]);
      const rejected = expect(
        f.writer.publish(f.publication, io(controller.signal, kind === 'deadline' ? 150 : 2500)),
      ).rejects.toThrow('PAPER_RUNTIME_ABORTED');
      await wait(50);
      const start = Date.now();
      if (kind === 'abort') controller.abort();
      await rejected;
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      controller.abort();
      await p.query('ROLLBACK');
      p.release();
    }
    expect(await f.writer.head(f.c.owner, io())).toBeNull();
    expect((await f.writer.publish(f.publication, io())).revision).toBe('1');
  },
);
it('four physical pending sockets are bounded, close drains them and restart retains no phantom publication', async () => {
  const f = await fixture(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.c.owner.accountId,
    ]);
    const pending = Promise.allSettled(
      Array.from({ length: 4 }, () => f.writer.publish(f.publication, io())),
    );
    await wait(60);
    await expect(f.writer.publish(f.publication, io())).rejects.toThrow('PAPER_RUNTIME_BUSY');
    await f.writer.close();
    expect((await pending).every((r) => r.status === 'rejected')).toBe(true);
    await expect(f.writer.head(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_CLOSED');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  const h = await observer();
  expect(await h.head(f.c.owner, io())).toBeNull();
  expect((await h.publish(f.publication, io())).revision).toBe('1');
});
it('lost acknowledged publication COMMIT returns UNCERTAIN; explicit restart reconciliation finds one event without monetary effect', async () => {
  const f = await fixture(),
    before = await effects(f.c.owner.tenantId),
    proxy = await registryCommitProxy(
      required('DATABASE_PAPER_RUNTIME_OBSERVER_URL'),
      'PAPER_RUNTIME_OBSERVATION',
    );
  try {
    const h = await observer(proxy.connectionString);
    proxy.arm();
    await expect(h.publish(f.publication, io())).rejects.toThrow('PAPER_RUNTIME_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    const restarted = await observer(),
      receipt = await restarted.find(f.publication, io());
    expect(receipt?.revision).toBe('1');
    expect((await (await reader()).read(f.c.owner, io())).reference.id).toBe(f.publication.id);
    expect(await effects(f.c.owner.tenantId)).toEqual(before);
    expect(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int n FROM ctp_paper.runtime_observation WHERE tenant_id=$1',
          [f.c.owner.tenantId],
        )
      ).rows[0]?.n,
    ).toBe(1);
  } finally {
    await proxy.close();
  }
});
it('lost acknowledged reader COMMIT yields no source and restart preserves original facts', async () => {
  const f = await fixture(),
    receipt = await f.writer.publish(f.publication, io()),
    proxy = await registryCommitProxy(
      required('DATABASE_PAPER_RUNTIME_READER_URL'),
      'PAPER_RUNTIME_SOURCE',
    );
  try {
    const h = await reader(proxy.connectionString);
    proxy.arm();
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    expect((await (await reader()).read(f.c.owner, io())).reference.id).toBe(receipt.id);
    expect(await f.writer.head(f.c.owner, io())).toEqual({ ...receipt, replayed: true });
  } finally {
    await proxy.close();
  }
});
it('GLOBAL then tenant and account locks hold current server context until transaction settlement', async () => {
  const f = await fixture(),
    pool = new Pool({ connectionString: required('DATABASE_PAPER_RUNTIME_OBSERVER_URL') }),
    p = await pool.connect(),
    writer = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query('SELECT ctp_paper.read_runtime_observation_context($1::jsonb)', [
      JSON.stringify(f.c.owner),
    ]);
    for (const [sql, params] of [
      ['SELECT pg_advisory_xact_lock(1129599058,12)', []],
      [
        "SELECT pg_advisory_xact_lock(hashtextextended('ctp:risk:'||$1::text,0))",
        [f.c.owner.tenantId],
      ],
      [
        'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE id=$1',
        [f.c.owner.accountId],
      ],
    ] as const) {
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout='80ms'");
      await expect(writer.query(sql, [...params])).rejects.toThrow(/lock timeout/u);
      await writer.query('ROLLBACK');
    }
  } finally {
    await p.query('ROLLBACK');
    p.release();
    await pool.end();
    await writer.query('ROLLBACK');
    writer.release();
  }
});
it('durable prior epoch watermark rejects server epoch rollback after producer restart', async () => {
  const f = await fixture();
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE id=$1',
    [f.c.owner.accountId],
  );
  const firstContext = await f.writer.context(f.c.owner, io());
  f.publication.observation.permissionEpoch = firstContext.current.permissionEpoch;
  for (const key of paperRuntimeDependencies)
    f.publication.observation.health[key].asOf = Date.now();
  const first = await f.writer.publish(f.publication, io());
  await f.writer.close();
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"-1 WHERE id=$1',
    [f.c.owner.accountId],
  );
  const h = await observer(),
    context = await h.context(f.c.owner, io()),
    p = next(f.publication);
  p.observation.permissionEpoch = context.current.permissionEpoch;
  for (const key of paperRuntimeDependencies) p.observation.health[key].asOf = Date.now();
  await expect(h.publish(p, io())).rejects.toThrow('PAPER_RUNTIME_EPOCH');
  expect(await h.head(f.c.owner, io())).toEqual({ ...first, replayed: true });
});
it.each(['abort', 'deadline'] as const)(
  'reader %s destroys blocked capture, frees slot and preserves original event',
  async (kind) => {
    const f = await fixture(),
      receipt = await f.writer.publish(f.publication, io()),
      h = await reader(),
      p = await admin.connect(),
      controller = new AbortController();
    try {
      await p.query('BEGIN');
      await p.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
        f.c.owner.accountId,
      ]);
      const rejected = expect(
        h.read(f.c.owner, io(controller.signal, kind === 'deadline' ? 150 : 2500)),
      ).rejects.toThrow('PAPER_RUNTIME_ABORTED');
      await wait(50);
      const start = Date.now();
      if (kind === 'abort') controller.abort();
      await rejected;
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      controller.abort();
      await p.query('ROLLBACK');
      p.release();
    }
    expect((await h.read(f.c.owner, io())).reference.id).toBe(receipt.id);
  },
);
it('reader bounds four waiting physical sockets and close settles all before restart', async () => {
  const f = await fixture(),
    receipt = await f.writer.publish(f.publication, io()),
    h = await reader(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.c.owner.accountId,
    ]);
    const pending = Promise.allSettled(Array.from({ length: 4 }, () => h.read(f.c.owner, io())));
    await wait(60);
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_BUSY');
    await h.close();
    expect((await pending).every((r) => r.status === 'rejected')).toBe(true);
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_CLOSED');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  expect((await (await reader()).read(f.c.owner, io())).reference.id).toBe(receipt.id);
});

// These are isolated server probe fixtures, not real service health acceptance.
function collectorProbes(executor?: PaperRuntimeProbe): PaperRuntimeProbes {
  return Object.fromEntries(
    paperRuntimeDependencies.map((dependency) => {
      const probe: PaperRuntimeProbe = {
        dependency,
        sample: (context) =>
          Promise.resolve({
            dependency,
            contextHash: context.hash,
            fact: { sourceId: `collector-test:${dependency}`, asOf: Date.now(), status: 'HEALTHY' },
          }),
        close: () => Promise.resolve(),
      };
      return [dependency, dependency === 'executor' && executor ? executor : probe];
    }),
  ) as unknown as PaperRuntimeProbes;
}
async function collector(
  probes: PaperRuntimeProbes,
  connectionString = required('DATABASE_PAPER_RUNTIME_OBSERVER_URL'),
) {
  const h = await createPostgresPaperRuntimeCollector({
    database: { connectionString, environment: 'test' },
    probes,
  });
  handles.push(h);
  return h;
}

it('native server collector restarts from durable revision and preserves explicit unavailable executor without financial writes', async () => {
  const f = await fixture(),
    before = await effects(f.c.owner.tenantId);
  const a = await collector(collectorProbes(createUnavailablePaperRuntimeProbe('executor')));
  const first = await a.collect(f.c.owner, io());
  expect(first.kind).toBe('PUBLISHED');
  expect(first.publication.expectedRevision).toBe('0');
  expect((await (await reader()).read(f.c.owner, io())).blockedBy).toEqual(['executor']);
  await a.close();
  await wait(2);
  const b = await collector(collectorProbes(createUnavailablePaperRuntimeProbe('executor')));
  const second = await b.collect(f.c.owner, io());
  expect(second.kind).toBe('PUBLISHED');
  expect(second.publication.expectedRevision).toBe('1');
  expect(second.publication.id).not.toBe(first.publication.id);
  expect((await f.writer.head(f.c.owner, io()))?.id).toBe(second.publication.id);
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});

it('native collector lost server COMMIT returns UNCERTAIN and restart reconciles original publication exactly once', async () => {
  const f = await fixture(),
    before = await effects(f.c.owner.tenantId);
  const proxy = await registryCommitProxy(
    required('DATABASE_PAPER_RUNTIME_OBSERVER_URL'),
    'PAPER_RUNTIME_OBSERVATION',
  );
  try {
    const a = await collector(collectorProbes(), proxy.connectionString);
    proxy.arm();
    const result = await a.collect(f.c.owner, io());
    expect(result.kind).toBe('UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await a.close();
    const restarted = await collector(collectorProbes());
    const receipt = await restarted.reconcile(result.publication, io());
    expect(receipt?.id).toBe(result.publication.id);
    expect(receipt?.replayed).toBe(true);
    const count = await admin.query<{ n: number }>(
      'SELECT count(*)::int n FROM ctp_paper.runtime_observation WHERE tenant_id=$1',
      [f.c.owner.tenantId],
    );
    expect(count.rows[0]!.n).toBe(1);
    expect(await effects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await proxy.close();
  }
});

it('native collector cannot publish facts from an epoch replaced during probe acquisition', async () => {
  const f = await fixture(),
    before = await effects(f.c.owner.tenantId);
  const executor: PaperRuntimeProbe = {
    dependency: 'executor',
    async sample(context) {
      await admin.query(
        'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE id=$1',
        [f.c.owner.accountId],
      );
      return {
        dependency: 'executor',
        contextHash: context.hash,
        fact: { sourceId: 'collector-test:old-epoch', asOf: Date.now(), status: 'HEALTHY' },
      };
    },
    close: () => Promise.resolve(),
  };
  const h = await collector(collectorProbes(executor));
  await expect(h.collect(f.c.owner, io())).rejects.toThrow('PAPER_RUNTIME_EPOCH');
  expect(await f.writer.head(f.c.owner, io())).toBeNull();
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});

it('native concurrent collector instances share durable CAS and never retry the losing publication', async () => {
  const f = await fixture();
  let arrived = 0,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor = (): PaperRuntimeProbe => ({
    dependency: 'executor',
    async sample(context) {
      if (++arrived === 2) release();
      await barrier;
      return {
        dependency: 'executor',
        contextHash: context.hash,
        fact: { sourceId: 'collector-test:concurrent', asOf: Date.now(), status: 'HEALTHY' },
      };
    },
    close: () => Promise.resolve(),
  });
  const a = await collector(collectorProbes(executor())),
    b = await collector(collectorProbes(executor()));
  const results = await Promise.allSettled([
    a.collect(f.c.owner, io()),
    b.collect(f.c.owner, io()),
  ]);
  expect(
    results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'PUBLISHED'),
  ).toHaveLength(1);
  const failed = results.find((r) => r.status === 'rejected');
  expect(
    failed?.status === 'rejected' && failed.reason instanceof Error && failed.reason.message,
  ).toBe('PAPER_RUNTIME_CONFLICT');
  expect(arrived).toBe(2);
  expect((await f.writer.head(f.c.owner, io()))?.revision).toBe('1');
});

it('native collector abort physically settles blocked head acquisition and permits a fresh later cycle', async () => {
  const f = await fixture(),
    h = await collector(collectorProbes()),
    lock = await admin.connect();
  const controller = new AbortController();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.c.owner.accountId,
    ]);
    const pending = h.collect(f.c.owner, io(controller.signal));
    const rejection = expect(pending).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_ABORTED');
    await wait(50);
    const start = Date.now();
    controller.abort();
    await rejection;
    expect(Date.now() - start).toBeLessThan(1500);
    await h.close();
  } finally {
    controller.abort();
    await lock.query('ROLLBACK');
    lock.release();
  }
  expect(await f.writer.head(f.c.owner, io())).toBeNull();
  const restarted = await collector(collectorProbes());
  expect((await restarted.collect(f.c.owner, io())).kind).toBe('PUBLISHED');
});

async function runtimeWorker(
  owner: PaperOwner,
  probes: PaperRuntimeProbes,
  connectionString = required('DATABASE_PAPER_RUNTIME_OBSERVER_URL'),
) {
  const h = await createPostgresPaperRuntimeWorker({
    database: { connectionString, environment: 'test' },
    probes,
    owners: [owner],
    intervalMs: 100,
  });
  handles.push(h);
  return h;
}
async function waitRuntimeRevision(owner: PaperOwner, minimum: bigint) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const r = await admin.query<{ revision: string }>(
      'SELECT revision::text FROM ctp_paper.runtime_observation_head WHERE tenant_id=$1 AND account_id=$2',
      [owner.tenantId, owner.accountId],
    );
    if (r.rows[0] && BigInt(r.rows[0].revision) >= minimum) return;
    await wait(25);
  }
  throw new Error('PAPER_RUNTIME_WORKER_NATIVE_REVISION_TIMEOUT');
}
it('native periodic worker restarts from durable revision, keeps unavailable executor negative and has no monetary writes', async () => {
  const f = await fixture(),
    before = await effects(f.c.owner.tenantId);
  const a = await runtimeWorker(
      f.c.owner,
      collectorProbes(createUnavailablePaperRuntimeProbe('executor')),
    ),
    ac = new AbortController(),
    first = a.run(ac.signal);
  try {
    await waitRuntimeRevision(f.c.owner, 2n);
    expect((await (await reader()).read(f.c.owner, io())).blockedBy).toEqual(['executor']);
  } finally {
    ac.abort();
    await a.close();
  }
  expect((await first).closed).toBe(true);
  const stopped = await f.writer.head(f.c.owner, io());
  expect(stopped).not.toBeNull();
  await wait(150);
  expect((await f.writer.head(f.c.owner, io()))?.id).toBe(stopped!.id);
  const b = await runtimeWorker(
      f.c.owner,
      collectorProbes(createUnavailablePaperRuntimeProbe('executor')),
    ),
    bc = new AbortController(),
    second = b.run(bc.signal);
  try {
    await waitRuntimeRevision(f.c.owner, BigInt(stopped!.revision) + 1n);
  } finally {
    bc.abort();
    await b.close();
  }
  expect((await second).closed).toBe(true);
  expect((await f.writer.head(f.c.owner, io()))?.id).not.toBe(stopped!.id);
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});
it('native worker lost COMMIT halts at one publication and restart reconciles its exact original without retry', async () => {
  const f = await fixture(),
    before = await effects(f.c.owner.tenantId),
    proxy = await registryCommitProxy(
      required('DATABASE_PAPER_RUNTIME_OBSERVER_URL'),
      'PAPER_RUNTIME_OBSERVATION',
    );
  try {
    const h = await runtimeWorker(f.c.owner, collectorProbes(), proxy.connectionString);
    proxy.arm();
    const result = await h.run(new AbortController().signal);
    expect(result.state).toBe('UNCERTAIN');
    expect(result.closed).toBe(true);
    expect(result.uncertain).toHaveLength(1);
    expect(proxy.dropped()).toBe(1);
    await wait(250);
    const count = await admin.query<{ n: number }>(
      'SELECT count(*)::int n FROM ctp_paper.runtime_observation WHERE tenant_id=$1',
      [f.c.owner.tenantId],
    );
    expect(count.rows[0]!.n).toBe(1);
    const restarted = await collector(collectorProbes()),
      original = result.uncertain[0]!;
    expect(await restarted.reconcile(original, io())).toMatchObject({
      id: original.id,
      replayed: true,
    });
    expect((await f.writer.head(f.c.owner, io()))?.id).toBe(original.id);
    expect(await effects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await proxy.close();
  }
});
it('native worker stops after permission epoch replacement during probes without publishing or retrying', async () => {
  const f = await fixture(),
    before = await effects(f.c.owner.tenantId);
  let samples = 0;
  const executor: PaperRuntimeProbe = {
    dependency: 'executor',
    async sample(context) {
      samples++;
      await admin.query(
        'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE id=$1',
        [f.c.owner.accountId],
      );
      return {
        dependency: 'executor',
        contextHash: context.hash,
        fact: { sourceId: 'worker-test:old-epoch', asOf: Date.now(), status: 'HEALTHY' },
      };
    },
    close: () => Promise.resolve(),
  };
  const h = await runtimeWorker(f.c.owner, collectorProbes(executor));
  expect(await h.run(new AbortController().signal)).toEqual({
    state: 'FAILED',
    uncertain: [],
    collectionFailed: true,
    closed: true,
  });
  await wait(250);
  expect(samples).toBe(1);
  expect(await f.writer.head(f.c.owner, io())).toBeNull();
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});
it('native worker abort drains a physically blocked PostgreSQL head and prevents future ticks before a fresh worker', async () => {
  const f = await fixture(),
    before = await effects(f.c.owner.tenantId),
    h = await runtimeWorker(f.c.owner, collectorProbes()),
    lock = await admin.connect(),
    c = new AbortController();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.c.owner.accountId,
    ]);
    const task = h.run(c.signal);
    await wait(50);
    const start = Date.now();
    c.abort();
    expect(await task).toEqual({
      state: 'STOPPED',
      uncertain: [],
      collectionFailed: false,
      closed: true,
    });
    expect(Date.now() - start).toBeLessThan(1500);
    await h.close();
  } finally {
    c.abort();
    await lock.query('ROLLBACK');
    lock.release();
  }
  await wait(150);
  expect(await f.writer.head(f.c.owner, io())).toBeNull();
  const next = await runtimeWorker(
      f.c.owner,
      collectorProbes(createUnavailablePaperRuntimeProbe('executor')),
    ),
    nc = new AbortController(),
    task = next.run(nc.signal);
  try {
    await waitRuntimeRevision(f.c.owner, 1n);
  } finally {
    nc.abort();
    await next.close();
  }
  expect((await task).closed).toBe(true);
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});
