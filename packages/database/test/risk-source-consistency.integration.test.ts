import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAuthDatabase, createDatabase } from '@ctp/database';
import {
  canonical,
  createState,
  createPostgresPortfolioStore,
  type PortfolioStore,
} from '@ctp/portfolio';
import { binding, snapshot } from '../../portfolio/test/fixtures.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_CONSISTENCY_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_CONSISTENCY_VARIABLE_REQUIRED');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const source = new Pool({
  connectionString: required('DATABASE_RISK_SNAPSHOT_URL'),
  max: 1,
  query_timeout: 5000,
});
let portfolio: PortfolioStore;
beforeAll(async () => {
  portfolio = await createPostgresPortfolioStore({
    connectionString: required('DATABASE_PORTFOLIO_URL'),
    environment: 'test',
  });
});
afterAll(async () => {
  await portfolio?.close();
  await source.end();
  await admin.end();
});

it.each([
  'ACCOUNT_INSERT',
  'ACCOUNT_MODE',
  'CONNECTION_INSERT',
  'CONNECTION_UPDATE',
  'BOOK_INSERT',
  'PORTFOLIO_WRITER',
] as const)('freezes %s until the certified source transaction settles', async (change) => {
  const b = {
    ...binding(),
    tenantId: randomUUID(),
    accountId: randomUUID(),
    connectionId: randomUUID(),
    mode: 'TESTNET' as const,
  };
  b.externalAccountId = b.accountId;
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized","updatedAt") VALUES($1,$2,now())',
    [b.tenantId, b.tenantId + '@example.invalid'],
  );
  await admin.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt")
    VALUES($1,$2,'BINANCE','TESTNET',$1::uuid::text,'global','SPOT','DISABLED','consistency',now())`,
    [b.accountId, b.tenantId],
  );
  await admin.query(
    `INSERT INTO public.exchange_connection(id,"tenantId","accountId",mode,label,status,permissions,"updatedAt")
    VALUES($1,$2,$3,'TESTNET','source','DISABLED','{}',now())`,
    [b.connectionId, b.tenantId, b.accountId],
  );
  await portfolio.apply(b, snapshot({ id: randomUUID(), timestamp: Date.now() }), 0, {
    signal: new AbortController().signal,
    deadline: Date.now() + 2500,
  });
  const peer = randomUUID();
  await admin.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt")
    VALUES($1,$2,'BINANCE','DEMO',$1::uuid::text,'global','SPOT','DISABLED','peer',now())`,
    [peer, b.tenantId],
  );
  const reader = await source.connect(),
    writer = await admin.connect();
  let pending: Promise<unknown> | undefined,
    finished = false;
  try {
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await reader.query("SELECT set_config('app.tenant_id',$1,true)", [b.tenantId]);
    const capture = await reader.query<{ result: { accounts: { id: string }[] } }>(
      'SELECT ctp_risk.capture_portfolio($1::jsonb) AS result',
      [
        JSON.stringify({
          tenantId: b.tenantId,
          mode: 'TESTNET',
          targetAccountId: b.accountId,
          maxEvidenceAgeMs: 5000,
        }),
      ],
    );
    expect(capture.rows[0]!.result.accounts.map((a) => a.id)).toEqual([b.accountId]);
    const rpid = (await reader.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    let wpid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const mutations = {
      ACCOUNT_INSERT: {
        sql: `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt")
      VALUES($1,$2,'BINANCE','TESTNET',$1::uuid::text,'global','SPOT','DISABLED','peer',now())`,
        values: [randomUUID(), b.tenantId],
      },
      ACCOUNT_MODE: {
        sql: "UPDATE public.exchange_account SET mode='TESTNET' WHERE id=$1",
        values: [peer],
      },
      CONNECTION_INSERT: {
        sql: `INSERT INTO public.exchange_connection(id,"tenantId","accountId",mode,label,status,permissions,"updatedAt") VALUES($1,$2,$3,'TESTNET','peer','DISABLED','{}',now())`,
        values: [randomUUID(), b.tenantId, b.accountId],
      },
      CONNECTION_UPDATE: {
        sql: 'UPDATE public.exchange_connection SET "permissionsVersion"="permissionsVersion"+1 WHERE id=$1',
        values: [b.connectionId],
      },
      BOOK_INSERT: {
        sql: 'INSERT INTO ctp_portfolio.book("tenantId","accountId",mode,wallet,state,state_hash) VALUES($1,$2,\'TESTNET\',$3,$4,sha256(convert_to($4,\'UTF8\')))',
        values: [
          b.tenantId,
          b.accountId,
          'peer-wallet',
          canonical(createState({ ...b, walletId: 'peer-wallet' })),
        ],
      },
    };
    const hold = {
      type: 'COMMITMENT' as const,
      id: randomUUID(),
      timestamp: Date.now(),
      hold: {
        id: randomUUID(),
        asset: 'USDT',
        amount: '10',
        status: 'UNKNOWN' as const,
        reflected: false,
      },
    };
    pending = (
      change === 'PORTFOLIO_WRITER'
        ? portfolio.apply(b, hold, 1, {
            signal: new AbortController().signal,
            deadline: Date.now() + 2500,
          })
        : writer.query(mutations[change].sql, mutations[change].values)
    ).finally(() => {
      finished = true;
    });
    void pending.catch(() => {});
    let blockers: number[] = [];
    const deadline = Date.now() + 500;
    while (!finished && !blockers.includes(rpid) && Date.now() < deadline) {
      if (change === 'PORTFOLIO_WRITER') {
        const observed = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory' AND $2=ANY(pg_blocking_pids(pid))",
          [new URL(required('DATABASE_PORTFOLIO_URL')).username, rpid],
        );
        wpid = observed.rows[0]?.pid ?? wpid;
      }
      blockers = (
        await admin.query<{ ids: number[] }>('SELECT pg_blocking_pids($1) AS ids', [wpid])
      ).rows[0]!.ids;
      if (!blockers.includes(rpid)) await new Promise((r) => setTimeout(r, 5));
    }
    expect(finished).toBe(false);
    expect(blockers).toContain(rpid);
    await reader.query('COMMIT');
    await pending;
    expect(finished).toBe(true);
    if (change === 'PORTFOLIO_WRITER') {
      const replay = await portfolio.apply(b, hold, 1, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      });
      expect(replay.duplicate).toBe(true);
      expect(replay.checkpoint.revision).toBe(2);
      expect(replay.checkpoint.state.holds).toEqual([hold.hold]);
      expect(
        (
          await admin.query('SELECT id FROM public.ledger_transaction WHERE "tenantId"=$1', [
            b.tenantId,
          ])
        ).rows,
      ).toHaveLength(1);
    }
  } finally {
    await reader.query('ROLLBACK');
    await pending?.catch(() => {});
    reader.release();
    writer.release();
  }
});

