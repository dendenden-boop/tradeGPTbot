import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { createPostgresMarketSnapshots, createPostgresMarketTrades } from '@ctp/market-data';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
} from '@ctp/paper-engine/configuration';
import {
  createPostgresPaperMarketFrames,
  type PaperMarketFrames,
} from '@ctp/paper-engine/evidence';
import { createPostgresPaperFunding, paperFundingSchema } from '@ctp/paper-engine/funding';
import { frameFixture } from '../../paper-engine/test/frame-fixture.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_FRAME_RUNNER_REQUIRED');
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error('ISOLATED_FRAME_VARIABLE_REQUIRED');
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
const options = () => ({
  configurationUrl: required('DATABASE_PAPER_CONFIGURATION_URL'),
  snapshotUrl: required('DATABASE_MARKET_SNAPSHOT_URL'),
  tradeUrl: required('DATABASE_MARKET_TRADE_URL'),
  environment: 'test' as const,
});
async function open(o = options()): Promise<PaperMarketFrames> {
  const h = await createPostgresPaperMarketFrames(o);
  handles.push(h);
  return h;
}
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await admin.end();
});
async function fixture({ book = true, trade = true, age = 5000, fund = false } = {}) {
  const f = frameFixture(),
    p = f.p,
    s = f.s;
  const c = paperConfigurationSchema.parse(f.configuration.configuration);
  c.model.maxEvidenceAgeMs = age;
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
    [c.owner.tenantId, c.owner.tenantId + '@example.invalid'],
  );
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'frame-epoch\',now())',
    [
      c.owner.accountId,
      c.owner.tenantId,
      c.source.exchange,
      'paper:' + c.owner.accountId,
      c.source.region,
    ],
  );
  const config = await createPostgresPaperConfiguration({
    connectionString: options().configurationUrl,
    environment: 'test',
  });
  try {
    await config.register(c, io());
  } finally {
    await config.close();
  }
  const i = p.record.instrument,
    r = p.record.rules;
  if (fund) {
    const funding = await createPostgresPaperFunding({
      connectionString: required('DATABASE_PAPER_FUNDING_URL'),
      environment: 'test',
    });
    try {
      await funding.initialize(
        paperFundingSchema.parse({
          id: randomUUID(),
          owner: c.owner,
          configurationId: c.id,
          balances: [
            { asset: i.baseAsset, amount: '1' },
            { asset: i.quoteAsset, amount: '10' },
          ],
        }),
        io(),
      );
    } finally {
      await funding.close();
    }
  }
  await admin.query(
    'INSERT INTO public.instrument(id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt") VALUES($1,$2,\'SPOT\',$3,$4,$5,$6,true,now())',
    [
      p.key.dbInstrumentId,
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
      p.key.dbRuleId,
      p.key.dbInstrumentId,
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
  const snapshots = await createPostgresMarketSnapshots({
      connectionString: options().snapshotUrl,
      environment: 'test',
    }),
    trades = await createPostgresMarketTrades({
      connectionString: options().tradeUrl,
      environment: 'test',
    });
  handles.push(snapshots, trades);
  const at = Date.now();
  s.timestamp = at;
  s.book.receivedAt = at;
  s.book.exchangeTime = at;
  s.ticker.receivedAt = at;
  s.ticker.exchangeTime = at;
  p.timestamp = at;
  p.trade.receivedAt = at;
  p.trade.exchangeTime = at;
  if (book) await snapshots.publish(s, io());
  if (trade) await trades.publish(p, io());
  return { ...f, c, snapshots, trades, request: { owner: c.owner, key: p.key } };
}
async function financial(owner: { tenantId: string }) {
  const counts: Record<string, number> = {};
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [owner.tenantId]);
    for (const table of [
      'ledger_transaction',
      'ledger_entry',
      'order_intent',
      'order',
      'risk_decision',
      'risk_reservation',
      'paper_account',
    ])
      counts[table] = (
        await client.query<{ n: number }>(
          `SELECT count(*)::int n FROM public."${table}" WHERE "tenantId"=$1`,
          [owner.tenantId],
        )
      ).rows[0]!.n;
    await client.query('COMMIT');
    return counts;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
async function postings(owner: { tenantId: string }) {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [owner.tenantId]);
    const rows = (
      await client.query<{ asset: string; bucket: string; amount: string; entryIndex: number }>(
        'SELECT asset,bucket,amount::text,"entryIndex" FROM public.ledger_entry WHERE "tenantId"=$1 ORDER BY "entryIndex"',
        [owner.tenantId],
      )
    ).rows;
    await client.query('COMMIT');
    return rows;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
it('native frame capture and restart preserve model, first native identity and zero financial effects', async () => {
  const f = await fixture({ book: true, trade: true, age: 5000, fund: true }),
    h = await open(),
    before = await financial(f.c.owner);
  const seeded = await postings(f.c.owner);
  expect(before.ledger_transaction).toBe(1);
  expect(before.ledger_entry).toBe(4);
  expect(seeded).toHaveLength(4);
  const a = await h.capture(f.request, io()),
    b = await h.capture(f.request, io());
  expect(a.evidence).toEqual(b.evidence);
  expect(a.frame.trade.tradeId).toBe(f.p.trade.tradeId);
  expect(a.frame.model).toEqual(f.c.model);
  await h.close();
  const restarted = await open(),
    c = await restarted.capture(f.request, io());
  expect(c.evidence).toEqual(a.evidence);
  expect(c.configuration).toEqual(a.configuration);
  expect(await financial(f.c.owner)).toEqual(before);
  expect(await postings(f.c.owner)).toEqual(seeded);
  for (const [table, n] of Object.entries(before))
    if (!['ledger_transaction', 'ledger_entry'].includes(table)) expect(n).toBe(0);
  expect(Object.keys(c.evidence).sort()).toEqual([
    'snapshotHash',
    'snapshotId',
    'snapshotRevision',
    'tradeHash',
    'tradeId',
    'tradeRevision',
  ]);
});
it.each(['book', 'trade'] as const)(
  'missing durable %s rejects without financial effects',
  async (missing) => {
    const f = await fixture({ book: missing !== 'book', trade: missing !== 'trade', age: 5000 }),
      h = await open();
    await expect(h.capture(f.request, io())).rejects.toThrow(/PAPER_FRAME_/);
    expect(Object.values(await financial(f.c.owner)).every((n) => n === 0)).toBe(true);
  },
);
it.each(['book', 'trade'] as const)(
  'durable %s GAP rejects across capture restart',
  async (kind) => {
    const f = await fixture(),
      gap = {
        id: randomUUID(),
        key: f.p.key,
        expectedRevision: '1',
        timestamp: Date.now(),
        kind: 'GAP' as const,
        reason: 'FRAME_TEST_GAP',
      };
    if (kind === 'book') await f.snapshots.publish(gap, io());
    else await f.trades.publish(gap, io());
    const h = await open();
    await expect(h.capture(f.request, io())).rejects.toThrow(/PAPER_FRAME_/);
    await h.close();
    await expect((await open()).capture(f.request, io())).rejects.toThrow(/PAPER_FRAME_/);
  },
);
it('current native rules replacement denies stale frame instead of using historical evidence', async () => {
  const f = await fixture(),
    h = await open();
  await h.capture(f.request, io());
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.p.key.dbRuleId,
  ]);
  await expect(h.capture(f.request, io())).rejects.toThrow(/PAPER_FRAME_/);
  expect(Object.values(await financial(f.c.owner)).every((n) => n === 0)).toBe(true);
});
it('exact PAPER ownership and current active status are required after capture restart', async () => {
  const f = await fixture(),
    h = await open();
  await expect(
    h.capture({ ...f.request, owner: { ...f.c.owner, tenantId: randomUUID() } }, io()),
  ).rejects.toThrow(/PAPER_FRAME_/);
  await admin.query("UPDATE public.exchange_account SET status='DISABLED' WHERE id=$1", [
    f.c.owner.accountId,
  ]);
  await expect(h.capture(f.request, io())).rejects.toThrow(/PAPER_FRAME_/);
  await h.close();
  await expect((await open()).capture(f.request, io())).rejects.toThrow(/PAPER_FRAME_/);
});
it('contradictory native mode and public environment are rejected without dispatch', async () => {
  const f = await fixture(),
    h = await open();
  await expect(
    h.capture({ ...f.request, owner: { ...f.c.owner, mode: 'TESTNET' } } as never, io()),
  ).rejects.toThrow('PAPER_FRAME_INPUT');
  await expect(
    h.capture(
      {
        ...f.request,
        key: {
          ...f.p.key,
          scope: {
            ...f.p.key.scope,
            environment: f.p.key.scope.environment === 'LIVE' ? 'TESTNET' : 'LIVE',
          },
        },
      },
      io(),
    ),
  ).rejects.toThrow('PAPER_FRAME_SCOPE');
  expect(Object.values(await financial(f.c.owner)).every((n) => n === 0)).toBe(true);
});
it('model freshness remains strict during real PostgreSQL frame reads', async () => {
  const f = await fixture({ book: true, trade: true, age: 1 }),
    h = await open();
  await expect(h.capture(f.request, io())).rejects.toThrow(/PAPER_FRAME_/);
});
it.each(['abort', 'deadline'] as const)(
  'hung native read %s settles physically with no capture and reusable slots',
  async (kind) => {
    const f = await fixture(),
      h = await open(),
      lock = await admin.connect(),
      controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(1129599058,12)');
    const started = performance.now();
    try {
      if (kind === 'abort') timer = setTimeout(() => controller.abort(), 60);
      await expect(
        h.capture(f.request, io(controller.signal, kind === 'deadline' ? 60 : 1500)),
      ).rejects.toThrow(/PAPER_FRAME_/);
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await lock.query('ROLLBACK');
      lock.release();
    }
    await expect(h.capture(f.request, io())).resolves.toHaveProperty('evidence.tradeId', f.p.id);
    expect(Object.values(await financial(f.c.owner)).every((n) => n === 0)).toBe(true);
  },
);
it('four bounded captures reject a fifth and close drains all physical readers', async () => {
  const f = await fixture(),
    h = await open(),
    lock = await admin.connect(),
    controller = new AbortController();
  await lock.query('BEGIN');
  await lock.query('SELECT pg_advisory_xact_lock(1129599058,12)');
  const tasks = Array.from({ length: 4 }, () =>
    h.capture(f.request, io(controller.signal, 1500)).catch((e: unknown) => e),
  );
  try {
    await wait(35);
    await expect(h.capture(f.request, io())).rejects.toThrow('PAPER_FRAME_BUSY');
    controller.abort();
    await Promise.all(tasks);
  } finally {
    controller.abort();
    await lock.query('ROLLBACK');
    lock.release();
    await Promise.all(tasks);
  }
  await expect(h.capture(f.request, io())).resolves.toHaveProperty('evidence.tradeId', f.p.id);
  await Promise.all([h.close(), h.close()]);
  await expect(h.capture(f.request, io())).rejects.toThrow('PAPER_FRAME_CLOSED');
});
it('physically lost read COMMIT returns no frame, performs no retry and restart preserves native identity', async () => {
  const f = await fixture(),
    proxy = await registryCommitProxy(options().tradeUrl, 'FRAME_TRADE_READ');
  const via = (url: string) => {
    const u = new URL(url);
    u.host = new URL(proxy.connectionString).host;
    return u.toString();
  };
  const o = options(),
    h = await open({
      ...o,
      configurationUrl: via(o.configurationUrl),
      snapshotUrl: via(o.snapshotUrl),
      tradeUrl: via(o.tradeUrl),
    });
  proxy.arm();
  try {
    await expect(h.capture(f.request, io())).rejects.toThrow('PAPER_FRAME_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    const restored = await (await open()).capture(f.request, io());
    expect(restored.evidence.tradeId).toBe(f.p.id);
    expect((await f.trades.head(f.p.key, io())).revision).toBe('1');
    expect(Object.values(await financial(f.c.owner)).every((n) => n === 0)).toBe(true);
  } finally {
    await proxy.close();
  }
});
it('production frame startup refuses swapped PostgreSQL authority roles', async () => {
  const o = options();
  await expect(
    open({ ...o, configurationUrl: o.tradeUrl, tradeUrl: o.configurationUrl }),
  ).rejects.toThrow('PAPER_FRAME_STARTUP');
});
