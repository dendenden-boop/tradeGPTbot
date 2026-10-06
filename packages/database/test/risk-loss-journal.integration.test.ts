import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { decimalSchema } from '@ctp/exchange-core';
import {
  createPostgresLossJournal,
  consumeLossCheckpoint,
  lossBatchSchema,
  type LossJournal,
  type LossBatch,
} from '@ctp/risk-engine';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('Loss journal tests require isolated runner');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('Missing isolated loss variable');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const collector = new Pool({
  connectionString: required('DATABASE_RISK_EVIDENCE_URL'),
  max: 2,
  query_timeout: 5000,
});
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
const open = () =>
  createPostgresLossJournal({
    connectionString: required('DATABASE_RISK_EVIDENCE_URL'),
    environment: 'test',
  });
let journal: LossJournal;
async function fixture() {
  const tenantId = randomUUID();
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized","updatedAt") VALUES($1,$2,now())',
    [tenantId, tenantId + '@example.invalid'],
  );
  const now = Date.now(),
    day = Math.floor(now / 86400000) * 86400000;
  return lossBatchSchema.parse({
    scope: { tenantId, mode: 'TESTNET', valuationAsset: 'USDT' },
    dayStart: day,
    id: randomUUID(),
    expectedSequence: '0',
    opening: { at: day, equity: '1000', sourceId: randomUUID(), sourceHash: 'a'.repeat(64) },
    coveredThrough: now,
    events: [
      { id: randomUUID(), at: now, kind: 'FLOW', amount: '50' },
      { id: randomUUID(), at: now, kind: 'REALIZED', amount: '-10' },
      { id: randomUUID(), at: now, kind: 'EQUITY', amount: '1040' },
    ],
    coverage: { from: day, through: now, sourceId: randomUUID(), sourceHash: 'b'.repeat(64) },
  });
}
const continuation = (p: LossBatch, sequence: string, from: number, amount = '1060'): LossBatch => {
  const now = Date.now();
  return lossBatchSchema.parse({
    ...p,
    id: randomUUID(),
    expectedSequence: sequence,
    opening: null,
    coveredThrough: now,
    events: [{ id: randomUUID(), at: now, kind: 'EQUITY', amount }],
    coverage: { ...p.coverage, from, through: now, sourceId: randomUUID() },
  });
};
async function direct(p: unknown, t: string) {
  const c = await collector.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [t]);
    return await c.query('SELECT ctp_risk.append_loss_batch($1::jsonb)', [JSON.stringify(p)]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
beforeAll(async () => {
  journal = await open();
});
afterAll(async () => {
  await journal?.close();
  await collector.end();
  await admin.end();
});
it('durable UTC baseline/flow-adjusted peak and realized loss survive restart and exact replay', async () => {
  const p = await fixture(),
    first = await journal.append(p, io());
  expect(first).toMatchObject({
    sequence: '4',
    openingEquity: '1000',
    externalFlows: '50',
    netRealized: '-10',
    adjustedCurrentEquity: '990',
    adjustedPeakEquity: '1000',
  });
  const q = continuation(p, first.sequence, first.coveredThrough),
    second = await journal.append(q, io());
  expect(second).toMatchObject({
    sequence: '5',
    adjustedCurrentEquity: '1010',
    adjustedPeakEquity: '1010',
  });
  const restarted = await open();
  try {
    const checkpoint = await restarted.read(p.scope, p.dayStart, io());
    expect(checkpoint).toEqual(second);
    expect(consumeLossCheckpoint(checkpoint, p.scope, checkpoint.coveredThrough, 5000)).toEqual({
      utcDayStart: p.dayStart,
      adjustedOpeningEquity: '1000',
      adjustedCurrentEquity: '1010',
      adjustedPeakEquity: '1010',
      dailyNetRealizedPnl: '-10',
      externalFlows: '50',
      lastSequence: '5',
    });
    expect(() =>
      consumeLossCheckpoint(checkpoint, p.scope, checkpoint.coveredThrough + 5001, 5000),
    ).toThrow('RISK_LOSS_BASELINE');
    expect(() =>
      consumeLossCheckpoint(
        checkpoint,
        { ...p.scope, mode: 'DEMO' },
        checkpoint.coveredThrough,
        5000,
      ),
    ).toThrow('RISK_LOSS_BASELINE');
    expect(await restarted.append(p, io())).toEqual(first);
  } finally {
    await restarted.close();
  }
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_risk.loss_event_identity WHERE "tenantId"=$1',
        [p.scope.tenantId],
      )
    ).rows[0]?.n,
  ).toBe(4);
});
it('concurrent same-sequence batches have one winner without two external flow effects', async () => {
  const p = await fixture();
  await journal.append(p, io());
  const a = continuation(p, '4', p.coveredThrough),
    b = continuation(p, '4', p.coveredThrough);
  const r = await Promise.allSettled([journal.append(a, io()), journal.append(b, io())]);
  expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
  expect((await journal.read(p.scope, p.dayStart, io())).sequence).toBe('5');
});
it('same permanent batch identity with different semantics rejects after restart', async () => {
  const p = await fixture();
  await journal.append(p, io());
  const q = structuredClone(p);
  q.events[0]!.amount = decimalSchema.parse('51');
  await expect(journal.append(q, io())).rejects.toThrow('RISK_LOSS_JOURNAL_CONFLICT');
});
it('native economic event identity cannot be reused under another batch or mode', async () => {
  const p = await fixture();
  await journal.append(p, io());
  const q = continuation(p, '4', p.coveredThrough);
  q.events[0]!.id = p.events[0]!.id;
  await expect(journal.append(q, io())).rejects.toThrow('RISK_LOSS_JOURNAL_EVENT_REUSE');
  await expect(
    journal.append({ ...p, id: randomUUID(), scope: { ...p.scope, mode: 'DEMO' } }, io()),
  ).rejects.toThrow('RISK_LOSS_JOURNAL_EVENT_REUSE');
});
it('existing opening cannot be replaced or UTC baseline shifted midday', async () => {
  const p = await fixture();
  await journal.append(p, io());
  await expect(
    direct({ ...p, id: randomUUID(), expectedSequence: '4' }, p.scope.tenantId),
  ).rejects.toThrow('RISK_LOSS_JOURNAL_BASELINE');
  await expect(
    direct({ ...p, id: randomUUID(), dayStart: p.dayStart + 1 }, p.scope.tenantId),
  ).rejects.toThrow('RISK_LOSS_JOURNAL_INPUT');
});
it('missing watermark and contradictory tenant scope fail closed', async () => {
  const p = await fixture();
  await expect(journal.read(p.scope, p.dayStart, io())).rejects.toThrow(
    'RISK_LOSS_JOURNAL_MISSING',
  );
  await expect(direct(p, randomUUID())).rejects.toThrow('RISK_LOSS_JOURNAL_SCOPE');
});
it('TESTNET and DEMO have independent durable baselines and cannot fall back across modes', async () => {
  const p = await fixture();
  await journal.append(p, io());
  await expect(journal.read({ ...p.scope, mode: 'DEMO' }, p.dayStart, io())).rejects.toThrow(
    'RISK_LOSS_JOURNAL_MISSING',
  );
  const q = await fixture();
  q.scope.tenantId = p.scope.tenantId;
  q.scope.mode = 'DEMO';
  q.opening!.equity = decimalSchema.parse('2000');
  expect((await journal.append(q, io())).openingEquity).toBe('2000');
  expect((await journal.read(p.scope, p.dayStart, io())).openingEquity).toBe('1000');
});
it.each([
  'null timestamp',
  'fraction timestamp',
  'null kind',
  'numeric amount',
  'numeric day',
  'numeric coverage',
])('direct SQL rejects %s without creating a baseline', async (kind) => {
  const p = await fixture(),
    q: Record<string, unknown> = structuredClone(p);
  const events = q['events'] as Record<string, unknown>[];
  if (kind === 'null timestamp') events[0]!['at'] = null;
  if (kind === 'fraction timestamp') events[0]!['at'] = (events[0]!['at'] as number) + 0.5;
  if (kind === 'null kind') events[0]!['kind'] = null;
  if (kind === 'numeric amount') events[0]!['amount'] = 50;
  if (kind === 'numeric day') q['dayStart'] = String(q['dayStart']);
  if (kind === 'numeric coverage')
    (q['coverage'] as Record<string, unknown>)['from'] = String(p.dayStart);
  await expect(direct(q, p.scope.tenantId)).rejects.toThrow('RISK_LOSS_JOURNAL_INPUT');
});
it('native SQL exact decimals above JS safe integer preserve flow adjustment', async () => {
  const p = await fixture();
  p.opening!.equity = decimalSchema.parse('9007199254740993.000000000000000001');
  p.events = [
    {
      id: randomUUID(),
      at: p.coveredThrough,
      kind: 'FLOW',
      amount: decimalSchema.parse('0.000000000000000001'),
    },
    {
      id: randomUUID(),
      at: p.coveredThrough,
      kind: 'EQUITY',
      amount: decimalSchema.parse('9007199254740993.000000000000000002'),
    },
  ];
  const r = await journal.append(p, io());
  expect(r.adjustedCurrentEquity).toBe(p.opening!.equity);
  expect(r.adjustedPeakEquity).toBe(p.opening!.equity);
});
it('old coverage cannot skip a history interval or finish with an unvalued flow', async () => {
  const p = await fixture();
  await journal.append(p, io());
  const q = continuation(p, '4', p.coveredThrough);
  q.coverage.from--;
  await expect(journal.append(q, io())).rejects.toThrow('RISK_LOSS_JOURNAL_BASELINE');
  const bad = structuredClone(p);
  bad.id = randomUUID();
  bad.scope.tenantId = (await fixture()).scope.tenantId;
  bad.events.at(-1)!.kind = 'FLOW';
  await expect(direct(bad, bad.scope.tenantId)).rejects.toThrow('RISK_LOSS_JOURNAL_COVERAGE');
});
it('immutable journal, event identities and nondeletable heads reject owner writes', async () => {
  const p = await fixture();
  await journal.append(p, io());
  for (const sql of [
    'UPDATE ctp_risk.loss_batch SET checkpoint=checkpoint WHERE "tenantId"=$1',
    'DELETE FROM ctp_risk.loss_batch WHERE "tenantId"=$1',
    'DELETE FROM ctp_risk.loss_event_identity WHERE "tenantId"=$1',
    'DELETE FROM ctp_risk.loss_head WHERE "tenantId"=$1',
    'UPDATE ctp_risk.loss_head SET sequence=sequence WHERE "tenantId"=$1',
  ])
    await expect(admin.query(sql, [p.scope.tenantId])).rejects.toThrow();
});
it('collector cannot access raw tables, grant Risk, write Portfolio or change policies', async () => {
  for (const sql of [
    'SELECT * FROM ctp_risk.loss_head',
    'SELECT * FROM public.risk_decision',
    'SELECT * FROM ctp_portfolio.book',
    "SELECT ctp_risk.update_user_policy('{}'::jsonb)",
  ])
    await expect(collector.query(sql)).rejects.toThrow(/permission denied/);
});
it('factory rejects superuser and mixed Portfolio authority', async () => {
  await expect(
    createPostgresLossJournal({
      connectionString: required('DATABASE_MIGRATION_URL'),
      environment: 'test',
    }),
  ).rejects.toThrow('RISK_LOSS_JOURNAL_ROLE_UNSAFE');
  const role = new URL(required('DATABASE_RISK_EVIDENCE_URL')).username;
  await admin.query(`GRANT ctp_portfolio TO "${role}"`);
  try {
    await expect(open()).rejects.toThrow('RISK_LOSS_JOURNAL_ROLE_UNSAFE');
    await expect(collector.query("SELECT ctp_risk.append_loss_batch('{}'::jsonb)")).rejects.toThrow(
      'RISK_LOSS_JOURNAL_ROLE_UNSAFE',
    );
  } finally {
    await admin.query(`REVOKE ctp_portfolio FROM "${role}"`);
  }
});
it('native publisher cannot bypass factory by execution function grant', async () => {
  const execution = new Pool({ connectionString: required('DATABASE_EXECUTION_URL'), max: 1 });
  const role = new URL(required('DATABASE_EXECUTION_URL')).username;
  await admin.query(`GRANT EXECUTE ON FUNCTION ctp_risk.append_loss_batch(jsonb) TO "${role}"`);
  try {
    await expect(execution.query("SELECT ctp_risk.append_loss_batch('{}'::jsonb)")).rejects.toThrow(
      'RISK_LOSS_JOURNAL_ROLE_UNSAFE',
    );
  } finally {
    await admin.query(
      `REVOKE EXECUTE ON FUNCTION ctp_risk.append_loss_batch(jsonb) FROM "${role}"`,
    );
    await execution.end();
  }
});
it('native long-running batches retain one bounded current checkpoint without resetting the peak', async () => {
  const p = await fixture();
  let head = await journal.append(p, io());
  for (let index = 0; index < 5; index++) {
    const q = continuation(p, head.sequence, head.coveredThrough);
    q.events = Array.from({ length: 999 }, () => ({
      id: randomUUID(),
      at: q.coveredThrough,
      kind: 'REALIZED' as const,
      amount: decimalSchema.parse('-0.001'),
    }));
    q.events.push({
      id: randomUUID(),
      at: q.coveredThrough,
      kind: 'EQUITY',
      amount: decimalSchema.parse('1040'),
    });
    head = await journal.append(q, io());
  }
  expect(head).toMatchObject({
    sequence: '5004',
    externalFlows: '50',
    netRealized: '-14.995',
    adjustedCurrentEquity: '990',
    adjustedPeakEquity: '1000',
  });
  expect(JSON.stringify(head).length).toBeLessThan(1024);
  expect(await journal.read(p.scope, p.dayStart, io())).toEqual(head);
});
async function waitForBlockedBy(pid: number, expected: boolean) {
  const started = Date.now();
  // The socket settles immediately; a backend inside a blocked SQL statement
  // observes disconnect when its existing 2 s statement timeout fires. Verify
  // physical backend settling inside the documented 3 s transaction bound.
  const bound = expected ? 1500 : 3000;
  while (Date.now() - started < bound) {
    const n = await admin.query<{ blocked: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',
      [pid],
    );
    if (n.rows[0]?.blocked === expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Native loss collector socket lifecycle assertion failed');
}
it('native physical deadline terminates lock waiter and subsequent append recovers', async () => {
  const p = await fixture(),
    lock = await admin.connect();
  try {
    await lock.query('BEGIN');
    const pid = (await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('ctp:risk:'||$1::text,0))", [
      p.scope.tenantId,
    ]);
    const pending = journal.append(p, io(undefined, 500));
    const rejected = expect(pending).rejects.toThrow('RISK_LOSS_JOURNAL_ABORTED');
    await waitForBlockedBy(pid, true);
    await rejected;
    await waitForBlockedBy(pid, false);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  expect((await journal.append(p, io())).sequence).toBe('4');
});
it('native physical abort releases PostgreSQL waiter before uncertain commit can publish a result', async () => {
  const p = await fixture(),
    lock = await admin.connect(),
    abort = new AbortController();
  try {
    await lock.query('BEGIN');
    const pid = (await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('ctp:risk:'||$1::text,0))", [
      p.scope.tenantId,
    ]);
    const pending = journal.append(p, io(abort.signal));
    const rejected = expect(pending).rejects.toThrow('RISK_LOSS_JOURNAL_ABORTED');
    await waitForBlockedBy(pid, true);
    abort.abort();
    await rejected;
    await waitForBlockedBy(pid, false);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  await expect(journal.read(p.scope, p.dayStart, io())).rejects.toThrow(
    'RISK_LOSS_JOURNAL_MISSING',
  );
  expect((await journal.append(p, io())).sequence).toBe('4');
});
