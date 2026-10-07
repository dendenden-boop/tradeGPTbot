import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPostgresPortfolioStore, type PortfolioStore, type Binding } from '@ctp/portfolio';
import { binding, fill, snapshot } from '../../portfolio/test/fixtures.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('Portfolio DB tests require isolated runner');
const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error('Missing isolated portfolio variable');
  return v;
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
let store: PortfolioStore;
beforeAll(async () => {
  store = await createPostgresPortfolioStore({
    connectionString: required('DATABASE_PORTFOLIO_URL'),
    environment: 'test',
  });
});
afterAll(async () => {
  await store?.close();
  await admin.end();
});
async function fixture(mode: Binding['mode'] = 'TESTNET'): Promise<Binding> {
  const b = {
    ...binding(),
    tenantId: randomUUID(),
    accountId: randomUUID(),
    connectionId: randomUUID(),
    mode,
    scope: {
      ...binding().scope,
      environment: mode === 'DEMO' ? ('DEMO' as const) : ('TESTNET' as const),
    },
  };
  b.externalAccountId = b.accountId;
  await admin.query('INSERT INTO "user"(id,"emailNormalized","updatedAt") VALUES($1,$2,now())', [
    b.tenantId,
    `${b.tenantId}@example.invalid`,
  ]);
  await admin.query(
    `INSERT INTO exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,'BINANCE',$4,$3,'global','SPOT','DISABLED','portfolio-test',now())`,
    [b.accountId, b.tenantId, b.externalAccountId, b.mode],
  );
  await admin.query(
    `INSERT INTO exchange_connection(id,"tenantId","accountId",mode,label,status,permissions,"updatedAt") VALUES($1,$2,$3,$4,'portfolio-test','DISABLED','{}',now())`,
    [b.connectionId, b.tenantId, b.accountId, b.mode],
  );
  return b;
}
it('rejects admin/API/auth/ingest identities for portfolio writer', async () => {
  for (const name of [
    'DATABASE_MIGRATION_URL',
    'DATABASE_RUNTIME_URL',
    'DATABASE_AUTH_URL',
    'DATABASE_INGEST_URL',
  ])
    await expect(
      createPostgresPortfolioStore({ connectionString: required(name), environment: 'test' }),
    ).rejects.toThrow('PORTFOLIO_DATABASE_ROLE_UNSAFE');
});
it('atomically commits native evidence, conserved ledger, checkpoint and publication', async () => {
  const b = await fixture();
  let cp = await store.read(b, io());
  cp = (await store.apply(b, snapshot(), cp.revision, io())).checkpoint;
  const r = await store.apply(b, fill(), cp.revision, io());
  expect(r.checkpoint.state.positions[0]?.quantity).toBe('1');
  const ledger = await admin.query<{ sum: string }>(
    `SELECT sum(amount)::text AS sum FROM ledger_entry WHERE "tenantId"=$1 GROUP BY asset`,
    [b.tenantId],
  );
  expect(ledger.rows.every((r) => r.sum === '0')).toBe(true);
  expect((await store.events(b, 200, io())).length).toBe(2);
  const publication = (await store.events(b, 200, io())).find((e) => e.type === 'FILL');
  expect(publication?.eventId).toBe('f1');
  const evidence = await store.evidence(b, ['f1'], io());
  expect(evidence[0]?.ledgerId).toBeTruthy();
  expect(evidence[0]?.event.type).toBe('FILL');
  if (evidence[0]?.event.type === 'FILL') expect(evidence[0].event.native.fillId).toBe('f1');
  await store.acknowledge(
    b,
    (await store.events(b, 200, io())).map((e) => e.id),
    io(),
  );
  expect(await store.events(b, 200, io())).toEqual([]);
  expect((await store.evidence(b, ['f1'], io())).length).toBe(1);
});
it('permanently deduplicates events after snapshot consumption and handle restart', async () => {
  const b = await fixture();
  await store.apply(b, snapshot(), 0, io());
  await store.apply(b, fill(), 1, io());
  await store.apply(
    b,
    snapshot({
      id: 'snap2',
      timestamp: 1000,
      covered: ['f1'],
      balances: [
        { asset: 'BTC', total: '1', free: '1', locked: '0', available: '1' },
        { asset: 'USDT', total: '900', free: '900', locked: '0', available: '900' },
      ],
      positions: [
        {
          instrumentId: 'BTCUSDT',
          positionSide: 'NET',
          bucket: 'CROSS',
          base: 'BTC',
          quote: 'USDT',
          quantity: '1',
          entryPrice: '100',
        },
      ],
    }),
    2,
    io(),
  );
  const restarted = await createPostgresPortfolioStore({
    connectionString: required('DATABASE_PORTFOLIO_URL'),
    environment: 'test',
  });
  try {
    const r = await restarted.apply(b, fill(), 0, io());
    expect(r.duplicate).toBe(true);
    expect(r.checkpoint.revision).toBe(3);
    expect(r.checkpoint.state.balances.find((x) => x.asset === 'BTC')?.total).toBe('1');
  } finally {
    await restarted.close();
  }
});
it('rejects A→B→A identity reuse and conflicting snapshot evidence', async () => {
  const b = await fixture();
  await store.apply(b, snapshot(), 0, io());
  await expect(store.apply(b, snapshot({ balances: [] }), 1, io())).rejects.toThrow(
    'EVIDENCE_CONFLICT',
  );
  const r = await store.apply(b, snapshot(), 99, io());
  expect(r.duplicate).toBe(true);
  expect(r.checkpoint.revision).toBe(1);
});
it('serializes concurrent revisions and does not lose economic events', async () => {
  const b = await fixture();
  await store.apply(b, snapshot(), 0, io());
  const r = await Promise.allSettled([
    store.apply(b, fill({ id: 'f1' }), 1, io()),
    store.apply(b, fill({ id: 'f2' }), 1, io()),
  ]);
  expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect((await store.read(b, io())).revision).toBe(2);
});
it('outbox failure rolls back journal, ledger and projection together', async () => {
  const b = await fixture();
  await store.apply(b, snapshot(), 0, io());
  await admin.query(
    `CREATE FUNCTION ctp_portfolio.test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tenantId"='${b.tenantId}'::uuid THEN RAISE EXCEPTION 'fixture fail'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_fail_outbox BEFORE INSERT ON ctp_portfolio.outbox FOR EACH ROW EXECUTE FUNCTION ctp_portfolio.test_fail_outbox()`,
  );
  try {
    await expect(store.apply(b, fill(), 1, io())).rejects.toThrow();
    expect((await store.read(b, io())).revision).toBe(1);
    expect(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM ledger_transaction WHERE "tenantId"=$1',
          [b.tenantId],
        )
      ).rows[0]?.n,
    ).toBe(1);
  } finally {
    await admin.query(
      'DROP TRIGGER test_fail_outbox ON ctp_portfolio.outbox; DROP FUNCTION ctp_portfolio.test_fail_outbox()',
    );
  }
  const r = await store.apply(b, fill(), 1, io());
  expect(r.duplicate).toBe(false);
});
it('isolates tenants and rejects a foreign connection/account/native binding', async () => {
  const a = await fixture(),
    b = await fixture();
  await store.apply(a, snapshot(), 0, io());
  await expect(store.read({ ...a, tenantId: b.tenantId }, io())).rejects.toThrow(
    'PORTFOLIO_BINDING_DENIED',
  );
  await expect(store.read({ ...a, connectionId: b.connectionId }, io())).rejects.toThrow(
    'PORTFOLIO_BINDING_DENIED',
  );
  await expect(store.read({ ...a, externalAccountId: 'forged' }, io())).rejects.toThrow(
    'PORTFOLIO_BINDING_DENIED',
  );
  expect((await store.read(b, io())).state.balances).toEqual([]);
});
it.each(['abort', 'deadline'] as const)(
  'settles a blocked real query on %s and frees capacity',
  async (mode) => {
    const b = await fixture();
    await store.apply(b, snapshot(), 0, io());
    const locker = await admin.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM ctp_portfolio.book WHERE "tenantId"=$1 FOR UPDATE', [
      b.tenantId,
    ]);
    const controller = new AbortController();
    const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 50) : undefined;
    const started = Date.now();
    try {
      await expect(
        store.apply(b, fill(), 1, io(controller.signal, mode === 'deadline' ? 50 : 2000)),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      if (timer) clearTimeout(timer);
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect((await store.apply(b, fill(), 1, io())).checkpoint.revision).toBe(2);
  },
);
it('stores immutable journal and verifies checkpoint digest under restricted grants', async () => {
  const b = await fixture();
  await store.apply(b, snapshot(), 0, io());
  await expect(
    admin.query(
      `UPDATE ctp_portfolio.evidence SET fingerprint=sha256(convert_to('changed','UTF8')) WHERE "tenantId"=$1`,
      [b.tenantId],
    ),
  ).rejects.toThrow();
  await expect(
    admin.query(`UPDATE ctp_portfolio.book SET state='{}' WHERE "tenantId"=$1`, [b.tenantId]),
  ).rejects.toThrow();
});

