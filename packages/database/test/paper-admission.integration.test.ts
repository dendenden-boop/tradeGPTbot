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

async function updatePolicy(
  tenantId: string,
  kind: 'PLATFORM' | 'USER',
  changes: Record<string, unknown> = {},
  mode: 'PAPER' | 'DEMO' = 'PAPER',
) {
  const h = await createPostgresPolicies({
    connectionString: required(
      kind === 'PLATFORM'
        ? 'DATABASE_RISK_POLICY_OPERATOR_URL'
        : 'DATABASE_RISK_POLICY_CONTROLLER_URL',
    ),
    environment: 'test',
    authority: kind,
  });
  try {
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
  } finally {
    await h.close();
  }
}

async function updateControl(tenantId: string | null, state: 'RUNNING' | 'PAUSED') {
  const h = await createPostgresControls({
    connectionString: required(
      tenantId === null ? 'DATABASE_RISK_OPERATOR_URL' : 'DATABASE_RISK_CONTROL_URL',
    ),
    environment: 'test',
    authority: tenantId === null ? 'GLOBAL' : 'TENANT',
  });
  try {
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
  } finally {
    await h.close();
  }
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

async function openBook(connectionString = required('DATABASE_PAPER_BOOK_URL')) {
  const h = await createPostgresPaperPortfolioBootstrap({ connectionString, environment: 'test' });
  handles.push(h);
  return h;
}

async function runtimeEvidence(
  f: Awaited<ReturnType<typeof tenantReady>>,
  status: 'HEALTHY' | 'FAILED' | 'UNKNOWN' = 'HEALTHY',
) {
  const h = await createPostgresPaperRuntimeObservations({
    connectionString: required('DATABASE_PAPER_RUNTIME_OBSERVER_URL'),
    environment: 'test',
  });
  handles.push(h);
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
    config = await createPostgresPaperConfiguration({
      connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
      environment: 'test',
    }),
    funding = await createPostgresPaperFunding({
      connectionString: required('DATABASE_PAPER_FUNDING_URL'),
      environment: 'test',
    });
  try {
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
  } finally {
    await config.close();
    await funding.close();
  }
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

import { createPostgresPaperOrderRiskPort, createPostgresPaperReservationLifecycle } from '@ctp/paper-engine/risk';
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
  const port = await createPostgresPaperReservationLifecycle({ connectionString, environment: 'test' });
  handles.push(port);
  return port;
}
async function unknownRequest(f: Ready, reservationId: string) {
  const { state, ...request } = await input(f);
  return { kind: 'PAPER_RESERVATION_UNKNOWN' as const, admission: { ...request, orderId: state.id }, reservationId, eventId: randomUUID(), expectedRevision: '1' as const };
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
  const f = await nativeReady(), admission = await openAdmission();
  const original = await admission.approve(await input(f), io()), before = await inventory(f);
  const request = await unknownRequest(f, original.reservationId), port = await openLifecycle();
  const receipt = await port.markUnknown(request, io());
  expect(receipt).toMatchObject({ reservationId: original.reservationId, revision: '2', intentId: f.order.intentId, eventId: request.eventId });
  expect(await inventory(f)).toEqual(before);
  const rows = await admin.query<{ status: string; amount: string; watermark: boolean; count: number }>(`SELECT s.status,trim_scale(d.amount)::text amount,w.unknown watermark,
    (SELECT count(*)::int FROM ctp_paper.reservation_state_event WHERE tenant_id=$1 AND reservation_id=$2) count
    FROM ctp_paper.reservation_state_event s JOIN ctp_paper.reservation_debit d USING(tenant_id,reservation_id)
    JOIN ctp_portfolio.hold_watermark w ON w."tenantId"=d.tenant_id AND w."holdId"=d.hold_id::text
    WHERE s.tenant_id=$1 AND s.reservation_id=$2 AND s.revision=2`, [f.c.owner.tenantId, original.reservationId]);
  expect(rows.rows).toEqual([{ status: 'UNKNOWN', amount: before.debits[0], watermark: true, count: 2 }]);
  await port.close();
  const restarted = await openLifecycle();
  expect(await restarted.markUnknown(request, io())).toEqual(receipt);
  expect(await restarted.reconcileUnknown(request, io())).toEqual({ kind: 'COMMITTED', request, receipt });
  expect(await inventory(f)).toEqual(before);
  await expect(admission.approve(await input(f), io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect((await admission.reconcileApproval(await input(f), io())).kind).toBe('COMMITTED');
  const next = await f.orders.create(f.binding, { ...f.draft, key: randomUUID() }, io());
  await expect(admission.approve(await input(f, next), io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
});

it('paper-unknown: a permanent event conflict, stale revision and wrong reservation cannot change the hold', async () => {
  const f = await nativeReady(), admission = await openAdmission(), port = await openLifecycle();
  const original = await admission.approve(await input(f), io()), request = await unknownRequest(f, original.reservationId);
  await port.markUnknown(request, io());
  const before = await inventory(f);
  await expect(port.markUnknown({ ...request, eventId: randomUUID() }, io())).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  await expect(port.markUnknown({ ...request, reservationId: randomUUID() }, io())).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  await expect(port.markUnknown({ ...request, expectedRevision: '2' }, io())).rejects.toThrow('PAPER_ADMISSION_INPUT');
  expect(await inventory(f)).toEqual(before);
});

it('paper-unknown: concurrent distinct events produce exactly one durable UNKNOWN and no second reserve', async () => {
  const f = await nativeReady(), admission = await openAdmission();
  const original = await admission.approve(await input(f), io()), request = await unknownRequest(f, original.reservationId);
  const before = await inventory(f), a = await openLifecycle(), b = await openLifecycle();
  const results = await Promise.allSettled([a.markUnknown(request, io()), b.markUnknown({ ...request, eventId: randomUUID() }, io())]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await inventory(f)).toEqual(before);
  expect((await admin.query('SELECT count(*)::int n FROM ctp_paper.admission_unknown_event WHERE tenant_id=$1', [f.c.owner.tenantId])).rows[0].n).toBe(1);
});

it('paper-unknown: lost COMMIT returns no receipt and only read-only reconciliation observes its durable result', async () => {
  const f = await nativeReady(), admission = await openAdmission();
  const original = await admission.approve(await input(f), io()), request = await unknownRequest(f, original.reservationId), before = await inventory(f);
  const proxy = await registryCommitProxy(required('DATABASE_PAPER_ADMISSION_URL'), 'PAPER_ADMISSION');
  const port = await openLifecycle(proxy.connectionString);
  try {
    proxy.arm();
    await expect(port.markUnknown(request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    const restarted = await openLifecycle(), result = await restarted.reconcileUnknown(request, io());
    expect(result.kind).toBe('COMMITTED');
    expect(await inventory(f)).toEqual(before);
    expect((await admin.query('SELECT count(*)::int n FROM ctp_paper.admission_unknown_event WHERE tenant_id=$1', [f.c.owner.tenantId])).rows[0].n).toBe(1);
  } finally { await port.close(); await proxy.close(); }
});

it('paper-unknown: pause and rule replacement cannot prevent conservative retention or turn it into a new grant', async () => {
  const f = await nativeReady(), admission = await openAdmission();
  const original = await admission.approve(await input(f), io()), request = await unknownRequest(f, original.reservationId), port = await openLifecycle();
  await updateControl(f.c.owner.tenantId, 'PAUSED');
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [f.f.p.key.dbRuleId]);
  expect(await port.markUnknown(request, io())).toMatchObject({ revision: '2' });
  await expect(admission.approve(await input(f), io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
});

it('paper-unknown: MISSING and a pre-aborted call have no monetary or lifecycle effect', async () => {
  const f = await nativeReady(), admission = await openAdmission(), port = await openLifecycle();
  const original = await admission.approve(await input(f), io()), request = await unknownRequest(f, original.reservationId), before = await inventory(f);
  expect(await port.reconcileUnknown(request, io())).toEqual({ kind: 'MISSING', request });
  const abort = new AbortController(); abort.abort();
  await expect(port.markUnknown(request, io(abort.signal))).rejects.toThrow('PAPER_ADMISSION_ABORTED');
  expect(await port.reconcileUnknown(request, io())).toEqual({ kind: 'MISSING', request });
  expect(await inventory(f)).toEqual(before);
});
