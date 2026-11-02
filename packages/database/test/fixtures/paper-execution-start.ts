// Isolated native test setup only. Every receipt comes from the real authority.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect } from 'vitest';
import { parseDecimal } from '@ctp/exchange-core';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
} from '@ctp/paper-engine/configuration';
import { createPostgresPaperFunding, paperFundingSchema } from '@ctp/paper-engine/funding';
import { createPostgresPaperPortfolioBootstrap } from '@ctp/paper-engine/portfolio';
import {
  createPostgresPaperRuntimeObservations,
  paperRuntimeDependencies,
  type PaperRuntimePublication,
} from '@ctp/paper-engine/runtime';
import { createPostgresMarketSnapshots, createPostgresMarketTrades } from '@ctp/market-data';
import { bindingSchema, draftSchema, createPostgresOrderStore } from '@ctp/order-engine';
import {
  createPostgresPolicies,
  createPostgresControls,
  policyUpdateSchema,
  controlUpdateSchema,
} from '@ctp/risk-engine';
import * as paper from '@ctp/paper-engine/risk';
import { frameFixture } from '../../../paper-engine/test/frame-fixture.js';
import { fixture as riskFixture } from '../../../risk-engine/test/fixtures.js';
import { state } from '../../../order-engine/test/fixtures.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw Error('ISOLATED_EXECUTION_START_RUNNER_REQUIRED');
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw Error('EXECUTION_START_FIXTURE_VARIABLE_REQUIRED');
  return value;
};
export const startIo = (signal = new AbortController().signal) => ({
  signal,
  deadline: Date.now() + 2500,
});
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const handles: { close(): Promise<void> }[] = [];
async function own<T extends { close(): Promise<void> }>(opening: Promise<T>) {
  const handle = await opening;
  handles.push(handle);
  return handle;
}
const options = (key: string) => ({
  connectionString: required(key),
  environment: 'test' as const,
});
let opening: ReturnType<typeof open> | undefined;
async function open() {
  const config = await own(
    createPostgresPaperConfiguration(options('DATABASE_PAPER_CONFIGURATION_URL')),
  );
  const funding = await own(createPostgresPaperFunding(options('DATABASE_PAPER_FUNDING_URL')));
  const orders = await own(createPostgresOrderStore(options('DATABASE_EXECUTION_URL')));
  const book = await own(createPostgresPaperPortfolioBootstrap(options('DATABASE_PAPER_BOOK_URL')));
  const snapshots = await own(
    createPostgresMarketSnapshots(options('DATABASE_MARKET_SNAPSHOT_URL')),
  );
  const trades = await own(createPostgresMarketTrades(options('DATABASE_MARKET_TRADE_URL')));
  const runtime = await own(
    createPostgresPaperRuntimeObservations(options('DATABASE_PAPER_RUNTIME_OBSERVER_URL')),
  );
  const platform = await own(
    createPostgresPolicies({
      ...options('DATABASE_RISK_POLICY_OPERATOR_URL'),
      authority: 'PLATFORM',
    }),
  );
  const user = await own(
    createPostgresPolicies({
      ...options('DATABASE_RISK_POLICY_CONTROLLER_URL'),
      authority: 'USER',
    }),
  );
  const global = await own(
    createPostgresControls({ ...options('DATABASE_RISK_OPERATOR_URL'), authority: 'GLOBAL' }),
  );
  const tenant = await own(
    createPostgresControls({ ...options('DATABASE_RISK_CONTROL_URL'), authority: 'TENANT' }),
  );
  const admission = await own(
    paper.createPostgresPaperOrderRiskPort(options('DATABASE_PAPER_ADMISSION_URL')),
  );
  const preparation = await own(
    paper.createPostgresPaperAttemptJournal(options('DATABASE_PAPER_ADMISSION_URL')),
  );
  const journal = await own(
    paper.createPostgresPaperExecutionStartJournal(options('DATABASE_PAPER_ADMISSION_URL')),
  );
  const lifecycle = await own(
    paper.createPostgresPaperReservationLifecycle(options('DATABASE_PAPER_ADMISSION_URL')),
  );
  return {
    config,
    funding,
    orders,
    book,
    snapshots,
    trades,
    runtime,
    platform,
    user,
    global,
    tenant,
    admission,
    preparation,
    journal,
    lifecycle,
  };
}
export async function closeStartFixture() {
  await Promise.all(handles.map((handle) => handle.close()));
  await admin.end();
}
export async function startFixturePolicy(
  tenantId: string,
  kind: 'PLATFORM' | 'USER',
  changes: Record<string, unknown> = {},
) {
  const ports = await (opening ??= open());
  const target = kind === 'PLATFORM' ? '00000000-0000-0000-0000-000000000000' : tenantId;
  const expectedVersion =
    (
      await admin.query<{ version: string }>(
        "SELECT version::text FROM ctp_risk.policy_head WHERE scope=$1 AND target=$2 AND mode='PAPER'",
        [kind, target],
      )
    ).rows[0]?.version ?? '0';
  return ports[kind === 'PLATFORM' ? 'platform' : 'user'].update(
    policyUpdateSchema.parse({
      scope: kind === 'PLATFORM' ? { kind } : { kind, tenantId },
      mode: 'PAPER',
      expectedVersion,
      eventId: randomUUID(),
      reason: 'TEST_EXECUTION_START',
      limits: { ...riskFixture().platform, ...changes },
    }),
    startIo(),
  );
}
export async function startFixturePause(tenantId: string | null, state: 'RUNNING' | 'PAUSED') {
  const ports = await (opening ??= open());
  const expectedEpoch =
    (
      await admin.query<{ epoch: string }>(
        tenantId === null
          ? "SELECT epoch::text FROM ctp_risk.global_head WHERE kind='KILL_SWITCH' AND key='kill'"
          : "SELECT epoch::text FROM ctp_risk.tenant_head WHERE scope='USER' AND \"tenantId\"=$1 AND target=$1 AND kind='KILL_SWITCH' AND key='kill'",
        tenantId === null ? [] : [tenantId],
      )
    ).rows[0]?.epoch ?? '0';
  return ports[tenantId === null ? 'global' : 'tenant'].update(
    controlUpdateSchema.parse({
      scope:
        tenantId === null ? { kind: 'GLOBAL' } : { kind: 'USER', tenantId, targetId: tenantId },
      kind: 'KILL_SWITCH',
      key: 'kill',
      state,
      eventId: randomUUID(),
      expectedEpoch,
      reason: 'TEST_EXECUTION_START',
      evidenceHash: '1'.repeat(64),
    }),
    startIo(),
  );
}
export async function readyExecutionStart() {
  const ports = await (opening ??= open()),
    f = frameFixture(),
    c = paperConfigurationSchema.parse(f.configuration.configuration);
  const externalAccountId = 'paper:' + c.owner.accountId;
  const dbName = new URL(required('DATABASE_MIGRATION_URL')).pathname;
  for (const name of [
    'DATABASE_EXECUTION_URL',
    'DATABASE_PAPER_ADMISSION_URL',
    'DATABASE_PAPER_CONFIGURATION_URL',
    'DATABASE_PAPER_FUNDING_URL',
    'DATABASE_PAPER_BOOK_URL',
    'DATABASE_PAPER_RUNTIME_OBSERVER_URL',
    'DATABASE_MARKET_SNAPSHOT_URL',
    'DATABASE_MARKET_TRADE_URL',
    'DATABASE_RISK_OPERATOR_URL',
    'DATABASE_RISK_CONTROL_URL',
    'DATABASE_RISK_POLICY_OPERATOR_URL',
    'DATABASE_RISK_POLICY_CONTROLLER_URL',
  ])
    expect(new URL(required(name)).pathname).toBe(dbName);
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
    [c.owner.tenantId, c.owner.tenantId + '@example.invalid'],
  );
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'paper-draft-epoch\',now())',
    [c.owner.accountId, c.owner.tenantId, c.source.exchange, externalAccountId, c.source.region],
  );
  const instrument = f.p.record.instrument,
    rules = f.p.record.rules;
  await admin.query(
    'INSERT INTO public.instrument(id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt") VALUES($1,$2,\'SPOT\',$3,$4,$5,$6,true,now())',
    [
      f.p.key.dbInstrumentId,
      instrument.scope.exchange,
      instrument.scope.environment,
      instrument.exchangeSymbol,
      instrument.baseAsset,
      instrument.quoteAsset,
    ],
  );
  await admin.query(
    'INSERT INTO public.instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",rules) VALUES($1,$2,1,true,$3,now(),$4,$5,$6,$7,$8,$9,$10::jsonb)',
    [
      f.p.key.dbRuleId,
      f.p.key.dbInstrumentId,
      new Date(rules.effectiveAt),
      Buffer.alloc(32, 1),
      rules.tickSize,
      rules.stepSize,
      rules.minQuantity,
      rules.maxQuantity,
      rules.minNotional,
      JSON.stringify(rules),
    ],
  );
  await ports.config.register(c, startIo());
  await ports.funding.initialize(
    paperFundingSchema.parse({
      id: randomUUID(),
      owner: c.owner,
      configurationId: c.id,
      balances: [{ asset: instrument.quoteAsset, amount: '1000' }],
    }),
    startIo(),
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
      instrumentId: instrument.id,
      ruleVersion: rules.version,
      type: 'LIMIT',
      limitPrice: '10.5',
      timeInForce: 'GTC',
      size: { kind: 'BASE_QUANTITY', asset: instrument.baseAsset, value: '0.5' },
    },
  });
  const order = await ports.orders.create(binding, draft, startIo());
  await ports.book.initialize(c.owner, startIo());
  await startFixturePolicy(c.owner.tenantId, 'PLATFORM');
  await startFixturePolicy(c.owner.tenantId, 'USER');
  await startFixturePause(null, 'RUNNING');
  const context = await ports.runtime.context(c.owner, startIo()),
    head = await ports.runtime.head(c.owner, startIo());
  const now = Date.now();
  f.p.timestamp = f.s.timestamp = now;
  for (const record of [f.p.trade, f.s.book, f.s.ticker])
    record.receivedAt = record.exchangeTime = now;
  f.p.trade.quantity = parseDecimal('100');
  for (const levels of [f.s.book.bids, f.s.book.asks])
    for (const level of levels) level.quantity = parseDecimal('100');
  await ports.snapshots.publish(f.s, startIo());
  await ports.trades.publish(f.p, startIo());
  const publication: PaperRuntimePublication = {
    id: randomUUID(),
    expectedRevision: head?.revision ?? '0',
    observation: {
      owner: c.owner,
      configurationId: c.id,
      configurationHash: context.configurationHash,
      permissionEpoch: context.current.permissionEpoch,
      userSessionEpoch: context.current.userSessionEpoch,
      accountVersion: context.current.accountVersion,
      health: Object.fromEntries(
        paperRuntimeDependencies.map((name) => [
          name,
          { sourceId: 'test-execution-start:' + name, asOf: Date.now(), status: 'HEALTHY' },
        ]),
      ) as PaperRuntimePublication['observation']['health'],
    },
  };
  await ports.runtime.publish(publication, startIo());
  const identity = (
    await admin.query<{ hash: string; permission: string; session: string }>(
      'SELECT encode(cmd."commandHash",\'hex\') hash,a."permissionEpoch"::text permission,u."sessionEpoch"::text session FROM ctp_execution.command cmd JOIN public.exchange_account a ON a.id=$3 AND a."tenantId"=cmd."tenantId" JOIN public."user" u ON u.id=a."tenantId" WHERE cmd."tenantId"=$1 AND cmd."intentId"=$2',
      [c.owner.tenantId, order.intentId, c.owner.accountId],
    )
  ).rows[0]!;
  const approvalInput = {
    binding,
    state: { id: order.id },
    intentId: order.intentId,
    operation: 'PLACE' as const,
    commandHash: identity.hash,
  };
  const approval = await ports.admission.approve(approvalInput, startIo());
  const admission = {
    binding,
    orderId: order.id,
    intentId: order.intentId,
    operation: 'PLACE' as const,
    commandHash: identity.hash,
  };
  const request = {
    kind: 'PAPER_EXECUTION_START' as const,
    preparationKey: 'prepare-' + randomUUID(),
    startKey: 'start-' + randomUUID(),
    admission,
    authorization: { permissionEpoch: identity.permission, userSessionEpoch: identity.session },
  };
  const prepareRequest = {
    kind: 'PAPER_ATTEMPT_PREPARE' as const,
    key: request.preparationKey,
    admission,
    authorization: request.authorization,
  };
  const preparation = await ports.preparation.prepare(prepareRequest, startIo());
  return {
    ...ports,
    c,
    f,
    binding,
    order,
    admission,
    approval,
    request,
    prepareRequest,
    prepared: preparation,
  };
}
export async function startFixtureEffects(tenantId: string) {
  return (
    await admin.query<{
      ledger: number;
      entries: number;
      decisions: number;
      reservations: number;
      debits: string[];
    }>(
      `SELECT
    (SELECT count(*)::int FROM public.ledger_transaction WHERE "tenantId"=$1) ledger,
    (SELECT count(*)::int FROM public.ledger_entry WHERE "tenantId"=$1) entries,
    (SELECT count(*)::int FROM public.risk_decision WHERE "tenantId"=$1) decisions,
    (SELECT count(*)::int FROM public.risk_reservation WHERE "tenantId"=$1) reservations,
    ARRAY(SELECT trim_scale(amount)::text FROM ctp_paper.reservation_debit WHERE tenant_id=$1 ORDER BY reservation_id,ordinal) debits`,
      [tenantId],
    )
  ).rows[0]!;
}
export async function startFixtureSql(text: string, values: readonly unknown[] = []) {
  return admin.query(text, [...values]);
}
export function startFixtureConnection() {
  return required('DATABASE_PAPER_ADMISSION_URL');
}
