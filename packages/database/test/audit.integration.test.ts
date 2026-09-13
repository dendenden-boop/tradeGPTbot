import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const project = process.env['CTP_TEST_PROJECT'];
if (!project || !/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(project)) {
  throw new Error('Audit integration requires the isolated project runner');
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
  throw new Error('Audit connections must target the same disposable database');
}
const admin = new Pool({ connectionString: adminUrl, max: 2, query_timeout: 7000 });
const runtime = new Pool({ connectionString: runtimeUrl, max: 2, query_timeout: 7000 });
interface Account {
  id: string;
  mode: 'PAPER' | 'LIVE';
  connectionId: string | null;
}
const paperA: Account = { id: randomUUID(), mode: 'PAPER', connectionId: null };
const paperB: Account = { id: randomUUID(), mode: 'PAPER', connectionId: null };
const live: Account = { id: randomUUID(), mode: 'LIVE', connectionId: randomUUID() };
const fixture = {
  tenant: randomUUID(),
  instrument: randomUUID(),
  rule: randomUUID(),
  capability: randomUUID(),
};
const evidence = Buffer.alloc(32, 17);
let stateVersion = 0;

async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [fixture.tenant]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function expectScopeRejection(operation: () => Promise<unknown>): Promise<void> {
  await expect(operation()).rejects.toMatchObject({ code: '23503' });
}

type Operation = 'PLACE' | 'AMEND' | 'CANCEL';

async function intent(
  client: PoolClient,
  account: Account,
  operation: Operation = 'PLACE',
  targetOrderId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO order_intent
      (id,"tenantId","accountId",mode,"connectionId","instrumentId","ruleVersionId",
       origin,destination,operation,"idempotencyKey","commandHash",side,"orderType",
       "quantityAsset","priceAsset",quantity,"targetOrderId")
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,'USER',$8,$10::text,$1::text,$9,'BUY','MARKET','BTC','USDT',
       CASE WHEN $10::text='AMEND' THEN 2 ELSE 1 END,$11)`,
    [
      id,
      fixture.tenant,
      account.id,
      account.mode,
      account.connectionId,
      fixture.instrument,
      fixture.rule,
      account.mode === 'PAPER' ? 'PAPER_ENGINE' : 'EXCHANGE',
      evidence,
      operation,
      targetOrderId,
    ],
  );
  return id;
}

async function order(client: PoolClient, account: Account, intentId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "order"
      (id,"tenantId","intentId","accountId",mode,"connectionId","instrumentId","ruleVersionId",
       "clientIdNamespace","clientId",market,side,"orderType","quantityAsset","priceAsset",quantity,"updatedAt")
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,'audit',$1::text,'SPOT','BUY','MARKET','BTC','USDT',1,now())`,
    [
      id,
      fixture.tenant,
      intentId,
      account.id,
      account.mode,
      account.connectionId,
      fixture.instrument,
      fixture.rule,
    ],
  );
  return id;
}

async function fill(client: PoolClient, account: Account, orderId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO fill
      (id,"tenantId","orderId","accountId",mode,"instrumentId","ruleVersionId",market,
       "executionIdentity",side,"baseAsset","quoteAsset",quantity,price,"quoteAmount",timestamp,"receivedAt","evidenceHash")
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,'SPOT',$1::text,'BUY','BTC','USDT',1,100,100,now(),now(),$8)`,
    [
      id,
      fixture.tenant,
      orderId,
      account.id,
      account.mode,
      fixture.instrument,
      fixture.rule,
      evidence,
    ],
  );
  return id;
}

async function posting(client: PoolClient, account: Account): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO ledger_transaction
      (id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode")
     VALUES ($1::uuid,$2,$3,$4,'ADJUSTMENT',$1::text,now(),'audit-fixture')`,
    [id, fixture.tenant, account.id, account.mode],
  );
  await client.query(
    `INSERT INTO ledger_entry ("tenantId","transactionId","accountId",mode,"entryIndex",asset,bucket,amount)
     VALUES ($1,$2,$3,$4,0,'USDT','EQUITY',1),($1,$2,$3,$4,1,'USDT','FEE',-1)`,
    [fixture.tenant, id, account.id, account.mode],
  );
  return id;
}

