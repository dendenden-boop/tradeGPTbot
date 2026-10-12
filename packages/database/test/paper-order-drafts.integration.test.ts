import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { createPostgresOrderStore, bindingSchema, draftSchema } from '@ctp/order-engine';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
} from '@ctp/paper-engine/configuration';
import { frameFixture } from '../../paper-engine/test/frame-fixture.js';
import { state } from '../../order-engine/test/fixtures.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_PAPER_DRAFT_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_PAPER_DRAFT_VARIABLE_REQUIRED');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await admin.end();
});
async function open() {
  const h = await createPostgresOrderStore({
    connectionString: required('DATABASE_EXECUTION_URL'),
    environment: 'test',
  });
  handles.push(h);
  return h;
}
async function fixture({ configure = true } = {}) {
  const f = frameFixture(),
    c = paperConfigurationSchema.parse(f.configuration.configuration);
  const externalAccountId = 'paper:' + c.owner.accountId;
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
    [c.owner.tenantId, c.owner.tenantId + '@example.invalid'],
  );
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'paper-draft-epoch\',now())',
    [c.owner.accountId, c.owner.tenantId, c.source.exchange, externalAccountId, c.source.region],
  );
  const config = await createPostgresPaperConfiguration({
    connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
    environment: 'test',
  });
  try {
    if (configure) await config.register(c, io());
  } finally {
    await config.close();
  }
  const i = f.p.record.instrument,
    r = f.p.record.rules;
  await admin.query(
    'INSERT INTO public.instrument(id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt") VALUES($1,$2,\'SPOT\',$3,$4,$5,$6,true,now())',
    [
      f.p.key.dbInstrumentId,
      i.scope.exchange,
      i.scope.environment,
      i.exchangeSymbol,
      i.baseAsset,
      i.quoteAsset,
    ],
  );
  await admin.query(
    'INSERT INTO public.instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",rules) VALUES($1,$2,1,true,$3,now(),$4,$5,$6,$7,$8,$9,$10::jsonb)',
    [
      f.p.key.dbRuleId,
      f.p.key.dbInstrumentId,
      new Date(r.effectiveAt),
      Buffer.alloc(32, 1),
      r.tickSize,
      r.stepSize,
      r.minQuantity,
      r.maxQuantity,
      r.minNotional,
      JSON.stringify(r),
    ],
  );
  const binding = bindingSchema.parse({
    ...c.owner,
    connectionId: null,
    externalAccountId,
    profile: {
      ...c.source,
      accountMode: 'SIMULATED',
      endpointProfileId: 'paper-spot-v1',
      profileVersion: c.model.version,
    },
  });
  const draft = draftSchema.parse({
    ...state().draft,
    key: randomUUID(),
    dbInstrumentId: f.p.key.dbInstrumentId,
    dbRuleId: f.p.key.dbRuleId,
    order: {
      ...state().draft.order,
      instrumentId: i.id,
      ruleVersion: r.version,
      size: { kind: 'BASE_QUANTITY', asset: i.baseAsset, value: '0.5' },
    },
  });
  return { f, c, binding, draft };
}

it('PAPER draft creates the common durable intent against its configured public-source rules without financial authority', async () => {
  const f = await fixture(),
    store = await open();
  const created = await store.create(f.binding, f.draft, io());
  expect(created).toMatchObject({
    binding: f.binding,
    status: 'CREATED',
    command: { clientOrderId: '1' },
  });
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.binding.tenantId]);
    const intent = await client.query(
      'SELECT mode,destination,"connectionId","instrumentId","ruleVersionId" FROM public.order_intent WHERE id=$1',
      [created.intentId],
    );
    expect(intent.rows).toEqual([
      {
        mode: 'PAPER',
        destination: 'PAPER_ENGINE',
        connectionId: null,
        instrumentId: f.draft.dbInstrumentId,
        ruleVersionId: f.draft.dbRuleId,
      },
    ]);
    for (const table of [
      'risk_decision',
      'risk_reservation',
      'submission_attempt',
      'ledger_transaction',
      'ledger_entry',
      'fill',
    ]) {
      expect(
        (
          await client.query<{ n: number }>(
            `SELECT count(*)::int n FROM public.${table} WHERE "tenantId"=$1`,
            [f.binding.tenantId],
          )
        ).rows[0]?.n,
      ).toBe(0);
    }
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

