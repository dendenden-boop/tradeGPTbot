import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../src/generated/client.js';
import { createDatabase } from '../src/index.js';
import { developmentIds, seedDevelopment } from '../src/seed.js';

const project = process.env['CTP_TEST_PROJECT'];
if (!project || !/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(project)) {
  throw new Error('Database integration requires the isolated project runner');
}

function requiredUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing isolated runner variable: ${name}`);
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname.slice(1)) {
    throw new Error('Expected an isolated PostgreSQL connection');
  }
  return value;
}

const adminUrl = requiredUrl('DATABASE_MIGRATION_URL');
const runtimeUrl = requiredUrl('DATABASE_RUNTIME_URL');
if (new URL(adminUrl).pathname !== new URL(runtimeUrl).pathname) {
  throw new Error('Migration and runtime connections must target the same disposable database');
}

const admin = new Pool({ connectionString: adminUrl, max: 5, query_timeout: 10_000 });
const runtime = new Pool({ connectionString: runtimeUrl, max: 5, query_timeout: 7000 });
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: adminUrl, max: 5, query_timeout: 10_000 }),
  log: [],
  errorFormat: 'minimal',
});
type SqlClient = Pool | PoolClient;
type Row = Record<string, unknown>;
type Database = Awaited<ReturnType<typeof createDatabase>>;
let database: Database | undefined;

const fixture = Object.freeze({
  a: randomUUID(),
  b: randomUUID(),
  accountA: randomUUID(),
  accountA2: randomUUID(),
  accountB: randomUUID(),
  connectionA: randomUUID(),
  connectionA2: randomUUID(),
  connectionB: randomUUID(),
  instrument: randomUUID(),
  rule: randomUUID(),
});
const evidence = Buffer.alloc(32, 7);
const timestamp = new Date('2026-09-01T00:00:00.000Z');

async function rows(
  client: SqlClient,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  return (await client.query<Row>(sql, [...values])).rows;
}

function stringField(row: Row | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== 'string') throw new Error(`Expected string result column: ${key}`);
  return value;
}

function numberField(row: Row | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected numeric result column: ${key}`);
  }
  return value;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function expectSqlFailure(operation: () => Promise<unknown>, codes: readonly string[]) {
  const result = await operation().then(
    () => ({ succeeded: true as const }),
    (error: unknown) => ({ succeeded: false as const, code: sqlState(error) }),
  );
  expect(result.succeeded).toBe(false);
  if (!result.succeeded) expect(codes).toContain(result.code);
}

