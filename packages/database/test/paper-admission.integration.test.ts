// Native fixtures use actual accepted configuration/funding/book/market/Order ports.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { parseDecimal } from '@ctp/exchange-core';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
  type PaperConfiguration,
} from '@ctp/paper-engine/configuration';
import { createPostgresPaperFunding, paperFundingSchema } from '@ctp/paper-engine/funding';
import { createPostgresPaperPortfolioBootstrap } from '@ctp/paper-engine/portfolio';
import {
  createPostgresPaperRuntimeObservations,
  paperRuntimeDependencies,
  type PaperRuntimePublication,
} from '@ctp/paper-engine/runtime';
import { createPostgresMarketSnapshots, createPostgresMarketTrades } from '@ctp/market-data';
// BEGIN PUBLIC MARKET FIXTURE IMPORT
import { createPublicMarketFixturePorts } from './fixtures/public-market-ports.js';
// END PUBLIC MARKET FIXTURE IMPORT
import { createPostgresOrderStore, bindingSchema, draftSchema } from '@ctp/order-engine';
// BEGIN ORDER FIXTURE PORT IMPORT
import { createOrderFixturePort } from './fixtures/order-fixture-port.js';
// END ORDER FIXTURE PORT IMPORT
// BEGIN ADMISSION FIXTURE PORT IMPORT
import { createAdmissionFixturePort } from './fixtures/admission-fixture-port.js';
// END ADMISSION FIXTURE PORT IMPORT
import {
  createPostgresPolicies,
  createPostgresControls,
  policyUpdateSchema,
  controlUpdateSchema,
} from '@ctp/risk-engine';
import { fixture as riskFixture } from '../../risk-engine/test/fixtures.js';
import { frameFixture } from '../../paper-engine/test/frame-fixture.js';
import { state } from '../../order-engine/test/fixtures.js';
// BEGIN PAPER EXECUTION SOURCE IMPORT
import * as paperSourceServer from '@ctp/paper-engine/risk';
// END PAPER EXECUTION SOURCE IMPORT
// BEGIN PAPER ATTEMPT JOURNAL IMPORT
import type { PaperExecutionAttempt } from '@ctp/paper-engine';
// END PAPER ATTEMPT JOURNAL IMPORT
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_PAPER_ADMISSION_RUNNER_REQUIRED');

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_PAPER_ADMISSION_VARIABLE_REQUIRED');
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
// Private, isolated fixture ownership only. Every command/context/head read is
// still executed against PostgreSQL. No financial reader, admission/lifecycle
// handle, observation, snapshot or result is cached. All eight possible fixture
// handles drain through the existing afterAll before the role-mutator cohort.
let configurationWriter: ReturnType<typeof createPostgresPaperConfiguration> | undefined;
let fundingWriter: ReturnType<typeof createPostgresPaperFunding> | undefined;
let bookWriter: ReturnType<typeof createPostgresPaperPortfolioBootstrap> | undefined;
let runtimeWriter: ReturnType<typeof createPostgresPaperRuntimeObservations> | undefined;
const policyWriters = new Map<'PLATFORM' | 'USER', ReturnType<typeof createPostgresPolicies>>();
const controlWriters = new Map<'GLOBAL' | 'TENANT', ReturnType<typeof createPostgresControls>>();
function ownWriter<T extends { close(): Promise<void> }>(opening: Promise<T>): Promise<T> {
  return opening.then((handle) => {
    handles.push(handle);
    return handle;
  });
}
function configurationPort() {
  return (configurationWriter ??= ownWriter(
    createPostgresPaperConfiguration({
      connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
      environment: 'test',
    }),
  ));
}
function fundingPort() {
  return (fundingWriter ??= ownWriter(
    createPostgresPaperFunding({
      connectionString: required('DATABASE_PAPER_FUNDING_URL'),
      environment: 'test',
    }),
  ));
}
function runtimePort() {
  return (runtimeWriter ??= ownWriter(
    createPostgresPaperRuntimeObservations({
      connectionString: required('DATABASE_PAPER_RUNTIME_OBSERVER_URL'),
      environment: 'test',
    }),
  ));
}

// BEGIN PUBLIC MARKET FIXTURE CACHE
const publicMarketFixturePorts = createPublicMarketFixturePorts({
  snapshots: () =>
    ownWriter(
      createPostgresMarketSnapshots({
        connectionString: required('DATABASE_MARKET_SNAPSHOT_URL'),
        environment: 'test',
      }),
    ),
  trades: () =>
    ownWriter(
      createPostgresMarketTrades({
        connectionString: required('DATABASE_MARKET_TRADE_URL'),
        environment: 'test',
      }),
    ),
});
// END PUBLIC MARKET FIXTURE CACHE
async function updatePolicy(
  tenantId: string,
  kind: 'PLATFORM' | 'USER',
  changes: Record<string, unknown> = {},
  mode: 'PAPER' | 'DEMO' = 'PAPER',
) {
  let opening = policyWriters.get(kind);
  if (!opening) {
    opening = ownWriter(
      createPostgresPolicies({
        connectionString: required(
          kind === 'PLATFORM'
            ? 'DATABASE_RISK_POLICY_OPERATOR_URL'
            : 'DATABASE_RISK_POLICY_CONTROLLER_URL',
        ),
        environment: 'test',
        authority: kind,
      }),
    );
    policyWriters.set(kind, opening);
  }
  const h = await opening;
  const expected =
    (
      await admin.query<{ version: string }>(
        'SELECT version::text FROM ctp_risk.policy_head WHERE scope=$1 AND target=$2 AND mode=$3',
        [kind, kind === 'PLATFORM' ? '00000000-0000-0000-0000-000000000000' : tenantId, mode],
      )
    ).rows[0]?.version ?? '0';
  return await h.update(
    policyUpdateSchema.parse({
      scope: kind === 'PLATFORM' ? { kind } : { kind, tenantId },
      mode,
      expectedVersion: expected,
      eventId: randomUUID(),
      reason: 'TEST_PAPER_AUTHORITY',
      limits: { ...riskFixture().platform, ...changes },
    }),
    io(),
  );
}

async function updateControl(tenantId: string | null, state: 'RUNNING' | 'PAUSED') {
  const authority = tenantId === null ? 'GLOBAL' : 'TENANT';
  let opening = controlWriters.get(authority);
  if (!opening) {
    opening = ownWriter(
      createPostgresControls({
        connectionString: required(
          tenantId === null ? 'DATABASE_RISK_OPERATOR_URL' : 'DATABASE_RISK_CONTROL_URL',
        ),
        environment: 'test',
        authority,
      }),
    );
    controlWriters.set(authority, opening);
  }
  const h = await opening;
  const expected =
    tenantId === null
      ? ((
          await admin.query<{ epoch: string }>(
            "SELECT epoch::text FROM ctp_risk.global_head WHERE kind='KILL_SWITCH' AND key='kill'",
          )
        ).rows[0]?.epoch ?? '0')
      : ((
          await admin.query<{ epoch: string }>(
            "SELECT epoch::text FROM ctp_risk.tenant_head WHERE \"tenantId\"=$1 AND scope='USER' AND kind='KILL_SWITCH' AND key='kill'",
            [tenantId],
          )
        ).rows[0]?.epoch ?? '0');
  return await h.update(
    controlUpdateSchema.parse({
      scope:
        tenantId === null ? { kind: 'GLOBAL' } : { kind: 'USER', tenantId, targetId: tenantId },
      kind: 'KILL_SWITCH',
      key: 'kill',
      state,
      eventId: randomUUID(),
      expectedEpoch: expected,
      reason: 'TEST_PAPER_AUTHORITY',
      evidenceHash: '1'.repeat(64),
    }),
    io(),
  );
}

async function ensurePolicies(tenantId: string) {
  await updatePolicy(tenantId, 'PLATFORM');
  await updatePolicy(tenantId, 'USER');
  await updateControl(null, 'RUNNING');
}

// BEGIN ORDER FIXTURE PORT OPEN
const orderFixturePort = createOrderFixturePort(() =>
  ownWriter(
    createPostgresOrderStore({
      connectionString: required('DATABASE_EXECUTION_URL'),
      environment: 'test',
    }),
  ),
);
async function openOrders() {
  return orderFixturePort();
}
// END ORDER FIXTURE PORT OPEN

async function fixture({
  configure = true,
  region,
}: { configure?: boolean; region?: string } = {}) {
  const f = frameFixture();
  if (region) {
    f.configuration.configuration.source = { ...f.configuration.configuration.source, region };
    for (const holder of [
      f.p.key,
      f.p.record.instrument,
      f.p.record.rules,
      f.s.key,
      f.s.record.instrument,
      f.s.record.rules,
      f.s.book,
      f.s.ticker,
    ])
      holder.scope = { ...holder.scope, region };
  }
  const c = paperConfigurationSchema.parse(f.configuration.configuration);
  const externalAccountId = 'paper:' + c.owner.accountId;
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
    [c.owner.tenantId, c.owner.tenantId + '@example.invalid'],
  );
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'paper-draft-epoch\',now())',
    [c.owner.accountId, c.owner.tenantId, c.source.exchange, externalAccountId, c.source.region],
  );
  const config = await configurationPort();
  if (configure) await config.register(c, io());
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

async function openBook(connectionString = required('DATABASE_PAPER_BOOK_URL')) {
  if (connectionString !== required('DATABASE_PAPER_BOOK_URL'))
    return ownWriter(
      createPostgresPaperPortfolioBootstrap({ connectionString, environment: 'test' }),
    );
  return (bookWriter ??= ownWriter(
    createPostgresPaperPortfolioBootstrap({ connectionString, environment: 'test' }),
  ));
}

async function runtimeEvidence(
  f: Awaited<ReturnType<typeof tenantReady>>,
  status: 'HEALTHY' | 'FAILED' | 'UNKNOWN' = 'HEALTHY',
) {
  const h = await runtimePort();
  const ctx = await h.context(f.c.owner, io());
  const publication: PaperRuntimePublication = {
    id: randomUUID(),
    expectedRevision: (await h.head(f.c.owner, io()))?.revision ?? '0',
    observation: {
      owner: f.c.owner,
      configurationId: ctx.configuration.configuration.id,
      configurationHash: ctx.configurationHash,
      permissionEpoch: ctx.current.permissionEpoch,
      userSessionEpoch: ctx.current.userSessionEpoch,
      accountVersion: ctx.current.accountVersion,
      // Explicit test-only observations, never operational health certification.
      health: Object.fromEntries(
        paperRuntimeDependencies.map((k) => [
          k,
          {
            sourceId: k + ':native-fixture:v1',
            asOf: Date.now(),
            status: k === 'executor' ? status : 'HEALTHY',
          },
        ]),
      ) as PaperRuntimePublication['observation']['health'],
    },
  };
  const receipt = await h.publish(publication, io());
  return { h, publication, receipt };
}

async function effects(tenantId: string) {
  return (
    await admin.query<{
      ledger: number;
      entries: number;
      intents: number;
      decisions: number;
      reservations: number;
      evidence: number;
      outbox: number;
      counter: string;
    }>(
      `SELECT
    (SELECT count(*)::int FROM public.ledger_transaction WHERE "tenantId"=$1) ledger,
    (SELECT count(*)::int FROM public.ledger_entry WHERE "tenantId"=$1) entries,
    (SELECT count(*)::int FROM public.order_intent WHERE "tenantId"=$1) intents,
    (SELECT count(*)::int FROM public.risk_decision WHERE "tenantId"=$1) decisions,
    (SELECT count(*)::int FROM public.risk_reservation WHERE "tenantId"=$1) reservations,
    (SELECT count(*)::int FROM ctp_portfolio.evidence WHERE "tenantId"=$1) evidence,
    (SELECT count(*)::int FROM ctp_portfolio.outbox WHERE "tenantId"=$1) outbox,
    (SELECT "clientIdHighWatermark"::text FROM public.exchange_account WHERE "tenantId"=$1 LIMIT 1) counter`,
      [tenantId],
    )
  ).rows;
}

async function fundCash(c: PaperConfiguration, noncash = false) {
  const fundingId = randomUUID(),
    config = await configurationPort(),
    funding = await fundingPort();
  await config.register(c, io());
  await funding.initialize(
    paperFundingSchema.parse({
      id: fundingId,
      owner: c.owner,
      configurationId: c.id,
      balances: noncash
        ? [
            { asset: 'BTC', amount: '1' },
            { asset: 'USDT', amount: '1000' },
          ]
        : [{ asset: 'USDT', amount: '1000' }],
    }),
    io(),
  );
  return fundingId;
}

async function tenantReady(liquid = false) {
  const f = await fixture(),
    fundingId = await fundCash(f.c),
    orders = await openOrders(),
    order = await orders.create(
      f.binding,
      liquid
        ? draftSchema.parse({
            ...f.draft,
            order: { ...f.draft.order, type: 'LIMIT', limitPrice: '10.5', timeInForce: 'GTC' },
          })
        : f.draft,
      io(),
    );
  await (await openBook()).initialize(f.c.owner, io());
  // BEGIN PUBLIC MARKET FIXTURE USE
  const snapshots = await publicMarketFixturePorts.snapshots(),
    trades = await publicMarketFixturePorts.trades();
  // END PUBLIC MARKET FIXTURE USE
  await ensurePolicies(f.c.owner.tenantId);
  const now = Date.now();
  f.f.s.timestamp = f.f.p.timestamp = now;
  for (const v of [f.f.s.ticker, f.f.s.book, f.f.p.trade]) v.receivedAt = v.exchangeTime = now;
  if (liquid) {
    f.f.s.book.bids = f.f.s.book.bids.map((v) => ({ ...v, quantity: parseDecimal('100') }));
    f.f.s.book.asks = f.f.s.book.asks.map((v) => ({ ...v, quantity: parseDecimal('100') }));
    f.f.p.trade.quantity = parseDecimal('100');
  }
  await snapshots.publish(f.f.s, io());
  await trades.publish(f.f.p, io());
  return {
    ...f,
    fundingId,
    orders,
    order,
    snapshots,
    trades,
    request: { owner: f.c.owner, intentId: order.intentId },
  };
}

