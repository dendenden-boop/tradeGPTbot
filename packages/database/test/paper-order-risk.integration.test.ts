import { setTimeout as wait } from 'node:timers/promises';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import * as portfolio from '@ctp/paper-engine/portfolio';

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

async function ready() {
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
  const now = Date.now();
  f.f.s.timestamp = f.f.p.timestamp = now;
  for (const v of [f.f.s.ticker, f.f.s.book, f.f.p.trade]) v.receivedAt = v.exchangeTime = now;
  await snapshots.publish(f.f.s, io());
  await trades.publish(f.f.p, io());
  const request = { owner: f.c.owner, intentId: f.order!.intentId };
  return { ...f, snapshots, trades, request };
}
async function openSource(connectionString = required('DATABASE_PAPER_ORDER_RISK_URL')) {
  const h = await portfolio.createPostgresPaperOrderRiskSource({
    connectionString,
    environment: 'test',
  });
  handles.push(h);
  return h;
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
it('actual durable PAPER PLACE and public heads yield conservative debits with no financial effect', async () => {
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
it('restart and concurrent reads preserve immutable original command, seed and client counter', async () => {
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
    await expect(h.read(request, io())).rejects.toThrow(/PAPER_ORDER_RISK_(OWNERSHIP|INPUT)/);
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
  await expect(h.read(f.request, io())).rejects.toThrow('PAPER_ORDER_RISK_MARKET');
});
it('current rule replacement cannot certify a stale original command', async () => {
  const f = await ready(),
    h = await openSource();
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  await expect(h.read(f.request, io())).rejects.toThrow('PAPER_ORDER_RISK_MARKET');
});
it('expired native evidence rejects even when the seeded cash book remains intact', async () => {
  const f = await ready(),
    h = await openSource();
  await wait(5050);
  await expect(h.read(f.request, io())).rejects.toThrow('PAPER_ORDER_RISK_STALE');
});
it('an UNKNOWN order status prevents pristine draft evidence', async () => {
  const f = await ready(),
    h = await openSource();
  await admin.query(
    'UPDATE public."order" SET status=\'UNKNOWN\',version=1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.order!.id],
  );
  await expect(h.read(f.request, io())).rejects.toThrow('PAPER_ORDER_RISK_INCOMPLETE');
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
      ).rejects.toThrow('PAPER_ORDER_RISK_ABORTED');
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
it('four actual sockets bound waiting captures and close drains all before restart', async () => {
  const f = await ready(),
    h = await openSource(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.fundingId]);
    const pending = Promise.allSettled(Array.from({ length: 4 }, () => h.read(f.request, io())));
    await wait(60);
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_ORDER_RISK_BUSY');
    await h.close();
    expect((await pending).every((v) => v.status === 'rejected')).toBe(true);
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_ORDER_RISK_CLOSED');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  expect((await (await openSource()).read(f.request, io())).target.orderId).toBe(f.order!.id);
});
it('lost acknowledged read COMMIT returns no source and restart adds no monetary effect', async () => {
  const f = await ready(),
    before = await effects(f.c.owner.tenantId),
    proxy = await registryCommitProxy(
      required('DATABASE_PAPER_ORDER_RISK_URL'),
      'PAPER_ORDER_RISK',
    );
  try {
    const h = await openSource(proxy.connectionString);
    proxy.arm();
    await expect(h.read(f.request, io())).rejects.toThrow('PAPER_ORDER_RISK_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    expect((await (await openSource()).read(f.request, io())).target.orderId).toBe(f.order!.id);
    expect(await effects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await proxy.close();
  }
});
it('head and rule replacements wait until capture transaction settles', async () => {
  const f = await ready(),
    runtime = new Pool({
      connectionString: required('DATABASE_PAPER_ORDER_RISK_URL'),
      max: 1,
      query_timeout: 3000,
    }),
    p = await runtime.connect(),
    writer = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query('SELECT ctp_paper.capture_order_risk($1::jsonb)', [JSON.stringify(f.request)]);
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
it('unapplied execution evidence cannot masquerade as an untouched draft', async () => {
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
  await expect(h.read(f.request, io())).rejects.toThrow('PAPER_ORDER_RISK_INCOMPLETE');
});
it.each(['LOGIN', 'extra-function'] as const)(
  'runtime rechecks %s role authority after startup',
  async (kind) => {
    const f = await ready(),
      h = await openSource();
    const mutation =
        kind === 'LOGIN'
          ? 'ALTER ROLE ctp_paper_order_risk LOGIN'
          : 'GRANT EXECUTE ON FUNCTION ctp_registry.publish(jsonb,jsonb) TO ctp_paper_order_risk',
      restore =
        kind === 'LOGIN'
          ? 'ALTER ROLE ctp_paper_order_risk NOLOGIN'
          : 'REVOKE EXECUTE ON FUNCTION ctp_registry.publish(jsonb,jsonb) FROM ctp_paper_order_risk';
    await admin.query(mutation);
    try {
      await expect(h.read(f.request, io())).rejects.toThrow('PAPER_ORDER_RISK_ROLE_UNSAFE');
    } finally {
      await admin.query(restore);
    }
  },
);
