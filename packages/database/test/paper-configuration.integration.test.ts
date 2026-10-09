import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
} from '@ctp/paper-engine/configuration';
import { fixture as modelFixture } from '../../paper-engine/test/fixtures.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_PAPER_RUNNER_REQUIRED');
const required = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error('ISOLATED_PAPER_VARIABLE_REQUIRED');
  return v;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const direct = new Pool({
  connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
  max: 2,
  query_timeout: 5000,
});
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
const handles: Awaited<ReturnType<typeof createPostgresPaperConfiguration>>[] = [];
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await direct.end();
  await admin.end();
});
async function open(connectionString = required('DATABASE_PAPER_CONFIGURATION_URL')) {
  const h = await createPostgresPaperConfiguration({ connectionString, environment: 'test' });
  handles.push(h);
  return h;
}
async function fixture(mode = 'PAPER') {
  const c = paperConfigurationSchema.parse({
    id: randomUUID(),
    owner: { tenantId: randomUUID(), accountId: randomUUID(), mode: 'PAPER' },
    source: { exchange: 'BINANCE', market: 'SPOT', region: 'global', environment: 'LIVE' },
    valuationAsset: 'USDT',
    model: modelFixture().model,
  });
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
    [c.owner.tenantId, `${c.owner.tenantId}@example.invalid`],
  );
  await admin.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,'BINANCE',$3,$4,'global','SIMULATED','ACTIVE','paper-epoch',now())`,
    [c.owner.accountId, c.owner.tenantId, mode, `paper:${c.owner.accountId}`],
  );
  return c;
}
it('native concurrent exact registration, restart and read return one immutable identity with no financial effect', async () => {
  const c = await fixture(),
    store = await open();
  const [a, b] = await Promise.all([store.register(c, io()), store.register(c, io())]);
  expect(a).toEqual(b);
  await store.close();
  const restarted = await open();
  expect(await restarted.read(c.owner, io())).toEqual(a);
  expect(await restarted.register(c, io())).toEqual(a);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_paper.configuration WHERE tenant_id=$1',
        [c.owner.tenantId],
      )
    ).rows[0]?.n,
  ).toBe(1);
  for (const table of [
    'ledger_transaction',
    'order_intent',
    'order',
    'risk_decision',
    'risk_reservation',
    'paper_account',
  ])
    expect(
      (
        await admin.query<{ n: number }>(
          `SELECT count(*)::int n FROM public."${table}" WHERE "tenantId"=$1`,
          [c.owner.tenantId],
        )
      ).rows[0]?.n,
    ).toBe(0);
});
it.each(['model', 'source', 'valuationAsset', 'id'] as const)(
  'permanent configuration rejects %s replacement after restart',
  async (key) => {
    const c = await fixture(),
      store = await open(),
      accepted = await store.register(c, io());
    await store.close();
    const restarted = await open();
    const changed =
      key === 'model'
        ? { ...c, model: { ...c.model, takerFeeRate: '0.002' } }
        : key === 'source'
          ? { ...c, source: { ...c.source, environment: 'TESTNET' as const } }
          : key === 'id'
            ? { ...c, id: randomUUID() }
            : { ...c, valuationAsset: 'BTC' };
    await expect(restarted.register(changed, io())).rejects.toThrow('PAPER_CONFIGURATION_CONFLICT');
    expect(await restarted.read(c.owner, io())).toEqual(accepted);
  },
);
it('same permanent ID cannot move to a different account or tenant', async () => {
  const a = await fixture(),
    b = await fixture(),
    store = await open();
  await store.register(a, io());
  await expect(store.register({ ...b, id: a.id }, io())).rejects.toThrow(
    'PAPER_CONFIGURATION_CONFLICT',
  );
  await expect(store.read(b.owner, io())).rejects.toThrow('PAPER_CONFIGURATION_MISSING');
});
it.each(['TESTNET', 'DEMO', 'LIVE'])('cannot bind native %s account as PAPER', async (mode) => {
  const c = await fixture(mode),
    store = await open();
  await expect(store.register(c, io())).rejects.toThrow('PAPER_CONFIGURATION_OWNERSHIP');
});
it('wrong tenant cannot read/register another account and SQL tenant context is mandatory', async () => {
  const a = await fixture(),
    b = await fixture(),
    store = await open();
  await store.register(a, io());
  await expect(store.read({ ...a.owner, tenantId: b.owner.tenantId }, io())).rejects.toThrow(
    'PAPER_CONFIGURATION_MISSING',
  );
  await expect(
    store.register(
      { ...a, id: randomUUID(), owner: { ...a.owner, tenantId: b.owner.tenantId } },
      io(),
    ),
  ).rejects.toThrow('PAPER_CONFIGURATION_OWNERSHIP');
  await expect(
    direct.query('SELECT ctp_paper.register_configuration($1)', [JSON.stringify(a)]),
  ).rejects.toThrow('PAPER_CONFIGURATION_OWNERSHIP');
});
it.each(['status', 'region', 'exchange', 'externalAccountId', 'clientIdEpoch'] as const)(
  'current account %s replacement fails closed without replacing receipt',
  async (key) => {
    const c = await fixture(),
      store = await open();
    await store.register(c, io());
    const changed = {
      status: 'DISABLED',
      region: 'other',
      exchange: 'OKX',
      externalAccountId: 'other-account',
      clientIdEpoch: 'other-epoch',
    }[key];
    await admin.query(`UPDATE public.exchange_account SET "${key}"=$1 WHERE id=$2`, [
      changed,
      c.owner.accountId,
    ]);
    await expect(store.read(c.owner, io())).rejects.toThrow('PAPER_CONFIGURATION_OWNERSHIP');
  },
);
it('suspended tenant and missing configuration never provide ownership authority', async () => {
  const c = await fixture(),
    store = await open();
  await expect(store.read(c.owner, io())).rejects.toThrow('PAPER_CONFIGURATION_MISSING');
  await store.register(c, io());
  await admin.query('UPDATE public."user" SET status=\'SUSPENDED\' WHERE id=$1', [
    c.owner.tenantId,
  ]);
  await expect(store.read(c.owner, io())).rejects.toThrow('PAPER_CONFIGURATION_OWNERSHIP');
});
it.each(['UPDATE', 'DELETE', 'TRUNCATE'])(
  'published configuration cannot be changed with %s even by migration owner',
  async (operation) => {
    const c = await fixture(),
      store = await open();
    await store.register(c, io());
    const query =
      operation === 'UPDATE'
        ? 'UPDATE ctp_paper.configuration SET request=request WHERE id=$1'
        : operation === 'DELETE'
          ? 'DELETE FROM ctp_paper.configuration WHERE id=$1'
          : 'TRUNCATE ctp_paper.configuration';
    await expect(admin.query(query, operation === 'TRUNCATE' ? [] : [c.id])).rejects.toThrow();
  },
);
it.each([
  (c: Awaited<ReturnType<typeof fixture>>) => ({ ...c, credentials: 'untrusted' }),
  (c: Awaited<ReturnType<typeof fixture>>) => ({ ...c, model: { ...c.model, seed: '1e3' } }),
  (c: Awaited<ReturnType<typeof fixture>>) => ({
    ...c,
    model: { ...c.model, seed: '9223372036854775808' },
  }),
  (c: Awaited<ReturnType<typeof fixture>>) => ({
    ...c,
    model: { ...c.model, participationRate: '0' },
  }),
  (c: Awaited<ReturnType<typeof fixture>>) => ({
    ...c,
    model: { ...c.model, maxSlippageRate: '0.100000000000000001' },
  }),
  (c: Awaited<ReturnType<typeof fixture>>) => ({
    ...c,
    source: { ...c.source, market: 'LINEAR_PERPETUAL' },
  }),
  (c: Awaited<ReturnType<typeof fixture>>) => ({ ...c, model: { ...c.model, latencyMs: 60001 } }),
])('SQL independently rejects unsupported/unknown config %#', async (change) => {
  const c = await fixture(),
    p = await direct.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [c.owner.tenantId]);
    await expect(
      p.query('SELECT ctp_paper.register_configuration($1)', [JSON.stringify(change(c))]),
    ).rejects.toThrow('PAPER_CONFIGURATION_INPUT');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
});
it('physically lost server COMMIT returns no receipt; exact restart replay recovers one publication', async () => {
  const c = await fixture(),
    proxy = await registryCommitProxy(
      required('DATABASE_PAPER_CONFIGURATION_URL'),
      'PAPER_CONFIGURATION',
    );
  const store = await open(proxy.connectionString);
  proxy.arm();
  try {
    await expect(store.register(c, io())).rejects.toThrow('PAPER_CONFIGURATION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await store.close();
    const restarted = await open(),
      recovered = await restarted.read(c.owner, io());
    expect(await restarted.register(c, io())).toEqual(recovered);
    expect(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int n FROM ctp_paper.configuration WHERE id=$1',
          [c.id],
        )
      ).rows[0]?.n,
    ).toBe(1);
  } finally {
    await proxy.close();
  }
});
it.each(['abort', 'deadline'] as const)(
  'hung account lock %s settles physically and frees slot',
  async (kind) => {
    const c = await fixture(),
      store = await open(),
      lock = await admin.connect(),
      controller = new AbortController();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
        c.owner.accountId,
      ]);
      const pending = store.register(c, io(controller.signal, kind === 'deadline' ? 100 : 2500));
      const outcome = pending.then(
        () => 'unexpected-receipt',
        (e: unknown) => (e instanceof Error ? e.message : 'unknown'),
      );
      await wait(50);
      if (kind === 'abort') controller.abort();
      expect(await outcome).toBe('PAPER_CONFIGURATION_ABORTED');
      await lock.query('ROLLBACK');
      await wait(50);
      expect((await store.register(c, io())).configuration).toEqual(c);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  },
);
it('runtime has no direct configuration, credentials, financial or native mutation authority', async () => {
  const r = await direct.query<{ unsafe: boolean }>(`SELECT
   EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_') AND t.relkind IN('r','p')
    AND (has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
    OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
   OR EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
    WHERE left(n.nspname,4)='ctp_' AND has_function_privilege(current_user,f.oid,'EXECUTE')
    AND (n.nspname<>'ctp_paper' OR f.proname NOT IN('register_configuration','read_configuration'))) AS unsafe`);
  expect(r.rows[0]?.unsafe).toBe(false);
});
it('configuration table forces tenant RLS and credential-free public mode constraint remains enforced', async () => {
  const r = await admin.query<{ safe: boolean }>(
    "SELECT relrowsecurity AND relforcerowsecurity AS safe FROM pg_class WHERE oid='ctp_paper.configuration'::regclass",
  );
  expect(r.rows[0]?.safe).toBe(true);
  const c = await fixture();
  await expect(
    admin.query(
      `INSERT INTO public.exchange_connection("tenantId","accountId",mode,label,permissions,"updatedAt") VALUES($1,$2,'PAPER','forbidden','{}',now())`,
      [c.owner.tenantId, c.owner.accountId],
    ),
  ).rejects.toThrow();
});
it('SQL independently denies a grouping role made LOGIN after port startup', async () => {
  const c = await fixture(),
    store = await open();
  await admin.query('ALTER ROLE ctp_paper_configuration LOGIN');
  try {
    await expect(store.register(c, io())).rejects.toThrow('PAPER_CONFIGURATION_ROLE_UNSAFE');
  } finally {
    await admin.query('ALTER ROLE ctp_paper_configuration NOLOGIN');
  }
});
it('four hung operations are bounded, excess work is BUSY and aborted slots become reusable', async () => {
  const c = await fixture(),
    store = await open(),
    lock = await admin.connect(),
    controller = new AbortController();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      c.owner.accountId,
    ]);
    const pending = Array.from({ length: 4 }, () =>
      store.register(c, io(controller.signal)).then(
        () => 'unexpected-receipt',
        (e: unknown) => (e instanceof Error ? e.message : 'unknown'),
      ),
    );
    await wait(50);
    await expect(store.register(c, io())).rejects.toThrow('PAPER_CONFIGURATION_BUSY');
    controller.abort();
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 4 }, () => 'PAPER_CONFIGURATION_ABORTED'),
    );
    await lock.query('ROLLBACK');
    await wait(50);
    expect((await store.register(c, io())).configuration).toEqual(c);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
});
