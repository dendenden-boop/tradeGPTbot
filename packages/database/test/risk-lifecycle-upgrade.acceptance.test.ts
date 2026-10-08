import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool, type PoolClient } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { computeCommandHash } from '@ctp/exchange-core';
import { canonical, createPostgresPortfolioStore } from '@ctp/portfolio';
import { createPostgresOrderStore } from '@ctp/order-engine';
import { createPostgresMarketSnapshots } from '@ctp/market-data';
import {
  createPostgresOrderRiskPort,
  createPostgresPolicies,
  createPostgresLossJournal,
  createPostgresRiskObservations,
} from '@ctp/risk-engine';
import { seedRiskCertification } from './fixtures/risk-certification.js';
import { order as nativeFixture } from '../../exchange-core/test/fixtures/adapter.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_UPGRADE_RUNNER_REQUIRED');
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error('ISOLATED_UPGRADE_VARIABLE_REQUIRED');
  return value;
};
const options = (name: string) => ({
  connectionString: required(name),
  environment: 'test' as const,
});
const targetUrl = new URL(required('DATABASE_PHASE12_UPGRADE_URL'));
if (
  targetUrl.hostname !== '127.0.0.1' ||
  !/^\/ctp_p2_lifecycle_[a-f0-9]{12}$/.test(targetUrl.pathname)
)
  throw new Error('ISOLATED_UPGRADE_DATABASE_REQUIRED');