async function fee(client: PoolClient, fillId: string, ledgerId: string | null): Promise<void> {
  await client.query(
    `INSERT INTO fee ("tenantId","fillId","ledgerTransactionId","feeIdentity",asset,kind,amount,timestamp,"accountId",mode)
     SELECT $1,$2,$3,$4,'USDT','CHARGE',1,now(),"accountId",mode FROM fill WHERE "tenantId"=$1 AND id=$2`,
    [fixture.tenant, fillId, ledgerId, randomUUID()],
  );
}

async function reservation(
  client: PoolClient,
  account: Account,
  intentId: string,
): Promise<string> {
  const profileId = randomUUID();
  const stateId = randomUUID();
  const decisionId = randomUUID();
  const budgetId = randomUUID();
  const reservationId = randomUUID();
  await client.query(
    `INSERT INTO risk_profile (id,"tenantId",name,version,"policyHash","valuationAsset",
       "maxNotional","maxDailyLoss","maxDrawdownRate","maxOpenOrders",policy,"effectiveAt")
     VALUES ($1::uuid,$2,$1::text,1,$3,'USDT',1000,100,0.2,5,'{}',now())`,
    [profileId, fixture.tenant, evidence],
  );
  await client.query(
    `INSERT INTO account_state_version (id,"tenantId","accountId",mode,version,"sourceCursor",
       "sourceAt","receivedAt","reconciliationEpoch","stateHash")
     VALUES ($1::uuid,$2,$3,$4,$6,$1::text,now(),now(),0,$5)`,
    [stateId, fixture.tenant, account.id, account.mode, evidence, ++stateVersion],
  );
  await client.query(
    `INSERT INTO risk_decision (id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId",
       "ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","reasonCodes","permissionEpoch","expiresAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'APPROVE',1,$10,ARRAY['FIXTURE'],0,now()+interval '1 hour')`,
    [
      decisionId,
      fixture.tenant,
      intentId,
      account.id,
      account.mode,
      profileId,
      stateId,
      fixture.rule,
      fixture.capability,
      evidence,
    ],
  );
  await client.query(
    `INSERT INTO risk_budget (id,"tenantId","accountId","profileId",mode,scope,"scopeKey",asset,
       "windowStart","windowEnd","limitAmount","updatedAt")
     VALUES ($1::uuid,$2,$3,$4,$5,'ACCOUNT',$1::text,'USDT',now(),now()+interval '1 day',1000,now())`,
    [budgetId, fixture.tenant, account.id, profileId, account.mode],
  );
  await client.query(
    `INSERT INTO risk_reservation (id,"tenantId","decisionId","intentId","accountId",mode,
       "budgetId",asset,amount,"expiresAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,'USDT',100,now()+interval '1 hour',now())`,
    [reservationId, fixture.tenant, decisionId, intentId, account.id, account.mode, budgetId],
  );
  return reservationId;
}

