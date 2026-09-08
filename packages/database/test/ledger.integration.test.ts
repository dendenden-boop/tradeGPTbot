import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const project = process.env['CTP_TEST_PROJECT'];
if (!project || !/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(project)) {
  throw new Error('Ledger integration requires the isolated project runner');
}

function requiredUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing isolated runner variable: ${name}`);
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/ctp_p2_fresh_[a-f0-9]+$/u.test(url.pathname)
  ) {
    throw new Error('Expected an isolated disposable PostgreSQL database');
  }
  return value;
}

const adminUrl = requiredUrl('DATABASE_MIGRATION_URL');
const runtimeUrl = requiredUrl('DATABASE_RUNTIME_URL');
if (new URL(adminUrl).pathname !== new URL(runtimeUrl).pathname) {
  throw new Error('Ledger integration connections must target the same disposable database');
}
const admin = new Pool({ connectionString: adminUrl, max: 3, query_timeout: 7000 });
const runtime = new Pool({ connectionString: runtimeUrl, max: 3, query_timeout: 7000 });
const fixture = { tenant: randomUUID(), otherTenant: randomUUID(), account: randomUUID() };

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  tenantId: string | null = fixture.tenant,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
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

async function expectSqlFailure(operation: () => Promise<unknown>, codes = ['23514']) {
  const result = await operation().then(
    () => ({ succeeded: true as const }),
    (error: unknown) => ({
      succeeded: false as const,
      code: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
    }),
  );
  expect(result.succeeded).toBe(false);
  if (!result.succeeded) expect(codes).toContain(result.code);
}

async function header(client: PoolClient, id = randomUUID()): Promise<string> {
  await client.query(
    `INSERT INTO ledger_transaction
       (id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode")
     VALUES ($1::uuid,$2,$3,'PAPER','ADJUSTMENT',$1::text,now(),'integration-fixture')`,
    [id, fixture.tenant, fixture.account],
  );
  return id;
}

interface Entry {
  asset: string;
  amount: string;
}

async function entries(client: PoolClient, id: string, values: readonly Entry[], offset = 0) {
  for (const [index, entry] of values.entries()) {
    await client.query(
      `INSERT INTO ledger_entry
         ("tenantId","transactionId","accountId",mode,"entryIndex",asset,bucket,amount)
       VALUES ($1,$2,$3,'PAPER',$4,$5,'EQUITY',$6::numeric)`,
      [fixture.tenant, id, fixture.account, index + offset, entry.asset, entry.amount],
    );
  }
}

const balanced: readonly Entry[] = [
  { asset: 'USDT', amount: '12.34567890123456789' },
  { asset: 'USDT', amount: '-12.34567890123456789' },
];

async function posting(values: readonly Entry[] = balanced): Promise<string> {
  return transaction(runtime, async (client) => {
    const id = await header(client);
    await entries(client, id, values);
    return id;
  });
}

beforeAll(async () => {
  await admin.query(
    `INSERT INTO "user" (id,"emailNormalized","updatedAt") VALUES
       ($1,$3,now()),($2,$4,now())`,
    [
      fixture.tenant,
      fixture.otherTenant,
      `${fixture.tenant}@example.invalid`,
      `${fixture.otherTenant}@example.invalid`,
    ],
  );
  await admin.query(
    `INSERT INTO exchange_account
       (id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,
        "clientIdEpoch","updatedAt")
     VALUES ($1::uuid,$2,'BINANCE','PAPER',$1::text,'development','SIMULATED','DISABLED',
       'ledger-fixture',now())`,
    [fixture.account, fixture.tenant],
  );
});

afterAll(async () => {
  const results = await Promise.allSettled([runtime.end(), admin.end()]);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
});

describe('atomic immutable ledger postings', () => {
  it('commits exact amounts only when each asset independently conserves value', async () => {
    const id = await posting([
      ...balanced,
      { asset: 'BTC', amount: '0.000000000000000001' },
      { asset: 'BTC', amount: '-0.000000000000000001' },
    ]);
    const result = await transaction(runtime, (client) =>
      client.query<{ asset: string; sum: string; count: string }>(
        `SELECT asset,sum(amount)::text,count(*)::text FROM ledger_entry
         WHERE "transactionId"=$1 GROUP BY asset ORDER BY asset`,
        [id],
      ),
    );
    expect(result.rows).toEqual([
      { asset: 'BTC', sum: '0.000000000000000000', count: '2' },
      { asset: 'USDT', sum: '0.00000000000000000', count: '2' },
    ]);
    const seal = await admin.query<{ count: string }>(
      `SELECT count(*)::text FROM ctp_internal.ledger_seal WHERE "transactionId"=$1`,
      [id],
    );
    expect(seal.rows).toEqual([{ count: '1' }]);
  });

  it.each([
    { name: 'empty header', values: [] },
    { name: 'one zero entry', values: [{ asset: 'USDT', amount: '0' }] },
    {
      name: 'unbalanced amount',
      values: [
        { asset: 'USDT', amount: '5' },
        { asset: 'USDT', amount: '-4.999999999999999999' },
      ],
    },
    {
      name: 'cross-asset cancellation',
      values: [
        { asset: 'USDT', amount: '5' },
        { asset: 'BTC', amount: '-5' },
      ],
    },
    {
      name: 'a single zero entry for an additional asset',
      values: [...balanced, { asset: 'BTC', amount: '0' }],
    },
  ])('rolls back the entire posting at commit: $name', async ({ values }) => {
    const id = randomUUID();
    await expectSqlFailure(() =>
      transaction(runtime, async (client) => {
        await header(client, id);
        await entries(client, id, values);
      }),
    );
    const persisted = await admin.query<{ count: string }>(
      `SELECT count(*)::text FROM ledger_transaction WHERE id=$1`,
      [id],
    );
    expect(persisted.rows).toEqual([{ count: '0' }]);
  });

  it('rejects even balanced late additions to a committed posting', async () => {
    const id = await posting();
    await expectSqlFailure(() =>
      transaction(runtime, (client) => entries(client, id, balanced, 2)),
    );
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text FROM ledger_entry WHERE "transactionId"=$1`,
      [id],
    );
    expect(result.rows).toEqual([{ count: '2' }]);
  });

  it('enforces immutable headers and entries even for the table owner', async () => {
    const id = await posting();
    for (const statement of [
      `UPDATE ledger_transaction SET "descriptionCode"='changed' WHERE id=$1`,
      `DELETE FROM ledger_transaction WHERE id=$1`,
      `UPDATE ledger_entry SET amount=amount+1 WHERE "transactionId"=$1`,
      `DELETE FROM ledger_entry WHERE "transactionId"=$1`,
    ]) {
      await expectSqlFailure(() => transaction(admin, (client) => client.query(statement, [id])));
    }
  });

  it('seals a completed posting when deferred constraints are made immediate', async () => {
    await transaction(runtime, async (client) => {
      const id = await header(client);
      await entries(client, id, balanced);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    await expectSqlFailure(() =>
      transaction(runtime, async (client) => {
        const id = await header(client);
        await entries(client, id, balanced);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        await entries(client, id, balanced, 2);
      }),
    );
  });

  it('fails closed when immediate constraints encounter an incomplete posting', async () => {
    await expectSqlFailure(() =>
      transaction(runtime, async (client) => {
        await header(client);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      }),
    );
    await expectSqlFailure(() =>
      transaction(runtime, async (client) => {
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        await header(client);
      }),
    );
  });

  it('rejects concurrent late writers without changing the posting', async () => {
    const id = await posting();
    await Promise.all([
      expectSqlFailure(() => transaction(runtime, (client) => entries(client, id, balanced, 2))),
      expectSqlFailure(() => transaction(runtime, (client) => entries(client, id, balanced, 4))),
    ]);
  });

  it('rejects a repeatable-read writer whose snapshot predates another posting commit', async () => {
    const stale = await runtime.connect();
    try {
      await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await stale.query("SELECT set_config('app.tenant_id',$1,true)", [fixture.tenant]);
      await stale.query('SELECT count(*) FROM ledger_transaction');
      const id = await posting();
      await expectSqlFailure(() => entries(stale, id, balanced, 2), ['23503', '23514', '40001']);
    } finally {
      await stale.query('ROLLBACK');
      stale.release();
    }
  });

  it('requires matching tenant context inside privileged trigger execution', async () => {
    for (const tenant of [null, fixture.otherTenant]) {
      await expectSqlFailure(
        () =>
          transaction(
            admin,
            async (client) => {
              const id = await header(client);
              await entries(client, id, balanced);
            },
            tenant,
          ),
        ['42501'],
      );
    }
  });

  it('keeps internal enforcement metadata and trigger entry points inaccessible to runtime', async () => {
    await expectSqlFailure(
      () => runtime.query('SELECT * FROM ctp_internal.ledger_seal'),
      ['42501'],
    );
    const result = await runtime.query<{ usable: boolean; guard: boolean; seal: boolean }>(
      `SELECT has_schema_privilege(current_user,'ctp_internal','USAGE') AS usable,
        (SELECT has_function_privilege(current_user,p.oid,'EXECUTE') FROM pg_proc p
         JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='ctp_internal' AND p.proname='ledger_entry_guard') AS guard,
        (SELECT has_function_privilege(current_user,p.oid,'EXECUTE') FROM pg_proc p
         JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='ctp_internal' AND p.proname='ledger_validate_and_seal') AS seal`,
    );
    expect(result.rows).toEqual([{ usable: false, guard: false, seal: false }]);
  });
});

