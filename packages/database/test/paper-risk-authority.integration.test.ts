import { setTimeout as wait } from 'node:timers/promises';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import * as authority from '@ctp/paper-engine/risk';
import {
  createPostgresPaperRuntimeObservations,
  paperRuntimeDependencies,
  type PaperRuntimePublication,
} from '@ctp/paper-engine/runtime';
import {
  createPostgresPolicies,
  createPostgresControls,
  policyUpdateSchema,
  policyLimitsText,
  policyFingerprint,
  controlUpdateSchema,
} from '@ctp/risk-engine';
import { fixture as riskFixture } from '../../risk-engine/test/fixtures.js';

import { createPostgresMarketSnapshots, createPostgresMarketTrades } from '@ctp/market-data';
import { createPostgresPaperPortfolioBootstrap } from '@ctp/paper-engine/portfolio';
import { createPostgresPaperFunding, paperFundingSchema } from '@ctp/paper-engine/funding';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { createPostgresOrderStore, bindingSchema, draftSchema } from '@ctp/order-engine';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
  type PaperConfiguration,
} from '@ctp/paper-engine/configuration';
import { frameFixture } from '../../paper-engine/test/frame-fixture.js';
import { state } from '../../order-engine/test/fixtures.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_PAPER_DRAFT_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_PAPER_DRAFT_VARIABLE_REQUIRED');
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
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await admin.end();
});
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

async function prepared({
  draft = true,
  fund = true,
  region,
}: { draft?: boolean; fund?: boolean; region?: string } = {}) {
  const f = await fixture(region ? { region } : {});
  const fundingId = randomUUID();
  if (fund) {
    const funding = await createPostgresPaperFunding({
      connectionString: required('DATABASE_PAPER_FUNDING_URL'),
      environment: 'test',
    });
    try {
      await funding.initialize(
        paperFundingSchema.parse({
          id: fundingId,
          owner: f.c.owner,
          configurationId: f.c.id,
          balances: [
            { asset: 'BTC', amount: '0.000000000000000001' },
            { asset: 'USDT', amount: '9007199254740993' },
          ],
        }),
        io(),
      );
    } finally {
      await funding.close();
    }
  }
  const orders = await openOrders();
  const order = draft ? await orders.create(f.binding, f.draft, io()) : null;
  return { ...f, fundingId, orders, order };
}
async function openBook(connectionString = required('DATABASE_PAPER_BOOK_URL')) {
  const h = await createPostgresPaperPortfolioBootstrap({ connectionString, environment: 'test' });
  handles.push(h);
  return h;
}

