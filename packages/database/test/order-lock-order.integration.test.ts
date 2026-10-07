import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPostgresOrderStore, type OrderStore } from '@ctp/order-engine';
import { state } from '../../order-engine/test/fixtures.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_ORDER_LOCK_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_ORDER_LOCK_VARIABLE_REQUIRED');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
let store: OrderStore;
beforeAll(async () => {
  store = await createPostgresOrderStore({
    connectionString: required('DATABASE_EXECUTION_URL'),
    environment: 'test',
  });
});
afterAll(async () => {
  await store?.close();
  await admin.end();
});
async function fixture() {
  const s = state(),
    b = {
      ...s.binding,
      tenantId: randomUUID(),
      accountId: randomUUID(),
      connectionId: randomUUID(),
    };
  b.externalAccountId = b.accountId;
  const instrument = randomUUID(),
    rule = randomUUID(),
    draft = {
      ...s.draft,
      key: randomUUID(),
      dbInstrumentId: instrument,
      dbRuleId: rule,
      order: { ...s.draft.order, instrumentId: instrument },
    };
  await admin.query(
    'INSERT INTO "user"(id,"emailNormalized","updatedAt") VALUES($1::uuid,$2,now())',
    [b.tenantId, `${b.tenantId}@example.invalid`],
  );
  await admin.query(
    `INSERT INTO exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","clientIdHighWatermark","updatedAt") VALUES($1::uuid,$2,'BINANCE','TESTNET',$1::text,'global','SPOT','ACTIVE','order-fixture',9007199254740992,now())`,
    [b.accountId, b.tenantId],
  );
  await admin.query(
    `INSERT INTO exchange_connection(id,"tenantId","accountId",mode,label,status,permissions,"permissionsVerifiedAt","updatedAt") VALUES($1::uuid,$2,$3,'TESTNET','order-fixture','ACTIVE','{"trade":true}',now(),now())`,
    [b.connectionId, b.tenantId, b.accountId],
  );
  await admin.query(
    `INSERT INTO instrument(id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt") VALUES($1::uuid,'BINANCE','SPOT','TESTNET',$1::text,'BTC','USDT',true,now())`,
    [instrument],
  );
  await admin.query(
    `INSERT INTO instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity",rules) VALUES($1::uuid,$2,1,true,now(),now(),$3,0.01,0.001,0.001,'{"version":"v1"}')`,
    [rule, instrument, Buffer.alloc(32, 1)],
  );
  return { b, draft };
}
it('orders GLOBAL then tenant before any account lock or immutable Order publication', async () => {
  const f = await fixture(),
    blocker = await admin.connect();
  let pending: Promise<unknown> | undefined,
    finished = false;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock_shared(1129599058,12)');
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('ctp:risk:'||$1::text,0))", [
      f.b.tenantId,
    ]);
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    pending = store
      .create(f.b, f.draft, { signal: new AbortController().signal, deadline: Date.now() + 2500 })
      .finally(() => {
        finished = true;
      });
    void pending.catch(() => {});
    let waiting = false;
    const deadline = Date.now() + 700;
    while (!finished && !waiting && Date.now() < deadline) {
      waiting =
        (
          await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory' AND $2=ANY(pg_blocking_pids(pid))",
            [new URL(required('DATABASE_EXECUTION_URL')).username, pid],
          )
        ).rowCount === 1;
      if (!waiting) await new Promise((r) => setTimeout(r, 5));
    }
    expect(finished).toBe(false);
    expect(waiting).toBe(true);
    expect(
      (await admin.query('SELECT id FROM public.order_intent WHERE "tenantId"=$1', [f.b.tenantId]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await admin.query(
          'SELECT "clientIdHighWatermark"::text AS counter FROM public.exchange_account WHERE id=$1',
          [f.b.accountId],
        )
      ).rows[0]?.counter,
    ).toBe('9007199254740992');
    await blocker.query('COMMIT');
    const created = await pending;
    expect(created).toHaveProperty('id');
    expect(finished).toBe(true);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    await pending?.catch(() => {});
    blocker.release();
  }
});
