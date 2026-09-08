import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const project = process.env['CTP_TEST_PROJECT'];
if (!project || !/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(project)) {
  throw new Error('Query-plan integration requires the isolated project runner');
}

function requiredUrl(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error(`Missing isolated runner variable: ${name}`);
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/ctp_p2_fresh_[a-f0-9]+$/u.test(url.pathname)
  ) {
    throw new Error('Expected a disposable local phase-2 database');
  }
  return url;
}

const adminUrl = requiredUrl('DATABASE_MIGRATION_URL');
const runtimeUrl = requiredUrl('DATABASE_RUNTIME_URL');
if (adminUrl.host !== runtimeUrl.host || adminUrl.pathname !== runtimeUrl.pathname) {
  throw new Error('Migration and runtime connections must target the same disposable database');
}

const admin = new Pool({ connectionString: adminUrl.href, max: 2, query_timeout: 15_000 });
const runtime = new Pool({ connectionString: runtimeUrl.href, max: 2, query_timeout: 10_000 });
const fixture = Object.freeze({
  tenant: randomUUID(),
  account: randomUUID(),
  instrument: randomUUID(),
  rule: randomUUID(),
  definition: randomUUID(),
  risk: randomUUID(),
});
const evidence = Buffer.alloc(32, 11);
const epoch = '2026-09-15T12:00:00.000Z';
const fixtureSize = 2400;
type Row = Record<string, unknown>;

async function rows(client: Pool | PoolClient, sql: string, values: readonly unknown[] = []) {
  return (await client.query<Row>(sql, [...values])).rows;
}

function textField(row: Row | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== 'string') throw new Error(`Expected string column: ${key}`);
  return value;
}