async function inspect(f: Awaited<ReturnType<typeof fixture>>) {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.binding.tenantId]);
    const counts: Record<string, number> = {};
    for (const table of [
      'order_intent',
      '"order"',
      'order_event',
      'outbox_event',
      'risk_decision',
      'risk_reservation',
      'submission_attempt',
      'ledger_transaction',
      'ledger_entry',
      'fill',
    ])
      counts[table] =
        (
          await client.query<{ n: number }>(
            `SELECT count(*)::int n FROM public.${table} WHERE "tenantId"=$1`,
            [f.binding.tenantId],
          )
        ).rows[0]?.n ?? -1;
    const counter = (
      await client.query<{ counter: string }>(
        'SELECT "clientIdHighWatermark"::text AS counter FROM public.exchange_account WHERE id=$1',
        [f.binding.accountId],
      )
    ).rows[0]?.counter;
    await client.query('ROLLBACK');
    return { counts, counter };
  } finally {
    client.release();
  }
}
it('exact PAPER create replay survives physical restart without new identity counter or events', async () => {
  const f = await fixture(),
    first = await open();
  const original = await first.create(f.binding, f.draft, io()),
    before = await inspect(f);
  await first.close();
  const restarted = await open();
  expect(await restarted.findCreate(f.binding, f.draft, io())).toEqual(original);
  expect(await restarted.create(f.binding, f.draft, io())).toEqual(original);
  expect(await inspect(f)).toEqual(before);
});
it('concurrent exact PAPER creates across physical stores allocate one common identity', async () => {
  const f = await fixture(),
    a = await open(),
    b = await open();
  const results = await Promise.all([
    a.create(f.binding, f.draft, io()),
    b.create(f.binding, f.draft, io()),
    a.create(f.binding, f.draft, io()),
    b.create(f.binding, f.draft, io()),
  ]);
  expect(
    results.every(
      (s) =>
        s.id === results[0]?.id &&
        s.intentId === results[0]?.intentId &&
        s.command.clientOrderId === '1',
    ),
  ).toBe(true);
  expect((await inspect(f)).counter).toBe('1');
  expect((await inspect(f)).counts.order_intent).toBe(1);
});
it('concurrent distinct PAPER drafts receive durable lossless FIFO client sequences', async () => {
  const f = await fixture(),
    a = await open(),
    b = await open();
  const results = await Promise.all(
    [a, b, a, b].map((h) => h.create(f.binding, { ...f.draft, key: randomUUID() }, io())),
  );
  expect(results.map((s) => s.command.clientOrderId).sort()).toEqual(['1', '2', '3', '4']);
  await a.close();
  await b.close();
  const restarted = await open();
  expect(
    (await restarted.create(f.binding, { ...f.draft, key: randomUUID() }, io())).command
      .clientOrderId,
  ).toBe('5');
  expect((await inspect(f)).counts.order_intent).toBe(5);
});
it('PAPER common client sequence stays lossless above Number precision and fails closed at signed-64 exhaustion', async () => {
  const f = await fixture(),
    h = await open();
  await admin.query(
    'UPDATE public.exchange_account SET "clientIdHighWatermark"=9007199254740992 WHERE id=$1',
    [f.binding.accountId],
  );
  const accepted = await h.create(f.binding, f.draft, io());
  expect(accepted.command.clientOrderId).toBe('9007199254740993');
  await admin.query(
    'UPDATE public.exchange_account SET "clientIdHighWatermark"=9223372036854775807 WHERE id=$1',
    [f.binding.accountId],
  );
  const before = await inspect(f);
  expect(await h.create(f.binding, f.draft, io())).toEqual(accepted);
  await expect(h.create(f.binding, { ...f.draft, key: randomUUID() }, io())).rejects.toThrow(
    'ORDER_ID_EXHAUSTED',
  );
  expect(await inspect(f)).toEqual(before);
});
it('semantic PAPER key conflict preserves the original identity and counter', async () => {
  const f = await fixture(),
    h = await open();
  const original = await h.create(f.binding, f.draft, io()),
    before = await inspect(f);
  const conflict = draftSchema.parse({
    ...f.draft,
    order: { ...f.draft.order, size: { ...f.draft.order.size, value: '1' } },
  });
  await expect(h.create(f.binding, conflict, io())).rejects.toThrow('ORDER_IDEMPOTENCY_CONFLICT');
  expect(await h.findCreate(f.binding, f.draft, io())).toEqual(original);
  expect(await inspect(f)).toEqual(before);
});
it('metadata replacement preserves exact PAPER replay but rejects a new stale-rule request', async () => {
  const f = await fixture(),
    h = await open();
  const original = await h.create(f.binding, f.draft, io()),
    before = await inspect(f);
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.draft.dbRuleId,
  ]);
  await h.close();
  const restarted = await open();
  expect(await restarted.create(f.binding, f.draft, io())).toEqual(original);
  await expect(
    restarted.create(f.binding, { ...f.draft, key: randomUUID() }, io()),
  ).rejects.toThrow('ORDER_METADATA');
  expect(await inspect(f)).toEqual(before);
});
it('PAPER ownership without a sealed server configuration cannot create an intent', async () => {
  const f = await fixture({ configure: false }),
    h = await open(),
    before = await inspect(f);
  await expect(h.create(f.binding, f.draft, io())).rejects.toThrow('ORDER_PAPER_CONFIGURATION');
  expect(await inspect(f)).toEqual(before);
});
it.each(['environment', 'endpoint', 'model', 'credential'])(
  'contradictory PAPER %s profile fails before allocating identity',
  async (kind) => {
    const f = await fixture(),
      h = await open(),
      before = await inspect(f);
    const profile = {
      ...f.binding.profile,
      ...(kind === 'environment' ? { environment: 'DEMO' as const } : {}),
      ...(kind === 'endpoint' ? { endpointProfileId: 'binance-spot-testnet-v1' } : {}),
      ...(kind === 'model' ? { profileVersion: 'unproven-model' } : {}),
      ...(kind === 'credential' ? { credentialRef: 'forbidden-reference' } : {}),
    };
    await expect(h.create({ ...f.binding, profile }, f.draft, io())).rejects.toThrow(
      'ORDER_PAPER_CONFIGURATION',
    );
    expect(await inspect(f)).toEqual(before);
  },
);
it.each(['account', 'user', 'epoch'])(
  'current PAPER %s revocation denies replay after restart',
  async (kind) => {
    const f = await fixture(),
      h = await open();
    await h.create(f.binding, f.draft, io());
    if (kind === 'account')
      await admin.query("UPDATE public.exchange_account SET status='DISABLED' WHERE id=$1", [
        f.binding.accountId,
      ]);
    if (kind === 'user')
      await admin.query('UPDATE public."user" SET status=\'SUSPENDED\' WHERE id=$1', [
        f.binding.tenantId,
      ]);
    if (kind === 'epoch')
      await admin.query(
        'UPDATE public.exchange_account SET "clientIdEpoch"=\'changed-epoch\' WHERE id=$1',
        [f.binding.accountId],
      );
    const before = await inspect(f);
    await h.close();
    const restarted = await open();
    await expect(restarted.create(f.binding, f.draft, io())).rejects.toThrow(
      'ORDER_PAPER_CONFIGURATION',
    );
    expect(await inspect(f)).toEqual(before);
  },
);
it('PAPER cannot use another account configuration or instrument source partition', async () => {
  const f = await fixture(),
    other = await fixture(),
    h = await open(),
    before = await inspect(f);
  await expect(
    h.create({ ...f.binding, externalAccountId: other.binding.externalAccountId }, f.draft, io()),
  ).rejects.toThrow('ORDER_PAPER_CONFIGURATION');
  const client = await admin.connect();
  try {
    await client.query("UPDATE public.instrument SET mode='PAPER' WHERE id=$1", [
      f.draft.dbInstrumentId,
    ]);
  } finally {
    client.release();
  }
  await expect(h.create(f.binding, f.draft, io())).rejects.toThrow('ORDER_METADATA');
  expect(await inspect(f)).toEqual(before);
});