it.each(['TESTNET', 'DEMO'] as const)(
  'uses exact %s account/connection mode and rejects contradictory environments',
  async (mode) => {
    const b = await fixture(mode);
    await store.apply(b, snapshot(), 0, io());
    expect((await store.read(b, io())).state.binding.mode).toBe(mode);
    await expect(
      Promise.resolve().then(() =>
        store.read(
          { ...b, scope: { ...b.scope, environment: mode === 'TESTNET' ? 'DEMO' : 'TESTNET' } },
          io(),
        ),
      ),
    ).rejects.toThrow();
    const other: Binding = {
      ...b,
      mode: mode === 'TESTNET' ? 'DEMO' : 'TESTNET',
      scope: { ...b.scope, environment: mode === 'TESTNET' ? 'DEMO' : 'TESTNET' },
    };
    await expect(store.read(other, io())).rejects.toThrow('PORTFOLIO_BINDING_DENIED');
  },
);
const reservation = {
  id: 'durable-hold',
  asset: 'USDT',
  amount: '100',
  status: 'RESERVED' as const,
  reflected: false,
};
const commitment = (id: string, timestamp: number, amount = '100') => ({
  type: 'COMMITMENT' as const,
  id,
  timestamp,
  hold: { ...reservation, amount },
});
const releaseHold = (id: string, timestamp: number, resolved = true) => ({
  type: 'RELEASE' as const,
  id,
  timestamp,
  holdId: reservation.id,
  resolved,
});
it('durable hold ordering ignores old updates/releases without revision or outbox effects', async () => {
  const b = await fixture();
  await store.apply(b, commitment('new', 900), 0, io());
  expect((await store.apply(b, commitment('old', 800, '1'), 1, io())).duplicate).toBe(true);
  expect((await store.apply(b, releaseHold('old-release', 850), 1, io())).duplicate).toBe(true);
  const cp = await store.read(b, io());
  expect(cp.revision).toBe(1);
  expect(cp.state.holds[0]?.amount).toBe('100');
  expect(await store.events(b, 200, io())).toHaveLength(1);
  expect(await store.evidence(b, ['old', 'old-release'], io())).toHaveLength(2);
});
it('durable tombstone survives restart and blocks reservation resurrection and identity conflicts', async () => {
  const b = await fixture();
  await store.apply(b, commitment('create', 800), 0, io());
  await store.apply(b, releaseHold('release', 900), 1, io());
  const restarted = await createPostgresPortfolioStore({
    connectionString: required('DATABASE_PORTFOLIO_URL'),
    environment: 'test',
  });
  try {
    expect((await restarted.apply(b, commitment('late', 850), 2, io())).duplicate).toBe(true);
    expect((await restarted.apply(b, commitment('create', 800), 0, io())).duplicate).toBe(true);
    expect((await restarted.read(b, io())).state.holds).toEqual([]);
    await expect(restarted.apply(b, commitment('reuse', 950), 2, io())).rejects.toThrow(
      'HOLD_CLOSED',
    );
    await expect(restarted.apply(b, commitment('late', 850, '99'), 2, io())).rejects.toThrow(
      'EVIDENCE_CONFLICT',
    );
  } finally {
    await restarted.close();
  }
});
it('rejects equal timestamp conflicts and weak UNKNOWN resolution while allowing identical semantic replay', async () => {
  const b = await fixture();
  const event = { ...commitment('u', 800), hold: { ...reservation, status: 'UNKNOWN' as const } };
  await store.apply(b, event, 0, io());
  expect((await store.apply(b, { ...event, id: 'same-semantic' }, 1, io())).duplicate).toBe(true);
  await expect(store.apply(b, commitment('conflict', 800, '1'), 1, io())).rejects.toThrow(
    'HOLD_VERSION_CONFLICT',
  );
  await expect(store.apply(b, releaseHold('unproven', 900, false), 1, io())).rejects.toThrow(
    'UNKNOWN_COMMITMENT',
  );
  await store.apply(b, releaseHold('resolved', 900), 1, io());
  expect((await store.read(b, io())).state.holds).toEqual([]);
});
it('outbox rollback rolls back the hold watermark, and SQL cannot regress it', async () => {
  const b = await fixture();
  await store.read(b, io());
  await admin.query(
    `CREATE FUNCTION ctp_portfolio.test_fail_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tenantId"='${b.tenantId}'::uuid THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_fail_hold BEFORE INSERT ON ctp_portfolio.outbox FOR EACH ROW EXECUTE FUNCTION ctp_portfolio.test_fail_hold()`,
  );
  try {
    await expect(store.apply(b, commitment('retry', 900), 0, io())).rejects.toThrow();
    expect(
      (
        await admin.query('SELECT * FROM ctp_portfolio.hold_watermark WHERE "tenantId"=$1', [
          b.tenantId,
        ])
      ).rows,
    ).toEqual([]);
  } finally {
    await admin.query(
      'DROP TRIGGER test_fail_hold ON ctp_portfolio.outbox; DROP FUNCTION ctp_portfolio.test_fail_hold()',
    );
  }
  await store.apply(b, commitment('retry', 900), 0, io());
  await expect(
    admin.query('UPDATE ctp_portfolio.hold_watermark SET timestamp=800 WHERE "tenantId"=$1', [
      b.tenantId,
    ]),
  ).rejects.toThrow();
});
it('legacy journal watermark backfill fails closed and requires newer trusted resolution', async () => {
  const b = await fixture();
  await store.read(b, io());
  // Same placeholder representation as migration backfill; migration execution is
  // independently covered by the upgrade fixture in the database runner.
  await admin.query(
    `INSERT INTO ctp_portfolio.hold_watermark("tenantId",book,"accountId",mode,"holdId",timestamp,fingerprint,released,unknown) SELECT "tenantId",id,"accountId",mode,$2,900,$3,false,true FROM ctp_portfolio.book WHERE "tenantId"=$1`,
    [
      b.tenantId,
      reservation.id,
      createHash('sha256')
        .update('legacy-hold-history:' + reservation.id)
        .digest(),
    ],
  );
  await expect(store.apply(b, commitment('unproven', 950), 0, io())).rejects.toThrow(
    'UNKNOWN_COMMITMENT',
  );
  await store.apply(b, releaseHold('trusted', 950), 0, io());
  await expect(store.apply(b, commitment('resurrect', 1000), 1, io())).rejects.toThrow(
    'HOLD_CLOSED',
  );
});

