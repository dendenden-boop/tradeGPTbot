import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Called only by the owned disposable database runner, after migration 002.
// The committed fixture proves backfill; invalid legacy fixtures always roll back.
async function legacyFixture(client, invalid) {
  const ids = Object.fromEntries(
    [
      'tenant',
      'account',
      'otherAccount',
      'instrument',
      'rule',
      'intent',
      'otherIntent',
      'order',
      'fill',
      'ledger',
      'fee',
      'profile',
      'state',
      'capability',
      'decision',
      'budget',
      'reservation',
      'attempt',
    ].map((key) => [key, randomUUID()]),
  );
  const hash = Buffer.alloc(32, 31);
  await client.query('INSERT INTO "user" (id,"updatedAt") VALUES ($1,now())', [ids.tenant]);
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [ids.tenant]);
  for (const account of [ids.account, ids.otherAccount]) {
    await client.query(
      `INSERT INTO exchange_account
      (id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode","clientIdEpoch","updatedAt")
      VALUES ($1::uuid,$2,'BINANCE','PAPER',$1::text,'development','SIMULATED','upgrade-audit',now())`,
      [account, ids.tenant],
    );
  }
  await client.query(
    `INSERT INTO instrument
    (id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset","updatedAt")
    VALUES ($1::uuid,'BINANCE','SPOT','LIVE',$1::text,'BTC','USDT',now())`,
    [ids.instrument],
  );
  await client.query(
    `INSERT INTO instrument_rule_version
    (id,"instrumentId",version,"effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity",rules)
    VALUES ($1,$2,1,now(),now(),$3,0.01,0.001,0.001,'{}')`,
    [ids.rule, ids.instrument, hash],
  );
  for (const intent of [ids.intent, ids.otherIntent]) {
    await client.query(
      `INSERT INTO order_intent
      (id,"tenantId","accountId",mode,"instrumentId","ruleVersionId",origin,destination,operation,
       "idempotencyKey","commandHash",side,"orderType","quantityAsset","priceAsset",quantity)
      VALUES ($1::uuid,$2,$3,'PAPER',$4,$5,'USER','PAPER_ENGINE','PLACE',$1::text,$6,'BUY','MARKET','BTC','USDT',1)`,
      [intent, ids.tenant, ids.account, ids.instrument, ids.rule, hash],
    );
  }
  await client.query(
    `INSERT INTO "order"
    (id,"tenantId","intentId","accountId",mode,"instrumentId","ruleVersionId","clientIdNamespace","clientId",
     market,side,"orderType","quantityAsset","priceAsset",quantity,"updatedAt")
    VALUES ($1::uuid,$2,$3,$4,'PAPER',$5,$6,'upgrade-audit',$1::text,'SPOT','BUY','MARKET','BTC','USDT',1,now())`,
    [ids.order, ids.tenant, ids.intent, ids.account, ids.instrument, ids.rule],
  );
  await client.query(
    `INSERT INTO fill
    (id,"tenantId","orderId","accountId",mode,"instrumentId","ruleVersionId",market,"executionIdentity",
     side,"baseAsset","quoteAsset",quantity,price,"quoteAmount",timestamp,"receivedAt","evidenceHash")
    VALUES ($1::uuid,$2,$3,$4,'PAPER',$5,$6,'SPOT',$1::text,'BUY','BTC','USDT',1,100,100,now(),now(),$7)`,
    [ids.fill, ids.tenant, ids.order, ids.account, ids.instrument, ids.rule, hash],
  );
  const ledgerAccount = invalid === 'fee' ? ids.otherAccount : ids.account;
  await client.query(
    `INSERT INTO ledger_transaction
    (id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode")
    VALUES ($1::uuid,$2,$3,'PAPER','ADJUSTMENT',$1::text,now(),'upgrade-audit')`,
    [ids.ledger, ids.tenant, ledgerAccount],
  );
  await client.query(
    `INSERT INTO ledger_entry
    ("tenantId","transactionId","accountId",mode,"entryIndex",asset,bucket,amount)
    VALUES ($1,$2,$3,'PAPER',0,'USDT','EQUITY',1),($1,$2,$3,'PAPER',1,'USDT','FEE',-1)`,
    [ids.tenant, ids.ledger, ledgerAccount],
  );
  await client.query(
    `INSERT INTO fee
    (id,"tenantId","fillId","ledgerTransactionId","feeIdentity",asset,kind,amount,timestamp)
    VALUES ($1::uuid,$2,$3,$4,$1::text,'USDT','CHARGE',1,now())`,
    [ids.fee, ids.tenant, ids.fill, ids.ledger],
  );
  await client.query(
    `INSERT INTO risk_profile
    (id,"tenantId",name,version,"policyHash","valuationAsset","maxNotional","maxDailyLoss","maxDrawdownRate","maxOpenOrders",policy,"effectiveAt")
    VALUES ($1::uuid,$2,$1::text,1,$3,'USDT',1000,100,0.2,5,'{}',now())`,
    [ids.profile, ids.tenant, hash],
  );
  await client.query(
    `INSERT INTO account_state_version
    (id,"tenantId","accountId",mode,version,"sourceCursor","sourceAt","receivedAt","reconciliationEpoch","stateHash")
    VALUES ($1::uuid,$2,$3,'PAPER',1,$1::text,now(),now(),0,$4)`,
    [ids.state, ids.tenant, ids.account, hash],
  );
  await client.query(
    `INSERT INTO capability_snapshot
    (id,exchange,market,mode,region,"accountMode",version,"profileVersion","verifiedAt","expiresAt",capabilities,"evidenceHash")
    VALUES ($1,'BINANCE','SPOT','LIVE','development','SIMULATED',1,'upgrade-audit',now(),now()+interval '1 hour','{}',$2)`,
    [ids.capability, hash],
  );
  const reservationIntent = invalid === 'attempt' ? ids.otherIntent : ids.intent;
  await client.query(
    `INSERT INTO risk_decision
    (id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",
     verdict,"policyVersion","commandHash","reasonCodes","permissionEpoch","expiresAt")
    VALUES ($1,$2,$3,$4,'PAPER',$5,$6,$7,$8,'APPROVE',1,$9,ARRAY['FIXTURE'],0,now()+interval '1 hour')`,
    [
      ids.decision,
      ids.tenant,
      reservationIntent,
      ids.account,
      ids.profile,
      ids.state,
      ids.rule,
      ids.capability,
      hash,
    ],
  );
  await client.query(
    `INSERT INTO risk_budget
    (id,"tenantId","accountId","profileId",mode,scope,"scopeKey",asset,"windowStart","windowEnd","limitAmount","updatedAt")
    VALUES ($1::uuid,$2,$3,$4,'PAPER','ACCOUNT',$1::text,'USDT',now(),now()+interval '1 day',1000,now())`,
    [ids.budget, ids.tenant, ids.account, ids.profile],
  );
  await client.query(
    `INSERT INTO risk_reservation
    (id,"tenantId","decisionId","intentId","accountId",mode,"budgetId",asset,amount,"expiresAt","updatedAt")
    VALUES ($1,$2,$3,$4,$5,'PAPER',$6,'USDT',100,now()+interval '1 hour',now())`,
    [ids.reservation, ids.tenant, ids.decision, reservationIntent, ids.account, ids.budget],
  );
  await client.query(
    `INSERT INTO submission_attempt
    (id,"tenantId","orderId","operationVersion",operation,"permissionEpoch","reservationId","workerId","commandHash","permitConsumedAt","deadlineAt")
    VALUES ($1,$2,$3,1,'PLACE',0,$4,'upgrade-audit',$5,now(),now()+interval '1 minute')`,
    [ids.attempt, ids.tenant, ids.order, ids.reservation, hash],
  );
  // Flush deferred ledger checks before DDL on these tables, as on a real pre-upgrade DB.
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  return ids;
}

