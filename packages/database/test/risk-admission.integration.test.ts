import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { computeCommandHash, parseDecimal } from '@ctp/exchange-core';
import { createPostgresPortfolioStore, type PortfolioStore } from '@ctp/portfolio';
import { createPostgresOrderStore, type OrderStore } from '@ctp/order-engine';
import { createPostgresMarketSnapshots, type DurableMarketSnapshots } from '@ctp/market-data';
import {
  createPostgresOrderRiskPort,
  createPostgresRiskObservations,
  createPostgresPolicies,
  createPostgresLossJournal,
  createPostgresControls,
  type PostgresPolicies,
} from '@ctp/risk-engine';
import { seedRiskCertification } from './fixtures/risk-certification.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_ADMISSION_RUNNER_REQUIRED');
const options = (key: string) => {
  const connectionString = process.env[key];
  if (!connectionString) throw new Error('ISOLATED_ADMISSION_VARIABLE_REQUIRED');
  return { connectionString, environment: 'test' as const };
};
const admin = new Pool({ ...options('DATABASE_MIGRATION_URL'), max: 3, query_timeout: 5000 });
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
let portfolio: PortfolioStore,
  orders: OrderStore,
  market: DurableMarketSnapshots,
  platform: PostgresPolicies,
  user: PostgresPolicies,
  loss: Awaited<ReturnType<typeof createPostgresLossJournal>>,
  observer: Awaited<ReturnType<typeof createPostgresRiskObservations>>;
const handles: { close(): Promise<void> }[] = [];
beforeAll(async () => {
  portfolio = await createPostgresPortfolioStore(options('DATABASE_PORTFOLIO_URL'));
  orders = await createPostgresOrderStore(options('DATABASE_EXECUTION_URL'));
  market = await createPostgresMarketSnapshots(options('DATABASE_MARKET_SNAPSHOT_URL'));
  platform = await createPostgresPolicies({
    ...options('DATABASE_RISK_POLICY_OPERATOR_URL'), authority: 'PLATFORM',
  });
  user = await createPostgresPolicies({
    ...options('DATABASE_RISK_POLICY_CONTROLLER_URL'), authority: 'USER',
  });
  loss = await createPostgresLossJournal(options('DATABASE_RISK_EVIDENCE_URL'));
  observer = await createPostgresRiskObservations(options('DATABASE_RISK_OBSERVATION_URL'));
  handles.push(portfolio, orders, market, platform, user, loss, observer);
  const operator = await createPostgresControls({
    ...options('DATABASE_RISK_OPERATOR_URL'), authority: 'GLOBAL',
  });
  handles.push(operator);
  const current = await operator.read(null, io());
  await operator.update({
    scope: { kind: 'GLOBAL' }, kind: 'KILL_SWITCH', key: 'kill', state: 'RUNNING',
    expectedEpoch: current.find((c) => c.kind === 'KILL_SWITCH')!.epoch,
    eventId: randomUUID(), reason: 'ISOLATED_ADMISSION_ACCEPTANCE', evidenceHash: 'a'.repeat(64),
  }, io());
});
afterAll(async () => {
  for (const h of handles.splice(0)) await h.close();
  await admin.end();
});
async function fixture() {
  const f = await seedRiskCertification({
    admin, portfolio, orders, market, platform, user, loss, observer,
    registryOptions: options('DATABASE_INSTRUMENT_REGISTRY_URL'),
  });
  const commandHash = computeCommandHash('createOrder', f.created.command, {
    profile: f.key.binding.profile,
    account: {
      tenantId: f.key.binding.tenantId, connectionId: f.key.binding.connectionId,
      externalAccountId: f.key.binding.externalAccountId,
    },
  });
  return { ...f, input: {
    binding: f.key.binding, state: { id: f.created.id }, intentId: f.created.intentId,
    operation: 'PLACE' as const, commandHash,
  } };
}
async function open() {
  const port = await createPostgresOrderRiskPort(options('DATABASE_RISK_ADMISSION_URL'));
  handles.push(port);
  return port;
}
it('atomically commits one immutable decision/reservation and an actual Portfolio commitment without a monetary posting', async () => {
  const f = await fixture(), port = await open(), tenantId = f.key.binding.tenantId;
  const before = (await admin.query<{ n: number }>(
    'SELECT count(*)::int n FROM public.ledger_transaction WHERE "tenantId"=$1', [tenantId],
  )).rows[0]!.n;
  const grant = await port.approve(f.input, io());
  const reservations = await admin.query(
    'SELECT status,asset,trim_scale(amount)::text amount FROM public.risk_reservation WHERE "tenantId"=$1 AND id=$2', [tenantId, grant.reservationId],
  );
  expect(reservations.rowCount).toBe(1);
  expect(reservations.rows[0]).toMatchObject({ status: 'ACTIVE', asset: 'USDT' });
  const book = (await admin.query<{ state: string }>(
    'SELECT state FROM ctp_portfolio.book WHERE "tenantId"=$1 AND "accountId"=$2', [tenantId, f.key.binding.accountId],
  )).rows[0]!;
  const state = JSON.parse(book.state) as { holds: unknown[] };
  expect(state.holds).toEqual([{ id: grant.reservationId, asset: 'USDT', amount: parseDecimal(reservations.rows[0]!.amount as string), status: 'RESERVED', reflected: false }]);
  expect((await admin.query(
    'SELECT ledger FROM ctp_portfolio.evidence WHERE "tenantId"=$1 AND id=$2', [tenantId, 'risk-reserve-' + grant.reservationId],
  )).rows).toEqual([{ ledger: null }]);
  expect((await admin.query(
    'SELECT type FROM ctp_portfolio.outbox WHERE "tenantId"=$1 AND "eventId"=$2', [tenantId, 'risk-reserve-' + grant.reservationId],
  )).rows).toEqual([{ type: 'COMMITMENT' }]);
  expect((await admin.query<{ n: number }>(
    'SELECT count(*)::int n FROM public.ledger_transaction WHERE "tenantId"=$1', [tenantId],
  )).rows[0]!.n).toBe(before);
});
it('exact admission replay survives process restart and preserves the original permanent decision, reservation and hold', async () => {
  const f = await fixture(), first = await open();
  const result = await first.approve(f.input, io());
  await first.close();
  const second = await open();
  expect(await second.approve(f.input, io())).toEqual(result);
  for (const table of ['risk_decision', 'risk_reservation'])
    expect((await admin.query<{ n: number }>(
      `SELECT count(*)::int n FROM public.${table} WHERE "tenantId"=$1`, [f.key.binding.tenantId],
    )).rows[0]!.n).toBe(1);
  await expect(second.approve({ ...f.input, commandHash: 'f'.repeat(64) }, io())).rejects.toThrow('RISK_ADMISSION_CONFLICT');
});