it('retains a committed UNKNOWN hold after actual COMMIT acknowledgement loss, restart and exact replay without ledger duplication', async () => {
  const b = await fixture();
  await store.apply(b, snapshot(), 0, io());
  const ledgerBefore = await admin.query(
    'SELECT * FROM public.ledger_transaction WHERE "tenantId"=$1 ORDER BY id',
    [b.tenantId],
  );
  const entriesBefore = await admin.query(
    'SELECT * FROM public.ledger_entry WHERE "tenantId"=$1 ORDER BY id',
    [b.tenantId],
  );
  const event = {
    ...commitment('commit-response-loss', 1100),
    hold: { ...reservation, status: 'UNKNOWN' as const },
  };
  const proxy = await registryCommitProxy(required('DATABASE_PORTFOLIO_URL'), 'PORTFOLIO');
  let viaProxy: PortfolioStore | undefined;
  try {
    viaProxy = await createPostgresPortfolioStore({
      connectionString: proxy.connectionString,
      environment: 'test',
    });
    proxy.arm();
    await expect(viaProxy.apply(b, event, 1, io())).rejects.toThrow();
    expect(proxy.dropped()).toBe(1);
    expect((await store.read(b, io())).state.holds).toEqual([event.hold]);
    await viaProxy.close();
    viaProxy = undefined;
    const restart = await createPostgresPortfolioStore({
      connectionString: required('DATABASE_PORTFOLIO_URL'),
      environment: 'test',
    });
    try {
      const replay = await restart.apply(b, event, 0, io());
      expect(replay.duplicate).toBe(true);
      expect(replay.checkpoint.revision).toBe(2);
      expect(replay.checkpoint.state.holds).toEqual([event.hold]);
      await expect(
        restart.apply(b, { ...event, hold: { ...event.hold, amount: '99' } }, 2, io()),
      ).rejects.toThrow('EVIDENCE_CONFLICT');
      expect(
        (
          await admin.query(
            'SELECT * FROM public.ledger_transaction WHERE "tenantId"=$1 ORDER BY id',
            [b.tenantId],
          )
        ).rows,
      ).toEqual(ledgerBefore.rows);
      expect(
        (
          await admin.query('SELECT * FROM public.ledger_entry WHERE "tenantId"=$1 ORDER BY id', [
            b.tenantId,
          ])
        ).rows,
      ).toEqual(entriesBefore.rows);
      expect(
        (await restart.events(b, 200, io())).filter((e) => e.type === 'COMMITMENT'),
      ).toHaveLength(1);
    } finally {
      await restart.close();
    }
  } finally {
    await viaProxy?.close();
    await proxy.close();
  }
});