async function ready(withPolicies = true) {
  const f = await prepared();
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
  if (withPolicies) await ensurePolicies(f.c.owner.tenantId);
  const now = Date.now();
  f.f.s.timestamp = f.f.p.timestamp = now;
  for (const v of [f.f.s.ticker, f.f.s.book, f.f.p.trade]) v.receivedAt = v.exchangeTime = now;
  await snapshots.publish(f.f.s, io());
  await trades.publish(f.f.p, io());
  const request = { owner: f.c.owner, intentId: f.order!.intentId };
  return { ...f, snapshots, trades, request };
}
async function openAuthority(connectionString = required('DATABASE_PAPER_RISK_AUTHORITY_URL')) {
  const h = await authority.createPostgresPaperRiskAuthoritySource({
    connectionString,
    environment: 'test',
  });
  handles.push(h);
  return h;
}
async function openContext(connectionString = required('DATABASE_PAPER_RISK_CONTEXT_URL')) {
  const h = await authority.createPostgresPaperRiskContextSource({
    connectionString,
    environment: 'test',
  });
  handles.push(h);
  return h;
}
async function runtimeEvidence(
  f: Awaited<ReturnType<typeof ready>>,
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

async function openSource(connectionString = required('DATABASE_PAPER_RISK_AUTHORITY_URL')) {
  const h = await openAuthority(connectionString);
  return {
    read: async (request: Parameters<typeof h.read>[0], context: Parameters<typeof h.read>[1]) =>
      (await h.read(request, context)).orderRisk,
    close: () => h.close(),
  };
}

it('authority compatibility: actual durable PAPER PLACE and public heads yield conservative debits with no financial effect', async () => {
  const f = await ready(),
    before = await effects(f.c.owner.tenantId),
    h = await openSource(),
    r = await h.read(f.request, io());
  expect(r).toMatchObject({
    kind: 'PAPER_ORDER_RISK_SOURCE',
    target: { orderId: f.order!.id, intentId: f.order!.intentId, command: f.order!.command },
    // The shared Order Engine fixture is MARKET, not the pure LIMIT fixture.
    // Its lifetime ceiling is the native maxPrice=1000, so .5 principal plus
    // per-lot fees is 500.5. Never substitute current last/limit for this bound.
    envelope: {
      quantity: '0.5',
      executionPrice: { maximum: '1000' },
      debits: [{ asset: 'USDT', amount: '500.5' }],
    },
  });
  expect(r.book.state.snapshotAt).toBeLessThanOrEqual(r.asOf);
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
  expect(r).not.toHaveProperty('certificate');
  expect(r).not.toHaveProperty('grant');
});

it('context: one locked transaction captures exact authority and runtime without any monetary effect', async () => {
  const f = await ready(),
    evidence = await runtimeEvidence(f),
    before = await effects(f.c.owner.tenantId);
  const r = await (await openContext()).read(f.request, io());
  expect(r.runtime.reference.id).toBe(evidence.receipt.id);
  expect(r.authority.orderRisk.target.orderId).toBe(f.order!.id);
  expect(r.runtime.configuration).toEqual(r.authority.orderRisk.book.origin.configuration);
  expect(r.runtime.current.permissionEpoch).toBe(r.authority.identity.permissionEpoch);
  expect(r.runtime.blockedBy).toEqual([]);
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
  for (const name of ['certificate', 'grant', 'reservation', 'permit', 'capabilities'])
    expect(name in r).toBe(false);
});
it('context: absent runtime journal cannot fall back to healthy defaults', async () => {
  const f = await ready();
  await expect((await openContext()).read(f.request, io())).rejects.toThrow(
    'PAPER_RISK_CONTEXT_MISSING',
  );
});
it('context: restart rereads policy and preserves original runtime publication, order, funding and counter', async () => {
  const f = await ready();
  await runtimeEvidence(f);
  const h = await openContext(),
    before = await h.read(f.request, io()),
    effectsBefore = await effects(f.c.owner.tenantId);
  await h.close();
  const policy = await updatePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' });
  const after = await (await openContext()).read(f.request, io());
  expect(after.authority.policies.user.version).toBe(policy.version);
  expect(after.authority.orderRisk.target).toEqual(before.authority.orderRisk.target);
  expect(after.runtime.reference).toEqual(before.runtime.reference);
  expect(after.hash).not.toBe(before.hash);
  expect(await effects(f.c.owner.tenantId)).toEqual(effectsBefore);
});
it.each(['permission', 'session', 'version'] as const)(
  'context: durable %s replacement rejects retained runtime facts after restart',
  async (kind) => {
    const f = await ready();
    await runtimeEvidence(f);
    const h = await openContext();
    await h.read(f.request, io());
    await h.close();
    if (kind === 'session')
      await admin.query('UPDATE public."user" SET "sessionEpoch"="sessionEpoch"+1 WHERE id=$1', [
        f.c.owner.tenantId,
      ]);
    else
      await admin.query(
        `UPDATE public.exchange_account SET ${kind === 'permission' ? '"permissionEpoch"="permissionEpoch"+1' : 'version=version+1'} WHERE id=$1`,
        [f.c.owner.accountId],
      );
    await expect((await openContext()).read(f.request, io())).rejects.toThrow(
      'PAPER_RISK_CONTEXT_EPOCH',
    );
    await runtimeEvidence(f);
    expect(
      (await (await openContext()).read(f.request, io())).authority.orderRisk.target.orderId,
    ).toBe(f.order!.id);
  },
);
it.each(['FAILED', 'UNKNOWN'] as const)(
  'context: %s executor and paused controls remain negative evidence',
  async (status) => {
    const f = await ready();
    await runtimeEvidence(f, status);
    await updateControl(f.c.owner.tenantId, 'PAUSED');
    const r = await (await openContext()).read(f.request, io());
    expect(r.runtime.blockedBy).toEqual(['executor']);
    expect(r.authority.controls.pauses.user).toBe(true);
    expect(r).not.toHaveProperty('approved');
  },
);
it.each(['tenant', 'account', 'intent', 'override'] as const)(
  'context: rejects foreign or caller-controlled %s',
  async (kind) => {
    const f = await ready();
    await runtimeEvidence(f);
    const request = structuredClone(f.request);
    if (kind === 'tenant') request.owner.tenantId = randomUUID();
    if (kind === 'account') request.owner.accountId = randomUUID();
    if (kind === 'intent') request.intentId = randomUUID();
    if (kind === 'override') Object.assign(request, { runtime: {} });
    await expect((await openContext()).read(request, io())).rejects.toThrow(
      /PAPER_RISK_CONTEXT_(OWNERSHIP|INPUT)/,
    );
  },
);
it('context: UNKNOWN order cannot bypass the accepted pristine draft guard', async () => {
  const f = await ready();
  await runtimeEvidence(f);
  await admin.query(
    'UPDATE public."order" SET status=\'UNKNOWN\',version=1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.order!.id],
  );
  await expect((await openContext()).read(f.request, io())).rejects.toThrow(
    'PAPER_RISK_CONTEXT_INCOMPLETE',
  );
});
it('context: tighter policy expires old runtime facts even after public heads refresh', async () => {
  const f = await ready();
  await runtimeEvidence(f);
  await updatePolicy(f.c.owner.tenantId, 'USER', { maxEvidenceAgeMs: 1000 });
  await wait(1100);
  const now = Date.now();
  f.f.s.id = randomUUID();
  f.f.p.id = randomUUID();
  f.f.p.trade.tradeId = randomUUID();
  f.f.p.trade.sourceSequence = '9007199254740994';
  f.f.s.book.sourceSequence = '9007199254740994';
  f.f.s.expectedRevision = f.f.p.expectedRevision = '1';
  f.f.s.timestamp = f.f.p.timestamp = now;
  for (const v of [f.f.s.ticker, f.f.s.book, f.f.p.trade]) v.receivedAt = v.exchangeTime = now;
  await f.snapshots.publish(f.f.s, io());
  await f.trades.publish(f.f.p, io());
  await (await openAuthority()).read(f.request, io());
  await expect((await openContext()).read(f.request, io())).rejects.toThrow(
    'PAPER_RISK_CONTEXT_STALE',
  );
});
it('context: lost acknowledged read COMMIT returns no context and restart has no monetary effect', async () => {
  const f = await ready();
  await runtimeEvidence(f);
  const before = await effects(f.c.owner.tenantId),
    proxy = await registryCommitProxy(
      required('DATABASE_PAPER_RISK_CONTEXT_URL'),
      'PAPER_RISK_CONTEXT',
    );
  try {
    const h = await openContext(proxy.connectionString);
    proxy.arm();
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_CONTEXT_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    expect(
      (await (await openContext()).read(f.request, io())).authority.orderRisk.target.orderId,
    ).toBe(f.order!.id);
    expect(await effects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await proxy.close();
  }
});
it.each(['abort', 'deadline'] as const)(
  'context: %s physically settles a blocked read and frees its slot',
  async (kind) => {
    const f = await ready();
    await runtimeEvidence(f);
    const h = await openContext(),
      p = await admin.connect(),
      controller = new AbortController();
    try {
      await p.query('BEGIN');
      await p.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.fundingId]);
      const rejected = expect(
        h.read(f.request, io(controller.signal, kind === 'deadline' ? 150 : 2500)),
      ).rejects.toThrow('PAPER_RISK_CONTEXT_ABORTED');
      await wait(50);
      const start = Date.now();
      if (kind === 'abort') controller.abort();
      await rejected;
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      controller.abort();
      await p.query('ROLLBACK');
      p.release();
    }
    expect((await h.read(f.request, io())).authority.orderRisk.target.orderId).toBe(f.order!.id);
  },
);
it('context: four physical slots remain bounded and close drains pending work before restart', async () => {
  const f = await ready();
  await runtimeEvidence(f);
  const h = await openContext(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.fundingId]);
    const pending = Promise.allSettled(Array.from({ length: 4 }, () => h.read(f.request, io())));
    await wait(60);
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_CONTEXT_BUSY');
    await h.close();
    expect((await pending).every((v) => v.status === 'rejected')).toBe(true);
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_CONTEXT_CLOSED');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  expect(
    (await (await openContext()).read(f.request, io())).authority.orderRisk.target.orderId,
  ).toBe(f.order!.id);
});
it.each(['LOGIN', 'extra-function'] as const)(
  'context: SQL rechecks %s role authority after startup',
  async (kind) => {
    const f = await ready();
    await runtimeEvidence(f);
    const h = await openContext();
    await admin.query(
      kind === 'LOGIN'
        ? 'ALTER ROLE ctp_paper_risk_context LOGIN'
        : 'GRANT EXECUTE ON FUNCTION ctp_paper.capture_risk_authority(jsonb) TO ctp_paper_risk_context',
    );
    try {
      await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_CONTEXT_ROLE_UNSAFE');
    } finally {
      await admin.query(
        kind === 'LOGIN'
          ? 'ALTER ROLE ctp_paper_risk_context NOLOGIN'
          : 'REVOKE EXECUTE ON FUNCTION ctp_paper.capture_risk_authority(jsonb) FROM ctp_paper_risk_context',
      );
    }
  },
);
it('context: capture-only login has no private helper, old RPC, financial or table authority', async () => {
  const pool = new Pool({ connectionString: required('DATABASE_PAPER_RISK_CONTEXT_URL') });
  try {
    for (const fn of [
      'context_authority_capture',
      'context_runtime_capture',
      'authority_order_capture',
      'capture_risk_authority',
      'capture_runtime_observation',
    ]) {
      expect(
        (
          await pool.query<{ allowed: boolean }>(
            "SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",
            [`ctp_paper.${fn}(jsonb)`],
          )
        ).rows[0]!.allowed,
      ).toBe(false);
    }
    expect(
      (
        await pool.query<{ allowed: boolean }>(
          "SELECT has_schema_privilege(current_user,'ctp_admission','USAGE') allowed",
        )
      ).rows[0]!.allowed,
    ).toBe(false);
    await expect(pool.query('INSERT INTO public.order_intent DEFAULT VALUES')).rejects.toThrow(
      /permission denied/u,
    );
  } finally {
    await pool.end();
  }
});
it('context: runtime publication waits through capture COMMIT and the next read sees its exact new revision', async () => {
  const f = await ready(),
    e = await runtimeEvidence(f),
    pool = new Pool({ connectionString: required('DATABASE_PAPER_RISK_CONTEXT_URL') }),
    p = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query('SELECT ctp_paper.capture_risk_context($1::jsonb)', [JSON.stringify(f.request)]);
    const next = structuredClone(e.publication);
    next.id = randomUUID();
    next.expectedRevision = e.receipt.revision;
    next.observation.health.executor.status = 'UNKNOWN';
    next.observation.health.executor.asOf = Date.now();
    let settled = false;
    pending = e.h.publish(next, io()).then(
      (r) => {
        settled = true;
        return r;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    // Observe a possible rejection immediately while deliberately holding locks.
    void pending.catch(() => {});
    await wait(80);
    expect(settled).toBe(false);
    await p.query('COMMIT');
    await pending;
    const after = await (await openContext()).read(f.request, io());
    expect(after.runtime.reference.revision).toBe('2');
    expect(after.runtime.blockedBy).toEqual(['executor']);
  } finally {
    await p.query('ROLLBACK');
    p.release();
    await pool.end();
    await pending?.catch(() => {});
  }
});
it.each(['policy', 'global-control'] as const)(
  'context: %s writer waits through the common transaction',
  async (kind) => {
    const f = await ready();
    await runtimeEvidence(f);
    const pool = new Pool({ connectionString: required('DATABASE_PAPER_RISK_CONTEXT_URL') }),
      p = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await p.query('BEGIN');
      await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
      await p.query('SELECT ctp_paper.capture_risk_context($1::jsonb)', [
        JSON.stringify(f.request),
      ]);
      let settled = false;
      pending = (
        kind === 'policy'
          ? updatePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' })
          : updateControl(null, 'PAUSED')
      ).then(
        (r) => {
          settled = true;
          return r;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      void pending.catch(() => {});
      await wait(80);
      expect(settled).toBe(false);
      await p.query('COMMIT');
      await pending;
      const after = await (await openContext()).read(f.request, io());
      if (kind === 'policy') expect(after.authority.policies.effective.maxOrderNotional).toBe('1');
      else expect(after.authority.controls.pauses.global).toBe(true);
    } finally {
      await p.query('ROLLBACK');
      p.release();
      await pool.end();
      await pending?.catch(() => {});
      if (kind !== 'policy') await updateControl(null, 'RUNNING');
    }
  },
);
it('authority compatibility: restart and concurrent reads preserve immutable original command, seed and client counter', async () => {
  const f = await ready(),
    before = await effects(f.c.owner.tenantId),
    h = await openSource(),
    first = await h.read(f.request, io());
  await h.close();
  const restarted = await openSource();
  const results = await Promise.all([
    restarted.read(f.request, io()),
    restarted.read(f.request, io()),
  ]);
  for (const r of results) {
    expect(r.target).toEqual(first.target);
    expect(r.book.origin).toEqual(first.book.origin);
    expect(r.envelope.debits).toEqual(first.envelope.debits);
  }
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});
it.each(['tenant', 'account', 'intent', 'override'] as const)(
  'rejects foreign or caller-controlled %s',
  async (kind) => {
    const f = await ready(),
      h = await openSource(),
      request = structuredClone(f.request);
    if (kind === 'tenant') request.owner.tenantId = randomUUID();
    if (kind === 'account') request.owner.accountId = randomUUID();
    if (kind === 'intent') request.intentId = randomUUID();
    if (kind === 'override') Object.assign(request, { command: f.order!.command });
    await expect(h.read(request, io())).rejects.toThrow(/PAPER_RISK_AUTHORITY_(OWNERSHIP|INPUT)/);
  },
);
it.each(['book', 'trade'] as const)('%s GAP invalidates capture wholly', async (kind) => {
  const f = await ready(),
    h = await openSource();
  const gap = {
    kind: 'GAP' as const,
    id: randomUUID(),
    key: f.f.p.key,
    expectedRevision: '1',
    timestamp: Date.now(),
    reason: 'TEST_GAP',
  };
  if (kind === 'book') await f.snapshots.publish(gap, io());
  else await f.trades.publish(gap, io());
  await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_AUTHORITY_MARKET');
});
it('authority compatibility: current rule replacement cannot certify a stale original command', async () => {
  const f = await ready(),
    h = await openSource();
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_AUTHORITY_MARKET');
});
it('authority compatibility: expired native evidence rejects even when the seeded cash book remains intact', async () => {
  const f = await ready(),
    h = await openSource();
  await wait(5050);
  await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_AUTHORITY_STALE');
});
it('authority compatibility: an UNKNOWN order status prevents pristine draft evidence', async () => {
  const f = await ready(),
    h = await openSource();
  await admin.query(
    'UPDATE public."order" SET status=\'UNKNOWN\',version=1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.order!.id],
  );
  await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_AUTHORITY_INCOMPLETE');
});
it.each(['abort', 'deadline'] as const)(
  '%s destroys a hung capture and releases its slot',
  async (kind) => {
    const f = await ready(),
      h = await openSource(),
      p = await admin.connect(),
      controller = new AbortController();
    try {
      await p.query('BEGIN');
      await p.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.fundingId]);
      const rejected = expect(
        h.read(f.request, io(controller.signal, kind === 'deadline' ? 150 : 2500)),
      ).rejects.toThrow('PAPER_RISK_AUTHORITY_ABORTED');
      await wait(50);
      const start = Date.now();
      if (kind === 'abort') controller.abort();
      await rejected;
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      controller.abort();
      await p.query('ROLLBACK');
      p.release();
    }
    expect((await h.read(f.request, io())).target.orderId).toBe(f.order!.id);
  },
);
it('authority compatibility: four actual sockets bound waiting captures and close drains all before restart', async () => {
  const f = await ready(),
    h = await openSource(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.fundingId]);
    const pending = Promise.allSettled(Array.from({ length: 4 }, () => h.read(f.request, io())));
    await wait(60);
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_AUTHORITY_BUSY');
    await h.close();
    expect((await pending).every((v) => v.status === 'rejected')).toBe(true);
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_AUTHORITY_CLOSED');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  expect((await (await openSource()).read(f.request, io())).target.orderId).toBe(f.order!.id);
});
it('authority compatibility: lost acknowledged read COMMIT returns no source and restart adds no monetary effect', async () => {
  const f = await ready(),
    before = await effects(f.c.owner.tenantId),
    proxy = await registryCommitProxy(
      required('DATABASE_PAPER_RISK_AUTHORITY_URL'),
      'PAPER_RISK_AUTHORITY',
    );
  try {
    const h = await openSource(proxy.connectionString);
    proxy.arm();
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_AUTHORITY_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    expect((await (await openSource()).read(f.request, io())).target.orderId).toBe(f.order!.id);
    expect(await effects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await proxy.close();
  }
});
it('authority compatibility: head and rule replacements wait until capture transaction settles', async () => {
  const f = await ready(),
    runtime = new Pool({
      connectionString: required('DATABASE_PAPER_RISK_AUTHORITY_URL'),
      max: 1,
      query_timeout: 3000,
    }),
    p = await runtime.connect(),
    writer = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query('SELECT ctp_paper.capture_risk_authority($1::jsonb)', [
      JSON.stringify(f.request),
    ]);
    for (const table of [
      'public.instrument_rule_version',
      'ctp_market.snapshot_head',
      'ctp_market.trade_head',
    ]) {
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout='80ms'");
      await expect(writer.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`)).rejects.toThrow(
        /lock timeout/,
      );
      await writer.query('ROLLBACK');
    }
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await p.query('ROLLBACK');
    p.release();
    await runtime.end();
  }
});
it('authority compatibility: unapplied execution evidence cannot masquerade as an untouched draft', async () => {
  const f = await ready(),
    h = await openSource(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query(
      'INSERT INTO ctp_execution.evidence("tenantId","orderId",identity,fingerprint) VALUES($1,$2,$3,$4)',
      [f.c.owner.tenantId, f.order!.id, randomUUID(), Buffer.alloc(32, 1)],
    );
    await p.query('COMMIT');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_AUTHORITY_INCOMPLETE');
});
it.each(['LOGIN', 'extra-function'] as const)(
  'runtime rechecks %s role authority after startup',
  async (kind) => {
    const f = await ready(),
      h = await openSource();
    const mutation =
        kind === 'LOGIN'
          ? 'ALTER ROLE ctp_paper_risk_authority LOGIN'
          : 'GRANT EXECUTE ON FUNCTION ctp_registry.publish(jsonb,jsonb) TO ctp_paper_risk_authority',
      restore =
        kind === 'LOGIN'
          ? 'ALTER ROLE ctp_paper_risk_authority NOLOGIN'
          : 'REVOKE EXECUTE ON FUNCTION ctp_registry.publish(jsonb,jsonb) FROM ctp_paper_risk_authority';
    await admin.query(mutation);
    try {
      await expect(h.read(f.request, io())).rejects.toThrow('PAPER_RISK_AUTHORITY_ROLE_UNSAFE');
    } finally {
      await admin.query(restore);
    }
  },
);

it('authority source captures actual policy/control/permission heads without minting Risk authority', async () => {
  const f = await ready(),
    before = await effects(f.c.owner.tenantId),
    h = await openAuthority();
  const r = await h.read(f.request, io());
  expect(r).toMatchObject({
    kind: 'PAPER_RISK_AUTHORITY_SOURCE',
    request: f.request,
    identity: {
      tenantId: f.c.owner.tenantId,
      accountId: f.c.owner.accountId,
      mode: 'PAPER',
      connectionId: null,
    },
    policies: {
      platform: { mode: 'PAPER' },
      user: { mode: 'PAPER', scope: { kind: 'USER', tenantId: f.c.owner.tenantId } },
    },
    controls: { pauses: { global: false, user: false, strategy: false }, circuit: 'CLOSED' },
  });
  expect(r.identity.permissionEpoch).toBe(r.orderRisk.book.accountState.permissionEpoch);
  expect(r.orderRisk.envelope.quoteNotionalBound).toBe('500');
  expect(r.policies.effective.maxOrderNotional).toBe('100');
  for (const name of ['certificate', 'grant', 'reservation', 'permit', 'health', 'capabilities'])
    expect(name in r).toBe(false);
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});
it('missing PAPER policy cannot fall back to defaults', async () => {
  const f = await ready(false);
  await expect((await openAuthority()).read(f.request, io())).rejects.toThrow(
    'PAPER_RISK_AUTHORITY_POLICY',
  );
});
it('a DEMO policy cannot substitute for exact PAPER storage mode', async () => {
  const f = await ready(false);
  await updatePolicy(f.c.owner.tenantId, 'PLATFORM');
  await updatePolicy(f.c.owner.tenantId, 'USER', {}, 'DEMO');
  await expect((await openAuthority()).read(f.request, io())).rejects.toThrow(
    'PAPER_RISK_AUTHORITY_POLICY',
  );
});
it('policy refresh is reread after restart without mutating the original command or funding', async () => {
  const f = await ready(),
    h = await openAuthority(),
    before = await h.read(f.request, io());
  await h.close();
  const updated = await updatePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' });
  const after = await (await openAuthority()).read(f.request, io());
  expect(after.policies.user.version).toBe(updated.version);
  expect(BigInt(after.policies.user.version)).toBe(BigInt(before.policies.user.version) + 1n);
  expect(after.policies.effective.maxOrderNotional).toBe('1');
  expect(after.orderRisk.target).toEqual(before.orderRisk.target);
  expect(after.orderRisk.book.origin).toEqual(before.orderRisk.book.origin);
  expect(after.hash).not.toBe(before.hash);
});
it('policy/config valuation conflict rejects the whole capture', async () => {
  const f = await ready();
  await updatePolicy(f.c.owner.tenantId, 'USER', { valuationAsset: 'USD' });
  await expect((await openAuthority()).read(f.request, io())).rejects.toThrow(
    'PAPER_RISK_AUTHORITY_POLICY',
  );
});
it('a tighter current policy invalidates older public evidence without renewing its timestamp', async () => {
  const f = await ready();
  await updatePolicy(f.c.owner.tenantId, 'USER', { maxEvidenceAgeMs: 100 });
  await wait(150);
  await expect((await openAuthority()).read(f.request, io())).rejects.toThrow(
    'PAPER_RISK_AUTHORITY_STALE',
  );
});
it('permission/session epochs remain lossless and current with no financial side effect', async () => {
  const f = await ready(),
    h = await openAuthority(),
    before = await effects(f.c.owner.tenantId);
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"=9007199254740993,version=version+1 WHERE id=$1',
    [f.c.owner.accountId],
  );
  await admin.query('UPDATE public."user" SET "sessionEpoch"=2147483647 WHERE id=$1', [
    f.c.owner.tenantId,
  ]);
  const r = await h.read(f.request, io());
  expect(r.identity.permissionEpoch).toBe('9007199254740993');
  expect(r.identity.userSessionEpoch).toBe('2147483647');
  expect(r.orderRisk.book.accountState.permissionEpoch).toBe('9007199254740993');
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});
it.each(['GLOBAL', 'USER'] as const)(
  '%s pause remains explicit source evidence and never an approval',
  async (kind) => {
    const f = await ready();
    const tenantId = kind === 'GLOBAL' ? null : f.c.owner.tenantId;
    await updateControl(tenantId, 'PAUSED');
    try {
      const r = await (await openAuthority()).read(f.request, io());
      expect(r.controls.pauses[kind === 'GLOBAL' ? 'global' : 'user']).toBe(true);
      expect(r).not.toHaveProperty('grant');
    } finally {
      await updateControl(tenantId, 'RUNNING');
    }
  },
);
it('legacy tenant pause and circuit evidence remains conservative in PAPER', async () => {
  const f = await ready(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query(
      `INSERT INTO public.trading_pause("tenantId",scope,"scopeKey",epoch,"reasonCode",initiator,"pausedAt") VALUES($1::uuid,'USER',$1::text,1,'TEST_PAUSE','test',now())`,
      [f.c.owner.tenantId],
    );
    await p.query(
      `INSERT INTO public.circuit_state("tenantId",scope,"scopeKey","circuitKey",status,"reasonCode","updatedAt") VALUES($1::uuid,'USER',$1::text,'test','HALF_OPEN','TEST_CIRCUIT',now())`,
      [f.c.owner.tenantId],
    );
    await p.query('COMMIT');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  const r = await (await openAuthority()).read(f.request, io());
  expect(r.controls.pauses.user).toBe(true);
  expect(r.controls.circuit).toBe('HALF_OPEN');
});
it('authority login has neither private helper/old source nor financial/table access', async () => {
  const f = await ready(),
    pool = new Pool({ connectionString: required('DATABASE_PAPER_RISK_AUTHORITY_URL') });
  try {
    const allowed = (
      await pool.query<{ helper: boolean; old: boolean; risk: boolean; table: boolean }>(`SELECT
      has_function_privilege(current_user,'ctp_paper.authority_order_capture(jsonb)','EXECUTE') helper,
      has_function_privilege(current_user,'ctp_paper.capture_order_risk(jsonb)','EXECUTE') old,
      has_schema_privilege(current_user,'ctp_admission','USAGE') risk,
      has_table_privilege(current_user,(SELECT c.oid FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='order_intent'),'INSERT') "table"`)
    ).rows[0]!;
    expect(allowed).toEqual({ helper: false, old: false, risk: false, table: false });
    await expect(
      pool.query('SELECT ctp_paper.authority_order_capture($1::jsonb)', [
        JSON.stringify(f.request),
      ]),
    ).rejects.toThrow(/permission denied/u);
    await expect(pool.query('INSERT INTO public.order_intent DEFAULT VALUES')).rejects.toThrow(
      /permission denied/u,
    );
  } finally {
    await pool.end();
  }
});
it.each(['platform policy', 'user policy', 'global control', 'user control'] as const)(
  '%s publication waits until the atomic authority capture settles',
  async (kind) => {
    const f = await ready(),
      source = new Pool({ connectionString: required('DATABASE_PAPER_RISK_AUTHORITY_URL') }),
      p = await source.connect();
    const isPolicy = kind.endsWith('policy'),
      global = kind === 'platform policy' || kind === 'global control';
    const writer = new Pool({
      connectionString: required(
        isPolicy
          ? global
            ? 'DATABASE_RISK_POLICY_OPERATOR_URL'
            : 'DATABASE_RISK_POLICY_CONTROLLER_URL'
          : global
            ? 'DATABASE_RISK_OPERATOR_URL'
            : 'DATABASE_RISK_CONTROL_URL',
      ),
    });
    const w = await writer.connect();
    const tenantId = f.c.owner.tenantId;
    try {
      await p.query('BEGIN');
      await p.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await p.query('SELECT ctp_paper.capture_risk_authority($1::jsonb)', [
        JSON.stringify(f.request),
      ]);
      await w.query('BEGIN');
      await w.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await w.query("SET LOCAL lock_timeout='80ms'");
      let sql: string, payload: unknown;
      if (isPolicy) {
        const scope = global ? 'PLATFORM' : 'USER',
          target = global ? '00000000-0000-0000-0000-000000000000' : tenantId;
        const version = (
          await admin.query<{ version: string }>(
            "SELECT version::text FROM ctp_risk.policy_head WHERE scope=$1 AND target=$2 AND mode='PAPER'",
            [scope, target],
          )
        ).rows[0]!.version;
        const limits = riskFixture().platform;
        payload = {
          scope: global ? { kind: 'PLATFORM' } : { kind: 'USER', tenantId },
          mode: 'PAPER',
          eventId: randomUUID(),
          expectedVersion: version,
          reason: 'TEST_PAPER_ORDERING',
          limitsText: policyLimitsText(limits),
          limitsHash: policyFingerprint(limits),
        };
        sql = global
          ? 'SELECT ctp_risk.update_platform_policy($1::jsonb)'
          : 'SELECT ctp_risk.update_user_policy($1::jsonb)';
      } else {
        const epoch = global
          ? (
              await admin.query<{ epoch: string }>(
                "SELECT epoch::text FROM ctp_risk.global_head WHERE kind='KILL_SWITCH' AND key='kill'",
              )
            ).rows[0]!.epoch
          : '0';
        payload = {
          scope: global ? { kind: 'GLOBAL' } : { kind: 'USER', tenantId, targetId: tenantId },
          kind: 'KILL_SWITCH',
          key: 'kill',
          state: 'PAUSED',
          eventId: randomUUID(),
          expectedEpoch: epoch,
          reason: 'TEST_PAPER_ORDERING',
          evidenceHash: '1'.repeat(64),
        };
        sql = global
          ? 'SELECT ctp_risk.update_global($1::jsonb)'
          : 'SELECT ctp_risk.update_tenant($1::jsonb)';
      }
      await expect(w.query(sql, [JSON.stringify(payload)])).rejects.toThrow(/lock timeout/u);
      await w.query('ROLLBACK');
      await p.query('COMMIT');
      if (isPolicy)
        await updatePolicy(tenantId, global ? 'PLATFORM' : 'USER', { maxOrderNotional: '1' });
      else await updateControl(global ? null : tenantId, 'PAUSED');
      const r = await (await openAuthority()).read(f.request, io());
      if (isPolicy) expect(r.policies.effective.maxOrderNotional).toBe('1');
      else expect(r.controls.pauses[global ? 'global' : 'user']).toBe(true);
    } finally {
      await p.query('ROLLBACK');
      p.release();
      await source.end();
      await w.query('ROLLBACK');
      w.release();
      await writer.end();
      if (!isPolicy) await updateControl(global ? null : tenantId, 'RUNNING');
    }
  },
);
it.each(['pause', 'circuit'] as const)(
  'legacy %s insertion respects capture ordering without catalog-lock inversion',
  async (kind) => {
    const f = await ready(),
      runtime = new Pool({ connectionString: required('DATABASE_PAPER_RISK_AUTHORITY_URL') }),
      p = await runtime.connect(),
      w = await admin.connect();
    try {
      await p.query('BEGIN');
      await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
      await p.query('SELECT ctp_paper.capture_risk_authority($1::jsonb)', [
        JSON.stringify(f.request),
      ]);
      await w.query('BEGIN');
      await w.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
      await w.query("SET LOCAL lock_timeout='80ms'");
      const sql =
        kind === 'pause'
          ? `INSERT INTO public.trading_pause("tenantId",scope,"scopeKey",epoch,"reasonCode",initiator,"pausedAt") VALUES($1::uuid,'USER',$1::text,1,'TEST_PAUSE','test',now())`
          : `INSERT INTO public.circuit_state("tenantId",scope,"scopeKey","circuitKey",status,"reasonCode","updatedAt") VALUES($1::uuid,'USER',$1::text,'test','OPEN','TEST_CIRCUIT',now())`;
      await expect(w.query(sql, [f.c.owner.tenantId])).rejects.toThrow(/lock timeout/u);
    } finally {
      await w.query('ROLLBACK');
      w.release();
      await p.query('ROLLBACK');
      p.release();
      await runtime.end();
    }
  },
);

it('tenant-context: lost acknowledged read COMMIT returns no context and restart has no monetary effect', async () => {
  const f = await tenantReady();
  await runtimeEvidence(f);
  const before = await effects(f.c.owner.tenantId),
    proxy = await registryCommitProxy(
      required('DATABASE_PAPER_TENANT_RISK_CONTEXT_URL'),
      'PAPER_TENANT_RISK_CONTEXT',
    );
  try {
    const h = await openTenantContext(proxy.connectionString);
    proxy.arm();
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_TENANT_RISK_CONTEXT_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    expect(
      (await (await openTenantContext()).read(f.request, io())).context.authority.orderRisk.target
        .orderId,
    ).toBe(f.order.id);
    expect(await effects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await proxy.close();
  }
});
it.each(['abort', 'deadline'] as const)(
  'tenant-context: %s physically settles a blocked read and frees its slot',
  async (kind) => {
    const f = await tenantReady();
    await runtimeEvidence(f);
    const h = await openTenantContext(),
      p = await admin.connect(),
      controller = new AbortController();
    try {
      await p.query('BEGIN');
      await p.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.fundingId]);
      const rejected = expect(
        h.read(f.request, io(controller.signal, kind === 'deadline' ? 150 : 2500)),
      ).rejects.toThrow('PAPER_TENANT_RISK_CONTEXT_ABORTED');
      await wait(50);
      const start = Date.now();
      if (kind === 'abort') controller.abort();
      await rejected;
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      controller.abort();
      await p.query('ROLLBACK');
      p.release();
    }
    expect((await h.read(f.request, io())).context.authority.orderRisk.target.orderId).toBe(
      f.order.id,
    );
  },
);
it('tenant-context: four physical slots remain bounded and close drains pending work before restart', async () => {
  const f = await tenantReady();
  await runtimeEvidence(f);
  const h = await openTenantContext(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.fundingId]);
    const pending = Promise.allSettled(Array.from({ length: 4 }, () => h.read(f.request, io())));
    await wait(60);
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_TENANT_RISK_CONTEXT_BUSY');
    await h.close();
    expect((await pending).every((v) => v.status === 'rejected')).toBe(true);
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_TENANT_RISK_CONTEXT_CLOSED');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  expect(
    (await (await openTenantContext()).read(f.request, io())).context.authority.orderRisk.target
      .orderId,
  ).toBe(f.order.id);
});
it.each(['LOGIN', 'extra-function'] as const)(
  'tenant-context: SQL rechecks %s role authority after startup',
  async (kind) => {
    const f = await tenantReady();
    await runtimeEvidence(f);
    const h = await openTenantContext();
    await admin.query(
      kind === 'LOGIN'
        ? 'ALTER ROLE ctp_paper_tenant_risk_context LOGIN'
        : 'GRANT EXECUTE ON FUNCTION ctp_paper.capture_risk_authority(jsonb) TO ctp_paper_tenant_risk_context',
    );
    try {
      await expect(h.read(f.request, io())).rejects.toThrow(
        'PAPER_TENANT_RISK_CONTEXT_ROLE_UNSAFE',
      );
    } finally {
      await admin.query(
        kind === 'LOGIN'
          ? 'ALTER ROLE ctp_paper_tenant_risk_context NOLOGIN'
          : 'REVOKE EXECUTE ON FUNCTION ctp_paper.capture_risk_authority(jsonb) FROM ctp_paper_tenant_risk_context',
      );
    }
  },
);
it('tenant-context: capture-only login has no private helper, old RPC, financial or table authority', async () => {
  const pool = new Pool({ connectionString: required('DATABASE_PAPER_TENANT_RISK_CONTEXT_URL') });
  try {
    for (const fn of [
      'tenant_context_loss_capture',
      'capture_risk_loss',
      'capture_risk_context',
      'context_authority_capture',
      'context_runtime_capture',
      'authority_order_capture',
      'capture_risk_authority',
      'capture_runtime_observation',
    ]) {
      expect(
        (
          await pool.query<{ allowed: boolean }>(
            "SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",
            [`ctp_paper.${fn}(jsonb)`],
          )
        ).rows[0]!.allowed,
      ).toBe(false);
    }
    expect(
      (
        await pool.query<{ allowed: boolean }>(
          "SELECT has_schema_privilege(current_user,'ctp_admission','USAGE') allowed",
        )
      ).rows[0]!.allowed,
    ).toBe(false);
    await expect(pool.query('INSERT INTO public.order_intent DEFAULT VALUES')).rejects.toThrow(
      /permission denied/u,
    );
  } finally {
    await pool.end();
  }
});
it('tenant-context: runtime publication waits through capture COMMIT and the next read sees its exact new revision', async () => {
  const f = await tenantReady(),
    e = await runtimeEvidence(f),
    pool = new Pool({ connectionString: required('DATABASE_PAPER_TENANT_RISK_CONTEXT_URL') }),
    p = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query('SELECT ctp_paper.capture_tenant_risk_context($1::jsonb)', [
      JSON.stringify(f.request),
    ]);
    const next = structuredClone(e.publication);
    next.id = randomUUID();
    next.expectedRevision = e.receipt.revision;
    next.observation.health.executor.status = 'UNKNOWN';
    next.observation.health.executor.asOf = Date.now();
    let settled = false;
    pending = e.h.publish(next, io()).then(
      (r) => {
        settled = true;
        return r;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    // Observe a possible rejection immediately while deliberately holding locks.
    void pending.catch(() => {});
    await wait(80);
    expect(settled).toBe(false);
    await p.query('COMMIT');
    await pending;
    const after = await (await openTenantContext()).read(f.request, io());
    expect(after.context.runtime.reference.revision).toBe('2');
    expect(after.context.runtime.blockedBy).toEqual(['executor']);
  } finally {
    await p.query('ROLLBACK');
    p.release();
    await pool.end();
    await pending?.catch(() => {});
  }
});
it.each(['policy', 'global-control'] as const)(
  'tenant-context: %s writer waits through the common transaction',
  async (kind) => {
    const f = await tenantReady();
    await runtimeEvidence(f);
    const pool = new Pool({ connectionString: required('DATABASE_PAPER_TENANT_RISK_CONTEXT_URL') }),
      p = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await p.query('BEGIN');
      await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
      await p.query('SELECT ctp_paper.capture_tenant_risk_context($1::jsonb)', [
        JSON.stringify(f.request),
      ]);
      let settled = false;
      pending = (
        kind === 'policy'
          ? updatePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' })
          : updateControl(null, 'PAUSED')
      ).then(
        (r) => {
          settled = true;
          return r;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      void pending.catch(() => {});
      await wait(80);
      expect(settled).toBe(false);
      await p.query('COMMIT');
      await pending;
      const after = await (await openTenantContext()).read(f.request, io());
      if (kind === 'policy')
        expect(after.context.authority.policies.effective.maxOrderNotional).toBe('1');
      else expect(after.context.authority.controls.pauses.global).toBe(true);
    } finally {
      await p.query('ROLLBACK');
      p.release();
      await pool.end();
      await pending?.catch(() => {});
      if (kind !== 'policy') await updateControl(null, 'RUNNING');
    }
  },
);
async function openTenantContext(
  connectionString = required('DATABASE_PAPER_TENANT_RISK_CONTEXT_URL'),
) {
  const h = await authority.createPostgresPaperTenantRiskContextSource({
    connectionString,
    environment: 'test',
  });
  handles.push(h);
  return h;
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
async function tenantReady() {
  const f = await fixture(),
    fundingId = await fundCash(f.c),
    orders = await openOrders(),
    order = await orders.create(f.binding, f.draft, io());
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
async function cashSibling(f: Awaited<ReturnType<typeof tenantReady>>, kind = 'cash') {
  const accountId = randomUUID(),
    c = paperConfigurationSchema.parse({
      ...f.c,
      id: randomUUID(),
      owner: { ...f.c.owner, accountId },
    });
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'paper-sibling-epoch\',now())',
    [accountId, c.owner.tenantId, c.source.exchange, 'paper:' + accountId, c.source.region],
  );
  if (kind !== 'missing') {
    await fundCash(c, kind === 'noncash');
    await (await openBook()).initialize(c.owner, io());
  }
  if (kind === 'disabled')
    await admin.query("UPDATE public.exchange_account SET status='DISABLED' WHERE id=$1", [
      accountId,
    ]);
  if (kind === 'UNKNOWN') {
    const b = bindingSchema.parse({
      ...f.binding,
      accountId,
      externalAccountId: 'paper:' + accountId,
    });
    const order = await f.orders.create(b, { ...f.draft, key: randomUUID() }, io());
    await admin.query('UPDATE public."order" SET status=\'UNKNOWN\' WHERE id=$1', [order.id]);
  }
  return c;
}
it('tenant-context: complete two-account cash history and exact target survive restart without a second monetary effect', async () => {
  const f = await tenantReady();
  await cashSibling(f);
  await runtimeEvidence(f, 'UNKNOWN');
  const before = await effects(f.c.owner.tenantId),
    h = await openTenantContext(),
    r = await h.read(f.request, io());
  expect(r.loss.inventory.accountIds).toHaveLength(2);
  expect(r.loss.actualEquity).toBe('2000');
  expect(r.context.authority.orderRisk.target.orderId).toBe(f.order.id);
  expect(r.context.runtime.blockedBy).toEqual(['executor']);
  expect(
    r.loss.inventory.accounts.find((a) => a.state.binding.accountId === f.c.owner.accountId)!.hash,
  ).toBe(r.context.authority.orderRisk.book.hash);
  expect(r.validUntil).toBeLessThanOrEqual(r.loss.validUntil);
  for (const key of ['certificate', 'grant', 'reservation', 'permit', 'approve'])
    expect(r).not.toHaveProperty(key);
  await h.close();
  const restarted = await (await openTenantContext()).read(f.request, io());
  expect(restarted.loss.actualEquity).toBe(r.loss.actualEquity);
  expect(restarted.context.authority.orderRisk.target).toEqual(
    r.context.authority.orderRisk.target,
  );
  expect(restarted.context.runtime.reference).toEqual(r.context.runtime.reference);
  expect(await effects(f.c.owner.tenantId)).toEqual(before);
});
it('tenant-context: missing target runtime has no healthy fallback even with complete cash books', async () => {
  const f = await tenantReady();
  await cashSibling(f);
  await expect((await openTenantContext()).read(f.request, io())).rejects.toThrow(
    'PAPER_TENANT_RISK_CONTEXT_MISSING',
  );
});
it.each(['missing', 'disabled', 'UNKNOWN', 'noncash'])(
  'tenant-context: %s sibling rejects the whole inventory instead of proving partial zero loss',
  async (kind) => {
    const f = await tenantReady();
    await cashSibling(f, kind);
    await runtimeEvidence(f);
    const before = await effects(f.c.owner.tenantId);
    await expect((await openTenantContext()).read(f.request, io())).rejects.toThrow(
      /PAPER_TENANT_RISK_CONTEXT_(MISSING|OWNERSHIP|INCOMPLETE|CASH_ONLY)/u,
    );
    expect(await effects(f.c.owner.tenantId)).toEqual(before);
  },
);
it('tenant-context: permission replacement after restart cannot reuse old runtime evidence or mismatched target book', async () => {
  const f = await tenantReady();
  await cashSibling(f);
  await runtimeEvidence(f);
  const h = await openTenantContext();
  await h.read(f.request, io());
  await h.close();
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE id=$1',
    [f.c.owner.accountId],
  );
  await expect((await openTenantContext()).read(f.request, io())).rejects.toThrow(
    'PAPER_TENANT_RISK_CONTEXT_EPOCH',
  );
});
it('tenant-context: held capture closes account FK insertion phantoms until COMMIT', async () => {
  const f = await tenantReady();
  await runtimeEvidence(f);
  const pool = new Pool({ connectionString: required('DATABASE_PAPER_TENANT_RISK_CONTEXT_URL') }),
    p = await pool.connect(),
    w = await admin.connect();
  const accountId = randomUUID();
  const insert = () =>
    w.query(
      'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'new-sibling-epoch\',now())',
      [accountId, f.c.owner.tenantId, f.c.source.exchange, 'paper:' + accountId, f.c.source.region],
    );
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query('SELECT ctp_paper.capture_tenant_risk_context($1::jsonb)', [
      JSON.stringify(f.request),
    ]);
    await w.query('BEGIN');
    await w.query("SET LOCAL lock_timeout='100ms'");
    await expect(insert()).rejects.toThrow(/lock timeout/u);
    await w.query('ROLLBACK');
    await p.query('COMMIT');
    await insert();
    await expect((await openTenantContext()).read(f.request, io())).rejects.toThrow(
      'PAPER_TENANT_RISK_CONTEXT_MISSING',
    );
  } finally {
    await w.query('ROLLBACK');
    w.release();
    await p.query('ROLLBACK');
    p.release();
    await pool.end();
  }
});
