import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createPostgresMarketSnapshots,
  type DurableMarketSnapshots,
  type MarketSnapshotPublication,
} from '@ctp/market-data';
import { snapshotFixture } from '../../market-data/test/snapshot-fixture.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('Snapshots require isolated runner');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('Missing isolated snapshot variable');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const publisher = new Pool({
  connectionString: required('DATABASE_MARKET_SNAPSHOT_URL'),
  max: 2,
  query_timeout: 5000,
});
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
const open = () =>
  createPostgresMarketSnapshots({
    connectionString: required('DATABASE_MARKET_SNAPSHOT_URL'),
    environment: 'test',
  });
let store: DurableMarketSnapshots;
beforeAll(async () => {
  store = await open();
});
afterAll(async () => {
  await store?.close();
  await publisher.end();
  await admin.end();
});
async function fixture() {
  const p = snapshotFixture(),
    i = p.record.instrument,
    r = p.record.rules;
  await admin.query(
    'INSERT INTO public.instrument(id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,true,now())',
    [
      p.key.dbInstrumentId,
      i.scope.exchange,
      i.scope.market,
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
  return p;
}
function next(
  p: ReturnType<typeof snapshotFixture>,
  revision: string,
  sequence: string,
): ReturnType<typeof snapshotFixture> {
  const now = Math.max(Date.now(), p.timestamp);
  return {
    ...structuredClone(p),
    id: randomUUID(),
    expectedRevision: revision,
    timestamp: now,
    ticker: { ...p.ticker, exchangeTime: now, receivedAt: now },
    book: {
      ...p.book,
      receivedAt: now,
      exchangeTime: now,
      sourceSequence: sequence,
      snapshotVersion: randomUUID(),
    },
  };
}
const direct = (p: unknown) => {
  const text = JSON.stringify(p);
  return publisher.query('SELECT ctp_market.publish_snapshot($1,$2)', [
    text,
    createHash('sha256').update(text).digest('hex'),
  ]);
};
it('native evidence and permanent replay survive process restart without a second head revision', async () => {
  const p = await fixture(),
    first = await store.publish(p, io());
  expect(first).toEqual({ id: p.id, revision: '1', status: 'APPLIED' });
  const restarted = await open();
  try {
    expect((await restarted.read(p.key, io())).publication).toEqual(p);
    expect(await restarted.publish(p, io())).toEqual(first);
  } finally {
    await restarted.close();
  }
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_market.snapshot_event WHERE id=$1',
        [p.id],
      )
    ).rows[0]?.n,
  ).toBe(1);
});
it('same identity changed semantics conflicts permanently', async () => {
  const p = await fixture();
  await store.publish(p, io());
  await expect(store.publish({ ...p, timestamp: p.timestamp + 1 }, io())).rejects.toThrow(
    'MARKET_EVIDENCE_CONFLICT',
  );
});
it('permanent event UUID cannot be reused for another instrument or exact storage environment', async () => {
  const p = await fixture();
  await store.publish(p, io());
  const q = await fixture();
  q.id = p.id;
  await expect(store.publish(q, io())).rejects.toThrow('MARKET_EVIDENCE_CONFLICT');
  const gap: MarketSnapshotPublication = {
    id: p.id,
    key: { ...p.key, scope: { ...p.key.scope, environment: 'DEMO' } },
    expectedRevision: '0',
    timestamp: Date.now(),
    kind: 'GAP',
    reason: 'STREAM_LOST',
  };
  await expect(store.publish(gap, io())).rejects.toThrow('MARKET_EVIDENCE_CONFLICT');
});
it('native history cannot be changed/deleted and ordering heads cannot be deleted or skip revision', async () => {
  const p = await fixture();
  await store.publish(p, io());
  await expect(
    admin.query('DELETE FROM ctp_market.snapshot_event WHERE id=$1', [p.id]),
  ).rejects.toThrow();
  await expect(
    admin.query("UPDATE ctp_market.snapshot_event SET status='DUPLICATE' WHERE id=$1", [p.id]),
  ).rejects.toThrow();
  await expect(
    admin.query('DELETE FROM ctp_market.snapshot_head WHERE event=$1', [p.id]),
  ).rejects.toThrow('MARKET_EVIDENCE_IMMUTABLE');
  await expect(
    admin.query('UPDATE ctp_market.snapshot_head SET revision=revision+2 WHERE event=$1', [p.id]),
  ).rejects.toThrow('MARKET_EVIDENCE_IMMUTABLE');
  expect((await store.read(p.key, io())).revision).toBe('1');
});
it('concurrent same native key/CAS has one winner, no lost update', async () => {
  const p = await fixture();
  await store.publish(p, io());
  const results = await Promise.allSettled([
    store.publish(next(p, '1', '9007199254740994'), io()),
    store.publish(next(p, '1', '9007199254740995'), io()),
  ]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
  expect((await store.read(p.key, io())).revision).toBe('2');
});
it('lossless regression above 2^53 records durable GAP; restart/equal old snapshot cannot resurrect', async () => {
  const p = await fixture();
  await store.publish(p, io());
  const q = next(p, '1', '9007199254740992');
  expect((await store.publish(q, io())).status).toBe('RESYNC_REQUIRED');
  await expect(store.read(p.key, io())).rejects.toThrow('MARKET_EVIDENCE_RESYNC_REQUIRED');
  const restarted = await open();
  try {
    const duplicate = {
      ...p,
      id: randomUUID(),
      expectedRevision: '2',
      timestamp: Date.now(),
      book: { ...p.book, receivedAt: Date.now(), snapshotVersion: randomUUID() },
      ticker: { ...p.ticker, receivedAt: Date.now() },
    };
    expect(await restarted.publish(duplicate, io())).toMatchObject({
      status: 'DUPLICATE',
      revision: '2',
    });
    await expect(restarted.read(p.key, io())).rejects.toThrow('MARKET_EVIDENCE_RESYNC_REQUIRED');
    expect((await restarted.publish(next(p, '2', '9007199254740994'), io())).status).toBe(
      'APPLIED',
    );
    expect((await restarted.read(p.key, io())).revision).toBe('3');
  } finally {
    await restarted.close();
  }
});
it('equal native sequence with changed level resyncs', async () => {
  const p = await fixture();
  await store.publish(p, io());
  const q = next(p, '1', p.book.sourceSequence!);
  q.book.bids = [{ ...q.book.bids[0]!, quantity: p.book.asks[1]!.quantity }];
  expect((await store.publish(q, io())).status).toBe('RESYNC_REQUIRED');
});
it('identical native payload with new receipt clock does not launder freshness or revision', async () => {
  const p = await fixture();
  await store.publish(p, io());
  const q = {
    ...p,
    id: randomUUID(),
    expectedRevision: '1',
    timestamp: Date.now(),
    ticker: { ...p.ticker, receivedAt: Date.now() },
    book: { ...p.book, receivedAt: Date.now(), snapshotVersion: randomUUID() },
  };
  expect(await store.publish(q, io())).toMatchObject({ status: 'DUPLICATE', revision: '1' });
  expect((await store.read(p.key, io())).publication).toEqual(p);
});
it('time-only ordering rejects regression and conflicting equal native time', async () => {
  for (const conflict of [false, true]) {
    const p = await fixture();
    p.book.sourceSequence = null;
    await store.publish(p, io());
    const q = next(p, '1', '9007199254740994');
    q.book.sourceSequence = null;
    q.book.exchangeTime = p.book.exchangeTime! - (conflict ? 0 : 1);
    if (conflict) q.book.bids = [{ ...q.book.bids[0]!, quantity: p.book.asks[1]!.quantity }];
    expect((await store.publish(q, io())).status).toBe('RESYNC_REQUIRED');
  }
});
it('ticker native clock regression cannot be hidden by a newer book', async () => {
  const p = await fixture();
  await store.publish(p, io());
  const q = next(p, '1', '9007199254740994');
  q.ticker.exchangeTime = p.ticker.exchangeTime - 1;
  expect((await store.publish(q, io())).status).toBe('RESYNC_REQUIRED');
});
it('new ticker cannot launder the receipt age of an unchanged sequence-only book', async () => {
  const p = await fixture();
  p.book.exchangeTime = null;
  await store.publish(p, io());
  const q = next(p, '1', p.book.sourceSequence!);
  q.book.exchangeTime = null;
  q.ticker.exchangeTime = p.ticker.exchangeTime + 1;
  while (Date.now() < q.ticker.exchangeTime) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(await store.publish(q, io())).toMatchObject({ status: 'DUPLICATE', revision: '1' });
  expect((await store.read(p.key, io())).publication.book.receivedAt).toBe(p.book.receivedAt);
});
it('explicit GAP invalidates read without discarding the last native watermark', async () => {
  const p = await fixture();
  await store.publish(p, io());
  const gap: MarketSnapshotPublication = {
    id: randomUUID(),
    key: p.key,
    expectedRevision: '1',
    timestamp: Date.now(),
    kind: 'GAP',
    reason: 'STREAM_LOST',
  };
  await store.publish(gap, io());
  await expect(store.read(p.key, io())).rejects.toThrow('MARKET_EVIDENCE_RESYNC_REQUIRED');
  expect((await store.publish(next(p, '2', '9007199254740992'), io())).status).toBe(
    'RESYNC_REQUIRED',
  );
});
it('metadata replacement invalidates durable reads; permanent exact replay remains available', async () => {
  const p = await fixture(),
    first = await store.publish(p, io());
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    p.key.dbRuleId,
  ]);
  await expect(store.read(p.key, io())).rejects.toThrow('MARKET_EVIDENCE_METADATA');
  expect(await store.publish(p, io())).toEqual(first);
  await expect(store.publish(next(p, '1', '9007199254740994'), io())).rejects.toThrow(
    'MARKET_EVIDENCE_METADATA',
  );
});
it('missing evidence, foreign exact mode and stale native clocks fail closed', async () => {
  const p = await fixture();
  await expect(store.read(p.key, io())).rejects.toThrow('MARKET_EVIDENCE_MISSING');
  await store.publish(p, io());
  await expect(
    store.read({ ...p.key, scope: { ...p.key.scope, environment: 'DEMO' } }, io()),
  ).rejects.toThrow('MARKET_EVIDENCE_MISSING');
  const q = next(p, '1', '9007199254740994');
  q.ticker.exchangeTime = Date.now() - 6000;
  await expect(store.publish(q, io())).rejects.toThrow('MARKET_EVIDENCE_STALE');
});
it.each([
  'extra',
  'sequenceNumber',
  'nullClock',
  'unknownConstraint',
  'accounting',
  'crossed',
  'decimal',
  'zeroPrice',
  'metadataScope',
])('direct SQL rejects malformed native evidence: %s', async (kind) => {
  const p = await fixture(),
    raw: Record<string, unknown> = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  const book = raw['book'] as Record<string, unknown>,
    ticker = raw['ticker'] as Record<string, unknown>;
  if (kind === 'extra') raw['unknown'] = true;
  if (kind === 'sequenceNumber') book['sourceSequence'] = 9007199254740992;
  if (kind === 'nullClock') ticker['exchangeTime'] = null;
  if (kind === 'unknownConstraint') book['futureLimit'] = '1';
  if (kind === 'accounting') raw['balances'] = [];
  if (kind === 'crossed') book['bids'] = [{ price: '100', quantity: '1' }];
  if (kind === 'decimal') book['bids'] = [{ price: '09.95', quantity: '1' }];
  if (kind === 'zeroPrice') ticker['last'] = { state: 'AVAILABLE', value: '0' };
  if (kind === 'metadataScope')
    raw['key'] = { ...p.key, scope: { ...p.key.scope, environment: 'LIVE' } };
  await expect(direct(raw)).rejects.toThrow(/^MARKET_EVIDENCE_/);
});
it.each([
  'DATABASE_MIGRATION_URL',
  'DATABASE_RUNTIME_URL',
  'DATABASE_INGEST_URL',
  'DATABASE_PORTFOLIO_URL',
  'DATABASE_EXECUTION_URL',
  'DATABASE_RISK_EVIDENCE_URL',
])('rejects unrelated authority at startup: %s', async (name) => {
  await expect(
    createPostgresMarketSnapshots({ connectionString: required(name), environment: 'test' }),
  ).rejects.toThrow('MARKET_EVIDENCE_ROLE_UNSAFE');
});
it('function-only runtime cannot read native history, accounting, credentials or mutate authority directly', async () => {
  for (const sql of [
    'SELECT * FROM ctp_market.snapshot_event',
    'SELECT * FROM ctp_market.snapshot_head',
    'SELECT * FROM ctp_portfolio.book',
    'SELECT * FROM public.risk_reservation',
    'SELECT * FROM public.exchange_connection',
  ])
    await expect(publisher.query(sql)).rejects.toThrow(/permission denied/);
  const acl = await publisher.query<{ safe: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('ctp_market','ctp_risk') AND has_function_privilege(current_user,p.oid,'EXECUTE') AND p.oid NOT IN('ctp_market.publish_snapshot(text,text)'::regprocedure::oid,'ctp_market.read_snapshot(jsonb,integer)'::regprocedure::oid)) safe`,
  );
  expect(acl.rows[0]?.safe).toBe(true);
});
it.each(['table', 'column', 'function', 'mixedRole'])(
  'startup rejects privilege expansion and direct mixed-role calls: %s',
  async (kind) => {
    const role = new URL(required('DATABASE_MARKET_SNAPSHOT_URL')).username;
    if (!/^ctp_p2_snapshot_[a-f0-9]{12}$/.test(role) && role !== 'snapshot_probe')
      throw new Error('Unrelated test role');
    const grant =
      kind === 'table'
        ? `GRANT SELECT ON ctp_market.snapshot_event TO "${role}"`
        : kind === 'column'
          ? `GRANT SELECT(id) ON ctp_market.snapshot_event TO "${role}"`
          : kind === 'function'
            ? `GRANT EXECUTE ON FUNCTION ctp_market.snapshot_key(jsonb) TO "${role}"`
            : `GRANT ctp_risk_evidence_collector TO "${role}"`;
    const revoke = grant.replace('GRANT ', 'REVOKE ').replace(` TO "${role}"`, ` FROM "${role}"`);
    await admin.query(grant);
    try {
      await expect(open()).rejects.toThrow('MARKET_EVIDENCE_ROLE_UNSAFE');
      if (kind === 'mixedRole')
        await expect(direct(await fixture())).rejects.toThrow('MARKET_EVIDENCE_ROLE_UNSAFE');
    } finally {
      await admin.query(revoke);
    }
    const recovered = await open();
    await recovered.close();
  },
);
it('native blocked request abort/deadline settle and remove server waiter while blocker remains held', async () => {
  for (const aborted of [true, false]) {
    const p = await fixture(),
      blocker = await admin.connect();
    await blocker.query('BEGIN');
    const key = {
      scope: p.key.scope,
      instrumentId: p.key.instrumentId,
      dbInstrumentId: p.key.dbInstrumentId,
    };
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ctp:market:snapshot:'||$1::jsonb::text,0))",
      [JSON.stringify(key)],
    );
    try {
      const abort = new AbortController(),
        pending = store.publish(p, io(abort.signal, aborted ? 2500 : 750));
      const observed = pending.then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      await expect
        .poll(
          async () =>
            (
              await admin.query<{ n: number }>(
                "SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1 AND query LIKE '%publish_snapshot%' AND wait_event_type='Lock'",
                [new URL(required('DATABASE_MARKET_SNAPSHOT_URL')).username],
              )
            ).rows[0]?.n,
        )
        .toBe(1);
      if (aborted) abort.abort();
      expect((await observed).error).toBeInstanceOf(Error);
      await expect
        .poll(
          async () =>
            (
              await admin.query<{ n: number }>(
                "SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1 AND query LIKE '%publish_snapshot%' AND wait_event_type='Lock'",
                [new URL(required('DATABASE_MARKET_SNAPSHOT_URL')).username],
              )
            ).rows[0]?.n,
          { timeout: 3000 },
        )
        .toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await store.publish(p, io())).status).toBe('APPLIED');
  }
});