it.each(['UPDATE(state)', 'TRIGGER', 'REFERENCES(state)'])(
  'API refuses %s on its private read table',
  async (privilege) => {
    const options = {
      connectionString: required('DATABASE_RUNTIME_URL'),
      environment: 'test' as const,
    };
    const baseline = await createDatabase(options);
    await baseline.close();
    await admin.query(`GRANT ${privilege} ON ctp_portfolio.book TO ctp_api`);
    try {
      let accepted = false;
      try {
        const db = await createDatabase(options);
        accepted = true;
        await db.close();
      } catch {
        /* Baseline is mandatory. */
      }
      expect(accepted).toBe(false);
    } finally {
      await admin.query(`REVOKE ${privilege} ON ctp_portfolio.book FROM ctp_api`);
    }
  },
);

it('enters the API tenant transaction callback only after GLOBAL then tenant acquisition', async () => {
  const tenant = randomUUID();
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized","updatedAt") VALUES($1,$2,now())',
    [tenant, tenant + '@example.invalid'],
  );
  const database = await createDatabase({
    connectionString: required('DATABASE_RUNTIME_URL'),
    environment: 'test',
  });
  const holder = await admin.connect();
  let pending: Promise<unknown> | undefined,
    entered = false;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock_shared(1129599058,12)');
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('ctp:risk:'||$1::text,0))", [
      tenant,
    ]);
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    pending = database.withTenant(tenant, () => {
      entered = true;
      return Promise.resolve(1);
    });
    void pending.catch(() => {});
    let blocked = false;
    const deadline = Date.now() + 500;
    while (!entered && !blocked && Date.now() < deadline) {
      blocked = (
        await admin.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))) AS blocked",
          [pid],
        )
      ).rows[0]!.blocked;
      if (!blocked) await new Promise((r) => setTimeout(r, 5));
    }
    expect(entered).toBe(false);
    expect(blocked).toBe(true);
    await holder.query('COMMIT');
    await expect(pending).resolves.toBe(1);
    expect(entered).toBe(true);
  } finally {
    await holder.query('ROLLBACK');
    await pending?.catch(() => {});
    holder.release();
    await database.close();
  }
});

it.each([
  [
    'private function',
    'GRANT EXECUTE ON FUNCTION ctp_registry.publish(jsonb,jsonb) TO ctp_auth_owner',
    'REVOKE EXECUTE ON FUNCTION ctp_registry.publish(jsonb,jsonb) FROM ctp_auth_owner',
  ],
  [
    'private column',
    'GRANT SELECT(record) ON ctp_registry.current_record TO ctp_auth_owner',
    'REVOKE SELECT(record) ON ctp_registry.current_record FROM ctp_auth_owner',
  ],
  [
    'later schema CREATE',
    'GRANT CREATE ON SCHEMA ctp_registry TO ctp_auth_owner',
    'REVOKE CREATE ON SCHEMA ctp_registry FROM ctp_auth_owner',
  ],
])('Auth refuses %s authority on its SECURITY DEFINER owner', async (_kind, grant, revoke) => {
  const options = { connectionString: required('DATABASE_AUTH_URL'), environment: 'test' as const };
  const positive = await createAuthDatabase(options);
  await positive.close();
  await admin.query(grant);
  let accepted = false;
  try {
    try {
      const db = await createAuthDatabase(options);
      accepted = true;
      await db.close();
    } catch {
      /* Exact positive baseline prevents treating a broken factory as safe. */
    }
    expect(accepted).toBe(false);
  } finally {
    await admin.query(revoke);
  }
});