export async function prepareAuditUpgrade(pool, migrationFile) {
  const migration = (await readFile(migrationFile, 'utf8'))
    .replace(/^BEGIN;$/mu, '')
    .replace(/COMMIT;\s*$/u, '');
  for (const invalid of ['fee', 'attempt']) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await legacyFixture(client, invalid);
      await assert.rejects(client.query(migration), (error) => error?.code === '23503');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    assert.equal(
      (
        await pool.query(`SELECT count(*)::int n FROM information_schema.columns
      WHERE table_schema='public' AND table_name='fee' AND column_name='accountId'`)
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(`SELECT tgenabled FROM pg_trigger
      WHERE tgrelid='fee'::regclass AND tgname='immutable_evidence'`)
      ).rows[0].tgenabled,
      'O',
    );
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = await legacyFixture(client);
    await client.query('COMMIT');
    return ids;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyAuditUpgrade(pool, ids) {
  assert.deepEqual(
    (
      await pool.query(
        `SELECT "accountId",mode,amount::text
    FROM fee WHERE id=$1`,
        [ids.fee],
      )
    ).rows,
    [{ accountId: ids.account, mode: 'PAPER', amount: '1' }],
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT "intentId","accountId",mode,"instrumentId","reservationId",encode("commandHash",'hex') AS hash
    FROM submission_attempt WHERE id=$1`,
        [ids.attempt],
      )
    ).rows,
    [
      {
        intentId: ids.intent,
        accountId: ids.account,
        mode: 'PAPER',
        instrumentId: ids.instrument,
        reservationId: ids.reservation,
        hash: '1f'.repeat(32),
      },
    ],
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int n FROM ctp_internal.ledger_seal
    WHERE "transactionId"=$1`,
        [ids.ledger],
      )
    ).rows[0].n,
    1,
  );
}