it('lost acknowledged PAPER create COMMIT returns no result and exact restart replay recovers one intent', async () => {
  const f = await fixture(),
    proxy = await registryCommitProxy(required('DATABASE_EXECUTION_URL'), 'PAPER_ORDER');
  const h = await createPostgresOrderStore({
    connectionString: proxy.connectionString,
    environment: 'test',
  });
  try {
    proxy.arm();
    await expect(h.create(f.binding, f.draft, io())).rejects.toThrow('ORDER_PAPER_STORE_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    const restarted = await open(),
      recovered = await restarted.findCreate(f.binding, f.draft, io()),
      before = await inspect(f);
    expect(recovered?.command.clientOrderId).toBe('1');
    expect(before.counts.order_intent).toBe(1);
    expect(before.counter).toBe('1');
    expect(await restarted.create(f.binding, f.draft, io())).toEqual(recovered);
    expect(await inspect(f)).toEqual(before);
    for (const table of [
      'risk_decision',
      'risk_reservation',
      'submission_attempt',
      'ledger_transaction',
      'ledger_entry',
      'fill',
    ])
      expect(before.counts[table]).toBe(0);
  } finally {
    await h.close();
    await proxy.close();
  }
});

it.each(['scope', 'expiresAt', 'effectiveAt', 'quantityUnit', 'instrumentId'])(
  'PAPER new draft rejects conflicting or stale %s rules without counter or monetary effects',
  async (field) => {
    const f = await fixture(),
      h = await open(),
      before = await inspect(f);
    const value =
      field === 'scope'
        ? { ...f.c.source, environment: 'DEMO' }
        : field === 'expiresAt'
          ? Date.now() - 1
          : field === 'effectiveAt'
            ? Date.now() + 60000
            : field === 'quantityUnit'
              ? 'CONTRACT'
              : 'another-instrument';
    // Rule rows are immutable in runtime. Isolated DDL owner corruption fixture only.
    const p = await admin.connect();
    try {
      await p.query('BEGIN');
      await p.query("SET LOCAL session_replication_role='replica'");
      await p.query(
        'UPDATE public.instrument_rule_version SET rules=jsonb_set(rules,$2::text[],$3::jsonb) WHERE id=$1',
        [f.draft.dbRuleId, [field], JSON.stringify(value)],
      );
      await p.query('COMMIT');
    } finally {
      await p.query('ROLLBACK');
      p.release();
    }
    await expect(h.create(f.binding, f.draft, io())).rejects.toThrow('ORDER_METADATA');
    expect(await inspect(f)).toEqual(before);
  },
);

it('missing original PAPER configuration seal denies common drafts after restart', async () => {
  const f = await fixture(),
    p = await admin.connect();
  let hash: Buffer | undefined;
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.binding.tenantId]);
    hash = (
      await p.query<{ receipt_hash: Buffer }>(
        'SELECT receipt_hash FROM ctp_paper.configuration_seal WHERE id=$1',
        [f.c.id],
      )
    ).rows[0]?.receipt_hash;
    if (!hash) throw new Error('SEAL_FIXTURE_MISSING');
    await p.query("SET LOCAL session_replication_role='replica'");
    await p.query('DELETE FROM ctp_paper.configuration_seal WHERE id=$1', [f.c.id]);
    await p.query('COMMIT');
    const h = await open(),
      before = await inspect(f);
    await expect(h.create(f.binding, f.draft, io())).rejects.toThrow('ORDER_PAPER_CONFIGURATION');
    expect(await inspect(f)).toEqual(before);
  } finally {
    await p.query('ROLLBACK');
    if (hash) {
      await p.query('BEGIN');
      await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.binding.tenantId]);
      await p.query(
        'INSERT INTO ctp_paper.configuration_seal(id,tenant_id,account_id,receipt_hash) VALUES($1,$2,$3,$4)',
        [f.c.id, f.binding.tenantId, f.binding.accountId, hash],
      );
      await p.query('COMMIT');
    }
    p.release();
  }
});