describe('immutable request identities and signed balances', () => {
  it('preserves the original idempotency identity while allowing result completion', async () => {
    const id = randomUUID();
    await transaction(runtime, (client) =>
      client.query(
        `INSERT INTO idempotency_record
          (id,"tenantId",operation,"idempotencyKey","requestHash","retainUntil")
         VALUES ($1::uuid,$2,'ledger-fixture',$1::text,$3,'2030-01-01T00:00:00Z')`,
        [id, fixture.tenant, randomBytes(32)],
      ),
    );
    for (const assignment of [
      'id=gen_random_uuid()',
      '"tenantId"=gen_random_uuid()',
      "operation='changed'",
      '"idempotencyKey"=gen_random_uuid()::text',
      "\"requestHash\"=decode(repeat('00',32),'hex')",
      '"createdAt"="createdAt"+interval \'1 second\'',
    ]) {
      await expectSqlFailure(() =>
        transaction(runtime, (client) =>
          client.query(`UPDATE idempotency_record SET ${assignment} WHERE id=$1`, [id]),
        ),
      );
    }
    const completed = await transaction(runtime, (client) =>
      client.query<{ responseCode: number; done: boolean }>(
        `UPDATE idempotency_record SET "responseCode"=202,"responseResourceId"=$2,"completedAt"=now()
         WHERE id=$1 RETURNING "responseCode","completedAt" IS NOT NULL AS done`,
        [id, randomUUID()],
      ),
    );
    expect(completed.rows).toEqual([{ responseCode: 202, done: true }]);
    await expectSqlFailure(() =>
      transaction(runtime, (client) =>
        client.query('DELETE FROM idempotency_record WHERE id=$1', [id]),
      ),
    );
  });

  it('stores negative margin balances without comparing them to nonnegative reservations', async () => {
    const stateId = randomUUID();
    const result = await transaction(runtime, async (client) => {
      await client.query(
        `INSERT INTO account_state_version
          (id,"tenantId","accountId",mode,version,"sourceCursor","sourceAt","receivedAt",
           "reconciliationEpoch","stateHash")
         VALUES ($1,$2,$3,'PAPER',1,'ledger-fixture',now(),now(),0,$4)`,
        [stateId, fixture.tenant, fixture.account, randomBytes(32)],
      );
      return client.query<{ total: string; available: string; reserved: string; borrowed: string }>(
        `INSERT INTO balance_snapshot
          ("tenantId","accountId",mode,"stateVersionId",asset,total,available,reserved,borrowed,
           "sourceAt","receivedAt")
         VALUES ($1,$2,'PAPER',$3,'USDT',-20,-15,5,20,now(),now())
         RETURNING total::text,available::text,reserved::text,borrowed::text`,
        [fixture.tenant, fixture.account, stateId],
      );
    });
    expect(result.rows).toEqual([
      { total: '-20', available: '-15', reserved: '5', borrowed: '20' },
    ]);
  });
});