async function attempt(
  client: PoolClient,
  orderId: string,
  reservationId: string | null,
  command?: { intentId: string; operation: Operation; hash?: Buffer },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO submission_attempt (id,"tenantId","orderId","operationVersion",operation,
       "permissionEpoch","reservationId","workerId","commandHash","permitConsumedAt","deadlineAt",
       "intentId","accountId",mode,"instrumentId")
     SELECT $5,$1,$2,CASE WHEN $6='PLACE' THEN 1 WHEN $6='AMEND' THEN 2 ELSE 3 END,
       $6::"SubmissionOperation",0,$3,'audit-fixture',$4,now(),now()+interval '1 minute',
       COALESCE($7::uuid,"intentId"),"accountId",mode,"instrumentId"
       FROM "order" WHERE "tenantId"=$1 AND id=$2`,
    [
      fixture.tenant,
      orderId,
      reservationId,
      command?.hash ?? evidence,
      id,
      command?.operation ?? 'PLACE',
      command?.intentId ?? null,
    ],
  );
  return id;
}

async function committedAttempt(): Promise<string> {
  return transaction(async (client) => {
    const intentId = await intent(client, paperA);
    const orderId = await order(client, paperA, intentId);
    return attempt(client, orderId, await reservation(client, paperA, intentId));
  });
}

async function committedOrder(): Promise<string> {
  return transaction(async (client) => order(client, paperA, await intent(client, paperA)));
}

async function committedEvent(): Promise<string> {
  return transaction(async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO outbox_event
       (id,"tenantId","eventType","schemaVersion","aggregateType","aggregateId",
        "aggregateVersion",payload,"occurredAt")
       VALUES ($1,$2,'AuditFixture',1,'OrderIntent',$3,1,'{"fixture":true}',now())`,
      [id, fixture.tenant, randomUUID()],
    );
    return id;
  });
}

