import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
} from '@ctp/paper-engine/configuration';
import { createPostgresPaperFunding, paperFundingSchema } from '@ctp/paper-engine/funding';
import { fixture as modelFixture } from '../../paper-engine/test/fixtures.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import { createPostgresControls } from '@ctp/risk-engine';

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
  connectionString: required('DATABASE_PAPER_FUNDING_URL'),
  max: 2,
  query_timeout: 5000,
});
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await direct.end();
  await admin.end();
});
async function open(connectionString = required('DATABASE_PAPER_FUNDING_URL')) {
  const h = await createPostgresPaperFunding({ connectionString, environment: 'test' });
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
  if (mode === 'PAPER') {
    const config = await createPostgresPaperConfiguration({
      connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
      environment: 'test',
    });
    try {
      await config.register(c, io());
    } finally {
      await config.close();
    }
  }
  return paperFundingSchema.parse({
    id: randomUUID(),
    configurationId: c.id,
    owner: c.owner,
    balances: [
      { asset: 'BTC', amount: '0.000000000000000001' },
      { asset: 'USDT', amount: '9007199254740993' },
    ],
  });
}
async function ledger(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await admin.query<{ asset: string; bucket: string; amount: string; entryIndex: number }>(
      `SELECT asset,bucket,amount::text,"entryIndex" FROM public.ledger_entry WHERE "transactionId"=$1 ORDER BY "entryIndex"`,
      [f.id],
    )
  ).rows;
}
it('concurrent exact funding, restart and replay produce one common ledger effect and no orders/reservations', async () => {
  const f = await fixture(),
    store = await open();
  const controlsBefore = (await admin.query('SELECT * FROM ctp_risk.global_head ORDER BY kind,key'))
    .rows;
  const [a, b] = await Promise.all([store.initialize(f, io()), store.initialize(f, io())]);
  expect(a).toEqual(b);
  expect(a.ledgerTransactionId).toBe(f.id);
  await store.close();
  const restarted = await open();
  expect(await restarted.read(f.owner, io())).toEqual(a);
  expect(await restarted.initialize(f, io())).toEqual(a);
  expect(await ledger(f)).toEqual([
    { asset: 'BTC', bucket: 'AVAILABLE', amount: '0.000000000000000001', entryIndex: 0 },
    { asset: 'BTC', bucket: 'EXTERNAL', amount: '-0.000000000000000001', entryIndex: 1 },
    { asset: 'USDT', bucket: 'AVAILABLE', amount: '9007199254740993', entryIndex: 2 },
    { asset: 'USDT', bucket: 'EXTERNAL', amount: '-9007199254740993', entryIndex: 3 },
  ]);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM public.ledger_transaction WHERE "accountId"=$1',
        [f.owner.accountId],
      )
    ).rows[0]?.n,
  ).toBe(1);
  expect(
    (
      await admin.query(
        'SELECT asset,sum(amount)::text total FROM public.ledger_entry WHERE "transactionId"=$1 GROUP BY asset',
        [f.id],
      )
    ).rows.every((r: { total: string }) => Number(r.total) === 0),
  ).toBe(true);
  for (const table of [
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
          [f.owner.tenantId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  expect((await admin.query('SELECT * FROM ctp_risk.global_head ORDER BY kind,key')).rows).toEqual(
    controlsBefore,
  );
});
it('initial funding while GLOBAL PAUSED neither resumes controls nor authorizes orders', async () => {
  const f = await fixture(),
    store = await open();
  const operator = await createPostgresControls({
    connectionString: required('DATABASE_RISK_OPERATOR_URL'),
    environment: 'test',
    authority: 'GLOBAL',
  });
  try {
    const previous = (await operator.read(null, io())).find((c) => c.kind === 'KILL_SWITCH')!;
    await operator.update(
      {
        scope: { kind: 'GLOBAL' },
        kind: 'KILL_SWITCH',
        key: 'kill',
        state: 'PAUSED',
        expectedEpoch: previous.epoch,
        eventId: randomUUID(),
        reason: 'PAPER_FUNDING_PAUSE_CONTRACT',
        evidenceHash: 'b'.repeat(64),
      },
      io(),
    );
    try {
      const paused = await operator.read(null, io());
      await store.initialize(f, io());
      expect(await operator.read(null, io())).toEqual(paused);
      expect(await ledger(f)).toHaveLength(4);
    } finally {
      const current = (await operator.read(null, io())).find((c) => c.kind === 'KILL_SWITCH')!;
      await operator.update(
        {
          scope: { kind: 'GLOBAL' },
          kind: 'KILL_SWITCH',
          key: 'kill',
          state: previous.state,
          expectedEpoch: current.epoch,
          eventId: randomUUID(),
          reason: 'PAPER_FUNDING_PAUSE_RESTORE',
          evidenceHash: 'b'.repeat(64),
        },
        io(),
      );
    }
  } finally {
    await operator.close();
  }
});
it('competing funding IDs serialize on account and cannot double seed', async () => {
  const f = await fixture(),
    store = await open();
  const results = await Promise.allSettled([
    store.initialize(f, io()),
    store.initialize({ ...f, id: randomUUID() }, io()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM public.ledger_entry WHERE "accountId"=$1',
        [f.owner.accountId],
      )
    ).rows[0]?.n,
  ).toBe(4);
});
it.each(['id', 'configurationId', 'balances'] as const)(
  'permanent funding rejects %s change after restart',
  async (key) => {
    const f = await fixture(),
      store = await open(),
      accepted = await store.initialize(f, io());
    await store.close();
    const restarted = await open();
    const changed =
      key === 'balances'
        ? {
            ...f,
            balances: paperFundingSchema.parse({
              ...f,
              balances: [{ asset: 'USDT', amount: '2000' }],
            }).balances,
          }
        : { ...f, [key]: randomUUID() };
    await expect(restarted.initialize(changed, io())).rejects.toThrow('PAPER_FUNDING_CONFLICT');
    expect(await restarted.read(f.owner, io())).toEqual(accepted);
    expect(await ledger(f)).toHaveLength(4);
  },
);
it('one global funding ID cannot move across account or tenant', async () => {
  const a = await fixture(),
    b = await fixture(),
    store = await open();
  await store.initialize(a, io());
  await expect(store.initialize({ ...b, id: a.id }, io())).rejects.toThrow(
    'PAPER_FUNDING_CONFLICT',
  );
  expect(await ledger(b)).toHaveLength(0);
});
it.each(['TESTNET', 'DEMO', 'LIVE'])('native %s destination is never funded', async (mode) => {
  const f = await fixture(mode),
    store = await open();
  await expect(store.initialize(f, io())).rejects.toThrow('PAPER_FUNDING_MISSING');
  expect(await ledger(f)).toHaveLength(0);
});
it('missing receipt and wrong tenant fail closed; SQL requires exact tenant context', async () => {
  const f = await fixture(),
    other = await fixture(),
    store = await open();
  await expect(store.read(f.owner, io())).rejects.toThrow('PAPER_FUNDING_MISSING');
  await store.initialize(f, io());
  await expect(store.read({ ...f.owner, tenantId: other.owner.tenantId }, io())).rejects.toThrow(
    'PAPER_FUNDING_MISSING',
  );
  await expect(
    direct.query('SELECT ctp_paper.initialize_funding($1)', [JSON.stringify(other)]),
  ).rejects.toThrow('PAPER_FUNDING_OWNERSHIP');
});
it.each(['status', 'region', 'exchange', 'externalAccountId', 'clientIdEpoch'] as const)(
  'current %s change cannot seed or export old authority',
  async (key) => {
    const f = await fixture(),
      store = await open();
    await store.initialize(f, io());
    const changed = {
      status: 'DISABLED',
      region: 'other',
      exchange: 'OKX',
      externalAccountId: 'other-account',
      clientIdEpoch: 'other-epoch',
    }[key];
    await admin.query(`UPDATE public.exchange_account SET "${key}"=$1 WHERE id=$2`, [
      changed,
      f.owner.accountId,
    ]);
    await expect(store.read(f.owner, io())).rejects.toThrow('PAPER_FUNDING_OWNERSHIP');
    await expect(store.initialize(f, io())).rejects.toThrow('PAPER_FUNDING_OWNERSHIP');
  },
);
it.each(['SUSPENDED', 'UNVERIFIED'])('%s tenant cannot seed', async (kind) => {
  const f = await fixture(),
    store = await open();
  await admin.query(
    kind === 'SUSPENDED'
      ? 'UPDATE public."user" SET status=\'SUSPENDED\' WHERE id=$1'
      : 'UPDATE public."user" SET "emailVerifiedAt"=NULL WHERE id=$1',
    [f.owner.tenantId],
  );
  await expect(store.initialize(f, io())).rejects.toThrow('PAPER_FUNDING_OWNERSHIP');
  expect(await ledger(f)).toHaveLength(0);
});
it.each(['UPDATE', 'DELETE', 'TRUNCATE'])(
  'funding and original seal reject %s',
  async (operation) => {
    const f = await fixture(),
      store = await open();
    await store.initialize(f, io());
    for (const table of ['initial_funding', 'funding_seal'])
      await expect(
        admin.query(
          operation === 'TRUNCATE'
            ? `TRUNCATE ctp_paper.${table}`
            : operation === 'UPDATE'
              ? `UPDATE ctp_paper.${table} SET id=id WHERE id=$1`
              : `DELETE FROM ctp_paper.${table} WHERE id=$1`,
          operation === 'TRUNCATE' ? [] : [f.id],
        ),
      ).rejects.toThrow();
  },
);
it.each([
  { balances: [] },
  { balances: [{ asset: 'USDT', amount: '0' }] },
  { balances: [{ asset: 'USDT', amount: '1.0' }] },
  { balances: [{ asset: 'USDT', amount: '1e3' }] },
  { balances: [{ asset: 'USDT', amount: '1', bucket: 'EQUITY' }] },
  {
    balances: [
      { asset: 'USDT', amount: '1' },
      { asset: 'BTC', amount: '1' },
    ],
  },
  {
    balances: [
      { asset: 'USDT', amount: '1' },
      { asset: 'USDT', amount: '1' },
    ],
  },
  { resetEpoch: 1 },
  { balances: [{ asset: 'USDT', amount: '100000000000000000000' }] },
  { owner: { tenantId: randomUUID(), accountId: randomUUID(), mode: 'LIVE' } },
])('SQL independently rejects unsafe funding %#', async (change) => {
  const f = await fixture(),
    p = await direct.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.owner.tenantId]);
    await expect(
      p.query('SELECT ctp_paper.initialize_funding($1)', [JSON.stringify({ ...f, ...change })]),
    ).rejects.toThrow('PAPER_FUNDING_INPUT');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  expect(await ledger(f)).toHaveLength(0);
});
it('unproven pre-existing public seed is not adopted or credited a second time', async () => {
  const f = await fixture(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.owner.tenantId]);
    await p.query(
      `INSERT INTO public.ledger_transaction(id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode") VALUES($1,$2,$3,'PAPER','PAPER_SEED','unproven',now(),'UNPROVEN')`,
      [f.id, f.owner.tenantId, f.owner.accountId],
    );
    await p.query(
      `INSERT INTO public.ledger_entry("tenantId","transactionId","accountId",mode,"entryIndex",asset,bucket,amount) VALUES($1,$2,$3,'PAPER',0,'USDT','AVAILABLE',10),($1,$2,$3,'PAPER',1,'USDT','EXTERNAL',-10)`,
      [f.owner.tenantId, f.id, f.owner.accountId],
    );
    await p.query('COMMIT');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  const store = await open();
  await expect(store.initialize(f, io())).rejects.toThrow('PAPER_FUNDING_CONFLICT');
  await expect(store.read(f.owner, io())).rejects.toThrow('PAPER_FUNDING_MISSING');
  expect(await ledger(f)).toHaveLength(2);
});
it('closed common seed posting rejects appended effects', async () => {
  const f = await fixture(),
    store = await open();
  await store.initialize(f, io());
  const p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.owner.tenantId]);
    await expect(
      p.query(
        `INSERT INTO public.ledger_entry("tenantId","transactionId","accountId",mode,"entryIndex",asset,bucket,amount) VALUES($1,$2,$3,'PAPER',4,'USDT','AVAILABLE',10)`,
        [f.owner.tenantId, f.id, f.owner.accountId],
      ),
    ).rejects.toThrow('A closed ledger posting');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  expect(await ledger(f)).toHaveLength(4);
});
it('physically lost acknowledged COMMIT recovers one ledger effect after restart without retry', async () => {
  const f = await fixture(),
    proxy = await registryCommitProxy(required('DATABASE_PAPER_FUNDING_URL'), 'PAPER_FUNDING'),
    store = await open(proxy.connectionString);
  proxy.arm();
  try {
    await expect(store.initialize(f, io())).rejects.toThrow('PAPER_FUNDING_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await store.close();
    const restarted = await open(),
      r = await restarted.read(f.owner, io());
    expect(await restarted.initialize(f, io())).toEqual(r);
    expect(await ledger(f)).toHaveLength(4);
  } finally {
    await proxy.close();
  }
});
it.each(['abort', 'deadline'] as const)(
  'hung account lock %s settles and cannot fund',
  async (kind) => {
    const f = await fixture(),
      store = await open(),
      lock = await admin.connect(),
      controller = new AbortController();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
        f.owner.accountId,
      ]);
      const pending = store
        .initialize(f, io(controller.signal, kind === 'deadline' ? 100 : 2500))
        .then(
          () => 'unexpected',
          (e: unknown) => (e instanceof Error ? e.message : 'unknown'),
        );
      await wait(50);
      if (kind === 'abort') controller.abort();
      expect(await pending).toBe('PAPER_FUNDING_ABORTED');
      await lock.query('ROLLBACK');
      await wait(50);
      expect(await ledger(f)).toHaveLength(0);
      expect((await store.initialize(f, io())).funding).toEqual(f);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  },
);
it('four physical pending slots bound work and all become reusable after abort', async () => {
  const f = await fixture(),
    store = await open(),
    lock = await admin.connect(),
    controller = new AbortController();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.owner.accountId,
    ]);
    const jobs = Array.from({ length: 4 }, () =>
      store.initialize(f, io(controller.signal)).then(
        () => 'unexpected',
        (e: unknown) => (e instanceof Error ? e.message : 'unknown'),
      ),
    );
    await wait(50);
    await expect(store.initialize(f, io())).rejects.toThrow('PAPER_FUNDING_BUSY');
    controller.abort();
    expect(await Promise.all(jobs)).toEqual(
      Array.from({ length: 4 }, () => 'PAPER_FUNDING_ABORTED'),
    );
    await lock.query('ROLLBACK');
    await wait(50);
    expect((await store.initialize(f, io())).funding).toEqual(f);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
});
it('SQL denies grouping role made LOGIN after startup', async () => {
  const f = await fixture(),
    store = await open();
  await admin.query('ALTER ROLE ctp_paper_funding LOGIN');
  try {
    await expect(store.initialize(f, io())).rejects.toThrow('PAPER_FUNDING_ROLE_UNSAFE');
  } finally {
    await admin.query('ALTER ROLE ctp_paper_funding NOLOGIN');
  }
  expect(await ledger(f)).toHaveLength(0);
});
it.each(['configuration', 'receipt', 'coherent-rewrite', 'ledger', 'seal'] as const)(
  'corrupt %s after restart is not reconstructed into authority',
  async (part) => {
    const f = await fixture(),
      store = await open();
    await store.initialize(f, io());
    await store.close();
    const original = (
      await admin.query<{ receipt_text: string; request: unknown }>(
        'SELECT receipt_text,request FROM ctp_paper.initial_funding WHERE id=$1',
        [f.id],
      )
    ).rows[0]!;
    const originalConfig = (
      await admin.query<{ receipt_text: string }>(
        'SELECT receipt_text FROM ctp_paper.configuration WHERE id=$1',
        [f.configurationId],
      )
    ).rows[0]!.receipt_text;
    const originalSeal = (
      await admin.query<{ receipt_hash: Buffer }>(
        'SELECT receipt_hash FROM ctp_paper.funding_seal WHERE id=$1',
        [f.id],
      )
    ).rows[0]!.receipt_hash;
    const p = await admin.connect();
    try {
      await p.query('BEGIN');
      await p.query("SET LOCAL session_replication_role='replica'");
      if (part === 'configuration')
        await p.query(
          `UPDATE ctp_paper.configuration SET receipt_text=jsonb_set(receipt_text::jsonb,'{configuration,model,takerFeeRate}','"0.002"')::text WHERE id=$1`,
          [f.configurationId],
        );
      else if (part === 'receipt' || part === 'coherent-rewrite') {
        await p.query(
          `UPDATE ctp_paper.initial_funding SET receipt_text=jsonb_set(receipt_text::jsonb,'{funding,balances,1,amount}','"2000"')::text WHERE id=$1`,
          [f.id],
        );
        if (part === 'coherent-rewrite')
          await p.query(
            `UPDATE ctp_paper.initial_funding SET request=jsonb_set(request,'{balances,1,amount}','"2000"') WHERE id=$1`,
            [f.id],
          );
      } else if (part === 'ledger')
        await p.query(
          `UPDATE public.ledger_entry SET amount=CASE WHEN bucket='AVAILABLE' THEN 2000 ELSE -2000 END WHERE "transactionId"=$1 AND asset='USDT'`,
          [f.id],
        );
      else await p.query('DELETE FROM ctp_paper.funding_seal WHERE id=$1', [f.id]);
      await p.query('COMMIT');
      const restarted = await open();
      await expect(restarted.read(f.owner, io())).rejects.toThrow('PAPER_FUNDING_CORRUPT');
    } finally {
      await p.query('ROLLBACK');
      await p.query('BEGIN');
      await p.query("SET LOCAL session_replication_role='replica'");
      await p.query(
        'UPDATE ctp_paper.initial_funding SET receipt_text=$2,request=$3::jsonb WHERE id=$1',
        [f.id, original.receipt_text, JSON.stringify(original.request)],
      );
      await p.query('UPDATE ctp_paper.configuration SET receipt_text=$2 WHERE id=$1', [
        f.configurationId,
        originalConfig,
      ]);
      if (part === 'ledger')
        await p.query(
          `UPDATE public.ledger_entry SET amount=CASE WHEN bucket='AVAILABLE' THEN $2::numeric ELSE -$2::numeric END WHERE "transactionId"=$1 AND asset='USDT'`,
          [f.id, f.balances[1]!.amount],
        );
      if (part === 'seal')
        await p.query(
          'INSERT INTO ctp_paper.funding_seal(id,tenant_id,account_id,receipt_hash) VALUES($1,$2,$3,$4)',
          [f.id, f.owner.tenantId, f.owner.accountId, originalSeal],
        );
      await p.query('COMMIT');
      p.release();
    }
  },
);