it('execution receives only the fixed PAPER proof RPC and no configuration or financial writer grants', async () => {
  const p = new Pool({ connectionString: required('DATABASE_EXECUTION_URL'), max: 1 });
  try {
    const r =
      await p.query(`SELECT has_function_privilege(current_user,'ctp_execution.paper_order_identity(jsonb)','EXECUTE') AS proof,
      (SELECT has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE') FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='ctp_paper' AND t.relname='configuration') AS configuration,
      (SELECT has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE') FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='ctp_paper' AND t.relname='configuration_seal') AS seal,
      has_table_privilege(current_user,'public.ledger_transaction','INSERT,UPDATE,DELETE') AS ledger,
      has_table_privilege(current_user,'public.ledger_entry','INSERT,UPDATE,DELETE') AS entries,
      (SELECT has_function_privilege(current_user,f.oid,'EXECUTE') FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='ctp_paper' AND f.proname='initialize_funding') AS funding`);
    expect(r.rows).toEqual([
      {
        proof: true,
        configuration: false,
        seal: false,
        ledger: false,
        entries: false,
        funding: false,
      },
    ]);
  } finally {
    await p.end();
  }
});

it.each(['login-group', 'mixed-group', 'configuration-grant'])(
  'opened PAPER store fails closed after current execution %s mutation',
  async (kind) => {
    const f = await fixture(),
      h = await open(),
      login = new URL(required('DATABASE_EXECUTION_URL')).username;
    if (!/^[a-z0-9_]+$/.test(login)) throw new Error('ROLE_FIXTURE_INVALID');
    const mutate =
      kind === 'login-group'
        ? 'ALTER ROLE ctp_execution LOGIN'
        : kind === 'mixed-group'
          ? `GRANT ctp_paper_configuration TO "${login}"`
          : `GRANT SELECT ON ctp_paper.configuration TO "${login}"`;
    const restore =
      kind === 'login-group'
        ? 'ALTER ROLE ctp_execution NOLOGIN'
        : kind === 'mixed-group'
          ? `REVOKE ctp_paper_configuration FROM "${login}"`
          : `REVOKE SELECT ON ctp_paper.configuration FROM "${login}"`;
    const before = await inspect(f);
    try {
      await admin.query(mutate);
      await expect(h.findCreate(f.binding, f.draft, io())).rejects.toThrow(
        'ORDER_PAPER_ROLE_UNSAFE',
      );
      expect(await inspect(f)).toEqual(before);
    } finally {
      await admin.query(restore);
    }
    expect(await h.findCreate(f.binding, f.draft, io())).toBeNull();
  },
);

