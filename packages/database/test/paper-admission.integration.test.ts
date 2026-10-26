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
import { createPostgresOrderStore, bindingSchema, draftSchema } from '@ctp/order-engine';
import {
  createPostgresPolicies,
  createPostgresControls,
  policyUpdateSchema,
  controlUpdateSchema,
} from '@ctp/risk-engine';
import { fixture as riskFixture } from '../../risk-engine/test/fixtures.js';
import { frameFixture } from '../../paper-engine/test/frame-fixture.js';
import { state } from '../../order-engine/test/fixtures.js';
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

async function openOrders() {
  const h = await createPostgresOrderStore({
    connectionString: required('DATABASE_EXECUTION_URL'),
    environment: 'test',
  });
  handles.push(h);
  return h;
}

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
  const snapshots = await createPostgresMarketSnapshots({
      connectionString: required('DATABASE_MARKET_SNAPSHOT_URL'),
      environment: 'test',
    }),
    trades = await createPostgresMarketTrades({
      connectionString: required('DATABASE_MARKET_TRADE_URL'),
      environment: 'test',
    });
  handles.push(snapshots, trades);
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
async function openAdmission() {
  const port = await createPostgresPaperOrderRiskPort({
    connectionString: required('DATABASE_PAPER_ADMISSION_URL'),
    environment: 'test',
  });
  handles.push(port);
  return port;
}
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