import {
  createPostgresPaperOrderRiskPort,
  createPostgresPaperReservationLifecycle,
} from '@ctp/paper-engine/risk';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await admin.end();
});
async function boundary() {
  const database = new URL(required('DATABASE_MIGRATION_URL')).pathname;
  for (const key of [
    'DATABASE_EXECUTION_URL',
    'DATABASE_PAPER_ADMISSION_URL',
    'DATABASE_PAPER_CONFIGURATION_URL',
    'DATABASE_PAPER_FUNDING_URL',
    'DATABASE_PAPER_BOOK_URL',
    'DATABASE_PAPER_RUNTIME_OBSERVER_URL',
    'DATABASE_PAPER_TENANT_RISK_CONTEXT_URL',
    'DATABASE_MARKET_SNAPSHOT_URL',
    'DATABASE_MARKET_TRADE_URL',
    'DATABASE_RISK_CONTROL_URL',
    'DATABASE_RISK_OPERATOR_URL',
    'DATABASE_RISK_POLICY_OPERATOR_URL',
    'DATABASE_RISK_POLICY_CONTROLLER_URL',
  ])
    expect(
      new URL(required(key)).pathname,
      'Every admission fixture port must use this isolated database',
    ).toBe(database);
  const row = await admin.query<{ ready: boolean }>(
    "SELECT to_regprocedure('ctp_paper.evaluate_and_reserve(jsonb)') IS NOT NULL AND to_regprocedure('ctp_paper.reconcile_admission(jsonb)') IS NOT NULL AND to_regrole('ctp_paper_risk_admission') IS NOT NULL ready",
  );
  expect(row.rows[0]!.ready, 'Real restricted PAPER admission SQL kernel is required').toBe(true);
}
async function nativeReady() {
  await boundary();
  const f = await tenantReady(true);
  await runtimeEvidence(f);
  return f;
}
type Ready = Awaited<ReturnType<typeof nativeReady>>;
async function input(f: Ready, order = f.order) {
  const row = await admin.query<{ hash: string }>(
    'SELECT encode("commandHash",\'hex\') hash FROM ctp_execution.command WHERE "tenantId"=$1 AND "intentId"=$2',
    [f.c.owner.tenantId, order.intentId],
  );
  return {
    binding: f.binding,
    state: { id: order.id },
    intentId: order.intentId,
    operation: 'PLACE' as const,
    commandHash: row.rows[0]!.hash,
  };
}
// BEGIN ADMISSION FIXTURE PORT OPEN
const admissionFixturePort = createAdmissionFixturePort(() =>
  ownWriter(
    createPostgresPaperOrderRiskPort({
      connectionString: required('DATABASE_PAPER_ADMISSION_URL'),
      environment: 'test',
    }),
  ),
);
async function openAdmission() {
  return admissionFixturePort();
}
// END ADMISSION FIXTURE PORT OPEN
async function openLifecycle(connectionString = required('DATABASE_PAPER_ADMISSION_URL')) {
  const port = await createPostgresPaperReservationLifecycle({
    connectionString,
    environment: 'test',
  });
  handles.push(port);
  return port;
}
async function unknownRequest(f: Ready, reservationId: string) {
  const { state, ...request } = await input(f);
  return {
    kind: 'PAPER_RESERVATION_UNKNOWN' as const,
    admission: { ...request, orderId: state.id },
    reservationId,
    eventId: randomUUID(),
    expectedRevision: '1' as const,
  };
}
async function anotherAccount(f: Ready, funded: boolean) {
  const c = paperConfigurationSchema.parse({
    ...f.c,
    id: randomUUID(),
    owner: { ...f.c.owner, accountId: randomUUID() },
  });
  const externalAccountId = 'paper:' + c.owner.accountId;
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'paper-draft-epoch\',now())',
    [c.owner.accountId, c.owner.tenantId, c.source.exchange, externalAccountId, c.source.region],
  );
  const binding = bindingSchema.parse({
    ...f.binding,
    accountId: c.owner.accountId,
    externalAccountId,
  });
  const config = await createPostgresPaperConfiguration({
    connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
    environment: 'test',
  });
  try {
    await config.register(c, io());
  } finally {
    await config.close();
  }
  if (funded) {
    await fundCash(c);
    await (await openBook()).initialize(c.owner, io());
  }
  const order = await f.orders.create(
    binding,
    {
      ...f.draft,
      key: randomUUID(),
      order: {
        ...f.draft.order,
        type: 'LIMIT',
        limitPrice: parseDecimal('10.5'),
        timeInForce: 'GTC',
      },
    },
    io(),
  );
  return { ...f, c, binding, order };
}
async function nextFixtureMarketObservation(f: Ready) {
  // A new test-only native observation through the actual Market Data ports;
  // never renew the timestamp of an existing persisted receipt.
  const snapshot = structuredClone(f.f.s),
    trade = structuredClone(f.f.p),
    now = Date.now();
  snapshot.id = randomUUID();
  trade.id = randomUUID();
  snapshot.expectedRevision = trade.expectedRevision = '1';
  snapshot.timestamp = trade.timestamp = now;
  for (const record of [snapshot.ticker, snapshot.book, trade.trade])
    record.exchangeTime = record.receivedAt = now;
  snapshot.book.sourceSequence = (BigInt(snapshot.book.sourceSequence!) + 1n).toString();
  trade.trade.sourceSequence = (BigInt(trade.trade.sourceSequence!) + 1n).toString();
  trade.trade.tradeId = randomUUID();
  expect((await f.snapshots.publish(snapshot, io())).status).toBe('APPLIED');
  expect((await f.trades.publish(trade, io())).status).toBe('APPLIED');
}
async function inventory(f: Ready) {
  return (
    await admin.query<{
      reservations: number;
      decisions: number;
      issuance: number;
      holds: number;
      debits: string[];
      ledger: number;
      entries: number;
    }>(
      `SELECT (SELECT count(*)::int FROM public.risk_reservation WHERE "tenantId"=$1) reservations,
  (SELECT count(*)::int FROM public.risk_decision WHERE "tenantId"=$1) decisions,
  (SELECT count(*)::int FROM ctp_paper.admission_issuance WHERE tenant_id=$1) issuance,
  (SELECT jsonb_array_length(state::jsonb->'holds') FROM ctp_portfolio.book WHERE "tenantId"=$1 LIMIT 1) holds,
  ARRAY(SELECT trim_scale(amount)::text FROM ctp_paper.reservation_debit WHERE tenant_id=$1 ORDER BY reservation_id,ordinal) debits,
  (SELECT count(*)::int FROM public.ledger_transaction WHERE "tenantId"=$1) ledger,
  (SELECT count(*)::int FROM public.ledger_entry WHERE "tenantId"=$1) entries`,
      [f.c.owner.tenantId],
    )
  ).rows[0]!;
}
it('paper-admission: fixed SQL boundaries exist and a read role has no writer capability', async () => {
  await boundary();
  const p = new Pool({ connectionString: required('DATABASE_PAPER_TENANT_RISK_CONTEXT_URL') });
  try {
    const r = await p.query<{ allowed: boolean }>(
      "SELECT has_function_privilege(current_user,'ctp_paper.evaluate_and_reserve(jsonb)','EXECUTE') allowed",
    );
    expect(r.rows[0]!.allowed).toBe(false);
    await expect(p.query('SELECT * FROM ctp_paper.admission_issuance')).rejects.toThrow(
      /permission denied/u,
    );
  } finally {
    await p.end();
  }
});
it('paper-admission: actual current source creates one immutable vector and common Portfolio hold without a second cash posting', async () => {
  const f = await nativeReady(),
    port = await openAdmission(),
    request = await input(f),
    before = await effects(f.c.owner.tenantId);
  const grant = await port.approve(request, io());
  expect(grant.permissionEpoch).toBe('0');
  expect(grant.expiresAt).toBeGreaterThan(Date.now());
  expect(await inventory(f)).toMatchObject({
    reservations: 1,
    decisions: 1,
    issuance: 1,
    holds: 1,
    debits: ['5.25525'],
    ledger: 1,
    entries: 2,
  });
  const after = await effects(f.c.owner.tenantId);
  expect(after[0]!.ledger).toBe(before[0]!.ledger);
  expect(after[0]!.entries).toBe(before[0]!.entries);
  expect(after[0]!.counter).toBe(before[0]!.counter);
  const r = await admin.query<{
    asset: null;
    amount: null;
    vectorSize: number;
    payload: { loss: { kind: string } };
  }>(
    `SELECT r.asset,r.amount,r."vectorSize",i.response AS payload FROM public.risk_reservation r JOIN ctp_paper.admission_issuance i ON i.tenant_id=r."tenantId" AND i.reservation_id=r.id WHERE r."tenantId"=$1`,
    [f.c.owner.tenantId],
  );
  expect(r.rows[0]!).toMatchObject({
    asset: null,
    amount: null,
    vectorSize: 1,
    payload: { loss: { kind: 'PAPER_INCEPTION' } },
  });
});
it('paper-admission: exact replay after connection restart and rule replacement retains permanent IDs and adds no rows', async () => {
  const f = await nativeReady(),
    port = await openAdmission(),
    request = await input(f),
    grant = await port.approve(request, io()),
    before = await inventory(f);
  await port.close();
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.draft.dbRuleId,
  ]);
  const restarted = await openAdmission();
  expect(await restarted.approve(request, io())).toEqual(grant);
  expect(await inventory(f)).toEqual(before);
  expect(await restarted.reconcileApproval(request, io())).toMatchObject({
    kind: 'COMMITTED',
    receipt: grant,
  });
});
it('paper-admission: same intent with different immutable command hash is a conflict without duplicate reserve', async () => {
  const f = await nativeReady(),
    port = await openAdmission(),
    request = await input(f);
  await port.approve(request, io());
  const before = await inventory(f);
  await expect(port.approve({ ...request, commandHash: 'f'.repeat(64) }, io())).rejects.toThrow(
    'PAPER_ADMISSION_CONFLICT',
  );
  expect(await inventory(f)).toEqual(before);
});
it('paper-admission: a new stale-rule request receives no idempotency bypass', async () => {
  const f = await nativeReady(),
    port = await openAdmission(),
    request = await input(f),
    before = await effects(f.c.owner.tenantId);
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.draft.dbRuleId,
  ]);
  await expect(port.approve(request, io())).rejects.toThrow(/^PAPER_ADMISSION_/u);
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-admission: two concurrent claims cannot both consume the last tenant budget', async () => {
  const f = await nativeReady(),
    port = await openAdmission();
  const second = await f.orders.create(
    f.binding,
    {
      ...f.draft,
      key: randomUUID(),
      order: {
        ...f.draft.order,
        type: 'LIMIT',
        limitPrice: parseDecimal('10.5'),
        timeInForce: 'GTC',
      },
    },
    io(),
  );
  await updatePolicy(f.c.owner.tenantId, 'USER', { maxUserExposure: '6' });
  await runtimeEvidence(f);
  const results = await Promise.allSettled([
    port.approve(await input(f), io()),
    port.approve(await input(f, second), io()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const rejection = results.find((r) => r.status === 'rejected');
  expect(rejection?.status === 'rejected' && (rejection.reason as Error).message).toBe(
    'PAPER_ADMISSION_LIMIT',
  );
  expect(await inventory(f)).toMatchObject({
    reservations: 1,
    decisions: 1,
    issuance: 1,
    holds: 1,
    ledger: 1,
    entries: 2,
  });
});
it('paper-admission: current GLOBAL pause rejects before financial effects', async () => {
  const f = await nativeReady(),
    port = await openAdmission(),
    request = await input(f),
    before = await effects(f.c.owner.tenantId);
  await updateControl(null, 'PAUSED');
  try {
    await expect(port.approve(request, io())).rejects.toThrow(/^PAPER_ADMISSION_/u);
    expect(await effects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await updateControl(null, 'RUNNING');
  }
});
it('paper-admission: original UNKNOWN executor observation is not renewed into HEALTHY', async () => {
  const f = await nativeReady(),
    port = await openAdmission(),
    request = await input(f);
  await runtimeEvidence(f, 'UNKNOWN');
  const before = await effects(f.c.owner.tenantId);
  await expect(port.approve(request, io())).rejects.toThrow(/^PAPER_ADMISSION_/u);
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-admission: current UNKNOWN order retains its original hold and prevents new risk', async () => {
  const f = await nativeReady(),
    port = await openAdmission(),
    request = await input(f);
  await port.approve(request, io());
  const second = await f.orders.create(
    f.binding,
    {
      ...f.draft,
      key: randomUUID(),
      order: {
        ...f.draft.order,
        type: 'LIMIT',
        limitPrice: parseDecimal('10.5'),
        timeInForce: 'GTC',
      },
    },
    io(),
  );
  await admin.query('UPDATE public."order" SET status=\'UNKNOWN\' WHERE id=$1', [f.order.id]);
  const before = await inventory(f);
  await runtimeEvidence(f);
  await expect(port.approve(await input(f, second), io())).rejects.toThrow(/^PAPER_ADMISSION_/u);
  expect(await inventory(f)).toEqual(before);
});
it('paper-admission: MISSING reconciliation is read-only and issues no grant, hold or cash movement', async () => {
  const f = await nativeReady(),
    port = await openAdmission(),
    request = await input(f),
    before = await effects(f.c.owner.tenantId);
  expect(await port.reconcileApproval(request, io())).toEqual({
    kind: 'MISSING',
    request: {
      binding: request.binding,
      orderId: request.state.id,
      intentId: request.intentId,
      operation: 'PLACE',
      commandHash: request.commandHash,
    },
  });
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});

it('paper-admission: authentic current holds admit a second order exactly once when budgets permit', async () => {
  const f = await nativeReady(),
    port = await openAdmission();
  await port.approve(await input(f), io());
  const second = await f.orders.create(
    f.binding,
    {
      ...f.draft,
      key: randomUUID(),
      order: {
        ...f.draft.order,
        type: 'LIMIT',
        limitPrice: parseDecimal('10.5'),
        timeInForce: 'GTC',
      },
    },
    io(),
  );
  await runtimeEvidence(f);
  await port.approve(await input(f, second), io());
  expect(await inventory(f)).toMatchObject({
    reservations: 2,
    decisions: 2,
    issuance: 2,
    holds: 2,
    debits: ['5.25525', '5.25525'],
    ledger: 1,
    entries: 2,
  });
});

it.each(['book', 'watermark'] as const)(
  'paper-admission: a common Portfolio SQL writer cannot erase issued %s authority',
  async (kind) => {
    const f = await nativeReady(),
      port = await openAdmission();
    await port.approve(await input(f), io());
    const before = await inventory(f),
      p = await admin.connect();
    try {
      await p.query('BEGIN');
      await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
      await p.query('SET LOCAL ROLE ctp_portfolio');
      if (kind === 'book')
        await p.query(
          `UPDATE ctp_portfolio.book SET state=jsonb_set(state::jsonb,'{holds}','[]')::text,
      state_hash=sha256(convert_to(jsonb_set(state::jsonb,'{holds}','[]')::text,'UTF8')) WHERE "tenantId"=$1`,
          [f.c.owner.tenantId],
        );
      else
        await p.query(
          `UPDATE ctp_portfolio.hold_watermark SET released=true,timestamp=timestamp+1,
      fingerprint=sha256(convert_to('forged-issued-release','UTF8')) WHERE "tenantId"=$1`,
          [f.c.owner.tenantId],
        );
      await expect(p.query('COMMIT')).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    } finally {
      await p.query('ROLLBACK');
      p.release();
    }
    expect(await inventory(f)).toEqual(before);
  },
);

it('paper-admission: lost acknowledged COMMIT grants nothing and reconciles one durable effect after reconnect', async () => {
  const f = await nativeReady(),
    request = await input(f),
    proxy = await registryCommitProxy(required('DATABASE_PAPER_ADMISSION_URL'), 'PAPER_ADMISSION');
  const port = await createPostgresPaperOrderRiskPort({
    connectionString: proxy.connectionString,
    environment: 'test',
  });
  try {
    proxy.arm();
    await expect(port.approve(request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    expect(await inventory(f)).toMatchObject({
      reservations: 1,
      decisions: 1,
      issuance: 1,
      holds: 1,
      ledger: 1,
      entries: 2,
    });
    const restarted = await openAdmission();
    const reconciled = await restarted.reconcileApproval(request, io());
    expect(reconciled.kind).toBe('COMMITTED');
    expect(await inventory(f)).toMatchObject({
      reservations: 1,
      decisions: 1,
      issuance: 1,
      holds: 1,
      ledger: 1,
      entries: 2,
    });
  } finally {
    await port.close();
    await proxy.close();
  }
});

it('paper-admission: genuine later account funding cannot remint genesis or increase the inception loss reference', async () => {
  const f = await nativeReady(),
    port = await openAdmission();
  await port.approve(await input(f), io());
  const before = await admin.query(
    'SELECT to_jsonb(g) AS genesis FROM ctp_paper.admission_genesis g WHERE tenant_id=$1',
    [f.c.owner.tenantId],
  );
  const second = await anotherAccount(f, true);
  await nextFixtureMarketObservation(f);
  await runtimeEvidence(second);
  const grant = await port.approve(await input(second), io());
  const result = await admin.query<{
    response: {
      loss: { kind: string; initialCapital: string };
      policy: { snapshot: { adjustedOpeningEquity: string; adjustedCurrentEquity: string } };
    };
    source: { inventory: { accountIds: string[] } };
  }>(
    'SELECT response,source FROM ctp_paper.admission_issuance WHERE tenant_id=$1 AND reservation_id=$2',
    [f.c.owner.tenantId, grant.reservationId],
  );
  expect(result.rows[0]!.response.loss).toMatchObject({
    kind: 'PAPER_INCEPTION',
    initialCapital: '1000',
  });
  expect(result.rows[0]!.response.policy.snapshot).toMatchObject({
    adjustedOpeningEquity: '1000',
    adjustedCurrentEquity: '1000',
  });
  expect(result.rows[0]!.source.inventory.accountIds.sort()).toEqual(
    [f.c.owner.accountId, second.c.owner.accountId].sort(),
  );
  expect(
    (
      await admin.query(
        'SELECT to_jsonb(g) AS genesis FROM ctp_paper.admission_genesis g WHERE tenant_id=$1',
        [f.c.owner.tenantId],
      )
    ).rows,
  ).toEqual(before.rows);
  expect((await effects(f.c.owner.tenantId))[0]).toMatchObject({
    ledger: 2,
    entries: 4,
    decisions: 2,
    reservations: 2,
  });
});

it('paper-admission: concurrent distinct accounts share one tenant exposure limit', async () => {
  const f = await nativeReady(),
    second = await anotherAccount(f, true),
    port = await openAdmission();
  await updatePolicy(f.c.owner.tenantId, 'USER', { maxUserExposure: '6' });
  await nextFixtureMarketObservation(f);
  await runtimeEvidence(f);
  await runtimeEvidence(second);
  const result = await Promise.allSettled([
    port.approve(await input(f), io()),
    port.approve(await input(second), io()),
  ]);
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const denied = result.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  expect(denied.reason).toMatchObject({ message: 'PAPER_ADMISSION_LIMIT' });
  expect((await effects(f.c.owner.tenantId))[0]).toMatchObject({
    ledger: 2,
    entries: 4,
    decisions: 1,
    reservations: 1,
  });
});

it('paper-admission: an unfunded second account cannot disappear from complete tenant inventory', async () => {
  const f = await nativeReady(),
    port = await openAdmission();
  await anotherAccount(f, false);
  await runtimeEvidence(f);
  const before = await effects(f.c.owner.tenantId);
  await expect(port.approve(await input(f), io())).rejects.toThrow(/^PAPER_/u);
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM ctp_paper.admission_genesis WHERE tenant_id=$1',
        [f.c.owner.tenantId],
      )
    ).rows[0]!.n,
  ).toBe(0);
});

it('paper-unknown: durable quarantine retains the original entire vector and cash, and exact replay survives restart', async () => {
  const f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    before = await inventory(f);
  const request = await unknownRequest(f, original.reservationId),
    port = await openLifecycle();
  const receipt = await port.markUnknown(request, io());
  expect(receipt).toMatchObject({
    reservationId: original.reservationId,
    revision: '2',
    intentId: f.order.intentId,
    eventId: request.eventId,
  });
  expect(await inventory(f)).toEqual(before);
  const rows = await admin.query<{
    status: string;
    amount: string;
    watermark: boolean;
    count: number;
  }>(
    `SELECT s.status,trim_scale(d.amount)::text amount,w.unknown watermark,
    (SELECT count(*)::int FROM ctp_paper.reservation_state_event WHERE tenant_id=$1 AND reservation_id=$2) count
    FROM ctp_paper.reservation_state_event s JOIN ctp_paper.reservation_debit d USING(tenant_id,reservation_id)
    JOIN ctp_portfolio.hold_watermark w ON w."tenantId"=d.tenant_id AND w."holdId"=d.hold_id::text
    WHERE s.tenant_id=$1 AND s.reservation_id=$2 AND s.revision=2`,
    [f.c.owner.tenantId, original.reservationId],
  );
  expect(rows.rows).toEqual([
    { status: 'UNKNOWN', amount: before.debits[0], watermark: true, count: 2 },
  ]);
  await port.close();
  const restarted = await openLifecycle();
  expect(await restarted.markUnknown(request, io())).toEqual(receipt);
  expect(await restarted.reconcileUnknown(request, io())).toEqual({
    kind: 'COMMITTED',
    request,
    receipt,
  });
  expect(await inventory(f)).toEqual(before);
  await expect(admission.approve(await input(f), io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect((await admission.reconcileApproval(await input(f), io())).kind).toBe('COMMITTED');
  const next = await f.orders.create(f.binding, { ...f.draft, key: randomUUID() }, io());
  await expect(admission.approve(await input(f, next), io())).rejects.toThrow(
    'PAPER_ADMISSION_EVIDENCE',
  );
});

it('paper-unknown: a permanent event conflict, stale revision and wrong reservation cannot change the hold', async () => {
  const f = await nativeReady(),
    admission = await openAdmission(),
    port = await openLifecycle();
  const original = await admission.approve(await input(f), io()),
    request = await unknownRequest(f, original.reservationId);
  await port.markUnknown(request, io());
  const before = await inventory(f);
  await expect(port.markUnknown({ ...request, eventId: randomUUID() }, io())).rejects.toThrow(
    'PAPER_ADMISSION_CONFLICT',
  );
  await expect(port.markUnknown({ ...request, reservationId: randomUUID() }, io())).rejects.toThrow(
    'PAPER_ADMISSION_CONFLICT',
  );
  await expect(port.markUnknown({ ...request, expectedRevision: '2' }, io())).rejects.toThrow(
    'PAPER_ADMISSION_INPUT',
  );
  expect(await inventory(f)).toEqual(before);
});

it('paper-unknown: concurrent distinct events produce exactly one durable UNKNOWN and no second reserve', async () => {
  const f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    request = await unknownRequest(f, original.reservationId);
  const before = await inventory(f),
    a = await openLifecycle(),
    b = await openLifecycle();
  const results = await Promise.allSettled([
    a.markUnknown(request, io()),
    b.markUnknown({ ...request, eventId: randomUUID() }, io()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await inventory(f)).toEqual(before);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_paper.admission_unknown_event WHERE tenant_id=$1',
        [f.c.owner.tenantId],
      )
    ).rows[0]?.n,
  ).toBe(1);
});

it('paper-unknown: lost COMMIT returns no receipt and only read-only reconciliation observes its durable result', async () => {
  const f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    request = await unknownRequest(f, original.reservationId),
    before = await inventory(f);
  const proxy = await registryCommitProxy(
    required('DATABASE_PAPER_ADMISSION_URL'),
    'PAPER_ADMISSION',
  );
  const port = await openLifecycle(proxy.connectionString);
  try {
    proxy.arm();
    await expect(port.markUnknown(request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    const restarted = await openLifecycle(),
      result = await restarted.reconcileUnknown(request, io());
    expect(result.kind).toBe('COMMITTED');
    expect(await inventory(f)).toEqual(before);
    expect(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int n FROM ctp_paper.admission_unknown_event WHERE tenant_id=$1',
          [f.c.owner.tenantId],
        )
      ).rows[0]?.n,
    ).toBe(1);
  } finally {
    await port.close();
    await proxy.close();
  }
});

it('paper-unknown: pause and rule replacement cannot prevent conservative retention or turn it into a new grant', async () => {
  const f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    request = await unknownRequest(f, original.reservationId),
    port = await openLifecycle();
  await updateControl(f.c.owner.tenantId, 'PAUSED');
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  expect(await port.markUnknown(request, io())).toMatchObject({ revision: '2' });
  await expect(admission.approve(await input(f), io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
});

it('paper-unknown: MISSING and a pre-aborted call have no monetary or lifecycle effect', async () => {
  const f = await nativeReady(),
    admission = await openAdmission(),
    port = await openLifecycle();
  const original = await admission.approve(await input(f), io()),
    request = await unknownRequest(f, original.reservationId),
    before = await inventory(f);
  expect(await port.reconcileUnknown(request, io())).toEqual({ kind: 'MISSING', request });
  const abort = new AbortController();
  abort.abort();
  await expect(port.markUnknown(request, io(abort.signal))).rejects.toThrow(
    'PAPER_ADMISSION_ABORTED',
  );
  expect(await port.reconcileUnknown(request, io())).toEqual({ kind: 'MISSING', request });
  expect(await inventory(f)).toEqual(before);
});

it('paper-unknown: a common writer cannot release, resurrect ACTIVE or erase the durable watermark', async () => {
  const f = await nativeReady(),
    admission = await openAdmission(),
    port = await openLifecycle();
  const original = await admission.approve(await input(f), io()),
    request = await unknownRequest(f, original.reservationId);
  const receipt = await port.markUnknown(request, io()),
    before = await inventory(f);
  for (const [mutation, failure] of [
    [
      `UPDATE ctp_portfolio.book SET state=jsonb_set(state::jsonb,'{holds}','[]')::text,state_hash=sha256(convert_to(jsonb_set(state::jsonb,'{holds}','[]')::text,'UTF8')) WHERE "tenantId"=$1`,
      'PAPER_ADMISSION_EVIDENCE',
    ],
    [
      `UPDATE ctp_portfolio.hold_watermark SET unknown=false,timestamp=timestamp+1 WHERE "tenantId"=$1`,
      'Hold watermark cannot regress',
    ],
    [
      `DELETE FROM ctp_portfolio.hold_watermark WHERE "tenantId"=$1`,
      'permission denied for table hold_watermark',
    ],
  ] as const) {
    const p = await admin.connect();
    try {
      await p.query('BEGIN');
      await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
      await p.query('SET LOCAL ROLE ctp_portfolio');
      await expect(
        (async () => {
          await p.query(mutation, [f.c.owner.tenantId]);
          await p.query('COMMIT');
        })(),
      ).rejects.toThrow(failure);
    } finally {
      await p.query('ROLLBACK');
      p.release();
    }
  }
  expect(await port.reconcileUnknown(request, io())).toMatchObject({ kind: 'COMMITTED', receipt });
  expect(await inventory(f)).toEqual(before);
  expect(
    (
      await admin.query<{ revision: string }>(
        'SELECT revision::text FROM ctp_portfolio.book WHERE "tenantId"=$1',
        [f.c.owner.tenantId],
      )
    ).rows[0]!.revision,
  ).toBe(receipt.bookRevision);
});

it('paper-unknown: restricted runtime cannot bypass the public wrapper or forge the private lifecycle witness', async () => {
  const p = new Pool({ connectionString: required('DATABASE_PAPER_ADMISSION_URL') });
  try {
    for (const signature of [
      'ctp_paper.evaluate_and_reserve_v53(jsonb)',
      'ctp_paper.reconcile_admission_v53(jsonb)',
      'ctp_paper.reservation_unknown(jsonb,boolean)',
    ])
      expect(
        (
          await p.query<{ allowed: boolean }>(
            "SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",
            [signature],
          )
        ).rows[0]!.allowed,
      ).toBe(false);
    await expect(p.query('SELECT * FROM ctp_paper.admission_unknown_event')).rejects.toThrow(
      /permission denied/u,
    );
  } finally {
    await p.end();
  }
});

it('paper-unknown: additive lifecycle retains the original state hash constraint and authentic predecessor chain', async () => {
  const checks = (
    await admin.query<{
      definition: string;
    }>(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
    WHERE conrelid='ctp_paper.admission_book_event'::regclass AND contype='c'`)
  ).rows.map((r) => r.definition);
  expect(
    checks.some(
      (s) => s.includes('state_hash') && s.includes('sha256') && s.includes('state_text'),
    ),
  ).toBe(true);
  expect(
    checks.some(
      (s) =>
        s.includes('previous_revision') && s.includes('UNKNOWN') && s.includes('previous_hash'),
    ),
  ).toBe(true);
  // Preserve the published52 owner-visible BEFORE TRUNCATE guard.
  const p = await admin.connect();
  try {
    await p.query('BEGIN');
    await expect(p.query('TRUNCATE ctp_paper.reservation_state_event')).rejects.toMatchObject({
      code: '23514',
    });
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
});

// The withdrawal is a negative capability, not a terminal CANCEL or release.
// This file still uses only its isolated database; no cluster-role DDL is added.
type Withdrawal = {
  withdraw(raw: unknown, options: ReturnType<typeof io>): Promise<unknown>;
  reconcile(raw: unknown, options: ReturnType<typeof io>): Promise<unknown>;
  close(): Promise<void>;
};
async function openWithdrawal(connectionString = required('DATABASE_PAPER_ADMISSION_URL')) {
  const exports = (await import('@ctp/paper-engine/risk')) as unknown as Record<string, unknown>;
  const factory = exports['createPostgresPaperWithdrawalBarrier'];
  expect(factory, 'Real durable PAPER withdrawal factory is required').toBeTypeOf('function');
  const port = await (factory as (options: unknown) => Promise<Withdrawal>)({
    connectionString,
    environment: 'test',
  });
  handles.push(port);
  return port;
}
async function withdrawalRequest(f: Ready, reservationId: string) {
  return { ...(await unknownRequest(f, reservationId)), kind: 'PAPER_WITHDRAW_BEFORE_DISPATCH' };
}
async function withdrawalInventory(f: Ready) {
  return {
    inventory: await inventory(f),
    effects: await effects(f.c.owner.tenantId),
    rows: (
      await admin.query(
        `SELECT
        (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public."order" o WHERE "tenantId"=$1) orders,
        (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM ctp_portfolio.book b WHERE "tenantId"=$1) books,
        (SELECT jsonb_agg(to_jsonb(w) ORDER BY "holdId") FROM ctp_portfolio.hold_watermark w WHERE "tenantId"=$1) watermarks,
        (SELECT count(*)::int FROM public.submission_attempt WHERE "tenantId"=$1) attempts,
        (SELECT count(*)::int FROM public.order_event WHERE "tenantId"=$1) events`,
        [f.c.owner.tenantId],
      )
    ).rows,
  };
}

it('paper-withdrawal: irreversible NOT_SENT retains the full original hold and exact replay survives restart, pause and rule refresh', async () => {
  const port = await openWithdrawal(),
    f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    request = await withdrawalRequest(f, original.reservationId),
    before = await withdrawalInventory(f);
  await updateControl(f.c.owner.tenantId, 'PAUSED');
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  const receipt = await port.withdraw(request, io());
  expect(receipt).toMatchObject({
    outcome: 'NOT_SENT',
    collateral: 'RETAINED',
    eventId: request.eventId,
    reservationId: original.reservationId,
    orderId: f.order.id,
    intentId: f.order.intentId,
    stateRevision: '1',
    commandHash: request.admission.commandHash,
  });
  expect(await withdrawalInventory(f)).toEqual(before);
  await port.close();
  const restarted = await openWithdrawal();
  expect(await restarted.withdraw(request, io())).toEqual(receipt);
  expect(await restarted.reconcile(request, io())).toEqual({ kind: 'COMMITTED', request, receipt });
  await expect(admission.approve(await input(f), io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect((await admission.reconcileApproval(await input(f), io())).kind).toBe('COMMITTED');
  expect(await withdrawalInventory(f)).toEqual(before);
});

it('paper-withdrawal: permanent event and target conflicts cannot change collateral or make a second barrier', async () => {
  const port = await openWithdrawal(),
    f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    request = await withdrawalRequest(f, original.reservationId);
  await port.withdraw(request, io());
  const before = await withdrawalInventory(f);
  for (const changed of [
    { ...request, eventId: randomUUID() },
    { ...request, reservationId: randomUUID() },
    { ...request, admission: { ...request.admission, commandHash: 'f'.repeat(64) } },
  ])
    await expect(port.withdraw(changed, io())).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  await expect(port.withdraw({ ...request, expectedRevision: '2' }, io())).rejects.toThrow(
    'PAPER_ADMISSION_INPUT',
  );
  expect(await withdrawalInventory(f)).toEqual(before);
});

it('paper-withdrawal: concurrent distinct keys commit exactly one barrier and identical replay is idempotent', async () => {
  const a = await openWithdrawal(),
    b = await openWithdrawal(),
    f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    request = await withdrawalRequest(f, original.reservationId),
    before = await withdrawalInventory(f);
  const results = await Promise.allSettled([
    a.withdraw(request, io()),
    b.withdraw({ ...request, eventId: randomUUID() }, io()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await withdrawalInventory(f)).toEqual(before);
  expect(
    (
      await admin.query(
        'SELECT count(*)::int n FROM ctp_paper.withdrawal_barrier WHERE tenant_id=$1',
        [f.c.owner.tenantId],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
});

it('paper-withdrawal: UNKNOWN and withdrawal serialize to one winner without weakening or releasing its hold', async () => {
  const port = await openWithdrawal(),
    f = await nativeReady(),
    admission = await openAdmission(),
    lifecycle = await openLifecycle();
  const original = await admission.approve(await input(f), io()),
    request = await withdrawalRequest(f, original.reservationId),
    unknown = await unknownRequest(f, original.reservationId),
    before = await inventory(f);
  const result = await Promise.allSettled([
    port.withdraw(request, io()),
    lifecycle.markUnknown(unknown, io()),
  ]);
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await inventory(f)).toEqual(before);
  if (result[0].status === 'fulfilled')
    await expect(lifecycle.markUnknown(unknown, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  else await expect(port.withdraw(request, io())).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
});

it('paper-withdrawal: lost COMMIT returns no authority; read-only reconciliation finds one durable barrier', async () => {
  await openWithdrawal();
  const f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    request = await withdrawalRequest(f, original.reservationId),
    before = await withdrawalInventory(f),
    proxy = await registryCommitProxy(required('DATABASE_PAPER_ADMISSION_URL'), 'PAPER_ADMISSION');
  const port = await openWithdrawal(proxy.connectionString);
  try {
    proxy.arm();
    await expect(port.withdraw(request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    expect(await (await openWithdrawal()).reconcile(request, io())).toMatchObject({
      kind: 'COMMITTED',
    });
    expect(await withdrawalInventory(f)).toEqual(before);
  } finally {
    await port.close();
    await proxy.close();
  }
});

it('paper-withdrawal: MISSING and pre-abort have no effect; fixed private helpers and witness are inaccessible', async () => {
  const port = await openWithdrawal(),
    f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    request = await withdrawalRequest(f, original.reservationId),
    before = await withdrawalInventory(f);
  expect(await port.reconcile(request, io())).toEqual({ kind: 'MISSING', request });
  const abort = new AbortController();
  abort.abort();
  await expect(port.withdraw(request, io(abort.signal))).rejects.toThrow('PAPER_ADMISSION_ABORTED');
  expect(await port.reconcile(request, io())).toEqual({ kind: 'MISSING', request });
  expect(await withdrawalInventory(f)).toEqual(before);
  const runtime = new Pool({ connectionString: required('DATABASE_PAPER_ADMISSION_URL') });
  try {
    for (const signature of [
      'ctp_paper.evaluate_and_reserve_v54(jsonb)',
      'ctp_paper.reconcile_admission_v54(jsonb)',
      'ctp_paper.withdraw_before_dispatch(jsonb,boolean)',
    ])
      expect(
        (
          await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed", [
            signature,
          ])
        ).rows,
      ).toEqual([{ allowed: false }]);
    await expect(runtime.query('SELECT * FROM ctp_paper.withdrawal_barrier')).rejects.toThrow(
      /permission denied/u,
    );
  } finally {
    await runtime.end();
  }
});

it('paper-withdrawal: durable barrier rejects later dispatch, progress, order changes and synthetic terminal events', async () => {
  const port = await openWithdrawal(),
    f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    request = await withdrawalRequest(f, original.reservationId);
  await port.withdraw(request, io());
  const before = await withdrawalInventory(f);
  for (const sql of [
    `UPDATE public."order" SET status='SUBMITTING',version=1 WHERE "tenantId"=$1 AND id=$2`,
    `UPDATE ctp_execution.progress SET "nativeAt"=1,"nativeHash"=decode(repeat('a',64),'hex'),"nativeStatus"='SUBMITTED' WHERE "tenantId"=$1 AND "orderId"=$2`,
    `INSERT INTO public.order_event("tenantId","orderId",version,"previousStatus",status,source,"sourceIdentity","evidenceHash","occurredAt") VALUES($1,$2,1,'CREATED','CANCELED','TEST','withdrawal-forgery',decode(repeat('a',64),'hex'),now())`,
    `INSERT INTO public.submission_attempt("tenantId","orderId","intentId","accountId",mode,"instrumentId","operationVersion",operation,"permissionEpoch","workerId","commandHash","deadlineAt") SELECT "tenantId",id,"intentId","accountId",mode,"instrumentId",1,'PLACE',0,'test',decode(repeat('a',64),'hex'),now()+interval '1 second' FROM public."order" WHERE "tenantId"=$1 AND id=$2`,
  ]) {
    const writer = await admin.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
      await writer.query('SET LOCAL ROLE ctp_execution');
      await expect(writer.query(sql, [f.c.owner.tenantId, f.order.id])).rejects.toThrow(
        'PAPER_WITHDRAWN_NOT_SENT',
      );
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  }
  expect(await withdrawalInventory(f)).toEqual(before);
});

// Additive terminal overlay only for a genuine irreversible NOT_SENT barrier.
// No role DDL, shared-role mutation, expiry inference or caller fill authority.
type WithdrawalRelease = {
  release(raw: unknown, options: ReturnType<typeof io>): Promise<unknown>;
  reconcile(raw: unknown, options: ReturnType<typeof io>): Promise<unknown>;
  close(): Promise<void>;
};
async function openWithdrawalRelease(connectionString = required('DATABASE_PAPER_ADMISSION_URL')) {
  const exports = (await import('@ctp/paper-engine/risk')) as unknown as Record<string, unknown>;
  const factory = exports['createPostgresPaperWithdrawalRelease'];
  expect(factory, 'Trusted durable NOT_SENT release factory is required').toBeTypeOf('function');
  const port = await (factory as (options: unknown) => Promise<WithdrawalRelease>)({
    connectionString,
    environment: 'test',
  });
  handles.push(port);
  return port;
}
async function releaseFixture() {
  const f = await nativeReady(),
    admission = await openAdmission(),
    withdrawal = await openWithdrawal();
  const original = await admission.approve(await input(f), io()),
    barrier = await withdrawalRequest(f, original.reservationId);
  await withdrawal.withdraw(barrier, io());
  const request = {
    kind: 'PAPER_RELEASE_WITHDRAWN',
    admission: barrier.admission,
    reservationId: original.reservationId,
    withdrawalEventId: barrier.eventId,
    eventId: randomUUID(),
    expectedRevision: '1',
  };
  return { f, admission, withdrawal, original, barrier, request };
}
async function releaseRows(f: Ready) {
  return (
    await admin.query<{
      records: number;
      released: number;
      live: number;
      events: number;
      revision: string;
    }>(
      `SELECT
    (SELECT count(*)::int FROM ctp_paper.withdrawal_release WHERE tenant_id=$1) records,
    (SELECT count(*)::int FROM ctp_portfolio.hold_watermark WHERE "tenantId"=$1 AND released) released,
    (SELECT jsonb_array_length(state::jsonb->'holds') FROM ctp_portfolio.book WHERE "tenantId"=$1) live,
    (SELECT count(*)::int FROM ctp_portfolio.evidence WHERE "tenantId"=$1 AND payload::jsonb->>'type'='RELEASE') events,
    (SELECT revision::text FROM ctp_portfolio.book WHERE "tenantId"=$1) revision`,
      [f.c.owner.tenantId],
    )
  ).rows[0]!;
}

// PAPER unsent cancellation: tenant-local rows only, no cluster/shared-role DDL.
type UnsentCancellation = {
  cancel(raw: unknown, options: ReturnType<typeof io>): Promise<Record<string, unknown>>;
  reconcile(raw: unknown, options: ReturnType<typeof io>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};
async function openUnsentCancellation(connectionString = required('DATABASE_PAPER_ADMISSION_URL')) {
  const exports = (await import('@ctp/paper-engine/risk')) as unknown as Record<string, unknown>;
  const factory = exports['createPostgresPaperUnsentCancellation'];
  expect(factory, 'The genuine durable PAPER cancellation bridge is required').toBeTypeOf(
    'function',
  );
  const port = await (factory as (options: unknown) => Promise<UnsentCancellation>)({
    connectionString,
    environment: 'test',
  });
  handles.push(port);
  return port;
}
async function cancellationRequest(f: Ready, key = randomUUID()) {
  const { rows } = await admin.query<{ permissionEpoch: string; userSessionEpoch: string }>(
    `SELECT a."permissionEpoch"::text AS "permissionEpoch",u."sessionEpoch"::text AS "userSessionEpoch"
     FROM public.exchange_account a JOIN public."user" u ON u.id=a."tenantId" WHERE a."tenantId"=$1 AND a.id=$2`,
    [f.c.owner.tenantId, f.c.owner.accountId],
  );
  return {
    kind: 'PAPER_CANCEL_UNSENT',
    binding: f.binding,
    orderId: f.order.id,
    key,
    authorization: rows[0]!,
  };
}
async function cancellationFixture() {
  const x = await releaseFixture();
  await (await openWithdrawalRelease()).release(x.request, io());
  return { ...x, cancel: await cancellationRequest(x.f) };
}
async function cancellationRows(f: Ready) {
  return (
    await admin.query<{
      causes: number;
      intents: number;
      commands: number;
      events: number;
      attempts: number;
      outbox: number;
    }>(
      `SELECT
    (SELECT count(*)::int FROM ctp_paper.unsent_cancellation WHERE tenant_id=$1) causes,
    (SELECT count(*)::int FROM public.order_intent WHERE "tenantId"=$1 AND operation='CANCEL') intents,
    (SELECT count(*)::int FROM ctp_execution.command WHERE "tenantId"=$1 AND operation='CANCEL') commands,
    (SELECT count(*)::int FROM public.order_event WHERE "tenantId"=$1 AND source='PAPER_NOT_SENT_CANCEL') events,
    (SELECT count(*)::int FROM public.submission_attempt WHERE "tenantId"=$1) attempts,
    (SELECT count(*)::int FROM public.outbox_event WHERE "tenantId"=$1 AND "eventType"='PaperOrderCanceled') outbox`,
      [f.c.owner.tenantId],
    )
  ).rows[0]!;
}

it('paper-cancel: authentic local terminal Order has one immutable CANCEL cause and no second monetary effect or client ID', async () => {
  const port = await openUnsentCancellation(),
    { f, cancel } = await cancellationFixture(),
    before = await withdrawalInventory(f),
    money = await releaseRows(f),
    cash = await effects(f.c.owner.tenantId);
  const result = await port.cancel(cancel, io());
  expect(result).toMatchObject({
    outcome: 'NOT_SENT',
    collateral: 'RELEASED',
    orderId: f.order.id,
    placeIntentId: f.order.intentId,
    clientOrderId: f.order.command.clientOrderId,
    status: 'CANCELED',
    version: '1',
  });
  expect(result.intentId).not.toBe(f.order.intentId);
  expect(await f.orders.read(f.binding, f.order.id, io())).toEqual({
    ...f.order,
    status: 'CANCELED',
    reconciliation: 'CONSISTENT',
    version: 1,
  });
  expect(await cancellationRows(f)).toEqual({
    causes: 1,
    intents: 1,
    commands: 1,
    events: 1,
    attempts: 0,
    outbox: 1,
  });
  expect(await releaseRows(f)).toEqual(money);
  expect(await effects(f.c.owner.tenantId)).toEqual(
    cash.map((r) => ({ ...r, intents: r.intents + 1 })),
  );
  const after = await withdrawalInventory(f);
  expect(after.inventory).toEqual(before.inventory);
  const detail = (raw: unknown) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('books' in raw) ||
      !('watermarks' in raw) ||
      !('attempts' in raw) ||
      typeof raw.attempts !== 'number' ||
      !('events' in raw) ||
      typeof raw.events !== 'number'
    )
      throw Error('CANCELLATION_FIXTURE_ROW');
    return {
      books: raw.books,
      watermarks: raw.watermarks,
      attempts: raw.attempts,
      events: raw.events,
    };
  };
  const previousDetail = detail(before.rows[0]),
    currentDetail = detail(after.rows[0]);
  expect(currentDetail).toEqual({ ...previousDetail, events: previousDetail.events + 1 });
  const restricted = new Pool({ connectionString: required('DATABASE_PAPER_ADMISSION_URL') });
  try {
    await expect(restricted.query('SELECT * FROM ctp_paper.unsent_cancellation')).rejects.toThrow(
      /permission denied/u,
    );
    for (const signature of [
      'ctp_paper.cancel_unsent(jsonb,boolean)',
      'ctp_paper.validate_unsent_cancellation(uuid,uuid)',
      'ctp_paper.validate_unsent_cancel_origin(uuid,uuid)',
      'ctp_paper.evaluate_and_reserve_v56(jsonb)',
    ])
      expect(
        (
          await restricted.query(
            "SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",
            [signature],
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
  } finally {
    await restricted.end();
  }
  for (const sql of [
    `UPDATE public."order" SET status='SUBMITTING',version=2 WHERE "tenantId"=$1 AND id=$2`,
    `UPDATE ctp_execution.progress SET "nativeAt"=1,"nativeHash"=decode(repeat('a',64),'hex'),"nativeStatus"='SUBMITTED' WHERE "tenantId"=$1 AND "orderId"=$2`,
    `INSERT INTO public.order_event("tenantId","orderId",version,"previousStatus",status,source,"sourceIdentity","evidenceHash","occurredAt") VALUES($1,$2,2,'CANCELED','SUBMITTED','PAPER_NOT_SENT_CANCEL','forged',decode(repeat('a',64),'hex'),now())`,
    `INSERT INTO public.submission_attempt("tenantId","orderId","intentId","accountId",mode,"instrumentId","operationVersion",operation,"permissionEpoch","workerId","commandHash","deadlineAt") SELECT "tenantId",id,"intentId","accountId",mode,"instrumentId",2,'PLACE',0,'test',decode(repeat('a',64),'hex'),now()+interval '1 second' FROM public."order" WHERE "tenantId"=$1 AND id=$2`,
  ]) {
    const writer = await admin.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.paper_cancel','true',true)",
        [f.c.owner.tenantId],
      );
      await writer.query('SET LOCAL ROLE ctp_execution');
      await expect(writer.query(sql, [f.c.owner.tenantId, f.order.id])).rejects.toThrow(
        'PAPER_WITHDRAWN_NOT_SENT',
      );
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  }
  expect(await withdrawalInventory(f)).toEqual(after);
});

it('paper-cancel: permanent exact replay survives restart, terminal state, pause and rule replacement; current epochs remain mandatory', async () => {
  const port = await openUnsentCancellation(),
    { f, cancel } = await cancellationFixture();
  const receipt = await port.cancel(cancel, io());
  await port.close();
  await updateControl(f.c.owner.tenantId, 'PAUSED');
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  const restarted = await openUnsentCancellation(),
    before = await cancellationRows(f);
  expect(await restarted.cancel(cancel, io())).toEqual(receipt);
  expect(await restarted.reconcile(cancel, io())).toEqual({
    kind: 'COMMITTED',
    request: { binding: f.binding, orderId: f.order.id, operation: 'CANCEL', key: cancel.key },
    receipt,
  });
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.c.owner.accountId],
  );
  await expect(restarted.cancel(cancel, io())).rejects.toThrow('PAPER_ADMISSION_SCOPE');
  expect(await restarted.cancel(await cancellationRequest(f, cancel.key), io())).toEqual(receipt);
  expect(await cancellationRows(f)).toEqual(before);
});

it('paper-cancel: permanent key conflicts and second keys cannot manufacture another cancellation; readonly missing stays missing', async () => {
  const port = await openUnsentCancellation(),
    { f, cancel } = await cancellationFixture();
  const semantic = {
    binding: f.binding,
    orderId: f.order.id,
    operation: 'CANCEL',
    key: cancel.key,
  };
  expect(await port.reconcile(cancel, io())).toEqual({ kind: 'MISSING', request: semantic });
  expect(await cancellationRows(f)).toEqual({
    causes: 0,
    intents: 0,
    commands: 0,
    events: 0,
    attempts: 0,
    outbox: 0,
  });
  await port.cancel(cancel, io());
  await expect(port.cancel({ ...cancel, orderId: randomUUID() }, io())).rejects.toThrow(
    'PAPER_ADMISSION_CONFLICT',
  );
  await expect(port.cancel({ ...cancel, key: randomUUID() }, io())).rejects.toThrow(
    'PAPER_ADMISSION_CONFLICT',
  );
  expect(await cancellationRows(f)).toMatchObject({ causes: 1, intents: 1, events: 1 });
});

it('paper-cancel: concurrent exact replay has one result; concurrent distinct keys have one winner', async () => {
  const a = await openUnsentCancellation(),
    b = await openUnsentCancellation(),
    x = await cancellationFixture();
  const exact = await Promise.all([a.cancel(x.cancel, io()), b.cancel(x.cancel, io())]);
  expect(exact[0]).toEqual(exact[1]);
  expect(await cancellationRows(x.f)).toMatchObject({ causes: 1, intents: 1, events: 1 });
  const y = await cancellationFixture(),
    competing = await Promise.allSettled([
      a.cancel(y.cancel, io()),
      b.cancel({ ...y.cancel, key: randomUUID() }, io()),
    ]);
  expect(competing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(competing.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await cancellationRows(y.f)).toMatchObject({ causes: 1, intents: 1, events: 1 });
});

it('paper-cancel: authentic terminal cause keeps current inventory healthy for subsequent admission without resurrecting released collateral', async () => {
  const port = await openUnsentCancellation(),
    { f, admission, cancel } = await cancellationFixture();
  await port.cancel(cancel, io());
  const second = await f.orders.create(
    f.binding,
    {
      ...f.draft,
      key: randomUUID(),
      order: {
        ...f.draft.order,
        type: 'LIMIT',
        limitPrice: parseDecimal('10.5'),
        timeInForce: 'GTC',
      },
    },
    io(),
  );
  await nextFixtureMarketObservation(f);
  await runtimeEvidence(f);
  await admission.approve(await input(f, second), io());
  expect(await inventory(f)).toMatchObject({
    reservations: 2,
    decisions: 2,
    issuance: 2,
    holds: 1,
    ledger: 1,
    entries: 2,
  });
  expect(await releaseRows(f)).toMatchObject({ records: 1, released: 1, live: 1, events: 1 });
});

it('paper-cancel: absent release, UNKNOWN and revoked ownership cannot authorize a local terminal outcome', async () => {
  const port = await openUnsentCancellation(),
    { f, request } = await releaseFixture(),
    cancel = await cancellationRequest(f);
  await expect(port.cancel(cancel, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  await (await openWithdrawalRelease()).release(request, io());
  // A matching self-hash and table-writer authority do not authenticate a
  // fabricated private terminal cause or open the common withdrawal guard.
  const forger = await admin.connect(),
    forgedIntent = randomUUID();
  try {
    await forger.query('BEGIN');
    await forger.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await forger.query(
      `INSERT INTO ctp_paper.unsent_cancellation
      (tenant_id,order_id,place_intent_id,intent_id,event_id,reservation_id,key,request,before_order,intent_row,command_row,event_row,response,response_hash,observed_ms,permission_epoch,session_epoch)
      SELECT o."tenantId",o.id,o."intentId",$3,gen_random_uuid(),$4,'forged-cancel',
       jsonb_build_object('binding',$5::jsonb,'orderId',o.id::text,'operation','CANCEL','key','forged-cancel'),to_jsonb(o),
       '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,sha256(convert_to('{}','UTF8')),floor(extract(epoch FROM clock_timestamp())*1000)::bigint,0,0
      FROM public."order" o WHERE o."tenantId"=$1 AND o.id=$2`,
      [
        f.c.owner.tenantId,
        f.order.id,
        forgedIntent,
        request.reservationId,
        JSON.stringify(f.binding),
      ],
    );
    await expect(
      forger.query(
        `INSERT INTO public.order_intent
      SELECT (jsonb_populate_record(NULL::public.order_intent,to_jsonb(i)||jsonb_build_object('id',$3::text,'targetOrderId',$2::text,'operation','CANCEL','idempotencyKey','forged-cancel'))).*
      FROM public.order_intent i WHERE i."tenantId"=$1 AND i.id=$4`,
        [f.c.owner.tenantId, f.order.id, forgedIntent, f.order.intentId],
      ),
    ).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  } finally {
    await forger.query('ROLLBACK');
    forger.release();
  }
  await admin.query('UPDATE public."user" SET "sessionEpoch"="sessionEpoch"+1 WHERE id=$1', [
    f.c.owner.tenantId,
  ]);
  await expect(port.cancel(cancel, io())).rejects.toThrow('PAPER_ADMISSION_SCOPE');
  const other = await nativeReady(),
    grant = await (await openAdmission()).approve(await input(other), io());
  await (await openLifecycle()).markUnknown(await unknownRequest(other, grant.reservationId), io());
  await expect(port.cancel(await cancellationRequest(other), io())).rejects.toThrow(
    'PAPER_ADMISSION_EVIDENCE',
  );
  expect(await cancellationRows(f)).toMatchObject({ causes: 0, intents: 0, events: 0 });
  expect(await cancellationRows(other)).toMatchObject({ causes: 0, intents: 0, events: 0 });
});

it('paper-cancel: lost COMMIT returns no receipt, readonly reconciliation recovers the only result after restart without mutation retry', async () => {
  const { f, cancel } = await cancellationFixture(),
    proxy = await registryCommitProxy(required('DATABASE_PAPER_ADMISSION_URL'), 'PAPER_ADMISSION');
  try {
    const port = await openUnsentCancellation(proxy.connectionString);
    proxy.arm();
    await expect(port.cancel(cancel, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await port.close();
    const restarted = await openUnsentCancellation(),
      found = await restarted.reconcile(cancel, io());
    expect(found.kind).toBe('COMMITTED');
    expect(found.receipt).toMatchObject({ status: 'CANCELED', orderId: f.order.id });
    expect(await cancellationRows(f)).toEqual({
      causes: 1,
      intents: 1,
      commands: 1,
      events: 1,
      attempts: 0,
      outbox: 1,
    });
  } finally {
    await proxy.close();
  }
});

it('paper-cancel: durable replay and private cause validation survive session timezone replacement without changing semantics or caller settings', async () => {
  const { f, cancel } = await cancellationFixture(),
    money = await releaseRows(f);
  const runtime = new Pool({
    connectionString: required('DATABASE_PAPER_ADMISSION_URL'),
    max: 1,
    query_timeout: 5000,
    connectionTimeoutMillis: 1000,
  });
  let receipt: unknown;
  try {
    const creation = await runtime.connect();
    try {
      await creation.query('BEGIN');
      await creation.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('TimeZone','Pacific/Honolulu',true)",
        [f.c.owner.tenantId],
      );
      const created = (
        await creation.query<{ result: { kind: string; receipt: unknown } }>(
          'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) result',
          [JSON.stringify(cancel)],
        )
      ).rows[0]!.result;
      await creation.query('COMMIT');
      expect(created.kind).toBe('CANCELED');
      expect(created.receipt).toMatchObject({
        outcome: 'NOT_SENT',
        status: 'CANCELED',
        orderId: f.order.id,
      });
      receipt = created.receipt;
    } finally {
      await creation.query('ROLLBACK');
      creation.release();
    }
    for (const zone of ['Pacific/Honolulu', 'Asia/Tokyo', 'UTC']) {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('TimeZone',$2,true)",
          [f.c.owner.tenantId, zone],
        );
        const found = (
          await client.query<{ result: { kind: string; receipt: unknown } }>(
            'SELECT ctp_paper.reconcile_admission($1::jsonb) result',
            [JSON.stringify(cancel)],
          )
        ).rows[0]!.result;
        expect(found.kind).toBe('COMMITTED');
        expect(found.receipt).toEqual(receipt);
        const replay = (
          await client.query<{ result: { kind: string; receipt: unknown } }>(
            'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) result',
            [JSON.stringify(cancel)],
          )
        ).rows[0]!.result;
        expect(replay.kind).toBe('CANCELED');
        expect(replay.receipt).toEqual(receipt);
        expect(
          (await client.query<{ zone: string }>("SELECT current_setting('TimeZone') zone")).rows,
        ).toEqual([{ zone }]);
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  } finally {
    await runtime.end();
  }
  const restarted = await openUnsentCancellation();
  expect(await restarted.reconcile(cancel, io())).toMatchObject({ kind: 'COMMITTED', receipt });
  expect(await cancellationRows(f)).toMatchObject({
    causes: 1,
    intents: 1,
    commands: 1,
    events: 1,
    attempts: 0,
    outbox: 1,
  });
  expect(await releaseRows(f)).toEqual(money);
});

it('paper-release: authentic NOT_SENT releases one full hold atomically without cash posting; permanent replay survives restart, pause and rule refresh', async () => {
  const port = await openWithdrawalRelease(),
    { f, admission, request } = await releaseFixture(),
    before = await inventory(f);
  await updateControl(f.c.owner.tenantId, 'PAUSED');
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  const receipt = await port.release(request, io());
  expect(receipt).toMatchObject({
    outcome: 'NOT_SENT',
    collateral: 'RELEASED',
    eventId: request.eventId,
    withdrawalEventId: request.withdrawalEventId,
    reservationId: request.reservationId,
    orderId: f.order.id,
    intentId: f.order.intentId,
    commandHash: request.admission.commandHash,
    releaseVersion: '1',
    bookRevision: '3',
  });
  expect(await inventory(f)).toEqual({ ...before, holds: 0 });
  expect(await releaseRows(f)).toEqual({
    records: 1,
    released: 1,
    live: 0,
    events: 1,
    revision: '3',
  });
  await port.close();
  const restarted = await openWithdrawalRelease(),
    stable = await withdrawalInventory(f);
  expect(await restarted.release(request, io())).toEqual(receipt);
  expect(await restarted.reconcile(request, io())).toEqual({ kind: 'COMMITTED', request, receipt });
  await expect(admission.approve(await input(f), io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect((await admission.reconcileApproval(await input(f), io())).kind).toBe('COMMITTED');
  expect(await withdrawalInventory(f)).toEqual(stable);
});

it('paper-release: new risk uses current terminal overlay exactly once while original allocation and cash remain immutable', async () => {
  const port = await openWithdrawalRelease(),
    { f, admission, request } = await releaseFixture();
  const released = await port.release(request, io());
  // Match the existing Portfolio acknowledge operation: delivery is not
  // durable financial authority and must not destroy terminal provenance.
  const delivery = await admin.connect();
  try {
    await delivery.query('BEGIN');
    await delivery.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await delivery.query('SET LOCAL ROLE ctp_portfolio');
    expect(
      (
        await delivery.query(
          'DELETE FROM ctp_portfolio.outbox WHERE "tenantId"=$1 AND type=\'RELEASE\' RETURNING id',
          [f.c.owner.tenantId],
        )
      ).rows,
    ).toHaveLength(1);
    await delivery.query('COMMIT');
  } finally {
    await delivery.query('ROLLBACK');
    delivery.release();
  }
  expect(await port.release(request, io())).toEqual(released);
  const second = await f.orders.create(
    f.binding,
    {
      ...f.draft,
      key: randomUUID(),
      order: {
        ...f.draft.order,
        type: 'LIMIT',
        limitPrice: parseDecimal('10.5'),
        timeInForce: 'GTC',
      },
    },
    io(),
  );
  await nextFixtureMarketObservation(f);
  await runtimeEvidence(f);
  await admission.approve(await input(f, second), io());
  expect(await inventory(f)).toMatchObject({
    reservations: 2,
    decisions: 2,
    issuance: 2,
    holds: 1,
    debits: ['5.25525', '5.25525'],
    ledger: 1,
    entries: 2,
  });
  expect(await releaseRows(f)).toEqual({
    records: 1,
    released: 1,
    live: 1,
    events: 1,
    revision: '4',
  });
  const payload = (
    await admin.query<{
      source: {
        inventory: { evidence: { holds: unknown[]; reservations: unknown[]; orders: unknown[] } };
      };
    }>('SELECT source FROM ctp_paper.admission_issuance WHERE tenant_id=$1 AND order_id=$2', [
      f.c.owner.tenantId,
      second.id,
    ])
  ).rows[0]!;
  expect(payload.source.inventory.evidence.holds).toEqual([]);
  expect(payload.source.inventory.evidence.reservations).toEqual([]);
  expect(payload.source.inventory.evidence.orders).toEqual([]);
});

it('paper-release: concurrent distinct keys have one winner; replay/conflicts cannot release twice or resurrect the hold', async () => {
  const a = await openWithdrawalRelease(),
    b = await openWithdrawalRelease(),
    { f, request } = await releaseFixture();
  const result = await Promise.allSettled([
    a.release(request, io()),
    b.release({ ...request, eventId: randomUUID() }, io()),
  ]);
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await releaseRows(f)).toEqual({
    records: 1,
    released: 1,
    live: 0,
    events: 1,
    revision: '3',
  });
  const stable = await withdrawalInventory(f);
  for (const changed of [
    { ...request, reservationId: randomUUID() },
    { ...request, withdrawalEventId: randomUUID() },
    { ...request, admission: { ...request.admission, commandHash: 'f'.repeat(64) } },
  ])
    await expect(a.release(changed, io())).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  await expect(
    (await openLifecycle()).markUnknown(await unknownRequest(f, request.reservationId), io()),
  ).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(await withdrawalInventory(f)).toEqual(stable);
});

it('paper-release: lost COMMIT grants no result; readonly reconciliation finds one durable release without a retry', async () => {
  await openWithdrawalRelease();
  const { f, request } = await releaseFixture(),
    before = await inventory(f),
    proxy = await registryCommitProxy(required('DATABASE_PAPER_ADMISSION_URL'), 'PAPER_ADMISSION');
  const port = await openWithdrawalRelease(proxy.connectionString);
  try {
    proxy.arm();
    await expect(port.release(request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    expect(await (await openWithdrawalRelease()).reconcile(request, io())).toMatchObject({
      kind: 'COMMITTED',
      request,
      receipt: { collateral: 'RELEASED' },
    });
    expect(await inventory(f)).toEqual({ ...before, holds: 0 });
    expect(await releaseRows(f)).toEqual({
      records: 1,
      released: 1,
      live: 0,
      events: 1,
      revision: '3',
    });
  } finally {
    await port.close();
    await proxy.close();
  }
});

it('paper-release: no barrier, UNKNOWN, pre-abort and MISSING cannot authorize any release', async () => {
  const port = await openWithdrawalRelease(),
    f = await nativeReady(),
    admission = await openAdmission();
  const original = await admission.approve(await input(f), io()),
    barrier = await withdrawalRequest(f, original.reservationId),
    request = {
      kind: 'PAPER_RELEASE_WITHDRAWN',
      admission: barrier.admission,
      reservationId: original.reservationId,
      withdrawalEventId: barrier.eventId,
      eventId: randomUUID(),
      expectedRevision: '1',
    },
    before = await withdrawalInventory(f);
  expect(await port.reconcile(request, io())).toEqual({ kind: 'MISSING', request });
  await expect(port.release(request, io())).rejects.toThrow('PAPER_ADMISSION_MISSING');
  const abort = new AbortController();
  abort.abort();
  await expect(port.release(request, io(abort.signal))).rejects.toThrow('PAPER_ADMISSION_ABORTED');
  expect(await withdrawalInventory(f)).toEqual(before);
  await (await openLifecycle()).markUnknown(await unknownRequest(f, original.reservationId), io());
  const unknown = await withdrawalInventory(f);
  await expect(port.release(request, io())).rejects.toThrow(/^PAPER_ADMISSION_/u);
  expect(await withdrawalInventory(f)).toEqual(unknown);
  expect(await releaseRows(f)).toMatchObject({ records: 0, released: 0, live: 1, events: 0 });
});

it('paper-release: private tombstone is inaccessible and stale common writers cannot erase or resurrect released history', async () => {
  const port = await openWithdrawalRelease(),
    { f, request } = await releaseFixture();
  await port.release(request, io());
  const runtime = new Pool({ connectionString: required('DATABASE_PAPER_ADMISSION_URL') });
  try {
    await expect(runtime.query('SELECT * FROM ctp_paper.withdrawal_release')).rejects.toThrow(
      /permission denied/u,
    );
    for (const signature of [
      'ctp_paper.release_withdrawn(jsonb,boolean)',
      'ctp_paper.evaluate_and_reserve_v55(jsonb)',
      'ctp_paper.reconcile_admission_v55(jsonb)',
    ])
      expect(
        (
          await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed", [
            signature,
          ])
        ).rows,
      ).toEqual([{ allowed: false }]);
  } finally {
    await runtime.end();
  }
  await expect(admin.query('TRUNCATE ctp_paper.withdrawal_barrier')).rejects.toMatchObject({
    code: '23514',
  }); // Preserve published55 BEFORE TRUNCATE semantics, including after a release.
  const stable = await withdrawalInventory(f);
  const writer = await admin.connect();
  try {
    await writer.query('BEGIN');
    await writer.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await writer.query('SET LOCAL ROLE ctp_portfolio');
    await expect(
      writer.query(
        `UPDATE ctp_portfolio.hold_watermark SET timestamp=timestamp+1,released=false WHERE "tenantId"=$1`,
        [f.c.owner.tenantId],
      ),
    ).rejects.toThrow(/Hold watermark cannot regress/u);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
  expect(await withdrawalInventory(f)).toEqual(stable);
});

// BEGIN PAPER EXECUTION SOURCE TESTS
// Initial server-owned execution inventory. These are genuine accepted Order /
// admission ports, not owner-inserted JSON certificates or a financial writer.
interface ExecutionCandidateRead {
  read(
    request: unknown,
    options: ReturnType<typeof io>,
  ): Promise<{
    kind: string;
    asOf: number;
    candidates: {
      orderId: string;
      intentId: string;
      admissionSequence: string;
      admittedAt: number;
    }[];
    portfolio: { holds: unknown[] };
  }>;
  close(): Promise<void>;
}
async function openExecutionSource(connectionString = required('DATABASE_PAPER_ADMISSION_URL')) {
  const factory = (paperSourceServer as unknown as Record<string, unknown>)[
    'createPostgresPaperExecutionSource'
  ];
  if (typeof factory !== 'function') throw Error('PAPER_EXECUTION_SOURCE_MISSING');
  const port = await (factory as (o: unknown) => Promise<ExecutionCandidateRead>)({
    connectionString,
    environment: 'test',
  });
  handles.push(port);
  return port;
}
async function executionRequest(f: Ready, order = f.order) {
  const { state, ...admission } = await input(f, order);
  const auth = (
    await admin.query<{ permissionEpoch: string; userSessionEpoch: string }>(
      'SELECT a."permissionEpoch"::text "permissionEpoch",u."sessionEpoch"::text "userSessionEpoch" FROM public.exchange_account a JOIN public."user" u ON u.id=a."tenantId" WHERE a."tenantId"=$1 AND a.id=$2',
      [f.c.owner.tenantId, f.c.owner.accountId],
    )
  ).rows[0]!;
  return {
    kind: 'PAPER_EXECUTION_CAPTURE',
    admission: { ...admission, orderId: state.id },
    authorization: auth,
  };
}
async function executionPair() {
  const f = await nativeReady(),
    admission = await openAdmission();
  const other = await f.orders.create(
    f.binding,
    {
      ...f.draft,
      key: randomUUID(),
      order: {
        ...f.draft.order,
        type: 'LIMIT',
        limitPrice: parseDecimal('10.5'),
        timeInForce: 'GTC',
      },
    },
    io(),
  );
  const second = await admission.approve(await input(f, other), io());
  const first = await admission.approve(await input(f), io());
  return { f, admission, other, first, second, request: await executionRequest(f) };
}
it('paper-execution: fixed SQL route captures a genuinely issued source without a financial effect', async () => {
  const ready = await nativeReady(),
    marketOrder = await ready.orders.create(
      ready.binding,
      {
        ...ready.draft,
        key: randomUUID(),
        order: { ...ready.draft.order, type: 'MARKET', limitPrice: null, timeInForce: null },
      },
      io(),
    ),
    f = ready,
    admission = await openAdmission();
  // The fixture's wide lifetime price bounds cannot prove MARKET min/max
  // notional. Preserve that Risk rejection; it is not a capture permission.
  const rejectedBefore = await withdrawalInventory(f);
  await expect(admission.approve(await input(f, marketOrder), io())).rejects.toThrow(
    'PAPER_ADMISSION_LIMIT',
  );
  expect(await withdrawalInventory(f)).toEqual(rejectedBefore);
  await admission.approve(await input(f), io());
  const request = await executionRequest(f),
    before = await withdrawalInventory(f),
    runtime = new Pool({
      connectionString: required('DATABASE_PAPER_ADMISSION_URL'),
      max: 1,
      query_timeout: 3000,
    });
  const c = await runtime.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    const result = (
      await c.query<{ result: { kind: string; candidates: { orderId: string }[] } }>(
        'SELECT ctp_paper.reconcile_admission($1::jsonb) result',
        [JSON.stringify(request)],
      )
    ).rows[0]!.result;
    expect(result.kind).toBe('PAPER_EXECUTION_CAPTURE');
    expect(result.candidates.map((x: { orderId: string }) => x.orderId)).toEqual([f.order.id]);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await runtime.end();
  }
  expect(await withdrawalInventory(f)).toEqual(before);
});
it('paper-execution: complete immutable FIFO follows admission rather than draft creation and survives new connections', async () => {
  const port = await openExecutionSource(),
    { f, other, request } = await executionPair(),
    before = await withdrawalInventory(f);
  const result = await port.read(request, io());
  expect(result.kind).toBe('PAPER_EXECUTION_SOURCE');
  expect(result.candidates.map((c) => c.orderId)).toEqual([other.id, f.order.id]);
  expect(
    BigInt(result.candidates[0]!.admissionSequence) <
      BigInt(result.candidates[1]!.admissionSequence),
  ).toBe(true);
  expect(result.portfolio.holds).toHaveLength(2);
  await port.close();
  const restarted = await openExecutionSource();
  expect((await restarted.read(request, io())).candidates).toEqual(result.candidates);
  expect(await withdrawalInventory(f)).toEqual(before);
});
it('paper-execution: reading cannot adopt a previously unadopted account or omit it from tenant inventory', async () => {
  const port = await openExecutionSource(),
    f = await nativeReady(),
    admission = await openAdmission();
  await admission.approve(await input(f), io());
  await anotherAccount(f, true);
  const before = await withdrawalInventory(f);
  const heads = () =>
    admin.query(
      'SELECT tenant_id::text,book_id::text,revision::text FROM ctp_paper.admission_book_head WHERE tenant_id=$1 ORDER BY book_id',
      [f.c.owner.tenantId],
    );
  const stable = (await heads()).rows;
  await expect(port.read(await executionRequest(f), io())).rejects.toThrow(
    'PAPER_ADMISSION_EVIDENCE',
  );
  expect((await heads()).rows).toEqual(stable);
  expect(await withdrawalInventory(f)).toEqual(before);
});
it('paper-execution: UNKNOWN is never silently dropped from a complete contender source', async () => {
  const port = await openExecutionSource(),
    { f, other, second, request } = await executionPair();
  await (
    await openLifecycle()
  ).markUnknown(await unknownRequest({ ...f, order: other }, second.reservationId), io());
  const before = await withdrawalInventory(f);
  await expect(port.read(request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(await withdrawalInventory(f)).toEqual(before);
});
it('paper-execution: private NOT_SENT exclusion retains all collateral and a withdrawn target cannot become executable', async () => {
  const port = await openExecutionSource(),
    { f, other, second, request } = await executionPair();
  await (
    await openWithdrawal()
  ).withdraw(await withdrawalRequest({ ...f, order: other }, second.reservationId), io());
  const before = await withdrawalInventory(f),
    result = await port.read(request, io());
  expect(result.candidates.map((c) => c.orderId)).toEqual([f.order.id]);
  expect(result.portfolio.holds).toHaveLength(2);
  await expect(port.read(await executionRequest(f, other), io())).rejects.toThrow(
    'PAPER_ADMISSION_EVIDENCE',
  );
  expect(await withdrawalInventory(f)).toEqual(before);
});
it('paper-execution: stale authorization and lost COMMIT produce no evidence or monetary mutation; retry is readonly', async () => {
  const normal = await openExecutionSource(),
    f = await nativeReady(),
    admission = await openAdmission();
  await admission.approve(await input(f), io());
  const request = await executionRequest(f),
    before = await withdrawalInventory(f);
  await expect(
    normal.read(
      {
        ...request,
        authorization: {
          ...request.authorization,
          permissionEpoch: (BigInt(request.authorization.permissionEpoch) + 1n).toString(),
        },
      },
      io(),
    ),
  ).rejects.toThrow('PAPER_ADMISSION_SCOPE');
  const proxy = await registryCommitProxy(
    required('DATABASE_PAPER_ADMISSION_URL'),
    'PAPER_EXECUTION_SOURCE',
  );
  const uncertain = await openExecutionSource(proxy.connectionString);
  try {
    proxy.arm();
    await expect(uncertain.read(request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
  } finally {
    await uncertain.close();
    await proxy.close();
  }
  expect((await normal.read(request, io())).candidates.map((c) => c.orderId)).toEqual([f.order.id]);
  expect(await withdrawalInventory(f)).toEqual(before);
});
// END PAPER EXECUTION SOURCE TESTS
// BEGIN PAPER ATTEMPT JOURNAL TESTS
interface AttemptJournal {
  prepare(raw: unknown, context: ReturnType<typeof io>): Promise<PaperExecutionAttempt>;
  read(
    raw: unknown,
    context: ReturnType<typeof io>,
  ): Promise<{
    kind: 'MISSING' | 'COMMITTED';
    preparation?: PaperExecutionAttempt;
    state?: PaperExecutionAttempt;
    withdrawal?: { eventId: string };
  }>;
  stopBeforeStart(raw: unknown, context: ReturnType<typeof io>): Promise<PaperExecutionAttempt>;
  reconcileStop(raw: unknown, context: ReturnType<typeof io>): ReturnType<AttemptJournal['read']>;
  close(): Promise<void>;
}
async function openAttemptJournal(connectionString = required('DATABASE_PAPER_ADMISSION_URL')) {
  const factory = (paperSourceServer as unknown as Record<string, unknown>)[
    'createPostgresPaperAttemptJournal'
  ];
  if (typeof factory !== 'function') throw Error('PAPER_ATTEMPT_JOURNAL_MISSING');
  const port = await (factory as (options: unknown) => Promise<AttemptJournal>)({
    connectionString,
    environment: 'test',
  });
  handles.push(port);
  return port;
}
async function attemptRequest(f: Ready, key = randomUUID()) {
  return { ...(await executionRequest(f)), kind: 'PAPER_ATTEMPT_PREPARE', key };
}
const stopRequest = (r: Awaited<ReturnType<typeof attemptRequest>>, reason = 'CANCELLED') => ({
  ...r,
  kind: 'PAPER_ATTEMPT_STOP',
  stopKey: randomUUID(),
  reason,
});
it('paper-attempt-journal: fixed runtime SQL route persists a real preparation without a financial effect or dispatch permit', async () => {
  const f = await nativeReady();
  await (await openAdmission()).approve(await input(f), io());
  const request = await attemptRequest(f),
    before = await withdrawalInventory(f);
  const runtime = new Pool({ connectionString: required('DATABASE_PAPER_ADMISSION_URL'), max: 1 });
  const c = await runtime.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    const r = (
      await c.query<{ result: { kind: string; preparation: PaperExecutionAttempt } }>(
        'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) result',
        [JSON.stringify(request)],
      )
    ).rows[0]!.result;
    expect(r.kind).toBe('PREPARED');
    expect(r.preparation.phase).toBe('PREPARED');
    expect(r.preparation.request.admission.orderId).toBe(f.order.id);
    expect(r.preparation.startedAt).toBeNull();
    expect(r.preparation).not.toHaveProperty('permit');
    await c.query('COMMIT');
    expect(await withdrawalInventory(f)).toEqual(before);
    expect(await (await openAttemptJournal()).prepare(request, io())).toEqual(r.preparation);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await runtime.end();
  }
});
it('paper-attempt-journal: concurrent exact replay preserves one immutable attempt and rejects another key for the intent', async () => {
  const port = await openAttemptJournal(),
    f = await nativeReady();
  await (await openAdmission()).approve(await input(f), io());
  const request = await attemptRequest(f),
    before = await withdrawalInventory(f);
  const [a, b] = await Promise.all([port.prepare(request, io()), port.prepare(request, io())]);
  expect(a).toEqual(b);
  expect(await (await openAttemptJournal()).read(request, io())).toMatchObject({
    kind: 'COMMITTED',
    preparation: a,
    state: a,
  });
  await expect(port.prepare({ ...request, key: randomUUID() }, io())).rejects.toThrow(
    'PAPER_ADMISSION_CONFLICT',
  );
  expect(await withdrawalInventory(f)).toEqual(before);
});
it('paper-attempt-journal: current ownership epochs precede historical replay but refreshed rules cannot rewrite the original preparation', async () => {
  const port = await openAttemptJournal(),
    f = await nativeReady();
  await (await openAdmission()).approve(await input(f), io());
  const request = await attemptRequest(f),
    a = await port.prepare(request, io());
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.c.owner.accountId],
  );
  await expect(port.read(request, io())).rejects.toThrow('PAPER_ADMISSION_SCOPE');
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    a.request.admission.dbRuleId,
  ]);
  const current = await attemptRequest(f, request.key);
  expect(await port.prepare(current, io())).toEqual(a);
  await expect(port.prepare({ ...current, key: randomUUID() }, io())).rejects.toThrow(
    'PAPER_ADMISSION_CONFLICT',
  );
});
it('paper-attempt-journal: STOP atomically shares the real withdrawal barrier, retains collateral and preserves original preparation replay', async () => {
  const port = await openAttemptJournal(),
    f = await nativeReady();
  await (await openAdmission()).approve(await input(f), io());
  const request = await attemptRequest(f),
    preparation = await port.prepare(request, io()),
    before = await withdrawalInventory(f),
    stop = stopRequest(request);
  const state = await port.stopBeforeStart(stop, io());
  expect(state).toMatchObject({ phase: 'NOT_SENT', revision: '2', startedAt: null });
  expect(await withdrawalInventory(f)).toEqual(before);
  expect(await port.prepare(request, io())).toEqual(preparation);
  expect(await port.read(request, io())).toMatchObject({
    kind: 'COMMITTED',
    state,
    withdrawal: { eventId: state.lastEvent.id },
  });
  expect(await port.reconcileStop(stop, io())).toMatchObject({ kind: 'COMMITTED', state });
  await expect(port.stopBeforeStart({ ...stop, reason: 'CONTROL' }, io())).rejects.toThrow(
    'PAPER_ADMISSION_CONFLICT',
  );
  await expect((await openExecutionSource()).read(await executionRequest(f), io())).rejects.toThrow(
    /PAPER_ADMISSION/,
  );
});
it('paper-attempt-journal: UNKNOWN and STOP race with one durable cause and no weakening or second ledger effect', async () => {
  const port = await openAttemptJournal(),
    lifecycle = await openLifecycle(),
    f = await nativeReady();
  const grant = await (await openAdmission()).approve(await input(f), io()),
    request = await attemptRequest(f);
  await port.prepare(request, io());
  const before = await withdrawalInventory(f),
    stop = stopRequest(request),
    unknown = await unknownRequest(f, grant.reservationId);
  const outcomes = await Promise.allSettled([
    port.stopBeforeStart(stop, io()),
    lifecycle.markUnknown(unknown, io()),
  ]);
  expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  if (outcomes[0].status === 'fulfilled') {
    await expect(lifecycle.markUnknown(unknown, io())).rejects.toThrow(/PAPER_ADMISSION/);
    expect(await withdrawalInventory(f)).toEqual(before);
  } else {
    await expect(port.stopBeforeStart(stop, io())).rejects.toThrow(/PAPER_ADMISSION/);
    expect((await port.read(request, io())).state?.phase).toBe('PREPARED');
  }
});
it('paper-attempt-journal: a legacy withdrawal supplies the same immutable negative cause after restart', async () => {
  const port = await openAttemptJournal(),
    f = await nativeReady();
  const grant = await (await openAdmission()).approve(await input(f), io()),
    request = await attemptRequest(f);
  const preparation = await port.prepare(request, io());
  const barrier = await (
    await openWithdrawal()
  ).withdraw(await withdrawalRequest(f, grant.reservationId), io());
  const before = await withdrawalInventory(f),
    stop = stopRequest(request);
  const state = await (await openAttemptJournal()).stopBeforeStart(stop, io());
  expect(barrier).toMatchObject({ eventId: state.lastEvent.id });
  expect(await port.prepare(request, io())).toEqual(preparation);
  expect(await withdrawalInventory(f)).toEqual(before);
  await (
    await openWithdrawalRelease()
  ).release(
    {
      kind: 'PAPER_RELEASE_WITHDRAWN',
      admission: request.admission,
      reservationId: grant.reservationId,
      withdrawalEventId: state.lastEvent.id,
      eventId: randomUUID(),
      expectedRevision: '1',
    },
    io(),
  );
  await (await openUnsentCancellation()).cancel(await cancellationRequest(f), io());
  const terminal = await withdrawalInventory(f);
  expect(await port.prepare(request, io())).toEqual(preparation);
  expect(await port.stopBeforeStart(stop, io())).toEqual(state);
  expect(await port.read(request, io())).toMatchObject({ kind: 'COMMITTED', state });
  expect(await withdrawalInventory(f)).toEqual(terminal);
});
it('paper-attempt-journal: lost COMMIT yields no grant and readonly recovery finds the single real preparation and stop', async () => {
  await openAttemptJournal();
  const f = await nativeReady();
  await (await openAdmission()).approve(await input(f), io());
  const request = await attemptRequest(f),
    before = await withdrawalInventory(f);
  const proxy = await registryCommitProxy(
    required('DATABASE_PAPER_ADMISSION_URL'),
    'PAPER_ADMISSION',
  );
  const port = await openAttemptJournal(proxy.connectionString);
  try {
    proxy.arm();
    await expect(port.prepare(request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    const normal = await openAttemptJournal(),
      recovered = await normal.read(request, io());
    expect(recovered.kind).toBe('COMMITTED');
    const stop = stopRequest(request);
    // The shared proxy drops one COMMIT in its lifetime. STOP needs its own
    // physical fault boundary; rearming cannot reproduce a second response loss.
    const stopProxy = await registryCommitProxy(
      required('DATABASE_PAPER_ADMISSION_URL'),
      'PAPER_ADMISSION',
    );
    const stopping = await openAttemptJournal(stopProxy.connectionString);
    try {
      stopProxy.arm();
      await expect(stopping.stopBeforeStart(stop, io())).rejects.toThrow(
        'PAPER_ADMISSION_UNCERTAIN',
      );
      expect(stopProxy.dropped()).toBe(1);
    } finally {
      await stopping.close();
      await stopProxy.close();
    }
    expect(await normal.reconcileStop(stop, io())).toMatchObject({
      kind: 'COMMITTED',
      preparation: recovered.preparation,
      state: { phase: 'NOT_SENT' },
    });
    expect(proxy.dropped()).toBe(1);
    expect(await withdrawalInventory(f)).toEqual(before);
  } finally {
    await port.close();
    await proxy.close();
  }
});
it('paper-attempt-journal: readonly MISSING cannot adopt an attempt and runtime cannot mutate private journal rows or invent START', async () => {
  const port = await openAttemptJournal(),
    f = await nativeReady(),
    request = await attemptRequest(f);
  expect(await port.read(request, io())).toMatchObject({ kind: 'MISSING' });
  await (await openAdmission()).approve(await input(f), io());
  const a = await port.prepare(request, io());
  const runtime = new Pool({ connectionString: required('DATABASE_PAPER_ADMISSION_URL'), max: 1 });
  try {
    for (const table of ['attempt_preparation', 'attempt_not_sent']) {
      for (const action of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
        expect(
          (
            await runtime.query<{ allowed: boolean }>(
              'SELECT has_table_privilege(current_user,$1,$2) allowed',
              ['ctp_paper.' + table, action],
            )
          ).rows[0]!.allowed,
        ).toBe(false);
    }
    await expect(
      port.prepare(
        { ...request, kind: 'PAPER_ATTEMPT_START', attemptId: a.request.attemptId },
        io(),
      ),
    ).rejects.toThrow('PAPER_ADMISSION_INPUT');
    await expect(
      admin.query('DELETE FROM ctp_paper.attempt_preparation WHERE tenant_id=$1', [
        f.c.owner.tenantId,
      ]),
    ).rejects.toThrow();
    expect((await port.read(request, io())).state).toEqual(a);
  } finally {
    await runtime.end();
  }
});
// END PAPER ATTEMPT JOURNAL TESTS
// BEGIN PAPER PREPARED SOURCE TESTS
it('paper-prepared-source: one readonly transaction anchors full current FIFO to original preparation without authority or writes', async () => {
  const factory = (paperSourceServer as unknown as Record<string, unknown>)[
    'createPostgresPaperPreparedExecutionSource'
  ];
  if (typeof factory !== 'function') throw Error('PAPER_PREPARED_EXECUTION_SOURCE_MISSING');
  interface PreparedView {
    kind: string;
    preparation: PaperExecutionAttempt;
    source: { candidates: { orderId: string; intentId: string; admissionSequence: string }[] };
  }
  interface PreparedReader {
    read(raw: unknown, context: ReturnType<typeof io>): Promise<PreparedView>;
    close(): Promise<void>;
  }
  const open = () =>
    (factory as (options: unknown) => Promise<PreparedReader>)({
      connectionString: required('DATABASE_PAPER_ADMISSION_URL'),
      environment: 'test',
    });
  const f = await nativeReady();
  const admission = await openAdmission();
  await admission.approve(await input(f), io());
  const request = await attemptRequest(f);
  const capture = {
    kind: 'PAPER_PREPARED_EXECUTION_CAPTURE',
    preparationKey: request.key,
    admission: request.admission,
    authorization: request.authorization,
  };
  let reader = await open();
  handles.push(reader);
  const beforeMissing = await withdrawalInventory(f);
  await expect(reader.read(capture, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(await withdrawalInventory(f)).toEqual(beforeMissing);
  const journal = await openAttemptJournal();
  const preparation = await journal.prepare(request, io());
  const second = await f.orders.create(
    f.binding,
    {
      ...f.draft,
      key: randomUUID(),
      order: {
        ...f.draft.order,
        type: 'LIMIT',
        limitPrice: parseDecimal('10.5'),
        timeInForce: 'GTC',
      },
    },
    io(),
  );
  await nextFixtureMarketObservation(f);
  await runtimeEvidence(f);
  await admission.approve(await input(f, second), io());
  const before = await withdrawalInventory(f);
  const view = await reader.read(capture, io());
  expect(view.kind).toBe('PAPER_PREPARED_EXECUTION_SOURCE');
  expect(view.preparation).toEqual(preparation);
  expect(view.preparation).toMatchObject({ phase: 'PREPARED', startedAt: null });
  expect(view.source.candidates.map((c) => c.intentId)).toEqual([
    f.order.intentId,
    second.intentId,
  ]);
  expect(BigInt(view.source.candidates[0]!.admissionSequence)).toBeLessThan(
    BigInt(view.source.candidates[1]!.admissionSequence),
  );
  for (const key of ['permit', 'grant', 'startedAt', 'submittedAt', 'fills', 'allocation'])
    expect(view).not.toHaveProperty(key);
  await reader.close();
  reader = await open();
  handles.push(reader);
  expect((await reader.read(capture, io())).preparation).toEqual(preparation);
  await expect(
    reader.read(
      {
        ...capture,
        preparationKey: randomUUID(),
        authorization: {
          ...capture.authorization,
          permissionEpoch: (BigInt(capture.authorization.permissionEpoch) + 1n).toString(),
        },
      },
      io(),
    ),
  ).rejects.toThrow('PAPER_ADMISSION_SCOPE');
  expect(await withdrawalInventory(f)).toEqual(before);
  await journal.stopBeforeStart(stopRequest(request), io());
  const stopped = await withdrawalInventory(f);
  await expect(reader.read(capture, io())).rejects.toThrow(/PAPER_ADMISSION_/u);
  expect((await journal.read(request, io())).preparation).toEqual(preparation);
  expect(await withdrawalInventory(f)).toEqual(stopped);
});
// END PAPER PREPARED SOURCE TESTS
// BEGIN PAPER EXECUTION RISK TESTS
async function refreshExecutionRiskMarket(f: Ready) {
  // Multiple genuinely new test observations: use actual durable head revisions,
  // never renew an existing receipt or assume a fixed expectedRevision.
  const key = JSON.stringify({
    scope: f.f.s.key.scope,
    instrumentId: f.f.s.key.instrumentId,
    dbInstrumentId: f.f.s.key.dbInstrumentId,
  });
  const snapshotHead = (
    await admin.query<{
      revision: string;
      payload: typeof f.f.s;
    }>(
      'SELECT h.revision::text revision,e.payload::jsonb payload FROM ctp_market.snapshot_head h JOIN ctp_market.snapshot_event e ON e.id=h.native WHERE h.key=$1::jsonb',
      [key],
    )
  ).rows[0]!;
  const tradeHead = (
    await admin.query<{
      revision: string;
      payload: typeof f.f.p;
    }>(
      'SELECT h.revision::text revision,e.payload::jsonb payload FROM ctp_market.trade_head h JOIN ctp_market.trade_event e ON e.id=h.native WHERE h.key=$1::jsonb',
      [key],
    )
  ).rows[0]!;
  const snapshot = structuredClone(snapshotHead.payload),
    trade = structuredClone(tradeHead.payload),
    now = Date.now();
  snapshot.id = randomUUID();
  trade.id = randomUUID();
  snapshot.expectedRevision = snapshotHead.revision;
  trade.expectedRevision = tradeHead.revision;
  snapshot.timestamp = trade.timestamp = now;
  for (const record of [snapshot.ticker, snapshot.book, trade.trade])
    record.exchangeTime = record.receivedAt = now;
  snapshot.book.sourceSequence = (BigInt(snapshot.book.sourceSequence!) + 1n).toString();
  trade.trade.sourceSequence = (BigInt(trade.trade.sourceSequence!) + 1n).toString();
  trade.trade.tradeId = randomUUID();
  expect((await f.snapshots.publish(snapshot, io())).status).toBe('APPLIED');
  expect((await f.trades.publish(trade, io())).status).toBe('APPLIED');
}
interface CurrentExecutionRiskView {
  kind: string;
  preparation: PaperExecutionAttempt;
  evaluation: { kind: string };
  retained: { reservationId: string; budget: { orders: { current: number; projected: number } } };
  policies: { user: { version: string } };
}
async function openCurrentExecutionRisk(
  connectionString = required('DATABASE_PAPER_ADMISSION_URL'),
) {
  const factory = (paperSourceServer as unknown as Record<string, unknown>)[
    'createPostgresPaperExecutionRiskSource'
  ];
  if (typeof factory !== 'function') throw Error('PAPER_EXECUTION_RISK_SOURCE_MISSING');
  const port = await (
    factory as (options: unknown) => Promise<{
      read(request: unknown, context: ReturnType<typeof io>): Promise<CurrentExecutionRiskView>;
      close(): Promise<void>;
    }>
  )({ connectionString, environment: 'test' });
  handles.push(port);
  return port;
}
async function currentExecutionRiskRequest(f: Ready) {
  const request = await attemptRequest(f),
    journal = await openAttemptJournal();
  const preparation = await journal.prepare(request, io());
  return {
    preparation,
    request: {
      kind: 'PAPER_EXECUTION_RISK_CAPTURE',
      preparationKey: request.key,
      admission: request.admission,
      authorization: request.authorization,
    },
  };
}
it('paper-execution-risk: real readonly RPC and reader evaluate current retained scope with no monetary or journal write', async () => {
  const f = await nativeReady();
  await refreshExecutionRiskMarket(f);
  await runtimeEvidence(f);
  await (await openAdmission()).approve(await input(f), io());
  const { request, preparation } = await currentExecutionRiskRequest(f),
    before = await withdrawalInventory(f);
  const runtime = new Pool({ connectionString: required('DATABASE_PAPER_ADMISSION_URL'), max: 1 });
  const c = await runtime.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    const raw = await c.query<{ result: { kind: string } }>(
      'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
      [JSON.stringify(request)],
    );
    expect(raw.rows[0]!.result.kind).toBe('PAPER_EXECUTION_RISK_CAPTURE');
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await runtime.end();
  }
  const reader = await openCurrentExecutionRisk();
  const view = await reader.read(request, io());
  expect(view.kind).toBe('PAPER_EXECUTION_RISK_SOURCE');
  expect(view.evaluation.kind).toBe('EVALUATED');
  expect(view.preparation).toEqual(preparation);
  expect(view.retained.reservationId).toBe(preparation.request.admission.reservationId);
  expect(view.retained.budget.orders).toEqual({ current: 0, projected: 1 });
  for (const key of [
    'grant',
    'permit',
    'startedAt',
    'submittedAt',
    'fills',
    'allocation',
    'postings',
  ])
    expect(view).not.toHaveProperty(key);
  await reader.close();
  const restarted = await openCurrentExecutionRisk();
  expect((await restarted.read(request, io())).preparation).toEqual(preparation);
  await expect(
    restarted.read(
      {
        ...request,
        preparationKey: randomUUID(),
        authorization: { ...request.authorization, permissionEpoch: '9223372036854775807' },
      },
      io(),
    ),
  ).rejects.toThrow('PAPER_ADMISSION_SCOPE');
  expect(await withdrawalInventory(f)).toEqual(before);
  const restricted = new Pool({
    connectionString: required('DATABASE_PAPER_ADMISSION_URL'),
    max: 1,
  });
  try {
    await expect(
      restricted.query('SELECT ctp_paper.capture_execution_risk($1::jsonb)', [
        JSON.stringify(request),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await restricted.end();
  }
});
it('paper-execution-risk: current policy, tenant pause and failed health block an already prepared original reservation', async () => {
  const f = await nativeReady();
  await refreshExecutionRiskMarket(f);
  await runtimeEvidence(f);
  await (await openAdmission()).approve(await input(f), io());
  const { request } = await currentExecutionRiskRequest(f),
    reader = await openCurrentExecutionRisk(),
    before = await withdrawalInventory(f);
  const limits = (
    await admin.query<{ limits: Record<string, unknown> }>(
      "SELECT v.\"limitsText\"::jsonb limits FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision v USING(scope,target,mode,version,id) WHERE h.scope='USER' AND h.target=$1 AND h.mode='PAPER'",
      [f.c.owner.tenantId],
    )
  ).rows[0]!.limits;
  await updatePolicy(f.c.owner.tenantId, 'USER', { ...limits, maxOpenOrders: 0 });
  await expect(reader.read(request, io())).rejects.toThrow(/PAPER_ADMISSION_(LIMIT|EVIDENCE)/u);
  await updatePolicy(f.c.owner.tenantId, 'USER', limits);
  await updateControl(f.c.owner.tenantId, 'PAUSED');
  await expect(reader.read(request, io())).rejects.toThrow('PAPER_ADMISSION_LIMIT');
  await updateControl(f.c.owner.tenantId, 'RUNNING');
  await runtimeEvidence(f, 'FAILED');
  await expect(reader.read(request, io())).rejects.toThrow('PAPER_ADMISSION_LIMIT');
  expect(await withdrawalInventory(f)).toEqual(before);
});
it('paper-execution-risk: lost read COMMIT returns no source, reconnect recovers data and UNKNOWN keeps the whole hold', async () => {
  const f = await nativeReady(),
    admission = await (await openAdmission()).approve(await input(f), io());
  const { request, preparation } = await currentExecutionRiskRequest(f),
    before = await withdrawalInventory(f);
  const proxy = await registryCommitProxy(
    required('DATABASE_PAPER_ADMISSION_URL'),
    'PAPER_EXECUTION_SOURCE',
  );
  const reader = await openCurrentExecutionRisk(proxy.connectionString);
  try {
    proxy.arm();
    await expect(reader.read(request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
  } finally {
    await reader.close();
    await proxy.close();
  }
  const normal = await openCurrentExecutionRisk();
  expect((await normal.read(request, io())).preparation).toEqual(preparation);
  expect(await withdrawalInventory(f)).toEqual(before);
  await (await openLifecycle()).markUnknown(await unknownRequest(f, admission.reservationId), io());
  const unknown = await withdrawalInventory(f);
  await expect(normal.read(request, io())).rejects.toThrow(/PAPER_ADMISSION_/u);
  expect(await withdrawalInventory(f)).toEqual(unknown);
});
// END PAPER EXECUTION RISK TESTS
// BEGIN PAPER PREPARATION INVENTORY TESTS
interface PreparationInventoryView {
  kind: string;
  source: { candidates: { intentId: string; admissionSequence: string }[] };
  entries: (
    | { kind: 'MISSING'; intentId: string }
    | { kind: 'PREPARED'; intentId: string; key: string; preparation: PaperExecutionAttempt }
  )[];
}
async function openPreparationInventory(
  connectionString = required('DATABASE_PAPER_ADMISSION_URL'),
) {
  const factory = (paperSourceServer as unknown as Record<string, unknown>)[
    'createPostgresPaperPreparationInventorySource'
  ];
  if (typeof factory !== 'function') throw Error('PAPER_PREPARATION_INVENTORY_SOURCE_MISSING');
  const port = await (
    factory as (options: unknown) => Promise<{
      read(raw: unknown, context: ReturnType<typeof io>): Promise<PreparationInventoryView>;
      close(): Promise<void>;
    }>
  )({ connectionString, environment: 'test' });
  handles.push(port);
  return port;
}
async function preparationRows(f: Ready) {
  return (
    await admin.query<Record<string, unknown>>(
      'SELECT preparation_key,attempt_id,intent_id,reservation_id,prepared_ms,state,state_hash FROM ctp_paper.attempt_preparation WHERE tenant_id=$1 ORDER BY preparation_key',
      [f.c.owner.tenantId],
    )
  ).rows;
}
it('paper-preparation-inventory: fixed readonly RPC joins the complete actual FIFO and preserves MISSING without adopting history or money', async () => {
  // Constructor checks precede admission; never spend or renew the original issuance window.
  const journal = await openAttemptJournal(),
    port = await openPreparationInventory(),
    runtime = new Pool({ connectionString: required('DATABASE_PAPER_ADMISSION_URL'), max: 1 }),
    c = await runtime.connect();
  try {
    const { f, other, request } = await executionPair();
    const capture = { ...request, kind: 'PAPER_PREPARATION_INVENTORY_CAPTURE' },
      before = await withdrawalInventory(f),
      originalRows = await preparationRows(f);
    await refreshExecutionRiskMarket(f);
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    const raw = (
      await c.query<{ result: PreparationInventoryView }>(
        'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
        [JSON.stringify(capture)],
      )
    ).rows[0]!.result;
    expect(raw.kind).toBe('PAPER_PREPARATION_INVENTORY_CAPTURE');
    expect(raw.entries).toEqual([
      { kind: 'MISSING', intentId: other.intentId },
      { kind: 'MISSING', intentId: f.order.intentId },
    ]);
    await c.query('COMMIT');
    expect(await preparationRows(f)).toEqual(originalRows);
    // Preparation must still fit the original issuance window; this read cannot renew it.
    const prepRequest = { ...request, kind: 'PAPER_ATTEMPT_PREPARE', key: randomUUID() };
    const prep = await journal.prepare(prepRequest, io());
    const rows = await preparationRows(f);
    await refreshExecutionRiskMarket(f);
    const view = await port.read(capture, io());
    expect(view.kind).toBe('PAPER_PREPARATION_INVENTORY_SOURCE');
    expect(view.entries).toEqual([
      { kind: 'MISSING', intentId: other.intentId },
      { kind: 'PREPARED', intentId: f.order.intentId, key: prepRequest.key, preparation: prep },
    ]);
    expect(view.source.candidates.map((x) => x.intentId)).toEqual([
      other.intentId,
      f.order.intentId,
    ]);
    expect(BigInt(view.source.candidates[0]!.admissionSequence)).toBeLessThan(
      BigInt(view.source.candidates[1]!.admissionSequence),
    );
    for (const field of ['grant', 'permit', 'startedAt', 'allocation', 'fills', 'postings'])
      expect(view).not.toHaveProperty(field);
    expect(await preparationRows(f)).toEqual(rows);
    expect(await withdrawalInventory(f)).toEqual(before);
    await port.close();
    await refreshExecutionRiskMarket(f);
    expect((await (await openPreparationInventory()).read(capture, io())).entries).toEqual(
      view.entries,
    );
    expect(await preparationRows(f)).toEqual(rows);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await runtime.end();
  }
});
it('paper-preparation-inventory: uncertain read COMMIT returns no evidence, recovery is readonly and UNKNOWN cannot disappear from competition', async () => {
  const f = await nativeReady(),
    admission = await (await openAdmission()).approve(await input(f), io());
  const request = await attemptRequest(f),
    prep = await (await openAttemptJournal()).prepare(request, io());
  const capture = { ...(await executionRequest(f)), kind: 'PAPER_PREPARATION_INVENTORY_CAPTURE' },
    before = await withdrawalInventory(f),
    rows = await preparationRows(f);
  const proxy = await registryCommitProxy(
    required('DATABASE_PAPER_ADMISSION_URL'),
    'PAPER_EXECUTION_SOURCE',
  );
  let port: Awaited<ReturnType<typeof openPreparationInventory>> | null = null;
  try {
    port = await openPreparationInventory(proxy.connectionString);
    await refreshExecutionRiskMarket(f);
    proxy.arm();
    await expect(port.read(capture, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
  } finally {
    await port?.close();
    await proxy.close();
  }
  const reader = await openPreparationInventory();
  await refreshExecutionRiskMarket(f);
  expect((await reader.read(capture, io())).entries).toEqual([
    { kind: 'PREPARED', intentId: f.order.intentId, key: request.key, preparation: prep },
  ]);
  await expect(
    reader.read(
      {
        ...capture,
        authorization: { ...capture.authorization, permissionEpoch: '9223372036854775807' },
      },
      io(),
    ),
  ).rejects.toThrow('PAPER_ADMISSION_SCOPE');
  expect(await preparationRows(f)).toEqual(rows);
  expect(await withdrawalInventory(f)).toEqual(before);
  const restricted = new Pool({
    connectionString: required('DATABASE_PAPER_ADMISSION_URL'),
    max: 1,
  });
  try {
    await expect(
      restricted.query('SELECT ctp_paper.capture_preparation_inventory($1::jsonb)', [
        JSON.stringify(capture),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await restricted.end();
  }
  await (await openLifecycle()).markUnknown(await unknownRequest(f, admission.reservationId), io());
  const unknown = await withdrawalInventory(f);
  await refreshExecutionRiskMarket(f);
  await expect(reader.read(capture, io())).rejects.toThrow(/PAPER_ADMISSION_/u);
  expect(await withdrawalInventory(f)).toEqual(unknown);
  expect(await preparationRows(f)).toEqual(rows);
});
// END PAPER PREPARATION INVENTORY TESTS
// BEGIN PAPER EXECUTION CONTEXT TESTS
async function openExecutionContext(connectionString = required('DATABASE_PAPER_ADMISSION_URL')) {
  const factory = (paperSourceServer as unknown as Record<string, unknown>)[
    'createPostgresPaperExecutionContextSource'
  ];
  if (typeof factory !== 'function') throw Error('PAPER_EXECUTION_CONTEXT_SOURCE_MISSING');
  const port = await (
    factory as (options: unknown) => Promise<{
      read(
        raw: unknown,
        context: ReturnType<typeof io>,
      ): Promise<{
        kind: string;
        risk: CurrentExecutionRiskView;
        inventory: PreparationInventoryView;
      }>;
      close(): Promise<void>;
    }>
  )({ connectionString, environment: 'test' });
  handles.push(port);
  return port;
}
it('paper-execution-context: same transaction joins real current Risk and complete original preparations, survives reopen without monetary effects', async () => {
  const journal = await openAttemptJournal(),
    port = await openExecutionContext(),
    admission = await openAdmission();
  const f = await nativeReady();
  const other = await f.orders.create(
    f.binding,
    {
      ...f.draft,
      key: randomUUID(),
      order: {
        ...f.draft.order,
        type: 'LIMIT',
        limitPrice: parseDecimal('10.5'),
        timeInForce: 'GTC',
      },
    },
    io(),
  );
  const request = await executionRequest(f),
    firstInput = await input(f),
    otherInput = await input(f, other);
  // Read immutable commands/auth and open handles before the finite original
  // issuance window. SQL still rechecks every current fact, no authority cached.
  await runtimeEvidence(f);
  await refreshExecutionRiskMarket(f);
  await admission.approve(otherInput, io());
  await admission.approve(firstInput, io());
  const prepare = { ...request, kind: 'PAPER_ATTEMPT_PREPARE', key: randomUUID() };
  const original = await journal.prepare(prepare, io());
  const capture = {
    kind: 'PAPER_EXECUTION_RISK_CAPTURE',
    preparationKey: prepare.key,
    admission: request.admission,
    authorization: request.authorization,
  };
  const before = await withdrawalInventory(f),
    rows = await preparationRows(f);
  await refreshExecutionRiskMarket(f);
  const view = await port.read(capture, io());
  expect(view.kind).toBe('PAPER_EXECUTION_CONTEXT_SOURCE');
  expect(view.risk.evaluation.kind).toBe('EVALUATED');
  expect(view.risk.preparation).toEqual(original);
  expect(view.risk.retained.budget.orders).toEqual({ current: 1, projected: 2 });
  expect(view.inventory.entries).toEqual([
    { kind: 'MISSING', intentId: other.intentId },
    { kind: 'PREPARED', intentId: f.order.intentId, key: prepare.key, preparation: original },
  ]);
  for (const field of [
    'grant',
    'permit',
    'startedAt',
    'submittedAt',
    'fills',
    'allocation',
    'postings',
  ])
    expect(view).not.toHaveProperty(field);
  await port.close();
  await refreshExecutionRiskMarket(f);
  expect((await (await openExecutionContext()).read(capture, io())).inventory.entries).toEqual(
    view.inventory.entries,
  );
  expect(await preparationRows(f)).toEqual(rows);
  expect(await withdrawalInventory(f)).toEqual(before);
});
it('paper-execution-context: physically lost readonly COMMIT grants nothing, explicit recapture and current scope/control/UNKNOWN remain fail closed', async () => {
  const proxy = await registryCommitProxy(
    required('DATABASE_PAPER_ADMISSION_URL'),
    'PAPER_EXECUTION_SOURCE',
  );
  let faulty: Awaited<ReturnType<typeof openExecutionContext>> | null = null;
  try {
    faulty = await openExecutionContext(proxy.connectionString);
    const port = await openExecutionContext(),
      journal = await openAttemptJournal(),
      admission = await openAdmission();
    const f = await nativeReady();
    const prepare = await attemptRequest(f),
      originalInput = await input(f);
    await updateControl(f.c.owner.tenantId, 'RUNNING');
    await runtimeEvidence(f);
    await refreshExecutionRiskMarket(f);
    const approval = await admission.approve(originalInput, io());
    const original = await journal.prepare(prepare, io());
    const capture = {
      kind: 'PAPER_EXECUTION_RISK_CAPTURE',
      preparationKey: prepare.key,
      admission: prepare.admission,
      authorization: prepare.authorization,
    };
    const before = await withdrawalInventory(f),
      rows = await preparationRows(f);
    await updateControl(f.c.owner.tenantId, 'PAUSED');
    await expect(port.read(capture, io())).rejects.toThrow('PAPER_ADMISSION_LIMIT');
    await updateControl(f.c.owner.tenantId, 'RUNNING');
    await refreshExecutionRiskMarket(f);
    await runtimeEvidence(f);
    proxy.arm();
    await expect(faulty.read(capture, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await refreshExecutionRiskMarket(f);
    expect((await port.read(capture, io())).risk.preparation).toEqual(original);
    await expect(
      port.read(
        {
          ...capture,
          authorization: { ...capture.authorization, permissionEpoch: '9223372036854775807' },
        },
        io(),
      ),
    ).rejects.toThrow('PAPER_ADMISSION_SCOPE');
    expect(await withdrawalInventory(f)).toEqual(before);
    await (
      await openLifecycle()
    ).markUnknown(await unknownRequest(f, approval.reservationId), io());
    const unknown = await withdrawalInventory(f);
    await expect(port.read(capture, io())).rejects.toThrow(/PAPER_ADMISSION_/u);
    expect(await withdrawalInventory(f)).toEqual(unknown);
    expect(await preparationRows(f)).toEqual(rows);
  } finally {
    await faulty?.close();
    await proxy.close();
  }
});
// END PAPER EXECUTION CONTEXT TESTS