it('PAPER account-lock abort settles physical operation and leaves the pool reusable without draft effects', async () => {
  const f = await fixture(),
    h = await open(),
    p = await admin.connect(),
    controller = new AbortController(),
    before = await inspect(f);
  try {
    await p.query('BEGIN');
    await p.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.binding.accountId,
    ]);
    const pending = h.create(f.binding, f.draft, {
      signal: controller.signal,
      deadline: Date.now() + 1000,
    });
    const rejected = expect(pending).rejects.toThrow('ORDER_ABORTED');
    await wait(30);
    controller.abort();
    await rejected;
    await p.query('ROLLBACK');
    expect(await inspect(f)).toEqual(before);
    expect((await h.create(f.binding, f.draft, io())).command.clientOrderId).toBe('1');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
});

it('PAPER account-lock deadline settles without an explicit abort and preserves durable draft identity', async () => {
  const f = await fixture(),
    h = await open(),
    p = await admin.connect(),
    before = await inspect(f);
  try {
    await p.query('BEGIN');
    await p.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.binding.accountId,
    ]);
    const signal = new AbortController().signal;
    await expect(
      h.create(f.binding, f.draft, { signal, deadline: Date.now() + 150 }),
    ).rejects.toThrow('ORDER_ABORTED');
    expect(signal.aborted).toBe(false);
    await p.query('ROLLBACK');
    expect(await inspect(f)).toEqual(before);
    expect((await h.create(f.binding, f.draft, io())).command.clientOrderId).toBe('1');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
});