async function tenantTransaction<T>(
  pool: Pool,
  tenantId: string | null,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function db(): Database {
  if (!database) throw new Error('Database helper was not initialized');
  return database;
}

interface IntentOptions {
  id?: string;
  tenantId?: string;
  accountId?: string;
  connectionId?: string | null;
  mode?: 'PAPER' | 'TESTNET' | 'DEMO' | 'LIVE';
  key?: string;
  quantity?: string;
  price?: string;
}

async function insertIntent(client: SqlClient, options: IntentOptions = {}): Promise<string> {
  const id = options.id ?? randomUUID();
  await rows(
    client,
    `INSERT INTO order_intent
      (id, "tenantId", "accountId", mode, "connectionId", "instrumentId", "ruleVersionId",
       origin, destination, operation, "idempotencyKey", "commandHash", side, "orderType",
       "timeInForce", "quantityAsset", "priceAsset", quantity, "limitPrice")
     VALUES ($1,$2,$3,$4,$5,$6,$7,'USER','EXCHANGE','PLACE',$8,$9,'BUY','LIMIT','GTC',
       'BTC','USDT',$10::numeric,$11::numeric)`,
    [
      id,
      options.tenantId ?? fixture.a,
      options.accountId ?? fixture.accountA,
      options.mode ?? 'TESTNET',
      options.connectionId === undefined ? fixture.connectionA : options.connectionId,
      fixture.instrument,
      fixture.rule,
      options.key ?? randomUUID(),
      evidence,
      options.quantity ?? '1',
      options.price ?? '100',
    ],
  );
  return id;
}

async function insertOrder(
  client: SqlClient,
  intentId: string,
  id = randomUUID(),
): Promise<string> {
  await rows(
    client,
    `INSERT INTO "order"
      (id,"tenantId","intentId","accountId",mode,"connectionId","instrumentId","ruleVersionId",
       "clientIdNamespace","clientId",market,side,"orderType","timeInForce","quantityAsset",
       "priceAsset",quantity,"limitPrice","updatedAt")
     VALUES ($1::uuid,$2,$3,$4,'TESTNET',$5,$6,$7,'db-integration',$1::text,'SPOT','BUY','LIMIT','GTC',
       'BTC','USDT',1,100,now())`,
    [
      id,
      fixture.a,
      intentId,
      fixture.accountA,
      fixture.connectionA,
      fixture.instrument,
      fixture.rule,
    ],
  );
  return id;
}

async function insertFill(
  client: SqlClient,
  orderId: string,
  identity = randomUUID(),
  quoteAmount = '100',
): Promise<string> {
  const id = randomUUID();
  await rows(
    client,
    `INSERT INTO fill
      (id,"tenantId","orderId","accountId",mode,"instrumentId","ruleVersionId",market,
       "executionIdentity",side,"baseAsset","quoteAsset",quantity,price,"quoteAmount",
       timestamp,"receivedAt","evidenceHash")
     VALUES ($1,$2,$3,$4,'TESTNET',$5,$6,'SPOT',$7,'BUY','BTC','USDT',1,100,$8::numeric,$9,$9,$10)`,
    [
      id,
      fixture.a,
      orderId,
      fixture.accountA,
      fixture.instrument,
      fixture.rule,
      identity,
      quoteAmount,
      timestamp,
      evidence,
    ],
  );
  return id;
}

async function insertOutbox(client: SqlClient, aggregateId = randomUUID()): Promise<string> {
  const id = randomUUID();
  await rows(
    client,
    `INSERT INTO outbox_event
      (id,"tenantId","eventType","schemaVersion","aggregateType","aggregateId",
       "aggregateVersion",payload,"occurredAt")
     VALUES ($1,$2,'OrderIntentCreated',1,'OrderIntent',$3,1,'{}',$4)`,
    [id, fixture.a, aggregateId, timestamp],
  );
  return id;
}

async function insertInbox(client: SqlClient, eventId: string): Promise<void> {
  await rows(
    client,
    `INSERT INTO consumer_inbox
      ("tenantId",consumer,"eventId","eventType","schemaVersion","payloadHash","retainUntil")
     VALUES ($1,'db-integration',$2,'OrderIntentCreated',1,$3,'2030-01-01T00:00:00Z')`,
    [fixture.a, eventId, evidence],
  );
}

/** Both independent backends reach the barrier before either contested statement starts. */
async function competingTransactions<T>(operation: (client: PoolClient) => Promise<T>) {
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backendIds = new Set<number>();
  let ready = 0;
  const compete = () =>
    tenantTransaction(runtime, fixture.a, async (client) => {
      const backend = await rows(client, 'SELECT pg_backend_pid() AS pid');
      backendIds.add(numberField(backend[0], 'pid'));
      ready += 1;
      if (ready === 2) release?.();
      await barrier;
      return operation(client);
    });
  const results = await Promise.allSettled([compete(), compete()]);
  expect(backendIds.size).toBe(2);
  return results;
}

function expectUniqueWinner(results: readonly PromiseSettledResult<unknown>[]) {
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const losers = results.filter((result) => result.status === 'rejected');
  expect(losers).toHaveLength(1);
  expect(sqlState(losers[0]?.reason)).toBe('23505');
}

async function insertFunding(amount: string, rate: string): Promise<Row | undefined> {
  const result = await rows(
    admin,
    `INSERT INTO funding_payment
      ("tenantId","accountId",mode,"instrumentId","paymentIdentity",asset,amount,rate,timestamp,"receivedAt")
     VALUES ($1,$2,'TESTNET',$3,$4,'USDT',$5::numeric,$6::numeric,$7,$7)
     RETURNING amount::text,rate::text`,
    [fixture.a, fixture.accountA, fixture.instrument, randomUUID(), amount, rate, timestamp],
  );
  return result[0];
}

beforeAll(async () => {
  await rows(
    admin,
    `INSERT INTO "user" (id,"emailNormalized","updatedAt") VALUES
      ($1,$3,now()),($2,$4,now())`,
    [fixture.a, fixture.b, `${fixture.a}@example.invalid`, `${fixture.b}@example.invalid`],
  );
  for (const [account, tenant] of [
    [fixture.accountA, fixture.a],
    [fixture.accountA2, fixture.a],
    [fixture.accountB, fixture.b],
  ] as const) {
    await rows(
      admin,
      `INSERT INTO exchange_account
        (id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,
         "clientIdEpoch","updatedAt")
       VALUES ($1::uuid,$2,'BINANCE','TESTNET',$1::text,'development','SIMULATED','DISABLED','test-epoch',now())`,
      [account, tenant],
    );
  }
  for (const [connection, account, tenant] of [
    [fixture.connectionA, fixture.accountA, fixture.a],
    [fixture.connectionA2, fixture.accountA2, fixture.a],
    [fixture.connectionB, fixture.accountB, fixture.b],
  ] as const) {
    await rows(
      admin,
      `INSERT INTO exchange_connection (id,"tenantId","accountId",mode,label,permissions,"updatedAt")
       VALUES ($1,$2,$3,'TESTNET','integration-fixture','{}',now())`,
      [connection, tenant, account],
    );
  }
  await rows(
    admin,
    `INSERT INTO instrument
      (id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt")
     VALUES ($1,'BINANCE','SPOT','TESTNET',$2,'BTC','USDT',false,now())`,
    [fixture.instrument, `FIXTURE_${fixture.instrument}`],
  );
  await rows(
    admin,
    `INSERT INTO instrument_rule_version
      (id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash",
       "priceTick","quantityStep","minQuantity",rules)
     VALUES ($1,$2,1,true,$3,$3,$4,0.01,0.000001,0.000001,'{"fixture":true}')`,
    [fixture.rule, fixture.instrument, timestamp, evidence],
  );
  database = await createDatabase({ connectionString: runtimeUrl, environment: 'test' });
});

afterAll(async () => {
  const results = await Promise.allSettled([
    database?.close(),
    prisma.$disconnect(),
    runtime.end(),
    admin.end(),
  ]);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
});

describe('PostgreSQL schema and tenant security', () => {
  it('installs the complete 59-model catalog with tenant RLS', async () => {
    const expected = [
      'user',
      'user_session',
      'two_factor_config',
      'email_verification_token',
      'password_reset_token',
      'recovery_code',
      'exchange_account',
      'exchange_connection',
      'encrypted_credential',
      'live_grant',
      'instrument',
      'instrument_rule_version',
      'capability_snapshot',
      'balance_snapshot',
      'position',
      'account_state_version',
      'ledger_transaction',
      'ledger_entry',
      'asset_valuation',
      'order_intent',
      'idempotency_record',
      'order',
      'algo_order',
      'submission_attempt',
      'order_event',
      'trade',
      'fill',
      'fee',
      'funding_payment',
      'strategy_definition',
      'strategy_parameter',
      'strategy_instance',
      'strategy_run',
      'strategy_state',
      'signal',
      'risk_profile',
      'risk_decision',
      'risk_event',
      'risk_reservation',
      'risk_budget',
      'trading_pause',
      'circuit_state',
      'paper_account',
      'paper_order',
      'paper_position',
      'backtest',
      'backtest_trade',
      'backtest_metric',
      'dataset_manifest',
      'candle',
      'market_gap',
      'market_checkpoint',
      'subscription_assignment',
      'outbox_event',
      'consumer_inbox',
      'notification',
      'audit_log',
      'system_event',
      'reconciliation_run',
    ].sort();
    const catalog = await rows(
      admin,
      `SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,
       EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenantId') AS tenant
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition
         AND c.relname <> '_prisma_migrations'`,
    );
    expect(catalog.map((row) => stringField(row, 'name')).sort()).toEqual(expected);
    for (const row of catalog) {
      if (row['tenant'] === true || row['name'] === 'user') {
        expect(row['rls'], stringField(row, 'name')).toBe(true);
        expect(row['forced'], stringField(row, 'name')).toBe(true);
      }
    }
  });

  it('denies tenant data without context but permits global lookup reads', async () => {
    expect(await rows(runtime, 'SELECT id FROM "user"')).toEqual([]);
    expect(await rows(runtime, 'SELECT id FROM exchange_account')).toEqual([]);
    expect(
      await rows(runtime, 'SELECT id FROM instrument WHERE id=$1', [fixture.instrument]),
    ).toHaveLength(1);
    await expectSqlFailure(
      () =>
        rows(
          runtime,
          `INSERT INTO outbox_event ("tenantId","eventType","schemaVersion","aggregateType", "aggregateId",
        "aggregateVersion",payload,"occurredAt") VALUES ($1,'Test',1,'Test',$2,1,'{}',now())`,
          [fixture.a, randomUUID()],
        ),
      ['42501'],
    );
  });

  it('isolates tenant reads, writes and forged parent foreign keys', async () => {
    const visibleA = await db().withTenant(fixture.a, (transaction) =>
      transaction.user.findMany({ select: { id: true } }),
    );
    expect(visibleA).toEqual([{ id: fixture.a }]);
    const visibleB = await db().withTenant(fixture.b, (transaction) =>
      transaction.user.findMany({ select: { id: true } }),
    );
    expect(visibleB).toEqual([{ id: fixture.b }]);
    const created = await tenantTransaction(runtime, fixture.a, (client) => insertIntent(client));
    expect(
      await tenantTransaction(runtime, fixture.b, (client) =>
        rows(client, 'SELECT id FROM order_intent WHERE id=$1', [created]),
      ),
    ).toEqual([]);
    await expectSqlFailure(
      () =>
        tenantTransaction(runtime, fixture.a, (client) =>
          insertIntent(client, {
            tenantId: fixture.b,
            accountId: fixture.accountB,
            connectionId: fixture.connectionB,
          }),
        ),
      ['42501'],
    );
    await expectSqlFailure(
      () =>
        tenantTransaction(runtime, fixture.a, (client) =>
          insertIntent(client, { accountId: fixture.accountB }),
        ),
      ['23503'],
    );
  });

  it('rejects a same-tenant connection from another account and mismatched mode', async () => {
    await expectSqlFailure(
      () => insertIntent(admin, { connectionId: fixture.connectionA2 }),
      ['23503', '23514'],
    );
    await expectSqlFailure(() => insertIntent(admin, { mode: 'DEMO' }), ['23503', '23514']);
  });

  it('defaults new accounts to PAPER and refuses a PAPER exchange connection', async () => {
    const account = randomUUID();
    const result = await rows(
      admin,
      `INSERT INTO exchange_account (id,"tenantId",exchange,"externalAccountId",region,
       "accountMode","clientIdEpoch","updatedAt")
       VALUES ($1::uuid,$2,'BINANCE',$1::text,'development','SIMULATED','paper-fixture',now()) RETURNING mode`,
      [account, fixture.a],
    );
    expect(stringField(result[0], 'mode')).toBe('PAPER');
    await expectSqlFailure(
      () =>
        rows(
          admin,
          `INSERT INTO exchange_connection ("tenantId","accountId",mode,label,permissions,"updatedAt")
       VALUES ($1,$2,'PAPER','forbidden-paper-connection','{}',now())`,
          [fixture.a, account],
        ),
      ['23514'],
    );
  });

  it('blocks secret tables, global mutations and schema-wide runtime privileges', async () => {
    for (const table of [
      'encrypted_credential',
      'two_factor_config',
      'user_session',
      'email_verification_token',
      'password_reset_token',
      'recovery_code',
    ]) {
      // Identifiers come exclusively from this fixed test allowlist.
      await expectSqlFailure(() => rows(runtime, `SELECT * FROM "${table}" LIMIT 1`), ['42501']);
    }
    await expectSqlFailure(
      () => rows(runtime, 'UPDATE instrument SET active=true WHERE id=$1', [fixture.instrument]),
      ['42501'],
    );
    await expectSqlFailure(() => rows(runtime, 'TRUNCATE "user"'), ['42501']);
    await expectSqlFailure(
      () => rows(runtime, 'CREATE TABLE public.forbidden_runtime_ddl (id integer)'),
      ['42501'],
    );
  });

  it('cannot update or delete another tenant event', async () => {
    const event = await tenantTransaction(runtime, fixture.a, (client) => insertOutbox(client));
    await tenantTransaction(runtime, fixture.b, async (client) => {
      expect(
        await rows(client, 'UPDATE outbox_event SET attempts=99 WHERE id=$1 RETURNING id', [event]),
      ).toEqual([]);
      expect(
        await rows(client, 'DELETE FROM outbox_event WHERE id=$1 RETURNING id', [event]),
      ).toEqual([]);
    });
    const result = await tenantTransaction(runtime, fixture.a, (client) =>
      rows(client, 'SELECT attempts FROM outbox_event WHERE id=$1', [event]),
    );
    expect(numberField(result[0], 'attempts')).toBe(0);
  });

  it('clears local tenant context on commit and rollback on the same pooled connection', async () => {
    const single = new Pool({ connectionString: runtimeUrl, max: 1, query_timeout: 7000 });
    try {
      const first = await tenantTransaction(single, fixture.a, (client) =>
        rows(client, 'SELECT pg_backend_pid() AS pid,id FROM "user"'),
      );
      expect(first.map((row) => stringField(row, 'id'))).toEqual([fixture.a]);
      expect(await rows(single, 'SELECT id FROM "user"')).toEqual([]);
      const pid = numberField((await rows(single, 'SELECT pg_backend_pid() AS pid'))[0], 'pid');
      expect(pid).toBe(numberField(first[0], 'pid'));
      await expect(
        tenantTransaction(single, fixture.b, async (client) => {
          expect(
            (await rows(client, 'SELECT id FROM "user"')).map((row) => stringField(row, 'id')),
          ).toEqual([fixture.b]);
          throw new Error('Intentional transaction rollback');
        }),
      ).rejects.toThrow('Intentional transaction rollback');
      expect(await rows(single, 'SELECT id FROM "user"')).toEqual([]);
      await expectSqlFailure(
        () =>
          tenantTransaction(single, 'invalid-tenant', (client) =>
            rows(client, 'SELECT id FROM "user"'),
          ),
        ['22P02'],
      );
      expect(await rows(single, 'SELECT id FROM "user"')).toEqual([]);
      expect(numberField((await rows(single, 'SELECT pg_backend_pid() AS pid'))[0], 'pid')).toBe(
        pid,
      );
    } finally {
      await single.end();
    }
  });
});

describe('Exact PostgreSQL numeric storage and evidence constraints', () => {
  it('uses unconstrained numeric plus explicit decimal checks for every money column', async () => {
    const columns = await rows(
      admin,
      `SELECT c.relname AS table_name,a.attname AS column_name,a.atttypmod AS typmod,
         EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid=c.oid AND con.contype='c'
           AND con.conname=c.relname || '_' || a.attname || '_decimal') AS checked
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND NOT c.relispartition AND a.atttypid='numeric'::regtype
         AND a.attnum>0 AND NOT a.attisdropped`,
    );
    expect(columns).toHaveLength(61);
    for (const column of columns) {
      expect(
        column['typmod'],
        `${stringField(column, 'table_name')}.${stringField(column, 'column_name')}`,
      ).toBe(-1);
      expect(column['checked']).toBe(true);
    }
  });

  it.each(['quantity', 'price'] as const)(
    'round-trips %s at both exact positive bounds and refuses rounding',
    async (kind) => {
      const maximum = '99999999999999999999.999999999999999999';
      const minimum = '0.000000000000000001';
      for (const value of [maximum, minimum]) {
        const id = await insertIntent(admin, { [kind]: value });
        const result = await rows(
          admin,
          'SELECT quantity::text,"limitPrice"::text AS price FROM order_intent WHERE id=$1',
          [id],
        );
        expect(stringField(result[0], kind)).toBe(value);
        const fetched = await db().withTenant(fixture.a, (transaction) =>
          transaction.orderIntent.findUniqueOrThrow({
            where: { id },
            select: { quantity: true, limitPrice: true },
          }),
        );
        expect((kind === 'quantity' ? fetched.quantity : fetched.limitPrice)?.toFixed(18)).toBe(
          value,
        );
      }
      for (const value of [
        '0',
        '-1',
        '100000000000000000000',
        '0.0000000000000000001',
        '1.0000000000000000000',
        'NaN',
        'Infinity',
        '-Infinity',
      ]) {
        await expectSqlFailure(() => insertIntent(admin, { [kind]: value }), ['23514']);
      }
    },
  );

  it.each(['amount', 'rate'] as const)(
    'round-trips signed %s boundaries and rejects overflow/special values',
    async (kind) => {
      const digits = kind === 'amount' ? 20 : 2;
      const maximum = `${'9'.repeat(digits)}.999999999999999999`;
      for (const value of [maximum, `-${maximum}`, '0', '-0.000000000000000001']) {
        const result = await insertFunding(
          kind === 'amount' ? value : '1',
          kind === 'rate' ? value : '0',
        );
        expect(stringField(result, kind)).toBe(value);
      }
      for (const value of [
        `1${'0'.repeat(digits)}`,
        `-1${'0'.repeat(digits)}`,
        '0.0000000000000000001',
        'NaN',
        'Infinity',
        '-Infinity',
      ]) {
        await expectSqlFailure(
          () => insertFunding(kind === 'amount' ? value : '1', kind === 'rate' ? value : '0'),
          ['23514'],
        );
      }
    },
  );

  it('preserves aggregate precision above the amount range and rejects forbidden values', async () => {
    const order = await insertOrder(admin, await insertIntent(admin));
    const maximum = '999999999999999999999999999999.999999999999999999';
    for (const value of ['0', '0.000000000000000001', maximum]) {
      const id = await insertFill(admin, order, randomUUID(), value);
      expect(
        stringField(
          (
            await rows(admin, 'SELECT "quoteAmount"::text AS amount FROM fill WHERE id=$1', [id])
          )[0],
          'amount',
        ),
      ).toBe(value);
    }
    for (const value of [
      '-1',
      '1000000000000000000000000000000',
      '0.0000000000000000001',
      'NaN',
      'Infinity',
      '-Infinity',
    ]) {
      await expectSqlFailure(() => insertFill(admin, order, randomUUID(), value), ['23514']);
    }
  });

  it('rejects malformed decimal SQL input and oversized scoped external identities', async () => {
    await expectSqlFailure(() => insertIntent(admin, { quantity: 'invalid-number' }), ['22P02']);
    await expectSqlFailure(() => insertIntent(admin, { key: 'x'.repeat(129) }), ['22001']);
  });

  it('enforces immutable execution evidence and a single current instrument rule', async () => {
    const intent = await insertIntent(admin);
    const order = await insertOrder(admin, intent);
    const fill = await insertFill(admin, order);
    await expectSqlFailure(
      () => rows(admin, 'UPDATE order_intent SET quantity=2 WHERE id=$1', [intent]),
      ['23514'],
    );
    await expectSqlFailure(() => rows(admin, 'DELETE FROM fill WHERE id=$1', [fill]), ['23514']);
    await expectSqlFailure(
      () =>
        rows(admin, 'UPDATE instrument_rule_version SET "priceTick"=1 WHERE id=$1', [fixture.rule]),
      ['23514'],
    );
    await expectSqlFailure(
      () =>
        rows(
          admin,
          `INSERT INTO instrument_rule_version
        ("instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity",rules)
       VALUES ($1,2,true,$2,$2,$3,0.01,0.000001,0.000001,'{}')`,
          [fixture.instrument, timestamp, evidence],
        ),
      ['23505'],
    );
    await expectSqlFailure(
      () => rows(admin, 'UPDATE "order" SET "filledQuantity"=2 WHERE id=$1', [order]),
      ['23514'],
    );
  });
});

describe('Durable identity and atomic transactions', () => {
  it('allows only one concurrent intent for the same tenant operation and idempotency key', async () => {
    const key = randomUUID();
    expectUniqueWinner(await competingTransactions((client) => insertIntent(client, { key })));
    expect(
      await rows(admin, 'SELECT id FROM order_intent WHERE "tenantId"=$1 AND "idempotencyKey"=$2', [
        fixture.a,
        key,
      ]),
    ).toHaveLength(1);
  });

  it('allows only one concurrent fill with the same account execution identity', async () => {
    const order = await insertOrder(admin, await insertIntent(admin));
    const identity = randomUUID();
    expectUniqueWinner(
      await competingTransactions((client) => insertFill(client, order, identity)),
    );
    expect(
      await rows(admin, 'SELECT id FROM fill WHERE "tenantId"=$1 AND "executionIdentity"=$2', [
        fixture.a,
        identity,
      ]),
    ).toHaveLength(1);
  });

  it('allows only one concurrent inbox receipt for the same consumer and event', async () => {
    const event = await insertOutbox(admin);
    expectUniqueWinner(await competingTransactions((client) => insertInbox(client, event)));
    expect(
      await rows(admin, 'SELECT id FROM consumer_inbox WHERE consumer=$1 AND "eventId"=$2', [
        'db-integration',
        event,
      ]),
    ).toHaveLength(1);
  });

  it('gives a single winner to competing compare-and-swap order updates', async () => {
    const order = await insertOrder(admin, await insertIntent(admin));
    const results = await competingTransactions((client) =>
      rows(
        client,
        'UPDATE "order" SET version=version+1,"updatedAt"=now() WHERE id=$1 AND version=0 RETURNING version',
        [order],
      ),
    );
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const changes = results
      .map((result) => (result.status === 'fulfilled' ? result.value.length : -1))
      .sort();
    expect(changes).toEqual([0, 1]);
    expect(
      numberField(
        (await rows(admin, 'SELECT version FROM "order" WHERE id=$1', [order]))[0],
        'version',
      ),
    ).toBe(1);
  });

  it('rolls back intent, order and outbox together after a later failure', async () => {
    const intentId = randomUUID();
    const orderId = randomUUID();
    await expect(
      tenantTransaction(runtime, fixture.a, async (client) => {
        await insertIntent(client, { id: intentId });
        await insertOrder(client, intentId, orderId);
        await insertOutbox(client, intentId);
        throw new Error('Rollback after outbox insert');
      }),
    ).rejects.toThrow('Rollback after outbox insert');
    expect(await rows(admin, 'SELECT id FROM order_intent WHERE id=$1', [intentId])).toEqual([]);
    expect(await rows(admin, 'SELECT id FROM "order" WHERE id=$1', [orderId])).toEqual([]);
    expect(
      await rows(admin, 'SELECT id FROM outbox_event WHERE "aggregateId"=$1', [intentId]),
    ).toEqual([]);
  });
});

describe('Runtime database lifecycle and development seed', () => {
  it('rejects the actual migration administrator as a runtime identity', async () => {
    await expect(
      createDatabase({ connectionString: adminUrl, environment: 'test' }),
    ).rejects.toMatchObject({
      code: 'DATABASE_ROLE_UNSAFE',
      message: 'Database operation failed',
    });
  });

  it('rejects a non-inheriting runtime role that can assume a privileged role', async () => {
    const role = `ctp_p2_guard_${randomBytes(8).toString('hex')}`;
    const password = randomBytes(24).toString('hex');
    const administrator = stringField(
      (await rows(admin, 'SELECT current_user AS name'))[0],
      'name',
    );
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(administrator))
      throw new Error('Unexpected isolated administrator identifier');
    await rows(
      admin,
      `CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
    );
    try {
      await rows(admin, `GRANT ctp_api, "${administrator}" TO "${role}"`);
      const url = new URL(runtimeUrl);
      url.username = role;
      url.password = password;
      await expect(
        createDatabase({ connectionString: url.href, environment: 'test' }),
      ).rejects.toMatchObject({
        code: 'DATABASE_ROLE_UNSAFE',
        message: 'Database operation failed',
      });
    } finally {
      await rows(admin, `DROP ROLE "${role}"`);
    }
  });

  it('sanitizes callback errors, rolls back work and accepts a subsequent tenant transaction', async () => {
    const marker = randomUUID();
    await expect(
      db().withTenant(fixture.a, async (transaction) => {
        await transaction.outboxEvent.create({
          data: {
            tenantId: fixture.a,
            eventType: 'Test',
            schemaVersion: 1,
            aggregateType: 'Test',
            aggregateId: marker,
            aggregateVersion: 1n,
            payload: {},
            occurredAt: timestamp,
          },
        });
        throw new Error(`Sensitive callback detail ${randomBytes(12).toString('hex')}`);
      }),
    ).rejects.toMatchObject({
      name: 'DatabaseError',
      code: 'DATABASE_FAILED',
      message: 'Database operation failed',
    });
    expect(
      await rows(admin, 'SELECT id FROM outbox_event WHERE "aggregateId"=$1', [marker]),
    ).toEqual([]);
    await expect(db().withTenant('invalid-tenant', () => Promise.resolve(1))).rejects.toMatchObject(
      {
        code: 'TENANT_ID_INVALID',
      },
    );
    const visible = await db().withTenant(fixture.b, (transaction) =>
      transaction.user.findMany({ select: { id: true } }),
    );
    expect(visible).toEqual([{ id: fixture.b }]);
  });

  it('bounds a stalled SQL operation and releases its connection for later work', async () => {
    const started = performance.now();
    await expect(
      db().withTenant(fixture.a, (transaction) => transaction.$executeRaw`SELECT pg_sleep(20)`),
    ).rejects.toMatchObject({ message: 'Database operation failed' });
    expect(performance.now() - started).toBeLessThan(7000);
    expect(
      await db().withTenant(fixture.a, (transaction) =>
        transaction.user.findMany({ select: { id: true } }),
      ),
    ).toEqual([{ id: fixture.a }]);
  });

  it('coalesces concurrent close calls and refuses work after close', async () => {
    const isolated = await createDatabase({ connectionString: runtimeUrl, environment: 'test' });
    const first = isolated.close();
    const second = isolated.close();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    await isolated.close();
    await expect(isolated.withTenant(fixture.a, () => Promise.resolve(1))).rejects.toMatchObject({
      code: 'DATABASE_CLOSED',
    });
  });

  it('seeds stable disabled fixtures repeatedly and concurrently without overwriting customizations', async () => {
    await seedDevelopment(prisma);
    await seedDevelopment(prisma);
    await rows(
      admin,
      'UPDATE paper_account SET "initialCapital"=12345.6789,"slippageModel"=$2::jsonb WHERE id=$1',
      [developmentIds.paper, JSON.stringify({ fixture: true, customization: 'preserved' })],
    );
    await Promise.all([seedDevelopment(prisma), seedDevelopment(prisma)]);
    const users = await rows(admin, 'SELECT status,"passwordHash" FROM "user" WHERE id=$1', [
      developmentIds.user,
    ]);
    expect(users).toEqual([{ status: 'SUSPENDED', passwordHash: null }]);
    expect(
      await rows(admin, 'SELECT id,mode,status FROM exchange_account WHERE "tenantId"=$1', [
        developmentIds.user,
      ]),
    ).toEqual([{ id: developmentIds.account, mode: 'PAPER', status: 'DISABLED' }]);
    expect(
      await rows(
        admin,
        'SELECT id,"initialCapital"::text AS capital,"slippageModel" AS model FROM paper_account WHERE "tenantId"=$1',
        [developmentIds.user],
      ),
    ).toEqual([
      {
        id: developmentIds.paper,
        capital: '12345.6789',
        model: { fixture: true, customization: 'preserved' },
      },
    ]);
    expect(
      await rows(admin, 'SELECT id,active FROM instrument WHERE id=$1', [
        developmentIds.instrument,
      ]),
    ).toEqual([{ id: developmentIds.instrument, active: false }]);
    expect(
      await rows(admin, 'SELECT id FROM instrument_rule_version WHERE "instrumentId"=$1', [
        developmentIds.instrument,
      ]),
    ).toEqual([{ id: developmentIds.rule }]);
    for (const table of [
      'exchange_connection',
      'encrypted_credential',
      'live_grant',
      'user_session',
    ]) {
      // Only the fixed evidence-table allowlist above is interpolated as an identifier.
      expect(
        await rows(admin, `SELECT id FROM "${table}" WHERE "tenantId"=$1`, [developmentIds.user]),
      ).toEqual([]);
    }
    expect(await rows(admin, 'SELECT id FROM "user" WHERE id=$1', [fixture.a])).toEqual([
      { id: fixture.a },
    ]);
  });
});