const admin = new Pool({ ...options('DATABASE_MIGRATION_URL'), max: 1, query_timeout: 5000 }),
  target = new Pool({ connectionString: targetUrl.href, max: 1, query_timeout: 5000 });
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await Promise.all([admin.end(), target.end()]);
});
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
// Explicit dependency order; no credentials, user SQL or unrelated tenant rows.
const tenantTables = [
  'public.exchange_account',
  'public.exchange_connection',
  'public.risk_profile',
  'public.account_state_version',
  'public.risk_budget',
  'public.order_intent',
  'public.order',
  'ctp_execution.command',
  'ctp_execution.progress',
  'ctp_execution.evidence',
  'public.order_event',
  'public.risk_decision',
  'public.risk_reservation',
  'public.submission_attempt',
  'public.ledger_transaction',
  'public.ledger_entry',
  'ctp_portfolio.book',
  'ctp_portfolio.evidence',
  'ctp_portfolio.hold_watermark',
  'ctp_portfolio.outbox',
  'ctp_certification.identity',
  'ctp_certification.identity_head',
  'ctp_certification.certificate',
  'ctp_certification.certificate_head',
  'ctp_certification.observation',
  'ctp_certification.observation_head',
  'ctp_admission.preparation',
  'ctp_admission.issuance',
  'public.outbox_event',
] as const;
const tableName = (table: string) => {
  if (!/^[a-z_]+\.[a-z_]+$/.test(table)) throw new Error('UPGRADE_TABLE');
  return table
    .split('.')
    .map((x) => `"${x}"`)
    .join('.');
};
async function rows(client: Pool | PoolClient, table: string, filter: string, values: string[]) {
  return (
    await client.query<{ payload: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text AS payload FROM ${tableName(table)} r WHERE ${filter}`,
      values,
    )
  ).rows[0]!.payload;
}
async function copy(transaction: PoolClient, table: string, filter: string, values: string[]) {
  const payload = await rows(admin, table, filter, values);
  const columns = (
    await transaction.query<{ name: string }>(
      "SELECT attname AS name FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum",
      [table],
    )
  ).rows
    .map((r) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name)) throw new Error('UPGRADE_COLUMN');
      return `"${r.name}"`;
    })
    .join(',');
  // PostgreSQL consumes its original JSON text: numeric counters never round
  // through JavaScript Number, and existing evidence bytes/hashes are unchanged.
  await transaction.query(
    `INSERT INTO ${tableName(table)}(${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${tableName(table)},$1::jsonb)`,
    [payload],
  );
}
it('populated published 19 upgrades without rewriting proof and recovers legacy UNKNOWN once after restart', async () => {
  expect(
    (
      await target.query<{ n: number }>(
        'SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      )
    ).rows[0]?.n,
  ).toBe(19);
  const portfolio = await createPostgresPortfolioStore(options('DATABASE_PORTFOLIO_URL')),
    orders = await createPostgresOrderStore(options('DATABASE_EXECUTION_URL')),
    market = await createPostgresMarketSnapshots(options('DATABASE_MARKET_SNAPSHOT_URL')),
    platform = await createPostgresPolicies({
      ...options('DATABASE_RISK_POLICY_OPERATOR_URL'),
      authority: 'PLATFORM',
    }),
    user = await createPostgresPolicies({
      ...options('DATABASE_RISK_POLICY_CONTROLLER_URL'),
      authority: 'USER',
    }),
    loss = await createPostgresLossJournal(options('DATABASE_RISK_EVIDENCE_URL')),
    observer = await createPostgresRiskObservations(options('DATABASE_RISK_OBSERVATION_URL')),
    risk = await createPostgresOrderRiskPort(options('DATABASE_RISK_ADMISSION_URL'));
  handles.push(portfolio, orders, market, platform, user, loss, observer, risk);
  const current = (
    await admin.query<{ epoch: string }>(
      "SELECT epoch::text FROM ctp_risk.global_head WHERE kind='KILL_SWITCH' AND key='kill'",
    )
  ).rows[0]!;
  await admin.query('SELECT ctp_risk.update_global($1::jsonb)', [
    JSON.stringify({
      scope: { kind: 'GLOBAL' },
      kind: 'KILL_SWITCH',
      key: 'kill',
      state: 'RUNNING',
      eventId: randomUUID(),
      expectedEpoch: current.epoch,
      reason: 'ISOLATED_POPULATED_UPGRADE',
      evidenceHash: 'a'.repeat(64),
    }),
  ]);
  const f = await seedRiskCertification({
      admin,
      portfolio,
      orders,
      market,
      platform,
      user,
      loss,
      observer,
      registryOptions: options('DATABASE_INSTRUMENT_REGISTRY_URL'),
    }),
    s = f.created,
    b = s.binding,
    commandHash = computeCommandHash('createOrder', s.command, {
      profile: b.profile,
      account: {
        tenantId: b.tenantId,
        connectionId: b.connectionId,
        externalAccountId: b.externalAccountId,
      },
    }),
    grant = await risk.approve(
      { binding: b, state: { id: s.id }, intentId: s.intentId, operation: 'PLACE', commandHash },
      io(),
    ),
    claim = await orders.begin(b, s.id, s.intentId, grant, io());
  if (!claim) throw new Error('UPGRADE_CLAIM_REQUIRED');
  // No network operation: UNKNOWN is deliberately conservative crash evidence.
  await orders.result(b, claim, { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } }, io());
  const native = {
    ...nativeFixture,
    account: {
      tenantId: b.tenantId,
      connectionId: b.connectionId,
      externalAccountId: b.externalAccountId,
    },
    scope: f.risk.record.instrument.scope,
    instrumentId: s.command.instrumentId,
    clientOrderId: s.command.clientOrderId,
    exchangeOrderId: `upgrade-${s.id}`,
    createdAt: s.createdAt,
    updatedAt: Date.now(),
    status: 'CANCELED',
    quantity: s.command.size.value,
    price: { state: 'AVAILABLE', value: s.command.limitPrice },
    filledQuantity: '0',
    averageFillPrice: { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' },
    fees: [],
  };
  const transaction = await target.connect();
  try {
    await transaction.query('BEGIN');
    await transaction.query("SELECT set_config('app.tenant_id',$1,true)", [b.tenantId]);
    await copy(transaction, 'public.user', 'r.id=$1::uuid', [b.tenantId]);
    await copy(transaction, 'public.instrument', 'r.id=$1::uuid', [f.key.dbInstrumentId]);
    await copy(transaction, 'public.instrument_rule_version', 'r.id=$1::uuid', [f.key.dbRuleId]);
    await copy(transaction, 'public.capability_snapshot', 'r.id=$1::uuid', [f.key.dbCapabilityId]);
    for (const table of tenantTables)
      await copy(transaction, table, 'r."tenantId"=$1::uuid', [b.tenantId]);
    // This body is not stored in published 19: only its permanent native hash.
    await transaction.query(
      'INSERT INTO ctp_execution.evidence("tenantId","orderId",identity,fingerprint) VALUES($1,$2,$3,$4)',
      [
        b.tenantId,
        s.id,
        `native:${native.updatedAt}`,
        createHash('sha256')
          .update(canonical({ type: 'NATIVE', order: native }))
          .digest(),
      ],
    );
    await transaction.query(
      'UPDATE public."order" SET status=\'CANCELED\',"reconciliationState"=\'CONSISTENT\',"exchangeOrderId"=$3,version=version+1,"lastExchangeAt"=to_timestamp($4::double precision/1000),"terminalAt"=now(),"updatedAt"=now() WHERE "tenantId"=$1 AND id=$2',
      [b.tenantId, s.id, native.exchangeOrderId, native.updatedAt],
    );
    await transaction.query(
      'UPDATE ctp_execution.progress SET "nativeAt"=$3,"nativeHash"=$4,"nativeStatus"=\'CANCELED\' WHERE "tenantId"=$1 AND "orderId"=$2',
      [b.tenantId, s.id, native.updatedAt, createHash('sha256').update(canonical(native)).digest()],
    );
    await transaction.query(
      'UPDATE public.submission_attempt SET status=\'RECONCILED\',"resolvedAt"=now() WHERE "tenantId"=$1 AND id=$2',
      [b.tenantId, claim.attemptId],
    );
    await transaction.query('COMMIT');
  } finally {
    await transaction.query('ROLLBACK').catch(() => {});
    transaction.release();
  }
  const before = new Map<string, string>();
  for (const table of tenantTables)
    before.set(table, await rows(target, table, 'r."tenantId"=$1::uuid', [b.tenantId]));
  for (const table of [
    'ctp_certification.certificate',
    'ctp_admission.preparation',
    'ctp_admission.issuance',
    'ctp_portfolio.book',
    'ctp_portfolio.hold_watermark',
  ])
    expect(before.get(table)).not.toBe('[]');
  expect(
    (
      await target.query<{ status: string }>(
        'SELECT status::text FROM public.risk_reservation WHERE id=$1',
        [grant.reservationId],
      )
    ).rows[0]?.status,
  ).toBe('UNRESOLVED');
  expect(
    (
      await target.query<{ missing: boolean }>(
        "SELECT to_regclass('ctp_execution.authoritative_event') IS NULL AS missing",
      )
    ).rows[0]?.missing,
  ).toBe(true);
  const prisma = createRequire(new URL('../package.json', import.meta.url)).resolve(
    'prisma/build/index.js',
  );
  try {
    await promisify(execFile)(
      process.execPath,
      [prisma, 'migrate', 'deploy', '--config', 'packages/database/prisma.config.ts'],
      {
        env: { ...process.env, DATABASE_MIGRATION_URL: targetUrl.href },
        timeout: 30000,
      },
    );
  } catch {
    throw new Error('POPULATED_UPGRADE_DEPLOY_FAILED');
  }
  for (const table of tenantTables)
    expect(await rows(target, table, 'r."tenantId"=$1::uuid', [b.tenantId])).toBe(
      before.get(table),
    );
  const restarted = await createPostgresOrderStore(
    options('DATABASE_PHASE12_UPGRADE_EXECUTION_URL'),
  );
  handles.push(restarted);
  expect((await restarted.findCreate(b, s.draft, io()))?.id).toBe(s.id);
  await restarted.complete(b, s.id, native, io());
  const released = await rows(target, 'public.risk_reservation', 'r."tenantId"=$1::uuid', [
    b.tenantId,
  ]);
  expect(
    (
      await target.query<{ status: string }>(
        'SELECT status::text FROM public.risk_reservation WHERE id=$1',
        [grant.reservationId],
      )
    ).rows[0]?.status,
  ).toBe('RELEASED');
  const afterHold = await rows(target, 'ctp_portfolio.hold_watermark', 'r."tenantId"=$1::uuid', [
    b.tenantId,
  ]);
  expect(
    (
      await target.query<{ released: boolean }>(
        'SELECT released FROM ctp_portfolio.hold_watermark WHERE "tenantId"=$1 AND "holdId"=$2',
        [b.tenantId, grant.reservationId],
      )
    ).rows[0]?.released,
  ).toBe(true);
  await restarted.close();
  const again = await createPostgresOrderStore(options('DATABASE_PHASE12_UPGRADE_EXECUTION_URL'));
  handles.push(again);
  await again.complete(b, s.id, native, io());
  expect(await rows(target, 'public.risk_reservation', 'r."tenantId"=$1::uuid', [b.tenantId])).toBe(
    released,
  );
  expect(
    await rows(target, 'ctp_portfolio.hold_watermark', 'r."tenantId"=$1::uuid', [b.tenantId]),
  ).toBe(afterHold);
  for (const table of [
    'ctp_certification.certificate',
    'ctp_admission.preparation',
    'ctp_admission.issuance',
    'public.order_intent',
    'ctp_execution.command',
    'public.ledger_transaction',
    'public.ledger_entry',
    'public.exchange_account',
  ])
    expect(await rows(target, table, 'r."tenantId"=$1::uuid', [b.tenantId])).toBe(
      before.get(table),
    );
});