async function committedReceipt(): Promise<string> {
  const eventId = await committedEvent();
  return transaction(async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO consumer_inbox
       (id,"tenantId",consumer,"eventId","eventType","schemaVersion","payloadHash","retainUntil")
       VALUES ($1,$2,'audit-fixture',$3,'AuditFixture',1,$4,'2030-01-01T00:00:00Z')`,
      [id, fixture.tenant, eventId, evidence],
    );
    return id;
  });
}

beforeAll(async () => {
  await admin.query(`INSERT INTO "user" (id,"emailNormalized","updatedAt") VALUES ($1,$2,now())`, [
    fixture.tenant,
    `${fixture.tenant}@example.invalid`,
  ]);
  for (const account of [paperA, paperB, live]) {
    await admin.query(
      `INSERT INTO exchange_account (id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt")
       VALUES ($1::uuid,$2,'BINANCE',$3,$1::text,'development','SIMULATED','DISABLED','audit',now())`,
      [account.id, fixture.tenant, account.mode],
    );
  }
  await admin.query(
    `INSERT INTO exchange_connection (id,"tenantId","accountId",mode,label,permissions,"updatedAt")
     VALUES ($1,$2,$3,'LIVE','disabled-audit-fixture','{}',now())`,
    [live.connectionId, fixture.tenant, live.id],
  );
  await admin.query(
    `INSERT INTO instrument (id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset","updatedAt")
     VALUES ($1::uuid,'BINANCE','SPOT','LIVE',$1::text,'BTC','USDT',now())`,
    [fixture.instrument],
  );
  await admin.query(
    `INSERT INTO instrument_rule_version (id,"instrumentId",version,"effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity",rules)
     VALUES ($1,$2,1,now(),now(),$3,0.01,0.001,0.001,'{"fixture":true}')`,
    [fixture.rule, fixture.instrument, evidence],
  );
  await admin.query(
    `INSERT INTO capability_snapshot (id,exchange,market,mode,region,"accountMode",version,"profileVersion","verifiedAt","expiresAt",capabilities,"evidenceHash")
     VALUES ($1,'BINANCE','SPOT','LIVE','development','SIMULATED',1,'audit',now(),now()+interval '1 hour','{}',$2)`,
    [fixture.capability, evidence],
  );
});

afterAll(async () => {
  const results = await Promise.allSettled([runtime.end(), admin.end()]);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
});

describe('audit regression: financial evidence parent scope', () => {
  it('accepts a fee linked to its fill and ledger in the same account and mode', async () => {
    await transaction(async (client) => {
      const intentId = await intent(client, paperA);
      const fillId = await fill(client, paperA, await order(client, paperA, intentId));
      await fee(client, fillId, await posting(client, paperA));
    });
  });

  it('accepts fee evidence without an optional ledger link', async () => {
    await transaction(async (client) => {
      const intentId = await intent(client, paperA);
      const fillId = await fill(client, paperA, await order(client, paperA, intentId));
      await fee(client, fillId, null);
      const result = await client.query(
        'SELECT "accountId",mode,"ledgerTransactionId" FROM fee WHERE "fillId"=$1',
        [fillId],
      );
      expect(result.rows).toEqual([
        { accountId: paperA.id, mode: 'PAPER', ledgerTransactionId: null },
      ]);
    });
  });

  it.each([
    { name: 'another account', account: paperB },
    { name: 'another trading mode', account: live },
  ])('rejects a fee linked to a ledger from $name', async ({ account }) => {
    await expectScopeRejection(() =>
      transaction(async (client) => {
        const intentId = await intent(client, paperA);
        const fillId = await fill(client, paperA, await order(client, paperA, intentId));
        await fee(client, fillId, await posting(client, account));
      }),
    );
  });

  it('accepts a submission attempt backed by its own intent reservation', async () => {
    await transaction(async (client) => {
      const intentId = await intent(client, paperA);
      const orderId = await order(client, paperA, intentId);
      await attempt(client, orderId, await reservation(client, paperA, intentId));
    });
  });

  it('accepts an amendment with its own command and reservation on the existing order', async () => {
    await transaction(async (client) => {
      const placementId = await intent(client, paperA);
      const orderId = await order(client, paperA, placementId);
      await attempt(client, orderId, await reservation(client, paperA, placementId));
      const amendmentId = await intent(client, paperA, 'AMEND', orderId);
      const reservationId = await reservation(client, paperA, amendmentId);
      const attemptId = await attempt(client, orderId, reservationId, {
        intentId: amendmentId,
        operation: 'AMEND',
      });
      const result = await client.query(
        `SELECT a."intentId",a."reservationId",a."orderId",a.operation,
          o."intentId" AS "placementId",command.quantity::text AS quantity
         FROM submission_attempt a JOIN "order" o ON o.id=a."orderId"
         JOIN order_intent command ON command.id=a."intentId" WHERE a.id=$1`,
        [attemptId],
      );
      expect(result.rows).toEqual([
        {
          intentId: amendmentId,
          reservationId,
          orderId,
          operation: 'AMEND',
          placementId,
          quantity: '2',
        },
      ]);
    });
  });

  it('accepts a cancel command targeting the existing order without a reservation', async () => {
    await transaction(async (client) => {
      const orderId = await order(client, paperA, await intent(client, paperA));
      const cancelId = await intent(client, paperA, 'CANCEL', orderId);
      const attemptId = await attempt(client, orderId, null, {
        intentId: cancelId,
        operation: 'CANCEL',
      });
      const result = await client.query(
        'SELECT "intentId",operation,"reservationId" FROM submission_attempt WHERE id=$1',
        [attemptId],
      );
      expect(result.rows).toEqual([
        { intentId: cancelId, operation: 'CANCEL', reservationId: null },
      ]);
    });
  });

  it('rejects an amendment targeting another order in the same account', async () => {
    await expectScopeRejection(() =>
      transaction(async (client) => {
        const orderId = await order(client, paperA, await intent(client, paperA));
        const otherOrderId = await order(client, paperA, await intent(client, paperA));
        const amendmentId = await intent(client, paperA, 'AMEND', otherOrderId);
        await attempt(client, orderId, await reservation(client, paperA, amendmentId), {
          intentId: amendmentId,
          operation: 'AMEND',
        });
      }),
    );
  });

  it('rejects an operation different from its immutable command', async () => {
    await expectScopeRejection(() =>
      transaction(async (client) => {
        const orderId = await order(client, paperA, await intent(client, paperA));
        const amendmentId = await intent(client, paperA, 'AMEND', orderId);
        await attempt(client, orderId, null, { intentId: amendmentId, operation: 'CANCEL' });
      }),
    );
  });

  it('rejects another placement command even when its reservation matches the account', async () => {
    await expectScopeRejection(() =>
      transaction(async (client) => {
        const orderId = await order(client, paperA, await intent(client, paperA));
        const unrelatedId = await intent(client, paperA);
        await attempt(client, orderId, await reservation(client, paperA, unrelatedId), {
          intentId: unrelatedId,
          operation: 'PLACE',
        });
      }),
    );
  });

  it('rejects a dispatch hash different from its immutable command', async () => {
    await expectScopeRejection(() =>
      transaction(async (client) => {
        const intentId = await intent(client, paperA);
        const orderId = await order(client, paperA, intentId);
        await attempt(client, orderId, await reservation(client, paperA, intentId), {
          intentId,
          operation: 'PLACE',
          hash: Buffer.alloc(32, 18),
        });
      }),
    );
  });

  it('rejects an operation command targeting another account', async () => {
    await expectScopeRejection(() =>
      transaction(async (client) => {
        const otherOrderId = await order(client, paperB, await intent(client, paperB));
        await intent(client, paperA, 'AMEND', otherOrderId);
      }),
    );
  });

  it.each(['AMEND', 'CANCEL'] as const)(
    'requires an explicit target for %s commands',
    async (operation) => {
      await expect(
        transaction((client) => intent(client, paperA, operation)),
      ).rejects.toMatchObject({
        code: '23514',
      });
    },
  );

  it.each([
    { name: 'another intent in the same account', account: paperA },
    { name: 'another account', account: paperB },
    { name: 'another trading mode', account: live },
  ])('rejects a submission attempt backed by a reservation for $name', async ({ account }) => {
    await expectScopeRejection(() =>
      transaction(async (client) => {
        const intentId = await intent(client, paperA);
        const orderId = await order(client, paperA, intentId);
        const otherIntentId = await intent(client, account);
        await attempt(client, orderId, await reservation(client, account, otherIntentId));
      }),
    );
  });
});

describe('audit regression: durable delivery and dispatch identities', () => {
  it.each([
    { name: 'client identity', sql: `UPDATE "order" SET "clientId"='replacement' WHERE id=$1` },
    {
      name: 'client namespace',
      sql: `UPDATE "order" SET "clientIdNamespace"='replacement' WHERE id=$1`,
    },
    { name: 'delete for intent identity reuse', sql: 'DELETE FROM "order" WHERE id=$1' },
  ])('rejects changing committed order $name', async ({ sql }) => {
    const id = await committedOrder();
    await expect(transaction((client) => client.query(sql, [id]))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it.each([
    { name: 'replacement', value: 'replacement' },
    { name: 'clearing', value: null },
  ])('rejects $name of an assigned exchange order identity', async ({ value }) => {
    const id = await committedOrder();
    await transaction((client) =>
      client.query(`UPDATE "order" SET "exchangeOrderId"=$1 WHERE id=$2`, [randomUUID(), id]),
    );
    await expect(
      transaction((client) =>
        client.query(`UPDATE "order" SET "exchangeOrderId"=$1 WHERE id=$2`, [value, id]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows order identity first assignment, current amendments and lifecycle progression', async () => {
    const id = await committedOrder();
    const externalId = randomUUID();
    await transaction(async (client) => {
      const amended = await client.query(
        `UPDATE "order" SET quantity=2,"limitPrice"=100,"orderType"='LIMIT',version=version+1,"updatedAt"=now()
         WHERE id=$1 RETURNING quantity::text AS quantity,"limitPrice"::text AS price`,
        [id],
      );
      expect(amended.rows).toEqual([{ quantity: '2', price: '100' }]);
      const result = await client.query(
        `UPDATE "order" SET "exchangeOrderId"=$2,status='FILLED',"filledQuantity"=quantity,
         "averageFillPrice"=100,version=version+1,"lastExchangeAt"=now(),"terminalAt"=now(),"updatedAt"=now()
         WHERE id=$1 RETURNING status,"isActive","exchangeOrderId"`,
        [id, externalId],
      );
      expect(result.rows).toEqual([
        { status: 'FILLED', isActive: false, exchangeOrderId: externalId },
      ]);
    });
  });

  it.each([
    {
      name: 'command hash',
      sql: `UPDATE submission_attempt SET "commandHash"=decode(repeat('22',32),'hex') WHERE id=$1`,
    },
    {
      name: 'operation version',
      sql: `UPDATE submission_attempt SET "operationVersion"=2 WHERE id=$1`,
    },
    {
      name: 'reservation evidence',
      sql: `UPDATE submission_attempt SET "reservationId"=NULL WHERE id=$1`,
    },
    {
      name: 'delete for dispatch identity reuse',
      sql: 'DELETE FROM submission_attempt WHERE id=$1',
    },
  ])('rejects changing committed attempt $name', async ({ sql }) => {
    const id = await committedAttempt();
    await expect(transaction((client) => client.query(sql, [id]))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('allows response and reconciliation lifecycle updates on a committed attempt', async () => {
    const id = await committedAttempt();
    await transaction(async (client) => {
      const result = await client.query(
        `UPDATE submission_attempt SET status='RECONCILED',"transportStartedAt"=now(),
         "responseReceivedAt"=now(),"resolvedAt"=now(),"responseCode"='FIXTURE',"evidenceHash"=$2
         WHERE id=$1 RETURNING status`,
        [id, evidence],
      );
      expect(result.rows).toEqual([{ status: 'RECONCILED' }]);
    });
  });

  it.each([
    { name: 'payload', sql: `UPDATE outbox_event SET payload='{"fixture":false}' WHERE id=$1` },
    { name: 'aggregate version', sql: `UPDATE outbox_event SET "aggregateVersion"=2 WHERE id=$1` },
    { name: 'delete before delivery', sql: 'DELETE FROM outbox_event WHERE id=$1' },
  ])('rejects changing committed outbox $name', async ({ sql }) => {
    const id = await committedEvent();
    await expect(transaction((client) => client.query(sql, [id]))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('allows outbox claim, retry and delivery lifecycle updates', async () => {
    const id = await committedEvent();
    await transaction(async (client) => {
      const result = await client.query(
        `UPDATE outbox_event SET "availableAt"=now(),attempts=1,"claimedBy"='audit-fixture',
         "claimExpiresAt"=now()+interval '1 minute',"deliveredAt"=now(),"lastErrorCode"='FIXTURE'
         WHERE id=$1 RETURNING attempts`,
        [id],
      );
      expect(result.rows).toEqual([{ attempts: 1 }]);
    });
  });

  it.each([
    {
      name: 'consumer identity',
      sql: `UPDATE consumer_inbox SET consumer='other-consumer' WHERE id=$1`,
    },
    {
      name: 'payload hash',
      sql: `UPDATE consumer_inbox SET "payloadHash"=decode(repeat('22',32),'hex') WHERE id=$1`,
    },
    {
      name: 'shorter retention horizon',
      sql: `UPDATE consumer_inbox SET "retainUntil"='2029-01-01T00:00:00Z' WHERE id=$1`,
    },
    { name: 'delete for dedup identity reuse', sql: 'DELETE FROM consumer_inbox WHERE id=$1' },
  ])('rejects changing committed inbox $name', async ({ sql }) => {
    const id = await committedReceipt();
    await expect(transaction((client) => client.query(sql, [id]))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('allows extending an inbox replay retention horizon', async () => {
    const id = await committedReceipt();
    await transaction(async (client) => {
      const result = await client.query(
        `UPDATE consumer_inbox SET "retainUntil"='2031-01-01T00:00:00Z'
         WHERE id=$1 RETURNING extract(year FROM "retainUntil")::int AS year`,
        [id],
      );
      expect(result.rows).toEqual([{ year: 2031 }]);
    });
  });
});
