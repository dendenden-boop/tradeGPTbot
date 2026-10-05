import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  createPostgresControls,
  type PostgresControls,
  type ControlScope,
  type ControlUpdate,
} from '@ctp/risk-engine';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('Risk tests require isolated runner');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('Missing isolated risk variable');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const execution = new Pool({
  connectionString: required('DATABASE_EXECUTION_URL'),
  max: 2,
  query_timeout: 2500,
});
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
const open = (authority: 'GLOBAL' | 'TENANT') =>
  createPostgresControls({
    connectionString: required(
      authority === 'GLOBAL' ? 'DATABASE_RISK_OPERATOR_URL' : 'DATABASE_RISK_CONTROL_URL',
    ),
    environment: 'test',
    authority,
  });
let controls: PostgresControls, operator: PostgresControls;
beforeAll(async () => {
  controls = await open('TENANT');
  operator = await open('GLOBAL');
});
afterAll(async () => {
  await controls?.close();
  await operator?.close();
  await admin.end();
  await execution.end();
});
const update = (
  scope: ControlScope,
  expectedEpoch = '0',
  state: ControlUpdate['state'] = 'PAUSED',
): ControlUpdate => ({
  scope,
  kind: 'KILL_SWITCH',
  key: 'kill',
  state,
  eventId: randomUUID(),
  expectedEpoch,
  reason: 'TEST_EVIDENCE',
  evidenceHash: 'a'.repeat(64),
});
async function fixture() {
  const tenantId = randomUUID(),
    accountId = randomUUID(),
    connectionId = randomUUID();
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized","updatedAt") VALUES($1,$2,now())',
    [tenantId, tenantId + '@example.invalid'],
  );
  await admin.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1::uuid,$2,'BINANCE','TESTNET',$1::text,'global','SPOT','ACTIVE','risk-fixture',now())`,
    [accountId, tenantId],
  );
  await admin.query(
    `INSERT INTO public.exchange_connection(id,"tenantId","accountId",mode,label,status,permissions,"permissionsVerifiedAt","updatedAt") VALUES($1,$2,$3,'TESTNET','risk-fixture','ACTIVE','{"trade":true}',now(),now())`,
    [connectionId, tenantId, accountId],
  );
  return {
    tenantId,
    accountId,
    connectionId,
    scope: { kind: 'USER' as const, tenantId, targetId: tenantId },
  };
}
async function gate(tenantId: string, connectionId: string | null) {
  const p = await execution.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const r = await p.query<{ allowed: boolean }>(
      'SELECT ctp_risk.dispatch_gate($1,$2) AS allowed',
      [tenantId, connectionId],
    );
    await p.query('COMMIT');
    return r.rows[0]?.allowed;
  } finally {
    await p.query('ROLLBACK').catch(() => {});
    p.release();
  }
}
async function resumeGlobal() {
  const h = (await operator.read(null, io())).find((h) => h.kind === 'KILL_SWITCH');
  if (!h) throw new Error('Missing global gate');
  if (h.state !== 'RUNNING')
    await operator.update(update({ kind: 'GLOBAL' }, h.epoch, 'RUNNING'), io());
}
async function waitForAdvisoryWaiter() {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const r = await admin.query<{ waiting: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`,
    );
    if (r.rows[0]?.waiting) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Expected actual PostgreSQL advisory lock waiter');
}
it('durable A→B→A epochs and permanent replay survive restart', async () => {
  const f = await fixture(),
    first = update(f.scope);
  expect(await controls.update(first, io())).toEqual({
    epoch: '1',
    state: 'PAUSED',
    replayed: false,
  });
  expect(await controls.update(update(f.scope, '1', 'RUNNING'), io())).toMatchObject({
    epoch: '2',
  });
  expect(await controls.update(update(f.scope, '2'), io())).toMatchObject({ epoch: '3' });
  const restarted = await open('TENANT');
  try {
    expect(await restarted.update(first, io())).toEqual({
      epoch: '1',
      state: 'PAUSED',
      replayed: true,
    });
    expect(
      (await restarted.read(f.tenantId, io())).find((h) => h.scope.kind === 'USER'),
    ).toMatchObject({ epoch: '3', state: 'PAUSED' });
    await expect(restarted.update(update(f.scope, '1', 'RUNNING'), io())).rejects.toThrow(
      'RISK_CONTROL_STALE',
    );
    await expect(restarted.update({ ...first, state: 'RUNNING' }, io())).rejects.toThrow(
      'RISK_CONTROL_CONFLICT',
    );
  } finally {
    await restarted.close();
  }
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM ctp_risk.tenant_event WHERE "tenantId"=$1',
        [f.tenantId],
      )
    ).rows[0]?.n,
  ).toBe(3);
});
it('concurrent compare-and-swap cannot lose a newer pause', async () => {
  const f = await fixture();
  await controls.update(update(f.scope), io());
  const r = await Promise.allSettled([
    controls.update(update(f.scope, '1', 'RUNNING'), io()),
    controls.update(update(f.scope, '1'), io()),
  ]);
  expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
  expect((await controls.read(f.tenantId, io())).find((h) => h.scope.kind === 'USER')?.epoch).toBe(
    '2',
  );
});
it('scope ownership and global operator authority are enforced in SQL and service', async () => {
  const a = await fixture(),
    b = await fixture();
  await expect(
    controls.update(
      update({ kind: 'CONNECTION', tenantId: a.tenantId, targetId: b.connectionId }),
      io(),
    ),
  ).rejects.toThrow('RISK_CONTROL_SCOPE');
  await expect(controls.update(update({ kind: 'GLOBAL' }), io())).rejects.toThrow(
    'RISK_CONTROL_AUTHORITY',
  );
  await expect(operator.update(update(a.scope), io())).rejects.toThrow('RISK_CONTROL_AUTHORITY');
  const raw = new Pool({ connectionString: required('DATABASE_RISK_CONTROL_URL') });
  const p = await raw.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    await expect(
      p.query('SELECT ctp_risk.update_tenant($1::jsonb)', [JSON.stringify(update(b.scope))]),
    ).rejects.toMatchObject({ message: 'RISK_CONTROL_SCOPE' });
    await p.query('ROLLBACK');
    await expect(
      p.query('SELECT ctp_risk.update_global($1::jsonb)', [
        JSON.stringify(update({ kind: 'GLOBAL' })),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(p.query("UPDATE ctp_risk.global_head SET state='RUNNING'")).rejects.toMatchObject({
      code: '42501',
    });
  } finally {
    p.release();
    await raw.end();
  }
});
it('new global pause blocks every tenant; its stale resume cannot reopen after restart', async () => {
  const f = await fixture();
  await resumeGlobal();
  expect(await gate(f.tenantId, f.connectionId)).toBe(true);
  const h = (await operator.read(null, io())).find((h) => h.kind === 'KILL_SWITCH');
  if (!h) throw new Error('Missing head');
  const r = await operator.update(update({ kind: 'GLOBAL' }, h.epoch), io());
  try {
    expect(await gate(f.tenantId, f.connectionId)).toBe(false);
    await expect(
      operator.update(update({ kind: 'GLOBAL' }, h.epoch, 'RUNNING'), io()),
    ).rejects.toThrow('RISK_CONTROL_STALE');
    const restarted = await open('GLOBAL');
    try {
      expect(
        (await restarted.read(null, io())).find((h) => h.kind === 'KILL_SWITCH'),
      ).toMatchObject({ epoch: r.epoch, state: 'PAUSED' });
    } finally {
      await restarted.close();
    }
  } finally {
    await resumeGlobal();
  }
});
it('connection pause does not affect a different connection or tenant', async () => {
  await resumeGlobal();
  const a = await fixture(),
    b = await fixture();
  const secondConnection = randomUUID();
  await admin.query(
    `INSERT INTO public.exchange_connection(id,"tenantId","accountId",mode,label,status,permissions,"permissionsVerifiedAt","updatedAt") VALUES($1,$2,$3,'TESTNET','second-connection','ACTIVE','{"trade":true}',now(),now())`,
    [secondConnection, a.tenantId, a.accountId],
  );
  await controls.update(
    update({ kind: 'CONNECTION', tenantId: a.tenantId, targetId: a.connectionId }),
    io(),
  );
  expect(await gate(a.tenantId, a.connectionId)).toBe(false);
  expect(await gate(b.tenantId, b.connectionId)).toBe(true);
  expect(await gate(a.tenantId, b.connectionId)).toBe(false);
  expect(await gate(a.tenantId, secondConnection)).toBe(true);
});
it('an owned blocked strategy closes unclassified dispatch, with cross-tenant rejection', async () => {
  await resumeGlobal();
  const a = await fixture(),
    b = await fixture(),
    definition = randomUUID(),
    profile = randomUUID(),
    strategy = randomUUID();
  await admin.query(
    `INSERT INTO public.strategy_definition(id,key,version,name,description,"implementationHash","parameterSchemaVersion","minimumWarmupBars","allowedMarkets") VALUES($1::uuid,$1::text,1,'test','test',$2,1,0,ARRAY['SPOT']::public."MarketType"[])`,
    [definition, Buffer.alloc(32, 1)],
  );
  await admin.query(
    `INSERT INTO public.risk_profile(id,"tenantId",name,version,"policyHash","valuationAsset","maxNotional","maxDailyLoss","maxDrawdownRate","maxOpenOrders",policy,"effectiveAt") VALUES($1::uuid,$2,$1::text,1,$3,'USDT',10000,100,0.2,5,'{}',now())`,
    [profile, a.tenantId, Buffer.alloc(32, 1)],
  );
  await admin.query(
    `INSERT INTO public.strategy_instance(id,"tenantId","accountId",mode,"definitionId","riskProfileId",label,parameters,"instrumentSelection","selectionHash","updatedAt") VALUES($1,$2,$3,'TESTNET',$4,$5,'test','{}','[]',$6,now())`,
    [strategy, a.tenantId, a.accountId, definition, profile, Buffer.alloc(32, 1)],
  );
  const request = update({ kind: 'STRATEGY', tenantId: a.tenantId, targetId: strategy });
  await expect(
    controls.update(
      {
        ...request,
        scope: { ...request.scope, kind: 'STRATEGY', tenantId: b.tenantId, targetId: strategy },
      },
      io(),
    ),
  ).rejects.toThrow('RISK_CONTROL_SCOPE');
  await controls.update(request, io());
  expect(await gate(a.tenantId, a.connectionId)).toBe(false);
  expect(await gate(b.tenantId, b.connectionId)).toBe(true);
});
it('global circuit replay and HALF_OPEN retain state across restart', async () => {
  await resumeGlobal();
  const f = await fixture(),
    request = {
      ...update({ kind: 'GLOBAL' }),
      kind: 'CIRCUIT' as const,
      key: 'test_database',
      state: 'OPEN' as const,
    };
  await operator.update(request, io());
  try {
    expect(await gate(f.tenantId, f.connectionId)).toBe(false);
    await operator.update(
      { ...request, eventId: randomUUID(), expectedEpoch: '1', state: 'HALF_OPEN' },
      io(),
    );
    const restarted = await open('GLOBAL');
    try {
      expect(await restarted.update(request, io())).toMatchObject({ epoch: '1', replayed: true });
      expect((await restarted.read(null, io())).find((h) => h.key === request.key)).toMatchObject({
        epoch: '2',
        state: 'HALF_OPEN',
      });
    } finally {
      await restarted.close();
    }
    expect(await gate(f.tenantId, f.connectionId)).toBe(false);
  } finally {
    await operator.update(
      { ...request, eventId: randomUUID(), expectedEpoch: '2', state: 'CLOSED' },
      io(),
    );
  }
});
it('SQL bigint epochs remain lossless above JS safe integer precision', async () => {
  const f = await fixture();
  // Administrative seed models a long-lived pre-existing durable head, not a runtime writer.
  await admin.query(
    `INSERT INTO ctp_risk.tenant_head("tenantId",scope,target,kind,key,state,epoch) VALUES($1,'USER',$1,'KILL_SWITCH','kill','PAUSED',9007199254740993)`,
    [f.tenantId],
  );
  const result = await controls.update(update(f.scope, '9007199254740993', 'RUNNING'), io());
  expect(result.epoch).toBe('9007199254740994');
  expect((await controls.read(f.tenantId, io())).find((h) => h.scope.kind === 'USER')?.epoch).toBe(
    result.epoch,
  );
});
it('existing public pauses and circuits remain conservative blockers', async () => {
  await resumeGlobal();
  const a = await fixture(),
    b = await fixture();
  await admin.query(
    `INSERT INTO public.trading_pause("tenantId",scope,"scopeKey",epoch,"reasonCode",initiator,"pausedAt") VALUES($1::uuid,'USER',$1::text,1,'TEST_PAUSE','test',now())`,
    [a.tenantId],
  );
  await admin.query(
    `INSERT INTO public.circuit_state("tenantId",scope,"scopeKey","circuitKey",status,"reasonCode","updatedAt") VALUES($1::uuid,'USER',$1::text,'test','HALF_OPEN','TEST_CIRCUIT',now())`,
    [b.tenantId],
  );
  expect(await gate(a.tenantId, a.connectionId)).toBe(false);
  expect(await gate(b.tenantId, b.connectionId)).toBe(false);
});
it.each(['OPEN', 'HALF_OPEN'] as const)('%s circuit cannot authorize a mutation', async (state) => {
  await resumeGlobal();
  const f = await fixture();
  const request = { ...update(f.scope), kind: 'CIRCUIT' as const, key: 'private_ws', state };
  await controls.update(request, io());
  expect(await gate(f.tenantId, f.connectionId)).toBe(false);
  await controls.update(
    { ...request, eventId: randomUUID(), expectedEpoch: '1', state: 'CLOSED' },
    io(),
  );
  expect(await gate(f.tenantId, f.connectionId)).toBe(true);
});
it('immutable SQL watermarks forbid deletion, epoch regression and event rewrites', async () => {
  const f = await fixture();
  await controls.update(update(f.scope), io());
  for (const sql of [
    'DELETE FROM ctp_risk.tenant_head WHERE "tenantId"=$1',
    'UPDATE ctp_risk.tenant_head SET epoch=epoch-1 WHERE "tenantId"=$1',
    'UPDATE ctp_risk.tenant_head SET target=gen_random_uuid(),epoch=epoch+1 WHERE "tenantId"=$1',
    'UPDATE ctp_risk.tenant_event SET epoch=epoch+1 WHERE "tenantId"=$1',
    'DELETE FROM ctp_risk.tenant_event WHERE "tenantId"=$1',
  ])
    await expect(admin.query(sql, [f.tenantId])).rejects.toMatchObject({ code: '23514' });
});
it.each(['abort', 'deadline'] as const)(
  'physical SQL gate lock settles on %s and frees pool',
  async (mode) => {
    const f = await fixture(),
      locker = await admin.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT pg_advisory_xact_lock(1129599058,12)');
    const controller = new AbortController(),
      timer = mode === 'abort' ? setTimeout(() => controller.abort(), 50) : undefined,
      start = Date.now();
    try {
      await expect(
        controls.update(update(f.scope), io(controller.signal, mode === 'abort' ? 2000 : 50)),
      ).rejects.toThrow('RISK_CONTROL_ABORTED');
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      if (timer) clearTimeout(timer);
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect(await controls.update(update(f.scope), io())).toMatchObject({ epoch: '1' });
    expect(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM ctp_risk.tenant_event WHERE "tenantId"=$1',
          [f.tenantId],
        )
      ).rows[0]?.n,
    ).toBe(1);
  },
);
it('pause transaction waits for earlier dispatch gate until permit transaction commits', async () => {
  await resumeGlobal();
  const f = await fixture(),
    p = await execution.connect();
  await p.query('BEGIN');
  await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenantId]);
  expect(
    (
      await p.query<{ allowed: boolean }>('SELECT ctp_risk.dispatch_gate($1,$2) AS allowed', [
        f.tenantId,
        f.connectionId,
      ])
    ).rows[0]?.allowed,
  ).toBe(true);
  let settled = false;
  const pause = controls.update(update(f.scope), io()).finally(() => {
    settled = true;
  });
  try {
    await waitForAdvisoryWaiter();
    expect(settled).toBe(false);
    await p.query('COMMIT');
    expect(await pause).toMatchObject({ epoch: '1' });
  } finally {
    await p.query('ROLLBACK').catch(() => {});
    p.release();
    await pause.catch(() => {});
  }
  expect(await gate(f.tenantId, f.connectionId)).toBe(false);
});
it.each(['trading_pause', 'circuit_state'] as const)(
  'legacy %s writes share final gate ordering',
  async (table) => {
    await resumeGlobal();
    const f = await fixture(),
      p = await execution.connect();
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenantId]);
    await p.query('SELECT ctp_risk.dispatch_gate($1,$2)', [f.tenantId, f.connectionId]);
    const sql =
      table === 'trading_pause'
        ? `INSERT INTO public.trading_pause("tenantId",scope,"scopeKey",epoch,"reasonCode",initiator,"pausedAt") VALUES($1::uuid,'USER',$1::text,1,'TEST_PAUSE','test',now())`
        : `INSERT INTO public.circuit_state("tenantId",scope,"scopeKey","circuitKey",status,"reasonCode","updatedAt") VALUES($1::uuid,'USER',$1::text,'test','OPEN','TEST_CIRCUIT',now())`;
    let settled = false;
    const pause = admin.query(sql, [f.tenantId]).finally(() => {
      settled = true;
    });
    try {
      await waitForAdvisoryWaiter();
      expect(settled).toBe(false);
      await p.query('COMMIT');
      await pause;
    } finally {
      await p.query('ROLLBACK').catch(() => {});
      p.release();
      await pause.catch(() => {});
    }
    expect(await gate(f.tenantId, f.connectionId)).toBe(false);
  },
);
it.each([
  'DATABASE_MIGRATION_URL',
  'DATABASE_RUNTIME_URL',
  'DATABASE_EXECUTION_URL',
  'DATABASE_PORTFOLIO_URL',
  'DATABASE_AUTH_URL',
  'DATABASE_INGEST_URL',
  'DATABASE_RISK_OPERATOR_URL',
])('rejects non-controller role %s', async (key) => {
  await expect(
    createPostgresControls({
      connectionString: required(key),
      environment: 'test',
      authority: 'TENANT',
    }),
  ).rejects.toThrow('RISK_CONTROL_ROLE_UNSAFE');
});
