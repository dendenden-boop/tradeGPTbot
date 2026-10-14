import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import { parseDecimal } from '@ctp/exchange-core';
import { afterAll, expect, it } from 'vitest';
import { createPostgresMarketTrades, type DurableMarketTrades } from '@ctp/market-data';
import { tradeFixture } from '../../market-data/test/trade-fixture.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_TRADE_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_TRADE_VARIABLE_REQUIRED');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const direct = new Pool({
  connectionString: required('DATABASE_MARKET_TRADE_URL'),
  max: 2,
  query_timeout: 5000,
});
const handles: DurableMarketTrades[] = [];
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
async function open(connectionString = required('DATABASE_MARKET_TRADE_URL')) {
  const s = await createPostgresMarketTrades({ connectionString, environment: 'test' });
  handles.push(s);
  return s;
}
afterAll(async () => {
  await Promise.all(handles.map((s) => s.close()));
  await direct.end();
  await admin.end();
});
type Publication = ReturnType<typeof tradeFixture>;
async function fixture(instrumentId?: string) {
  const p = tradeFixture(),
    i = p.record.instrument;
  if (instrumentId) {
    p.key.instrumentId = instrumentId;
    i.id = instrumentId;
    p.record.rules.instrumentId = instrumentId;
    p.trade.instrumentId = instrumentId;
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
  await insertRule(p, 1);
  return p;
}
async function insertRule(p: Publication, version: number) {
  const r = p.record.rules;
  await admin.query(
    'INSERT INTO public.instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",rules) VALUES($1,$2,$3,true,$4,now(),$5,$6,$7,$8,$9,$10,$11::jsonb)',
    [
      p.key.dbRuleId,
      p.key.dbInstrumentId,
      version,
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
}
function next(
  p: Publication,
  revision: string,
  sequence: string | null = (BigInt(p.trade.sourceSequence!) + 1n).toString(),
): Publication {
  const now = Date.now();
  return {
    ...structuredClone(p),
    id: randomUUID(),
    expectedRevision: revision,
    timestamp: now,
    trade: {
      ...p.trade,
      tradeId: 'trade-' + randomUUID(),
      sourceSequence: sequence,
      exchangeTime: now,
      receivedAt: now,
    },
  };
}
async function rows(p: Publication) {
  return (
    await admin.query<{ events: number; native: number; seals: number }>(
      "SELECT (SELECT count(*)::int FROM ctp_market.trade_event WHERE key=$1::jsonb) events,(SELECT count(*)::int FROM ctp_market.native_trade_seen WHERE identity->'partition'=$1::jsonb) native,(SELECT count(*)::int FROM ctp_market.trade_seal WHERE key=$1::jsonb) seals",
      [
        JSON.stringify({
          scope: p.key.scope,
          instrumentId: p.key.instrumentId,
          dbInstrumentId: p.key.dbInstrumentId,
        }),
      ],
    )
  ).rows[0]!;
}
async function raw(value: unknown) {
  const text = JSON.stringify(value);
  return direct.query('SELECT ctp_market.publish_trade($1::text,$2::text) result', [
    text,
    createHash('sha256').update(text).digest('hex'),
  ]);
}
it('empty public journal returns progress only and no fabricated execution evidence', async () => {
  const p = await fixture(),
    s = await open();
  expect(await s.head(p.key, io())).toEqual({ revision: '0', gap: false });
  await expect(s.read(p.key, io())).rejects.toThrow('MARKET_TRADE_MISSING');
});
it('native publication and permanent replay survive restart with one original event and seal', async () => {
  const p = await fixture(),
    s = await open(),
    receipt = await s.publish(p, io());
  await s.close();
  const restarted = await open();
  expect(await restarted.publish(p, io())).toEqual(receipt);
  expect((await restarted.read(p.key, io())).publication).toEqual(p);
  expect(await rows(p)).toEqual({ events: 1, native: 1, seals: 1 });
});
it('concurrent exact publication across physical clients commits one immutable event', async () => {
  const p = await fixture(),
    a = await open(),
    b = await open();
  const receipts = await Promise.all(
    Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).publish(p, io())),
  );
  expect(receipts.every((r) => r.id === p.id && r.revision === '1' && r.status === 'APPLIED')).toBe(
    true,
  );
  expect(await rows(p)).toEqual({ events: 1, native: 1, seals: 1 });
});
it('concurrent native duplicates preserve first receipt time and one native volume identity', async () => {
  const p = await fixture(),
    a = await open(),
    b = await open();
  await a.publish(p, io());
  const duplicates = Array.from({ length: 6 }, () => {
    const timestamp = Date.now();
    return {
      ...p,
      id: randomUUID(),
      expectedRevision: '1',
      timestamp,
      trade: { ...p.trade, receivedAt: timestamp },
    };
  });
  expect(
    (await Promise.all(duplicates.map((d, i) => (i % 2 ? a : b).publish(d, io())))).every(
      (r) => r.status === 'DUPLICATE' && r.revision === '1',
    ),
  ).toBe(true);
  expect((await a.read(p.key, io())).publication.trade.receivedAt).toBe(p.trade.receivedAt);
  expect(await rows(p)).toEqual({ events: 7, native: 1, seals: 7 });
});
it('competing successors use exact durable CAS without silently replacing an accepted head', async () => {
  const p = await fixture(),
    s = await open();
  await s.publish(p, io());
  const outcomes = await Promise.allSettled([
    s.publish(next(p, '1'), io()),
    s.publish(next(p, '1'), io()),
  ]);
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await s.head(p.key, io())).toEqual({ revision: '2', gap: false });
  expect((await rows(p)).native).toBe(2);
});
it('old native duplicate after a later trade cannot resurrect old evidence or volume', async () => {
  const p = await fixture(),
    s = await open();
  await s.publish(p, io());
  const newer = next(p, '1');
  await s.publish(newer, io());
  const timestamp = Date.now();
  expect(
    (
      await s.publish(
        {
          ...p,
          id: randomUUID(),
          expectedRevision: '2',
          timestamp,
          trade: { ...p.trade, receivedAt: timestamp },
        },
        io(),
      )
    ).status,
  ).toBe('DUPLICATE');
  expect((await s.read(p.key, io())).id).toBe(newer.id);
  expect(await rows(p)).toEqual({ events: 3, native: 2, seals: 3 });
});
it('permanent publication identity rejects changed semantics and cross-instrument reuse', async () => {
  const p = await fixture(),
    q = await fixture(),
    s = await open();
  await s.publish(p, io());
  await expect(
    s.publish({ ...p, trade: { ...p.trade, quantity: parseDecimal('2') } }, io()),
  ).rejects.toThrow('MARKET_TRADE_CONFLICT');
  await expect(s.publish({ ...q, id: p.id }, io())).rejects.toThrow('MARKET_TRADE_CONFLICT');
  expect(await s.head(q.key, io())).toEqual({ revision: '0', gap: false });
});
it('A to B to conflicting A native identity durably poisons the source across restart', async () => {
  const p = await fixture(),
    s = await open();
  await s.publish(p, io());
  await s.publish(next(p, '1'), io());
  const now = Date.now(),
    conflict = {
      ...p,
      id: randomUUID(),
      expectedRevision: '2',
      timestamp: now,
      trade: { ...p.trade, quantity: parseDecimal('2'), receivedAt: now },
    };
  const receipt = await s.publish(conflict, io());
  expect(receipt.status).toBe('RESYNC_REQUIRED');
  await s.close();
  const restarted = await open();
  expect(await restarted.publish(conflict, io())).toEqual(receipt);
  await expect(restarted.read(p.key, io())).rejects.toThrow('MARKET_TRADE_RESYNC_REQUIRED');
  expect((await restarted.publish(next(p, '3', '9007199254740999'), io())).status).toBe(
    'RESYNC_REQUIRED',
  );
  expect((await restarted.head(p.key, io())).gap).toBe(true);
});
it.each(['99', '100'])(
  'native sequence %s after 100 rejects regression or equal conflicting identity',
  async (sequence) => {
    const p = await fixture(),
      s = await open();
    p.trade.sourceSequence = '100';
    await s.publish(p, io());
    await wait(2);
    expect((await s.publish(next(p, '1', sequence), io())).status).toBe('RESYNC_REQUIRED');
    await expect(s.read(p.key, io())).rejects.toThrow('MARKET_TRADE_RESYNC_REQUIRED');
  },
);
it.each(['9007199254740993', '1' + '0'.repeat(127)])(
  'strictly increasing native sequence %s remains lossless',
  async (sequence) => {
    const p = await fixture(),
      s = await open();
    p.trade.sourceSequence = sequence;
    await s.publish(p, io());
    const newer = next(p, '1', (BigInt(sequence) + 1n).toString());
    expect((await s.publish(newer, io())).status).toBe('APPLIED');
    expect((await s.read(p.key, io())).publication.trade.sourceSequence).toBe(
      newer.trade.sourceSequence,
    );
  },
);
it('timestamp regression without native sequence creates a durable GAP', async () => {
  const p = await fixture(),
    s = await open();
  p.trade.sourceSequence = null;
  await s.publish(p, io());
  const late = next(p, '1', null);
  late.trade.exchangeTime = p.trade.exchangeTime - 1;
  expect((await s.publish(late, io())).status).toBe('RESYNC_REQUIRED');
});
it('distinct native trades in the same millisecond remain distinct in durable receipt order', async () => {
  const p = await fixture(),
    s = await open();
  p.trade.sourceSequence = null;
  await s.publish(p, io());
  const sibling = next(p, '1', null);
  sibling.trade.exchangeTime = p.trade.exchangeTime;
  expect((await s.publish(sibling, io())).status).toBe('APPLIED');
  expect((await rows(p)).native).toBe(2);
});
it.each(['sequence-presence', 'identity-scope'])(
  'native ordering domain replacement %s cannot reset its watermark',
  async (kind) => {
    const p = await fixture(),
      s = await open();
    await s.publish(p, io());
    const q = next(p, '1');
    if (kind === 'sequence-presence') q.trade.sourceSequence = null;
    else q.trade.identityScope = 'replacement-domain';
    expect((await s.publish(q, io())).status).toBe('RESYNC_REQUIRED');
  },
);
it('explicit GAP stays closed after restart, duplicate, newer trade and metadata refresh', async () => {
  const p = await fixture(),
    s = await open();
  await s.publish(p, io());
  const gap = {
    id: randomUUID(),
    key: p.key,
    expectedRevision: '1',
    timestamp: Date.now(),
    kind: 'GAP' as const,
    reason: 'STREAM_DISCONNECTED',
  };
  await s.publish(gap, io());
  await s.close();
  const restarted = await open();
  expect(await restarted.head(p.key, io())).toEqual({ revision: '2', gap: true });
  const n = next(p, '2');
  expect((await restarted.publish(n, io())).status).toBe('RESYNC_REQUIRED');
  const timestamp = Date.now();
  expect(
    (
      await restarted.publish(
        {
          ...p,
          id: randomUUID(),
          expectedRevision: '3',
          timestamp,
          trade: { ...p.trade, receivedAt: timestamp },
        },
        io(),
      )
    ).status,
  ).toBe('DUPLICATE');
  expect((await restarted.head({ ...p.key, dbRuleId: randomUUID() }, io())).gap).toBe(true);
  await expect(restarted.read(p.key, io())).rejects.toThrow('MARKET_TRADE_RESYNC_REQUIRED');
});
it.each(['stale', 'future'])(
  'new %s evidence fails closed before durable insertion',
  async (kind) => {
    const p = await fixture(),
      s = await open(),
      timestamp = Date.now() + (kind === 'stale' ? -6000 : 60000);
    p.timestamp = timestamp;
    p.trade.receivedAt = timestamp;
    p.trade.exchangeTime = timestamp;
    await expect(s.publish(p, io())).rejects.toThrow('MARKET_TRADE_STALE');
    expect(await rows(p)).toEqual({ events: 0, native: 0, seals: 0 });
  },
);
it('aged evidence remains unusable while head progress permits restart and later publication', async () => {
  const p = await fixture(),
    s = await open();
  await s.publish(p, io());
  await wait(10);
  await s.close();
  const restarted = await open();
  await expect(restarted.read(p.key, io(), 1)).rejects.toThrow('MARKET_TRADE_STALE');
  expect(await restarted.head(p.key, io())).toEqual({ revision: '1', gap: false });
  expect((await restarted.publish(next(p, '1'), io())).status).toBe('APPLIED');
});
it('current rule replacement denies old source but preserves exact historical publication replay', async () => {
  const p = await fixture(),
    s = await open(),
    first = await s.publish(p, io());
  await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    p.key.dbRuleId,
  ]);
  const q = next(p, '1');
  q.key.dbRuleId = randomUUID();
  q.record.rules.version = 'rule-' + randomUUID();
  await insertRule(q, 2);
  await expect(s.read(p.key, io())).rejects.toThrow('MARKET_TRADE_METADATA');
  expect(await s.publish(p, io())).toEqual(first);
  const timestamp = Date.now();
  expect(
    (
      await s.publish(
        { ...q, id: randomUUID(), trade: { ...p.trade, receivedAt: timestamp }, timestamp },
        io(),
      )
    ).status,
  ).toBe('DUPLICATE');
  await expect(s.read(q.key, io())).rejects.toThrow('MARKET_TRADE_METADATA');
  expect((await s.publish(q, io())).status).toBe('APPLIED');
  expect((await s.read(q.key, io())).publication.record.rules.version).toBe(q.record.rules.version);
});
it('physically lost acknowledged journal COMMIT gives no receipt and resolves by exact restart replay', async () => {
  const p = await fixture(),
    proxy = await registryCommitProxy(required('DATABASE_MARKET_TRADE_URL'), 'MARKET_TRADE'),
    s = await open(proxy.connectionString);
  proxy.arm();
  try {
    await expect(s.publish(p, io())).rejects.toThrow('MARKET_TRADE_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await s.close();
    const restarted = await open();
    expect((await restarted.read(p.key, io())).id).toBe(p.id);
    expect((await restarted.publish(p, io())).revision).toBe('1');
    expect(await rows(p)).toEqual({ events: 1, native: 1, seals: 1 });
  } finally {
    await proxy.close();
  }
});
it.each(['abort', 'deadline'] as const)(
  'hung public journal lock %s physically settles without publication',
  async (kind) => {
    const p = await fixture(),
      s = await open(),
      lock = await admin.connect(),
      controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(1129599058,12)');
    const started = performance.now();
    try {
      if (kind === 'abort') timer = setTimeout(() => controller.abort(), 40);
      await expect(
        s.publish(p, io(controller.signal, kind === 'deadline' ? 40 : 1000)),
      ).rejects.toThrow('MARKET_TRADE_ABORTED');
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      clearTimeout(timer);
      await lock.query('ROLLBACK');
      lock.release();
    }
    expect(await rows(p)).toEqual({ events: 0, native: 0, seals: 0 });
    expect((await s.publish(p, io())).status).toBe('APPLIED');
  },
);
it('four physical pending journal slots reject BUSY and become reusable after abort settlement', async () => {
  const p = await fixture(),
    s = await open(),
    lock = await admin.connect(),
    controller = new AbortController();
  await lock.query('BEGIN');
  await lock.query('SELECT pg_advisory_xact_lock(1129599058,12)');
  const pending = Array.from({ length: 4 }, () =>
    s.publish(p, io(controller.signal, 1500)).catch((e) => e as Error),
  );
  try {
    await wait(30);
    await expect(s.publish(p, io())).rejects.toThrow('MARKET_TRADE_BUSY');
    controller.abort();
    expect(
      (await Promise.all(pending)).every(
        (e) => e instanceof Error && e.message === 'MARKET_TRADE_ABORTED',
      ),
    ).toBe(true);
  } finally {
    controller.abort();
    await lock.query('ROLLBACK');
    lock.release();
    await Promise.all(pending);
  }
  expect((await s.publish(p, io())).status).toBe('APPLIED');
});
it('300 instruments retain independent heads across consecutive refresh and restart', async () => {
  const s = await open(),
    publications: Publication[] = [];
  // Prepare independent metadata within the existing three-connection admin
  // bound; 600 sequential seed statements needlessly consume the test budget.
  for (let offset = 0; offset < 300; offset += 3)
    publications.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(3, 300 - offset) }, (_, i) =>
          fixture('SPOT-' + (offset + i)),
        ),
      )),
    );
  // Independent instruments use the port's bounded admission. Keep each
  // instrument's two updates ordered; never schedule an unbounded queue or
  // consume all four physical slots while one is still closing.
  const wave = async (work: (p: Publication) => Promise<void>) => {
    for (let offset = 0; offset < publications.length; offset += 3)
      await Promise.all(publications.slice(offset, offset + 3).map(work));
  };
  await wave(async (p) => {
    const q = next(p, '0', p.trade.sourceSequence);
    q.trade.tradeId = p.trade.tradeId;
    Object.assign(p, q);
    expect((await s.publish(p, io())).status).toBe('APPLIED');
  });
  await wave(async (p) => {
    expect((await s.publish(next(p, '1'), io())).status).toBe('APPLIED');
  });
  await s.close();
  const restarted = await open();
  await wave(async (p) => {
    expect(await restarted.head(p.key, io())).toEqual({ revision: '2', gap: false });
    expect(await rows(p)).toEqual({ events: 2, native: 2, seals: 2 });
  });
}, 30000);
it('coherent payload and checksum rewrite cannot replace the retained original publication seal', async () => {
  const p = await fixture(),
    s = await open();
  await s.publish(p, io());
  const original = JSON.stringify(p),
    changed = JSON.stringify({ ...p, trade: { ...p.trade, quantity: '2' } });
  const rewrite = async (text: string) => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE ctp_market.trade_event DISABLE TRIGGER USER');
      await c.query(
        "UPDATE ctp_market.trade_event SET payload=$2,hash=sha256(convert_to($2,'UTF8')) WHERE id=$1",
        [p.id, text],
      );
      await c.query('ALTER TABLE ctp_market.trade_event ENABLE TRIGGER USER');
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  };
  try {
    await rewrite(changed);
    const restarted = await open();
    await expect(restarted.read(p.key, io())).rejects.toThrow('MARKET_TRADE_CORRUPT');
    await expect(
      restarted.publish({ ...p, trade: { ...p.trade, quantity: parseDecimal('2') } }, io()),
    ).rejects.toThrow('MARKET_TRADE_CORRUPT');
  } finally {
    await rewrite(original);
  }
});
it.each(['trade_seal', 'native_trade_seen', 'trade_head'] as const)(
  'missing durable %s is never reconstructed into source authority',
  async (table) => {
    const p = await fixture(),
      s = await open();
    await s.publish(p, io());
    const c = await admin.connect();
    const predicate =
      table === 'trade_seal' ? 'id=$1' : table === 'native_trade_seen' ? 'event=$1' : 'event=$1';
    const old = (
      await c.query<Record<string, unknown>>(
        `SELECT * FROM ctp_market.${table} WHERE ${predicate}`,
        [p.id],
      )
    ).rows[0]!;
    if (Buffer.isBuffer(old['hash'])) old['hash'] = '\\x' + old['hash'].toString('hex');
    try {
      await c.query('BEGIN');
      await c.query(`ALTER TABLE ctp_market.${table} DISABLE TRIGGER USER`);
      await c.query(`DELETE FROM ctp_market.${table} WHERE ${predicate}`, [p.id]);
      await c.query(`ALTER TABLE ctp_market.${table} ENABLE TRIGGER USER`);
      await c.query('COMMIT');
      const restarted = await open();
      await expect(restarted.read(p.key, io())).rejects.toThrow('MARKET_TRADE_CORRUPT');
      await expect(restarted.publish(p, io())).rejects.toThrow('MARKET_TRADE_CORRUPT');
    } finally {
      await c.query('ROLLBACK');
      await c.query(
        `INSERT INTO ctp_market.${table} SELECT * FROM jsonb_populate_record(NULL::ctp_market.${table},$1::jsonb)`,
        [JSON.stringify(old)],
      );
      c.release();
    }
  },
);
it.each(['trade_event', 'trade_seal', 'native_trade_seen', 'trade_head'] as const)(
  'immutable %s rejects UPDATE, DELETE and TRUNCATE',
  async (table) => {
    const p = await fixture(),
      s = await open();
    await s.publish(p, io());
    await expect(
      admin.query(
        `UPDATE ctp_market.${table} SET ${table === 'native_trade_seen' ? 'event=event' : table === 'trade_head' ? 'revision=revision' : 'id=id'}`,
      ),
    ).rejects.toThrow();
    await expect(admin.query(`DELETE FROM ctp_market.${table}`)).rejects.toThrow();
    await expect(admin.query(`TRUNCATE ctp_market.${table} CASCADE`)).rejects.toThrow();
  },
);
it('role privilege drift after startup is independently rejected by fixed SQL RPC', async () => {
  const p = await fixture(),
    s = await open();
  await admin.query('GRANT SELECT(payload) ON ctp_market.trade_event TO ctp_market_trade');
  try {
    await expect(s.publish(p, io())).rejects.toThrow('MARKET_TRADE_ROLE_UNSAFE');
  } finally {
    await admin.query('REVOKE SELECT(payload) ON ctp_market.trade_event FROM ctp_market_trade');
  }
});
it('direct RPC independently denies unknown authority fields and native constraint fields', async () => {
  const p = await fixture();
  await expect(raw({ ...p, tenantId: randomUUID() })).rejects.toThrow('MARKET_TRADE_INPUT');
  await expect(raw({ ...p, trade: { ...p.trade, newConstraint: true } })).rejects.toThrow(
    'MARKET_TRADE_INPUT',
  );
  expect(await rows(p)).toEqual({ events: 0, native: 0, seals: 0 });
});
async function rejectHistoricalIdentityLoss(removeSeal: boolean) {
  const p = await fixture(),
    s = await open();
  await s.publish(p, io());
  await s.publish(next(p, '1'), io());
  await s.close();
  const c = await admin.connect();
  const old = (
    await c.query<Record<string, unknown>>(
      'SELECT * FROM ctp_market.native_trade_seen WHERE event=$1',
      [p.id],
    )
  ).rows[0]!;
  const oldSeal = (
    await c.query<Record<string, unknown>>('SELECT * FROM ctp_market.trade_seal WHERE id=$1', [
      p.id,
    ])
  ).rows[0]!;
  if (Buffer.isBuffer(oldSeal['hash'])) oldSeal['hash'] = '\\x' + oldSeal['hash'].toString('hex');
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE ctp_market.native_trade_seen DISABLE TRIGGER USER');
    await c.query('DELETE FROM ctp_market.native_trade_seen WHERE event=$1', [p.id]);
    await c.query('ALTER TABLE ctp_market.native_trade_seen ENABLE TRIGGER USER');
    if (removeSeal) {
      await c.query('ALTER TABLE ctp_market.trade_seal DISABLE TRIGGER USER');
      await c.query('DELETE FROM ctp_market.trade_seal WHERE id=$1', [p.id]);
      await c.query('ALTER TABLE ctp_market.trade_seal ENABLE TRIGGER USER');
    }
    await c.query('COMMIT');
    const restarted = await open(),
      candidate = next(p, '2', (BigInt(p.trade.sourceSequence!) + 2n).toString());
    candidate.trade.tradeId = p.trade.tradeId;
    await expect(restarted.publish(candidate, io())).rejects.toThrow('MARKET_TRADE_CORRUPT');
    expect(await restarted.head(p.key, io())).toEqual({ revision: '2', gap: false });
  } finally {
    await c.query('ROLLBACK');
    if (removeSeal)
      await c.query(
        'INSERT INTO ctp_market.trade_seal SELECT * FROM jsonb_populate_record(NULL::ctp_market.trade_seal,$1::jsonb)',
        [JSON.stringify(oldSeal)],
      );
    await c.query(
      'INSERT INTO ctp_market.native_trade_seen SELECT * FROM jsonb_populate_record(NULL::ctp_market.native_trade_seen,$1::jsonb)',
      [JSON.stringify(old)],
    );
    c.release();
  }
}
it('missing historical native identity cannot be reused after a newer head and restart', async () => {
  await rejectHistoricalIdentityLoss(false);
});
it('missing historical identity and seal cannot erase a retained event after restart', async () => {
  await rejectHistoricalIdentityLoss(true);
});
it('publication, duplicate, GAP and restart cannot add financial effects', async () => {
  const p = await fixture(),
    s = await open();
  const financialCounts = async () =>
    (
      await admin.query<{ ledger: number; intents: number; reservations: number; books: number }>(
        'SELECT (SELECT count(*)::int FROM public.ledger_entry) ledger, (SELECT count(*)::int FROM public.order_intent) intents, (SELECT count(*)::int FROM public.risk_reservation) reservations, (SELECT count(*)::int FROM ctp_portfolio.book) books',
      )
    ).rows[0];
  const before = await financialCounts();
  await s.publish(p, io());
  const timestamp = Date.now();
  await s.publish(
    {
      ...p,
      id: randomUUID(),
      expectedRevision: '1',
      timestamp,
      trade: { ...p.trade, receivedAt: timestamp },
    },
    io(),
  );
  await s.publish(
    {
      id: randomUUID(),
      key: p.key,
      kind: 'GAP',
      expectedRevision: '1',
      timestamp: Date.now(),
      reason: 'STREAM_DISCONNECTED',
    },
    io(),
  );
  await s.close();
  const restarted = await open();
  await expect(restarted.read(p.key, io())).rejects.toThrow('MARKET_TRADE_RESYNC_REQUIRED');
  expect(await financialCounts()).toEqual(before);
});
it('public journal role has no financial table or credential authority', async () => {
  for (const table of [
    'public.ledger_transaction',
    'public.risk_reservation',
    'public.order_intent',
    'public.exchange_connection',
  ])
    await expect(direct.query(`SELECT count(*) FROM ${table}`)).rejects.toThrow(
      'permission denied',
    );
});
