import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPostgresPortfolioStore, type Binding, type PortfolioStore } from '@ctp/portfolio';
import {
  createPostgresRiskPortfolioReader,
  type RiskPortfolioReader,
  type RiskPortfolioScope,
} from '@ctp/risk-engine';
import { binding, snapshot } from '../../portfolio/test/fixtures.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('Portfolio source tests require isolated runner');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('Missing isolated source variable');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const rawReader = new Pool({
  connectionString: required('DATABASE_RISK_SNAPSHOT_URL'),
  max: 2,
  query_timeout: 5000,
});
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
const open = () =>
  createPostgresRiskPortfolioReader({
    connectionString: required('DATABASE_RISK_SNAPSHOT_URL'),
    environment: 'test',
  });
let reader: RiskPortfolioReader, portfolio: PortfolioStore;
beforeAll(async () => {
  reader = await open();
  portfolio = await createPostgresPortfolioStore({
    connectionString: required('DATABASE_PORTFOLIO_URL'),
    environment: 'test',
  });
});
afterAll(async () => {
  await reader?.close();
  await portfolio?.close();
  await rawReader.end();
  await admin.end();
});
async function fixture(mode: Binding['mode'] = 'TESTNET', existingTenant?: string) {
  const b: Binding = {
    ...binding(),
    tenantId: existingTenant ?? randomUUID(),
    accountId: randomUUID(),
    connectionId: randomUUID(),
    mode,
    scope: { ...binding().scope, environment: mode === 'DEMO' ? 'DEMO' : 'TESTNET' },
  };
  b.externalAccountId = b.accountId;
  if (!existingTenant)
    await admin.query(
      'INSERT INTO public."user"(id,"emailNormalized","updatedAt") VALUES($1,$2,now())',
      [b.tenantId, b.tenantId + '@example.invalid'],
    );
  await admin.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,'BINANCE',$3,$1::uuid::text,'global','SPOT','DISABLED','risk-source',now())`,
    [b.accountId, b.tenantId, mode],
  );
  await admin.query(
    `INSERT INTO public.exchange_connection(id,"tenantId","accountId",mode,label,status,permissions,"updatedAt") VALUES($1,$2,$3,$4,'source','DISABLED','{}',now())`,
    [b.connectionId, b.tenantId, b.accountId, mode],
  );
  await portfolio.apply(b, snapshot({ id: randomUUID(), timestamp: Date.now() }), 0, io());
  const scope: RiskPortfolioScope = {
    tenantId: b.tenantId,
    mode,
    targetAccountId: b.accountId,
    maxEvidenceAgeMs: 5000,
  };
  return { b, scope };
}
async function direct(p: unknown, tenantId: string) {
  const c = await rawReader.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    return await c.query('SELECT ctp_risk.capture_portfolio($1::jsonb) AS result', [
      JSON.stringify(p),
    ]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
it('reads all owned accounts/native Portfolio books and stable durable revisions across reader restart', async () => {
  const f = await fixture(),
    peer = await fixture('TESTNET', f.b.tenantId);
  const ledgerBefore = (
    await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.ledger_transaction WHERE "tenantId"=$1',
      [f.b.tenantId],
    )
  ).rows[0]!.n;
  await portfolio.apply(
    f.b,
    {
      type: 'COMMITMENT',
      id: randomUUID(),
      timestamp: Date.now(),
      hold: { id: 'unknown', asset: 'USDT', amount: '10', status: 'UNKNOWN', reflected: false },
    },
    1,
    io(),
  );
  const first = await reader.read(f.scope, io());
  expect(first.accounts.map((a) => a.id).sort()).toEqual([f.b.accountId, peer.b.accountId].sort());
  expect(first.books.find((b) => b.accountId === f.b.accountId)?.state.holds[0]?.status).toBe(
    'UNKNOWN',
  );
  const restart = await open();
  try {
    expect(await restart.read(f.scope, io())).toEqual(first);
  } finally {
    await restart.close();
  }
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.ledger_transaction WHERE "tenantId"=$1',
        [f.b.tenantId],
      )
    ).rows[0]!.n,
  ).toBe(ledgerBefore);
  expect(first).not.toHaveProperty('complete');
  expect(first).not.toHaveProperty('decisionId');
});
it('keeps TESTNET and DEMO inventories separate without hiding peers in the same mode', async () => {
  const f = await fixture(),
    demo = await fixture('DEMO', f.b.tenantId);
  expect((await reader.read(f.scope, io())).accounts.map((a) => a.id)).toEqual([f.b.accountId]);
  expect((await reader.read(demo.scope, io())).accounts.map((a) => a.id)).toEqual([
    demo.b.accountId,
  ]);
  await expect(
    reader.read({ ...demo.scope, targetAccountId: f.b.accountId }, io()),
  ).rejects.toThrow('RISK_PORTFOLIO_SCOPE');
});
it('does not omit missing or unreconciled owned peer books', async () => {
  const f = await fixture(),
    peer = await fixture('TESTNET', f.b.tenantId);
  await portfolio.apply(peer.b, { type: 'GAP', id: randomUUID(), timestamp: Date.now() }, 1, io());
  await expect(reader.read(f.scope, io())).rejects.toThrow('RISK_PORTFOLIO_INCOMPLETE');
  const checkpoint = await portfolio.read(peer.b, io());
  await portfolio.apply(
    peer.b,
    snapshot({ id: randomUUID(), timestamp: Date.now(), repairFrom: checkpoint.state.snapshotId! }),
    checkpoint.revision,
    io(),
  );
  expect((await reader.read(f.scope, io())).accounts).toHaveLength(2);
  // Never delete financial history; exercise a missing book with an additional owned account.
  const id = randomUUID();
  await admin.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,'BINANCE','TESTNET',$1::uuid::text,'global','SPOT','DISABLED','missing',now())`,
    [id, f.b.tenantId],
  );
  await expect(reader.read({ ...f.scope, targetAccountId: id }, io())).rejects.toThrow(
    'RISK_PORTFOLIO_INCOMPLETE',
  );
});
it('cannot select another tenant account or bypass context with a forged payload', async () => {
  const f = await fixture(),
    other = await fixture();
  await expect(
    reader.read({ ...f.scope, targetAccountId: other.b.accountId }, io()),
  ).rejects.toThrow('RISK_PORTFOLIO_SCOPE');
  await expect(direct(f.scope, other.b.tenantId)).rejects.toThrow('RISK_PORTFOLIO_SCOPE');
  await expect(direct({ ...f.scope, complete: true }, f.b.tenantId)).rejects.toThrow(
    'RISK_PORTFOLIO_INPUT',
  );
});
it('rejects SQL-owned checkpoint binding replacement with another connection', async () => {
  const f = await fixture(),
    other = await fixture();
  await admin.query(
    `UPDATE ctp_portfolio.book SET state=jsonb_set(state::jsonb,'{binding,connectionId}',to_jsonb($2::text))::text,state_hash=sha256(convert_to(jsonb_set(state::jsonb,'{binding,connectionId}',to_jsonb($2::text))::text,'UTF8')) WHERE "tenantId"=$1`,
    [f.b.tenantId, other.b.connectionId],
  );
  await expect(reader.read(f.scope, io())).rejects.toThrow('RISK_PORTFOLIO_CORRUPT');
});
it('rejects a resurrected hold whose durable watermark is RELEASED', async () => {
  const f = await fixture();
  await portfolio.apply(
    f.b,
    {
      type: 'COMMITMENT',
      id: randomUUID(),
      timestamp: Date.now(),
      hold: { id: 'hold', asset: 'USDT', amount: '10', status: 'RESERVED', reflected: false },
    },
    1,
    io(),
  );
  const before = (
    await admin.query<{ state: string }>(
      'SELECT state FROM ctp_portfolio.book WHERE "tenantId"=$1',
      [f.b.tenantId],
    )
  ).rows[0]!;
  await new Promise((resolve) => setTimeout(resolve, 2));
  await portfolio.apply(
    f.b,
    { type: 'RELEASE', id: randomUUID(), timestamp: Date.now(), holdId: 'hold', resolved: true },
    2,
    io(),
  );
  await admin.query(
    'UPDATE ctp_portfolio.book SET state=$2,state_hash=sha256(convert_to($2,\'UTF8\')),revision=revision+1 WHERE "tenantId"=$1',
    [f.b.tenantId, before.state],
  );
  await expect(reader.read(f.scope, io())).rejects.toThrow('RISK_PORTFOLIO_HOLD_HISTORY');
});
it('rejects changed active hold amount against the durable COMMITMENT fingerprint', async () => {
  const f = await fixture();
  await portfolio.apply(
    f.b,
    {
      type: 'COMMITMENT',
      id: randomUUID(),
      timestamp: Date.now(),
      hold: { id: 'hold', asset: 'USDT', amount: '10', status: 'RESERVED', reflected: false },
    },
    1,
    io(),
  );
  expect((await reader.read(f.scope, io())).books[0]?.state.holds[0]?.amount).toBe('10');
  await admin.query(
    `UPDATE ctp_portfolio.book SET state=jsonb_set(state::jsonb,'{holds,0,amount}','"1"'::jsonb)::text,state_hash=sha256(convert_to(jsonb_set(state::jsonb,'{holds,0,amount}','"1"'::jsonb)::text,'UTF8')),revision=revision+1 WHERE "tenantId"=$1`,
    [f.b.tenantId],
  );
  await expect(reader.read(f.scope, io())).rejects.toThrow('RISK_PORTFOLIO_HOLD_HISTORY');
});
it.each(['abort', 'deadline'] as const)(
  'settles native blocked Portfolio read on %s and releases underlying connection/locks',
  async (kind) => {
    const f = await fixture(),
      blocker = await admin.connect(),
      controller = new AbortController();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM ctp_portfolio.book WHERE "tenantId"=$1 FOR UPDATE', [
      f.b.tenantId,
    ]);
    const timer = kind === 'abort' ? setTimeout(() => controller.abort(), 100) : undefined;
    const started = Date.now();
    try {
      await expect(
        reader.read(f.scope, io(controller.signal, kind === 'deadline' ? 100 : 2500)),
      ).rejects.toThrow('RISK_PORTFOLIO_ABORTED');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      clearTimeout(timer);
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await reader.read(f.scope, io())).books).toHaveLength(1);
  },
);
it('fails closed on 101 owned accounts without silently truncating inventory', async () => {
  const f = await fixture();
  await admin.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") SELECT gen_random_uuid(),$1,'BINANCE','TESTNET','peer-'||n,'global','SPOT','DISABLED','capacity',now() FROM generate_series(1,100)n`,
    [f.b.tenantId],
  );
  await expect(reader.read(f.scope, io())).rejects.toThrow('RISK_PORTFOLIO_CAPACITY');
});
it('rejects writer/admin/other authority credentials at startup', async () => {
  for (const key of [
    'DATABASE_MIGRATION_URL',
    'DATABASE_RUNTIME_URL',
    'DATABASE_AUTH_URL',
    'DATABASE_PORTFOLIO_URL',
    'DATABASE_EXECUTION_URL',
    'DATABASE_RISK_EVIDENCE_URL',
    'DATABASE_MARKET_SNAPSHOT_URL',
  ])
    await expect(
      createPostgresRiskPortfolioReader({ connectionString: required(key), environment: 'test' }),
    ).rejects.toThrow('RISK_PORTFOLIO_ROLE_UNSAFE');
});
it.each([
  'SELECT ON public.exchange_account',
  'UPDATE(amount) ON public.risk_reservation',
  'EXECUTE ON FUNCTION ctp_risk.read_global()',
] as const)('rejects added %s privilege at startup', async (privilege) => {
  const role = new URL(required('DATABASE_RISK_SNAPSHOT_URL')).username;
  if (!/^[a-z0-9_]+$/.test(role)) throw new Error('Unexpected isolated role');
  await admin.query(`GRANT ${privilege} TO "${role}"`);
  try {
    await expect(open()).rejects.toThrow('RISK_PORTFOLIO_ROLE_UNSAFE');
  } finally {
    await admin.query(`REVOKE ${privilege} FROM "${role}"`);
  }
});
it('has no direct read/write permission on financial, credentials or Portfolio authority tables', async () => {
  for (const table of [
    'public.risk_reservation',
    'public.encrypted_credential',
    'public.ledger_transaction',
    'ctp_portfolio.book',
  ])
    await expect(rawReader.query(`SELECT * FROM ${table} LIMIT 0`)).rejects.toThrow(
      /permission denied/,
    );
  await expect(rawReader.query('SELECT ctp_risk.read_global()')).rejects.toThrow(
    /permission denied/,
  );
});
it('rereads native permission/state epochs losslessly without inventing permission or healthy admission', async () => {
  const f = await fixture();
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"=9007199254740993,"reconciliationEpoch"=9007199254740994 WHERE id=$1',
    [f.b.accountId],
  );
  const source = await reader.read(f.scope, io());
  expect(source.accounts[0]).toMatchObject({
    permissionEpoch: '9007199254740993',
    reconciliationEpoch: '9007199254740994',
    status: 'DISABLED',
  });
  expect(source).not.toHaveProperty('tradeAllowed');
  expect(source).not.toHaveProperty('health');
});
it('rejects original snapshot staleness even when checkpoint storage/update time is new', async () => {
  const f = await fixture();
  await admin.query(
    `UPDATE ctp_portfolio.book SET state=jsonb_set(state::jsonb,'{snapshotAt}',to_jsonb($2::bigint))::text,state_hash=sha256(convert_to(jsonb_set(state::jsonb,'{snapshotAt}',to_jsonb($2::bigint))::text,'UTF8')),revision=revision+1 WHERE "tenantId"=$1`,
    [f.b.tenantId, Date.now() - 6000],
  );
  await expect(reader.read(f.scope, io())).rejects.toThrow('RISK_PORTFOLIO_INCOMPLETE');
});
it('rejects additional authority membership even when the reader function remains granted', async () => {
  const role = new URL(required('DATABASE_RISK_SNAPSHOT_URL')).username;
  if (!/^[a-z0-9_]+$/.test(role)) throw new Error('Unexpected isolated role');
  await admin.query(`GRANT ctp_execution TO "${role}"`);
  try {
    await expect(open()).rejects.toThrow('RISK_PORTFOLIO_ROLE_UNSAFE');
  } finally {
    await admin.query(`REVOKE ctp_execution FROM "${role}"`);
  }
});