function dateField(row: Row | undefined, key: string): Date {
  const value = row?.[key];
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Expected timestamp column: ${key}`);
  }
  return value;
}

async function withTenant<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [fixture.tenant]);
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

beforeAll(async () => {
  await rows(
    admin,
    'INSERT INTO "user" (id,"emailNormalized","updatedAt") VALUES ($1::uuid,$2,now())',
    [fixture.tenant, `${fixture.tenant}@example.invalid`],
  );
  await rows(
    admin,
    `INSERT INTO exchange_account
      (id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt")
     VALUES ($1::uuid,$2::uuid,'BINANCE','PAPER',$3,'development','SIMULATED','DISABLED','query-plan',now())`,
    [fixture.account, fixture.tenant, fixture.account],
  );
  await rows(
    admin,
    `INSERT INTO instrument
      (id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt")
     VALUES ($1::uuid,'BINANCE','SPOT','PAPER',$2,'BTC','USDT',false,now())`,
    [fixture.instrument, `PLAN_${fixture.instrument}`],
  );
  await rows(
    admin,
    `INSERT INTO instrument_rule_version
      (id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash",
       "priceTick","quantityStep","minQuantity",rules)
     VALUES ($1::uuid,$2::uuid,1,true,$3::timestamptz,$3::timestamptz,$4,0.01,0.000001,0.000001,'{}')`,
    [fixture.rule, fixture.instrument, epoch, evidence],
  );
  await rows(
    admin,
    `INSERT INTO order_intent
      ("tenantId","accountId",mode,"instrumentId","ruleVersionId",origin,destination,
       operation,"idempotencyKey","commandHash",side,"orderType","quantityAsset","priceAsset",
       quantity,"limitPrice","createdAt")
     SELECT $1::uuid,$2::uuid,'PAPER',$3::uuid,$4::uuid,'USER','PAPER_ENGINE','PLACE',
       n::text,$5,'BUY','LIMIT','BTC','USDT',1,100,
       $6::timestamptz-((n-1)/100)*interval '1 minute'
     FROM generate_series(1,$7::int) AS n`,
    [
      fixture.tenant,
      fixture.account,
      fixture.instrument,
      fixture.rule,
      evidence,
      epoch,
      fixtureSize,
    ],
  );
  await rows(
    admin,
    `INSERT INTO "order"
      ("tenantId","intentId","accountId",mode,"instrumentId","ruleVersionId",
       "clientIdNamespace","clientId",market,status,side,"orderType","quantityAsset","priceAsset",
       quantity,"limitPrice","updatedAt","createdAt")
     SELECT "tenantId",id,"accountId",mode,"instrumentId","ruleVersionId",'query-plan',id::text,
       'SPOT',CASE WHEN "idempotencyKey"::int<=24 THEN 'SUBMITTED' ELSE 'FILLED' END::"OrderStatus",
       side,"orderType","quantityAsset","priceAsset",quantity,"limitPrice","createdAt","createdAt"
     FROM order_intent WHERE "tenantId"=$1::uuid`,
    [fixture.tenant],
  );
  await rows(
    admin,
    `INSERT INTO fill
      ("tenantId","orderId","accountId",mode,"instrumentId","ruleVersionId",market,
       "executionIdentity",side,"baseAsset","quoteAsset",quantity,price,"quoteAmount",
       timestamp,"receivedAt","evidenceHash")
     SELECT "tenantId",id,"accountId",mode,"instrumentId","ruleVersionId",market,id::text,
       side,'BTC','USDT',1,100,100,"createdAt","createdAt",$2
     FROM "order" WHERE "tenantId"=$1::uuid`,
    [fixture.tenant, evidence],
  );
  await rows(
    admin,
    `INSERT INTO strategy_definition
      (id,key,version,name,description,"implementationHash","parameterSchemaVersion","minimumWarmupBars","allowedMarkets")
     VALUES ($1::uuid,$2,1,'Query-plan fixture','Inert database fixture',$3,1,1,ARRAY['SPOT']::"MarketType"[])`,
    [fixture.definition, fixture.definition, evidence],
  );
  await rows(
    admin,
    `INSERT INTO risk_profile
      (id,"tenantId",name,version,"policyHash","valuationAsset","maxNotional","maxDailyLoss",
       "maxDrawdownRate","maxOpenOrders",policy,"effectiveAt")
     VALUES ($1::uuid,$2::uuid,'Query-plan fixture',1,$3,'USDT',0,0,0,0,'{}',$4::timestamptz)`,
    [fixture.risk, fixture.tenant, evidence, epoch],
  );
  await rows(
    admin,
    `INSERT INTO strategy_instance
      ("tenantId","accountId",mode,"definitionId","riskProfileId",label,status,parameters,
       "instrumentSelection","selectionHash","updatedAt")
     SELECT $1::uuid,$2::uuid,'PAPER',$3::uuid,$4::uuid,'Query-plan fixture',
       CASE WHEN n<=24 THEN 'RUNNING' ELSE 'ARCHIVED' END::"StrategyStatus",'{}','[]',$5,now()
     FROM generate_series(1,$6::int) AS n`,
    [fixture.tenant, fixture.account, fixture.definition, fixture.risk, evidence, fixtureSize],
  );
  await rows(
    admin,
    `INSERT INTO outbox_event
      ("tenantId","eventType","schemaVersion","aggregateType","aggregateId","aggregateVersion",
       payload,"occurredAt","availableAt","deliveredAt")
     SELECT $1::uuid,'FixtureCreated',1,'Fixture',gen_random_uuid(),1,'{}',$2::timestamptz,
       $2::timestamptz+n*interval '1 second',CASE WHEN n<=24 THEN NULL ELSE $2::timestamptz END
     FROM generate_series(1,$3::int) AS n`,
    [fixture.tenant, epoch, fixtureSize],
  );
  for (const month of ['2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z']) {
    await rows(
      admin,
      `INSERT INTO candle
        ("instrumentId","ruleVersionId","timeframeSeconds","openTime","closeTime",
         open,high,low,close,"baseVolume","quoteVolume","tradeCount","isClosed",quality,source,"sourceHash","receivedAt")
       SELECT $1::uuid,$2::uuid,60,$3::timestamptz+n*interval '1 minute',
         $3::timestamptz+(n+1)*interval '1 minute',100,101,99,100,1,100,1,true,'VERIFIED','fixture',$4,
         $3::timestamptz+(n+1)*interval '1 minute'
       FROM generate_series(0,999) AS n`,
      [fixture.instrument, fixture.rule, month, evidence],
    );
  }
  // Real statistics and normal planner settings: a sequential scan is never disabled.
  await admin.query('ANALYZE "order", fill, strategy_instance, outbox_event, candle');
});

afterAll(async () => {
  const results = await Promise.allSettled([runtime.end(), admin.end()]);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
});

function object(value: unknown): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected PostgreSQL JSON plan object');
  }
  return value as Row;
}

function planNodes(document: unknown): Row[] {
  const root = object(document);
  const plan = object(root['Plan']);
  const result: Row[] = [];
  function visit(node: Row): void {
    result.push(node);
    const children: unknown = node['Plans'];
    if (Array.isArray(children)) for (const child of children) visit(object(child));
  }
  visit(plan);
  return result;
}

// Keep execution, estimates, buffers, relation/index choices and pruning evidence.
// Exclude expressions, SQL, connection information and fixture identifiers by construction.
const reportKeys = new Set([
  'Plan',
  'Plans',
  'Node Type',
  'Parent Relationship',
  'Parallel Aware',
  'Async Capable',
  'Relation Name',
  'Alias',
  'Index Name',
  'Scan Direction',
  'Startup Cost',
  'Total Cost',
  'Plan Rows',
  'Plan Width',
  'Actual Startup Time',
  'Actual Total Time',
  'Actual Rows',
  'Actual Loops',
  'Rows Removed by Filter',
  'Rows Removed by Index Recheck',
  'Heap Fetches',
  'Shared Hit Blocks',
  'Shared Read Blocks',
  'Shared Dirtied Blocks',
  'Shared Written Blocks',
  'Local Hit Blocks',
  'Local Read Blocks',
  'Local Dirtied Blocks',
  'Local Written Blocks',
  'Temp Read Blocks',
  'Temp Written Blocks',
  'Planning Time',
  'Execution Time',
  'Planning',
  'Subplans Removed',
  'Sort Method',
  'Sort Space Used',
  'Sort Space Type',
  'Exact Heap Blocks',
  'Lossy Heap Blocks',
]);

function sanitizePlan(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePlan);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => reportKeys.has(key))
      .map(([key, item]: [string, unknown]) => [key, sanitizePlan(item)]),
  );
}

async function explain(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
): Promise<unknown> {
  const result = await rows(client, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values);
  const document: unknown = result[0]?.['QUERY PLAN'];
  if (!Array.isArray(document) || document.length !== 1)
    throw new Error('Missing PostgreSQL JSON plan');
  return document[0];
}

const historySql = `SELECT id,"createdAt" FROM "order" WHERE "tenantId"=$1::uuid
  ORDER BY "createdAt" DESC,id DESC LIMIT 20`;
const activeSql = `SELECT id,status,"instrumentId" FROM "order"
  WHERE "tenantId"=$1::uuid AND "accountId"=$2::uuid
    AND "isActive"`;
const fillsSql = `SELECT id,timestamp,quantity,price FROM fill
  WHERE "tenantId"=$1::uuid AND "instrumentId"=$2::uuid ORDER BY timestamp DESC,id DESC LIMIT 20`;
const strategiesSql = `SELECT id,label FROM strategy_instance
  WHERE "tenantId"=$1::uuid AND "isRunning" ORDER BY id LIMIT 20`;
const candlesSql = `SELECT "openTime",open,high,low,close FROM candle
  WHERE "instrumentId"=$1::uuid AND "timeframeSeconds"=60
    AND "openTime">=$2::timestamptz AND "openTime"<$3::timestamptz
  ORDER BY "openTime" LIMIT 20`;
const outboxSql = `SELECT id,"availableAt" FROM outbox_event
  WHERE "tenantId"=$1::uuid AND "deliveredAt" IS NULL AND "availableAt"<=$2::timestamptz
  ORDER BY "availableAt",id LIMIT 20`;

describe('PostgreSQL query plans, stable pagination and candle partitions', () => {
  it('derives indexed activity flags from status and rejects forged flag values', async () => {
    for (const [table, flag, enabled, disabled] of [
      ['order', 'isActive', 'SUBMITTED', 'FILLED'],
      ['strategy_instance', 'isRunning', 'RUNNING', 'ARCHIVED'],
    ] as const) {
      const id = await withTenant(async (client) => {
        const original = await rows(
          client,
          `SELECT id FROM "${table}" WHERE "tenantId"=$1::uuid AND "${flag}" LIMIT 1`,
          [fixture.tenant],
        );
        const selected = textField(original[0], 'id');
        for (const [status, expected] of [
          [disabled, false],
          [enabled, true],
        ] as const) {
          const changed = await rows(
            client,
            `UPDATE "${table}" SET status=$2 WHERE id=$1::uuid RETURNING "${flag}" AS enabled`,
            [selected, status],
          );
          expect(changed).toEqual([{ enabled: expected }]);
        }
        return selected;
      });
      await expect(
        withTenant((client) =>
          rows(client, `UPDATE "${table}" SET "${flag}"=false WHERE id=$1::uuid`, [id]),
        ),
      ).rejects.toMatchObject({ code: '428C9' });
    }
  });

  it('executes six representative reads with real statistics and saves sanitized plan evidence', async () => {
    const plans = await withTenant(async (client) => {
      expect(textField((await rows(client, 'SHOW enable_seqscan'))[0], 'enable_seqscan')).toBe(
        'on',
      );
      const cases = [
        {
          name: 'orderHistory',
          sql: historySql,
          values: [fixture.tenant],
          indexes: ['order_tenantId_createdAt_id_idx'],
        },
        {
          name: 'activeOrders',
          sql: activeSql,
          values: [fixture.tenant, fixture.account],
          indexes: ['order_active_account'],
        },
        {
          name: 'fills',
          sql: fillsSql,
          values: [fixture.tenant, fixture.instrument],
          indexes: ['fill_tenantId_instrumentId_timestamp_id_idx'],
        },
        {
          name: 'strategies',
          sql: strategiesSql,
          values: [fixture.tenant],
          indexes: ['strategy_running_tenant'],
        },
        {
          name: 'candles',
          sql: candlesSql,
          values: [fixture.instrument, '2026-09-01T01:00:00Z', '2026-09-01T01:20:00Z'],
          indexes: [],
        },
        {
          name: 'readyOutbox',
          sql: outboxSql,
          values: [fixture.tenant, '2026-09-16T00:00:00Z'],
          indexes: ['outbox_ready', 'outbox_event_tenantId_deliveredAt_availableAt_id_idx'],
        },
      ];
      const result: Record<string, unknown> = {};
      for (const item of cases) {
        const plan = await explain(client, item.sql, item.values);
        const nodes = planNodes(plan);
        expect
          .soft(
            nodes.some((node) => typeof node['Index Name'] === 'string'),
            item.name,
          )
          .toBe(true);
        if (item.indexes.length > 0) {
          expect
            .soft(
              nodes.some((node) => item.indexes.includes(String(node['Index Name']))),
              item.name,
            )
            .toBe(true);
        }
        expect
          .soft(object(object(plan)['Plan'])['Actual Rows'], item.name)
          .toBe(item.name === 'activeOrders' ? 24 : 20);
        expect
          .soft(
            nodes.some((node) => typeof node['Shared Hit Blocks'] === 'number'),
            item.name,
          )
          .toBe(true);
        result[item.name] = sanitizePlan(plan);
      }
      return result;
    });
    await mkdir('test-results', { recursive: true });
    await writeFile(
      'test-results/database-query-plans.json',
      JSON.stringify(
        {
          fixtureRows: {
            orders: fixtureSize,
            fills: fixtureSize,
            strategies: fixtureSize,
            outbox: fixtureSize,
            candles: 3000,
          },
          rareRows: { activeOrders: 24, runningStrategies: 24, readyOutbox: 24 },
          explain: ['ANALYZE', 'BUFFERS', 'FORMAT JSON'],
          runtimeRole: 'non-owner, non-superuser, tenant RLS',
          sequentialScansEnabled: true,
          plans,
        },
        null,
        2,
      ) + '\n',
    );
  });

  it('paginates tied timestamps without duplicate or missing old rows during a concurrent insert', async () => {
    const firstSql = `SELECT id,"createdAt" FROM "order" WHERE "tenantId"=$1::uuid
      ORDER BY "createdAt" DESC,id DESC LIMIT 73`;
    const nextSql = `SELECT id,"createdAt" FROM "order" WHERE "tenantId"=$1::uuid
      AND ("createdAt",id)<($2::timestamptz,$3::uuid)
      ORDER BY "createdAt" DESC,id DESC LIMIT 73`;
    await withTenant(async (client) => {
      const baseline = await rows(
        client,
        'SELECT id,"createdAt" FROM "order" WHERE "tenantId"=$1::uuid ORDER BY "createdAt" DESC,id DESC',
        [fixture.tenant],
      );
      expect(baseline).toHaveLength(fixtureSize);
      let page = await rows(client, firstSql, [fixture.tenant]);
      expect(dateField(page[0], 'createdAt').getTime()).toBe(
        dateField(page.at(-1), 'createdAt').getTime(),
      );
      const visited = page.map((row) => textField(row, 'id'));
      const cursor = page.at(-1);
      const tiedId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      expect(tiedId > textField(cursor, 'id')).toBe(true);
      const insert = async (orderId: string, createdAt: Date) => {
        const insertedIntent = randomUUID();
        await rows(
          admin,
          `INSERT INTO order_intent
            (id,"tenantId","accountId",mode,"instrumentId","ruleVersionId",origin,destination,
             operation,"idempotencyKey","commandHash",side,"orderType","quantityAsset","priceAsset",quantity)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'PAPER',$4::uuid,$5::uuid,'USER','PAPER_ENGINE',
             'PLACE',$6,$7,'BUY','MARKET','BTC','USDT',1)`,
          [
            insertedIntent,
            fixture.tenant,
            fixture.account,
            fixture.instrument,
            fixture.rule,
            insertedIntent,
            evidence,
          ],
        );
        await rows(
          admin,
          `INSERT INTO "order"
            (id,"tenantId","intentId","accountId",mode,"instrumentId","ruleVersionId","clientIdNamespace",
             "clientId",market,side,"orderType","quantityAsset","priceAsset",quantity,"updatedAt","createdAt")
           VALUES ($8::uuid,$1::uuid,$2::uuid,$3::uuid,'PAPER',$4::uuid,$5::uuid,'query-plan',$6,
             'SPOT','BUY','MARKET','BTC','USDT',1,$7::timestamptz,$7::timestamptz)`,
          [
            fixture.tenant,
            insertedIntent,
            fixture.account,
            fixture.instrument,
            fixture.rule,
            insertedIntent,
            createdAt,
            orderId,
          ],
        );
      };
      const results = await Promise.all([
        rows(client, nextSql, [
          fixture.tenant,
          dateField(cursor, 'createdAt'),
          textField(cursor, 'id'),
        ]),
        insert(randomUUID(), new Date('2026-09-15T12:01:00Z')),
        insert(tiedId, dateField(cursor, 'createdAt')),
      ]);
      page = results[0];
      while (page.length > 0) {
        visited.push(...page.map((row) => textField(row, 'id')));
        const last = page.at(-1);
        page = await rows(client, nextSql, [
          fixture.tenant,
          dateField(last, 'createdAt'),
          textField(last, 'id'),
        ]);
      }
      expect(visited).toEqual(baseline.map((row) => textField(row, 'id')));
      expect(new Set(visited).size).toBe(fixtureSize);
      const count = await rows(
        client,
        'SELECT count(*)::int AS count FROM "order" WHERE "tenantId"=$1::uuid',
        [fixture.tenant],
      );
      expect(count[0]?.['count']).toBe(fixtureSize + 2);
    });
  });

  it('routes monthly and overflow candles and prunes unrelated partitions with normal planner settings', async () => {
    const counts = await rows(
      admin,
      `SELECT tableoid::regclass::text AS partition,count(*)::int AS count FROM candle
       WHERE "instrumentId"=$1::uuid GROUP BY tableoid ORDER BY partition`,
      [fixture.instrument],
    );
    expect(counts).toEqual([
      { partition: 'candle_2026_09', count: 1000 },
      { partition: 'candle_2026_10', count: 1000 },
      { partition: 'candle_default', count: 1000 },
    ]);
    await withTenant(async (client) => {
      for (const [start, end, partition] of [
        ['2026-09-01T01:00:00Z', '2026-09-01T01:20:00Z', 'candle_2026_09'],
        ['2026-10-01T01:00:00Z', '2026-10-01T01:20:00Z', 'candle_2026_10'],
        ['2026-11-01T01:00:00Z', '2026-11-01T01:20:00Z', 'candle_default'],
      ] as const) {
        const plan = await explain(client, candlesSql, [fixture.instrument, start, end]);
        const relations = planNodes(plan).flatMap((node) =>
          typeof node['Relation Name'] === 'string' ? [node['Relation Name']] : [],
        );
        expect(relations).toEqual([partition]);
        expect(object(object(plan)['Plan'])['Actual Rows']).toBe(20);
      }
    });
  });
});
