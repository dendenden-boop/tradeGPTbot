import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  computeCommandHash,
  orderSchema,
  createExchangeAdapter,
  createInstrumentRegistry,
  type Order,
} from '@ctp/exchange-core';
import {
  createPostgresOrderStore,
  createOrderEngine,
  type OrderStore,
  type OrderState,
  type RiskGrant,
  hash,
} from '@ctp/order-engine';
import { createPostgresPortfolioStore, type PortfolioStore } from '@ctp/portfolio';
import { state, native } from '../../order-engine/test/fixtures.js';
import { binding as portfolioBinding, snapshot, fill } from '../../portfolio/test/fixtures.js';
import { instrument, rules } from '../../exchange-core/test/fixtures/adapter.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('Order tests require isolated runner');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('Missing isolated order variable');
  return value;
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
const open = () =>
  createPostgresOrderStore({
    connectionString: required('DATABASE_EXECUTION_URL'),
    environment: 'test',
  });
let store: OrderStore, portfolio: PortfolioStore, capability: string;
beforeAll(async () => {
  // Only this isolated fixture opens the migration's fail-closed GLOBAL gate.
  const head = await admin.query<{ epoch: string }>(
    "SELECT epoch::text FROM ctp_risk.global_head WHERE kind='KILL_SWITCH' AND key='kill'",
  );
  await admin.query('SELECT ctp_risk.update_global($1::jsonb)', [
    JSON.stringify({
      scope: { kind: 'GLOBAL' },
      kind: 'KILL_SWITCH',
      key: 'kill',
      state: 'RUNNING',
      eventId: randomUUID(),
      expectedEpoch: head.rows[0]?.epoch,
      reason: 'ISOLATED_TEST_INITIALIZATION',
      evidenceHash: 'a'.repeat(64),
    }),
  ]);
  store = await open();
  portfolio = await createPostgresPortfolioStore({
    connectionString: required('DATABASE_PORTFOLIO_URL'),
    environment: 'test',
  });
  capability = randomUUID();
  await admin.query(
    `INSERT INTO capability_snapshot(id,exchange,market,mode,region,"accountMode",version,"profileVersion","verifiedAt","expiresAt",capabilities,"evidenceHash") SELECT $1::uuid,'BINANCE','SPOT','TESTNET','global','SPOT',COALESCE(max(version),0)+1,'v1',now(),now()+interval '1 hour','{}',$2 FROM capability_snapshot WHERE exchange='BINANCE' AND market='SPOT' AND mode='TESTNET' AND region='global' AND "accountMode"='SPOT'`,
    [capability, Buffer.alloc(32, 1)],
  );
});
afterAll(async () => {
  await store?.close();
  await portfolio?.close();
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
async function grant(
  s: OrderState,
  intentId = s.intentId,
  commandHash = computeCommandHash('createOrder', s.command, {
    profile: s.binding.profile,
    account: {
      tenantId: s.binding.tenantId,
      connectionId: s.binding.connectionId,
      externalAccountId: s.binding.externalAccountId,
    },
  }),
): Promise<RiskGrant> {
  const b = s.binding,
    profile = randomUUID(),
    version = randomUUID(),
    decisionId = randomUUID(),
    budget = randomUUID(),
    reservationId = randomUUID();
  const ruleId = (
    await admin.query<{ id: string }>(
      'SELECT "ruleVersionId" AS id FROM order_intent WHERE "tenantId"=$1 AND id=$2',
      [b.tenantId, intentId],
    )
  ).rows[0]?.id;
  await admin.query(`UPDATE exchange_connection SET "permissionsVerifiedAt"=now() WHERE id=$1`, [
    b.connectionId,
  ]);
  await admin.query(
    `INSERT INTO risk_profile(id,"tenantId",name,version,"policyHash","valuationAsset","maxNotional","maxDailyLoss","maxDrawdownRate","maxOpenOrders",policy,"effectiveAt") VALUES($1::uuid,$2,$1::text,1,$3,'USDT',10000,100,0.2,5,'{}',now())`,
    [profile, b.tenantId, Buffer.alloc(32, 1)],
  );
  await admin.query(
    `INSERT INTO account_state_version(id,"tenantId","accountId",mode,version,"sourceCursor","sourceAt","receivedAt","reconciledAt","reconciliationEpoch","stateHash") SELECT $1::uuid,$2,$3,'TESTNET',COALESCE(max(version),0)+1,$1::text,now(),now(),now(),0,$4 FROM account_state_version WHERE "tenantId"=$2 AND "accountId"=$3`,
    [version, b.tenantId, b.accountId, Buffer.alloc(32, 1)],
  );
  await admin.query(
    `INSERT INTO risk_decision(id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","reasonCodes","permissionEpoch","expiresAt") VALUES($1::uuid,$2,$3,$4,'TESTNET',$5,$6,$7,$8,'APPROVE',1,$9,ARRAY['TEST_ONLY'],0,now()+interval '1 hour')`,
    [
      decisionId,
      b.tenantId,
      intentId,
      b.accountId,
      profile,
      version,
      ruleId,
      capability,
      Buffer.from(commandHash, 'hex'),
    ],
  );
  await admin.query(
    `INSERT INTO risk_budget(id,"tenantId","accountId","profileId",mode,scope,"scopeKey",asset,"windowStart","windowEnd","limitAmount","updatedAt") VALUES($1::uuid,$2,$3,$4,'TESTNET','ACCOUNT',$1::text,'USDT',now(),now()+interval '1 day',10000,now())`,
    [budget, b.tenantId, b.accountId, profile],
  );
  await admin.query(
    `INSERT INTO risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"budgetId",asset,amount,"expiresAt","updatedAt") VALUES($1::uuid,$2,$3,$4,$5,'TESTNET',$6,'USDT',100,now()+interval '1 hour',now())`,
    [reservationId, b.tenantId, decisionId, intentId, b.accountId, budget],
  );
  return { decisionId, reservationId, permissionEpoch: '0', expiresAt: Date.now() + 10000 };
}
function observation(s: OrderState, overrides: Record<string, unknown> = {}) {
  return orderSchema.parse({
    ...(native(s) as { type: 'NATIVE'; order: Order }).order,
    account: {
      tenantId: s.binding.tenantId,
      connectionId: s.binding.connectionId,
      externalAccountId: s.binding.externalAccountId,
    },
    scope: {
      exchange: s.binding.profile.exchange,
      region: s.binding.profile.region,
      environment: s.binding.profile.environment,
      market: s.binding.profile.market,
    },
    instrumentId: s.command.instrumentId,
    clientOrderId: s.command.clientOrderId,
    exchangeOrderId: 'remote-' + s.id,
    createdAt: s.createdAt,
    updatedAt: Date.now(),
    status: 'OPEN',
    filledQuantity: '0',
    averageFillPrice: { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' },
    ...overrides,
  });
}
async function submitted() {
  const f = await fixture(),
    s = await store.create(f.b, f.draft, io()),
    g = await grant(s),
    c = await store.begin(f.b, s.id, s.intentId, g, io());
  if (!c) throw new Error('Missing fixture claim');
  await store.result(f.b, c, { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } }, io());
  return { ...f, s, c };
}
it('service create replay survives rules replacement and PostgreSQL restart without new effects', async () => {
  const { b, draft } = await fixture(),
    registry = createInstrumentRegistry({ capacity: 1 });
  const refresh = (version: string) => {
    expect(
      registry.put(
        {
          instrument: {
            ...instrument,
            id: draft.order.instrumentId,
            exchangeSymbol: draft.order.instrumentId,
            metadataVersion: version,
          },
          rules: {
            ...rules,
            instrumentId: draft.order.instrumentId,
            version,
            effectiveAt: Date.now() - 1000,
            expiresAt: Date.now() + 60000,
          },
        },
        Date.now(),
      ).ok,
    ).toBe(true);
  };
  refresh('v1');
  const adapter = createExchangeAdapter({
    profile: b.profile,
    account: {
      tenantId: b.tenantId,
      connectionId: b.connectionId,
      externalAccountId: b.externalAccountId,
    },
    adapterVersion: 'v1',
    registry,
    capabilities: [],
    transport: {
      request: () => Promise.reject(new Error('No exchange I/O expected')),
      subscribe: () => Promise.reject(new Error('No stream expected')),
      disconnect: () => Promise.resolve(),
    },
    now: Date.now,
  });
  const compose = (durable: OrderStore) =>
    createOrderEngine({
      binding: b,
      authorization: { check: () => Promise.resolve(true) },
      risk: { approve: () => Promise.reject(new Error('No Risk evaluation expected')) },
      fills: { ingest: () => Promise.reject(new Error('No fill ingestion expected')) },
      registry,
      store: durable,
      adapter,
      now: Date.now,
    });
  const effects = async () =>
    (
      await admin.query<{
        intents: number;
        orders: number;
        commands: number;
        outbox: number;
        counter: string;
      }>(
        `SELECT (SELECT count(*)::int FROM order_intent WHERE "tenantId"=$1) AS intents,(SELECT count(*)::int FROM public."order" WHERE "tenantId"=$1) AS orders,(SELECT count(*)::int FROM ctp_execution.command WHERE "tenantId"=$1) AS commands,(SELECT count(*)::int FROM outbox_event WHERE "tenantId"=$1) AS outbox,"clientIdHighWatermark"::text AS counter FROM exchange_account WHERE "tenantId"=$1 AND id=$2`,
        [b.tenantId, b.accountId],
      )
    ).rows[0];
  const engine = compose(store);
  let restarted: OrderStore | undefined,
    recovered: ReturnType<typeof createOrderEngine> | undefined;
  try {
    const original = await engine.create(draft),
      before = await effects();
    await admin.query('UPDATE instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
      draft.dbRuleId,
    ]);
    const currentRule = randomUUID();
    await admin.query(
      `INSERT INTO instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity",rules) VALUES($1,$2,2,true,now(),now(),$3,0.01,0.001,0.001,'{"version":"v2"}')`,
      [currentRule, draft.dbInstrumentId, Buffer.alloc(32, 2)],
    );
    refresh('v2');
    expect(await engine.create(structuredClone(draft))).toEqual(original);
    await engine.close();
    restarted = await open();
    recovered = compose(restarted);
    expect(await recovered.create(structuredClone(draft))).toEqual(original);
    await expect(
      recovered.create({ ...draft, order: { ...draft.order, side: 'SELL' } }),
    ).rejects.toThrow('ORDER_IDEMPOTENCY_CONFLICT');
    const stale = { ...draft, key: randomUUID() };
    await expect(recovered.create(stale)).rejects.toThrow('ORDER_METADATA');
    await expect(restarted.create(b, stale, io())).rejects.toThrow('ORDER_METADATA');
    expect(await effects()).toEqual(before);
    const fresh = await recovered.create({
      ...draft,
      key: randomUUID(),
      dbRuleId: currentRule,
      order: { ...draft.order, ruleVersion: 'v2' },
    });
    expect(fresh.command.clientOrderId).toBe('9007199254740994');
  } finally {
    await recovered?.close();
    await restarted?.close();
    await engine.close();
    await adapter.disconnect();
  }
});
it('rejects admin/API/auth/ingest/Portfolio roles for execution', async () => {
  for (const key of [
    'DATABASE_MIGRATION_URL',
    'DATABASE_RUNTIME_URL',
    'DATABASE_AUTH_URL',
    'DATABASE_INGEST_URL',
    'DATABASE_PORTFOLIO_URL',
  ])
    await expect(
      createPostgresOrderStore({ connectionString: required(key), environment: 'test' }),
    ).rejects.toThrow('ORDER_DATABASE_ROLE_UNSAFE');
});
it('rejects execution identities with direct grants to forge Risk evidence', async () => {
  const role = 'ctp_order_probe_' + randomUUID().replaceAll('-', ''),
    url = new URL(required('DATABASE_EXECUTION_URL'));
  url.username = role;
  url.password = randomUUID();
  await admin.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${url.password}'; GRANT ctp_execution TO "${role}"; GRANT UPDATE ON public.risk_decision TO "${role}"`,
  );
  try {
    await expect(
      createPostgresOrderStore({ connectionString: url.href, environment: 'test' }),
    ).rejects.toThrow('ORDER_DATABASE_ROLE_UNSAFE');
  } finally {
    await admin.query(
      `REVOKE UPDATE ON public.risk_decision FROM "${role}"; REVOKE ctp_execution FROM "${role}"; DROP ROLE "${role}"`,
    );
  }
});
it('execution cannot acquire controller authority by direct SQL function grant', async () => {
  const role = 'ctp_risk_exec_probe_' + randomUUID().replaceAll('-', ''),
    url = new URL(required('DATABASE_EXECUTION_URL'));
  url.username = role;
  url.password = randomUUID();
  await admin.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${url.password}'; GRANT ctp_execution TO "${role}"; GRANT EXECUTE ON FUNCTION ctp_risk.update_global(jsonb) TO "${role}"`,
  );
  try {
    await expect(
      createPostgresOrderStore({ connectionString: url.href, environment: 'test' }),
    ).rejects.toThrow('ORDER_DATABASE_ROLE_UNSAFE');
  } finally {
    await admin.query(
      `REVOKE EXECUTE ON FUNCTION ctp_risk.update_global(jsonb) FROM "${role}"; REVOKE ctp_execution FROM "${role}"; DROP ROLE "${role}"`,
    );
  }
});
it('execution rejects every additional Risk function privilege including unknown overloads', async () => {
  const suffix = randomUUID().replaceAll('-', ''),
    role = 'ctp_risk_extra_' + suffix,
    fn = 'ctp_risk.extra_' + suffix,
    url = new URL(required('DATABASE_EXECUTION_URL'));
  url.username = role;
  url.password = randomUUID();
  await admin.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${url.password}'; GRANT ctp_execution TO "${role}"; CREATE FUNCTION ${fn}(text) RETURNS boolean LANGUAGE sql AS 'SELECT true'; REVOKE ALL ON FUNCTION ${fn}(text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION ${fn}(text) TO "${role}"`,
  );
  try {
    await expect(
      createPostgresOrderStore({ connectionString: url.toString(), environment: 'test' }),
    ).rejects.toThrow('ORDER_DATABASE_ROLE_UNSAFE');
  } finally {
    await admin.query(
      `DROP FUNCTION ${fn}(text); REVOKE ctp_execution FROM "${role}"; DROP ROLE "${role}"`,
    );
  }
});
it('execution cannot create future Risk functions after its startup allowlist check', async () => {
  const role = 'ctp_risk_create_' + randomUUID().replaceAll('-', ''),
    url = new URL(required('DATABASE_EXECUTION_URL'));
  url.username = role;
  url.password = randomUUID();
  await admin.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${url.password}'; GRANT ctp_execution TO "${role}"; GRANT CREATE ON SCHEMA ctp_risk TO "${role}"`,
  );
  try {
    await expect(
      createPostgresOrderStore({ connectionString: url.toString(), environment: 'test' }),
    ).rejects.toThrow('ORDER_DATABASE_ROLE_UNSAFE');
  } finally {
    await admin.query(
      `REVOKE CREATE ON SCHEMA ctp_risk FROM "${role}"; REVOKE ctp_execution FROM "${role}"; DROP ROLE "${role}"`,
    );
  }
});
it('atomically creates intent, command, order and outbox with lossless durable client counter', async () => {
  const { b, draft } = await fixture(),
    results = await Promise.all(Array.from({ length: 8 }, () => store.create(b, draft, io())));
  expect(new Set(results.map((s) => s.id)).size).toBe(1);
  expect(results[0]?.command.clientOrderId).toBe('9007199254740993');
  const restarted = await open();
  try {
    const next = await restarted.create(b, { ...draft, key: randomUUID() }, io());
    expect(next.command.clientOrderId).toBe('9007199254740994');
  } finally {
    await restarted.close();
  }
  await expect(
    store.create(b, { ...draft, order: { ...draft.order, side: 'SELL' } }, io()),
  ).rejects.toThrow('ORDER_IDEMPOTENCY_CONFLICT');
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM order_intent WHERE "tenantId"=$1',
        [b.tenantId],
      )
    ).rows[0]?.n,
  ).toBe(2);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM outbox_event WHERE "tenantId"=$1',
        [b.tenantId],
      )
    ).rows[0]?.n,
  ).toBe(2);
});
it('serializes workers, persists UNKNOWN across restart and reconciles without another attempt', async () => {
  const { b, draft } = await fixture(),
    s = await store.create(b, draft, io()),
    g = await grant(s),
    claims = await Promise.all([
      store.begin(b, s.id, s.intentId, g, io()),
      store.begin(b, s.id, s.intentId, g, io()),
    ]),
    c = claims.find((x) => x !== null);
  expect(claims.filter(Boolean)).toHaveLength(1);
  if (!c) throw new Error('No claim');
  await store.result(b, c, { kind: 'UNKNOWN', error: { code: 'DEADLINE_EXCEEDED' } }, io());
  const restarted = await open();
  try {
    expect((await restarted.read(b, s.id, io())).status).toBe('UNKNOWN');
    expect(await restarted.begin(b, s.id, s.intentId, g, io())).toBeNull();
    const o = observation(s);
    expect((await restarted.observe(b, s.id, o, io())).reconciliation).toBe('CONSISTENT');
    expect((await restarted.observe(b, s.id, o, io())).version).toBe(
      (await restarted.read(b, s.id, io())).version,
    );
  } finally {
    await restarted.close();
  }
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM submission_attempt WHERE "tenantId"=$1',
        [b.tenantId],
      )
    ).rows[0]?.n,
  ).toBe(1);
});
it('requires durable risk proof, current permission epoch and latest fresh state', async () => {
  const { b, draft } = await fixture(),
    s = await store.create(b, draft, io()),
    g = await grant(s);
  await expect(
    store.begin(b, s.id, s.intentId, { ...g, reservationId: randomUUID() }, io()),
  ).rejects.toThrow('ORDER_RISK_DENIED');
  await admin.query('UPDATE exchange_account SET "permissionEpoch"=1 WHERE id=$1', [b.accountId]);
  await expect(store.begin(b, s.id, s.intentId, g, io())).rejects.toThrow('ORDER_RISK_DENIED');
  expect((await store.read(b, s.id, io())).status).toBe('CREATED');
});
it('cannot reset the durable client counter, including with a changed namespace', async () => {
  const { b, draft } = await fixture();
  await store.create(b, draft, io());
  await expect(
    admin.query(
      'UPDATE exchange_account SET "clientIdEpoch"=\'new-epoch\',"clientIdHighWatermark"=0 WHERE id=$1',
      [b.accountId],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
it('rejects expired source state and a superseded approval snapshot', async () => {
  const { b, draft } = await fixture(),
    s = await store.create(b, draft, io()),
    older = await grant(s),
    current = await grant(s);
  await expect(store.begin(b, s.id, s.intentId, older, io())).rejects.toThrow('ORDER_RISK_DENIED');
  await admin.query(
    'UPDATE account_state_version SET "sourceAt"=now()-interval \'10 seconds\' WHERE "tenantId"=$1',
    [b.tenantId],
  );
  await expect(store.begin(b, s.id, s.intentId, current, io())).rejects.toThrow(
    'ORDER_RISK_DENIED',
  );
  expect((await store.read(b, s.id, io())).status).toBe('CREATED');
});
it('rejects forged result claims without changing attempt or order', async () => {
  const { b, s, c } = await submitted();
  await expect(
    store.result(
      b,
      { ...c, commandHash: hash('forged') },
      { kind: 'UNKNOWN', error: { code: 'DEADLINE_EXCEEDED' } },
      io(),
    ),
  ).rejects.toThrow('ORDER_BINDING_DENIED');
  expect((await store.read(b, s.id, io())).status).toBe('UNKNOWN');
});
it.each(['USER', 'CONNECTION', 'GLOBAL', 'OPEN', 'HALF_OPEN'] as const)(
  'final transport permit rejects a newer durable %s control without consuming it',
  async (scope) => {
    const { b, draft } = await fixture(),
      s = await store.create(b, draft, io()),
      g = await grant(s),
      c = await store.begin(b, s.id, s.intentId, g, io());
    if (!c) throw new Error('No claim');
    const global = scope === 'GLOBAL';
    const p = await admin.connect();
    let epoch = '0',
      released = false;
    const request = {
      scope: global
        ? { kind: 'GLOBAL' }
        : {
            kind: scope === 'CONNECTION' ? 'CONNECTION' : 'USER',
            tenantId: b.tenantId,
            targetId: scope === 'CONNECTION' ? b.connectionId : b.tenantId,
          },
      kind: scope === 'OPEN' || scope === 'HALF_OPEN' ? 'CIRCUIT' : 'KILL_SWITCH',
      key: scope === 'OPEN' || scope === 'HALF_OPEN' ? 'private_ws' : 'kill',
      state: scope === 'OPEN' || scope === 'HALF_OPEN' ? scope : 'PAUSED',
      eventId: randomUUID(),
      expectedEpoch: '0',
      reason: 'TEST_PAUSE',
      evidenceHash: 'a'.repeat(64),
    };
    try {
      await p.query('BEGIN');
      if (global) {
        const r = await p.query<{ epoch: string }>(
          "SELECT epoch::text FROM ctp_risk.global_head WHERE kind='KILL_SWITCH'",
        );
        request.expectedEpoch = r.rows[0]!.epoch;
      } else await p.query("SELECT set_config('app.tenant_id',$1,true)", [b.tenantId]);
      const r = await p.query<{ result: { epoch: string } }>(
        global
          ? 'SELECT ctp_risk.update_global($1::jsonb) AS result'
          : 'SELECT ctp_risk.update_tenant($1::jsonb) AS result',
        [JSON.stringify(request)],
      );
      epoch = r.rows[0]!.result.epoch;
      await p.query('COMMIT');
      p.release();
      released = true;
      const account = {
        tenantId: b.tenantId,
        connectionId: b.connectionId,
        externalAccountId: b.externalAccountId,
      };
      const authorization = {
        commandId: s.intentId,
        commandHash: c.commandHash,
        dispatchAttemptId: c.attemptId,
        profile: b.profile,
        account,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 1000,
      };
      expect(
        await store.authorize(
          'createOrder',
          { command: s.command, authorization },
          { ...io(), profile: b.profile, account, correlationId: randomUUID() },
        ),
      ).toBe(false);
      expect(
        (
          await admin.query<{ started: Date | null }>(
            'SELECT "transportStartedAt" AS started FROM submission_attempt WHERE id=$1',
            [c.attemptId],
          )
        ).rows[0]?.started,
      ).toBeNull();
      const restarted = await open();
      try {
        expect(
          await restarted.authorize(
            'createOrder',
            { command: s.command, authorization },
            { ...io(), profile: b.profile, account, correlationId: randomUUID() },
          ),
        ).toBe(false);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!released) {
        await p.query('ROLLBACK').catch(() => {});
        p.release();
      }
      if (global && epoch !== '0')
        await admin.query('SELECT ctp_risk.update_global($1::jsonb)', [
          JSON.stringify({
            ...request,
            eventId: randomUUID(),
            expectedEpoch: epoch,
            state: 'RUNNING',
          }),
        ]);
    }
  },
);
it('consumes an exact adapter permit once and rechecks permission before transport', async () => {
  const { b, draft } = await fixture(),
    s = await store.create(b, draft, io()),
    g = await grant(s),
    c = await store.begin(b, s.id, s.intentId, g, io());
  if (!c) throw new Error('No claim');
  const account = {
      tenantId: b.tenantId,
      connectionId: b.connectionId,
      externalAccountId: b.externalAccountId,
    },
    authorization = {
      commandId: s.intentId,
      commandHash: c.commandHash,
      dispatchAttemptId: c.attemptId,
      profile: b.profile,
      account,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1000,
    },
    input = { command: s.command, authorization },
    context = { ...io(), profile: b.profile, account, correlationId: randomUUID() };
  expect(
    await store.authorize(
      'createOrder',
      {
        ...input,
        authorization: {
          ...authorization,
          issuedAt: Date.now() - 2000,
          expiresAt: Date.now() - 1000,
        },
      },
      context,
    ),
  ).toBe(false);
  expect(
    await store.authorize(
      'createOrder',
      { ...input, authorization: { ...authorization, expiresAt: g.expiresAt + 1000 } },
      context,
    ),
  ).toBe(false);
  const results = await Promise.all([
    store.authorize('createOrder', input, context),
    store.authorize('createOrder', input, context),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const delayed = await fixture(),
    delayedState = await store.create(delayed.b, delayed.draft, io()),
    delayedGrant = await grant(delayedState),
    delayedClaim = await store.begin(
      delayed.b,
      delayedState.id,
      delayedState.intentId,
      delayedGrant,
      io(),
    );
  if (!delayedClaim) throw new Error('No claim');
  // Statement trigger delays predicate evaluation after the transaction has begun.
  await admin.query(
    `CREATE FUNCTION ctp_execution.test_permit_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('app.tenant_id',true)='${delayed.b.tenantId}' THEN PERFORM pg_sleep(0.3); END IF; RETURN NULL; END $$; CREATE TRIGGER execution_test_permit_delay BEFORE UPDATE ON submission_attempt FOR EACH STATEMENT EXECUTE FUNCTION ctp_execution.test_permit_delay()`,
  );
  try {
    const delayedAccount = {
      tenantId: delayed.b.tenantId,
      connectionId: delayed.b.connectionId,
      externalAccountId: delayed.b.externalAccountId,
    };
    expect(
      await store.authorize(
        'createOrder',
        {
          command: delayedState.command,
          authorization: {
            ...authorization,
            commandId: delayedState.intentId,
            commandHash: delayedClaim.commandHash,
            dispatchAttemptId: delayedClaim.attemptId,
            account: delayedAccount,
            issuedAt: Date.now(),
            expiresAt: Date.now() + 200,
          },
        },
        {
          ...io(),
          profile: delayed.b.profile,
          account: delayedAccount,
          correlationId: randomUUID(),
        },
      ),
    ).toBe(false);
    expect(
      (
        await admin.query<{ started: Date | null }>(
          'SELECT "transportStartedAt" AS started FROM submission_attempt WHERE id=$1',
          [delayedClaim.attemptId],
        )
      ).rows[0]?.started,
    ).toBeNull();
  } finally {
    await admin.query(
      'DROP TRIGGER execution_test_permit_delay ON submission_attempt; DROP FUNCTION ctp_execution.test_permit_delay()',
    );
  }
  const f = await fixture(),
    t = await store.create(f.b, f.draft, io()),
    r = await grant(t),
    claim = await store.begin(f.b, t.id, t.intentId, r, io());
  if (!claim) throw new Error('No claim');
  await admin.query('UPDATE exchange_account SET "permissionEpoch"=1 WHERE id=$1', [f.b.accountId]);
  expect(
    await store.authorize(
      'createOrder',
      {
        command: t.command,
        authorization: {
          ...authorization,
          commandId: t.intentId,
          commandHash: claim.commandHash,
          dispatchAttemptId: claim.attemptId,
          account: {
            ...account,
            tenantId: f.b.tenantId,
            connectionId: f.b.connectionId,
            externalAccountId: f.b.externalAccountId,
          },
        },
      },
      {
        ...context,
        account: {
          ...account,
          tenantId: f.b.tenantId,
          connectionId: f.b.connectionId,
          externalAccountId: f.b.externalAccountId,
        },
      },
    ),
  ).toBe(false);
});
it('watermarks reject equal-time conflict, ignore older proof and survive restart', async () => {
  const { b, s } = await submitted(),
    o = observation(s),
    a = await store.observe(b, s.id, o, io());
  await expect(store.observe(b, s.id, { ...o, status: 'CANCELED' }, io())).rejects.toThrow(
    'ORDER_EVIDENCE_CONFLICT',
  );
  const restarted = await open();
  try {
    expect(
      (await restarted.observe(b, s.id, { ...o, updatedAt: o.updatedAt - 1 }, io())).version,
    ).toBe(a.version);
  } finally {
    await restarted.close();
  }
});
it('CANCEL has its own durable intent and stays pending until positive native cancellation', async () => {
  const { b, s } = await submitted();
  await store.observe(b, s.id, observation(s), io());
  const cmd = await store.cancelIntent(b, s.id, 'cancel-1', io()),
    g = await grant(s, cmd.intentId, cmd.commandHash),
    c = await store.begin(b, s.id, cmd.intentId, g, io());
  if (!c) throw new Error('No claim');
  const r = await store.result(
    b,
    c,
    {
      kind: 'ACCEPTED',
      ack: {
        commandId: cmd.intentId,
        status: 'ACKNOWLEDGED',
        exchangeId: 'remote-' + s.id,
        receivedAt: Date.now(),
      },
    },
    io(),
  );
  expect(r.status).toBe('CANCEL_PENDING');
  expect((await store.cancelIntent(b, s.id, 'cancel-1', io())).intentId).toBe(cmd.intentId);
  expect(await store.begin(b, s.id, cmd.intentId, g, io())).toBeNull();
  const final = await store.observe(
    b,
    s.id,
    observation(s, { status: 'CANCELED', updatedAt: Date.now() + 1 }),
    io(),
  );
  expect(final.status).toBe('CANCELED');
  expect(final.reconciliation).toBe('CONSISTENT');
});
it('unclassified CANCEL cannot bypass a kill switch or consume transport authority', async () => {
  const { b, s } = await submitted();
  await store.observe(b, s.id, observation(s), io());
  const cmd = await store.cancelIntent(b, s.id, 'paused-cancel', io()),
    g = await grant(s, cmd.intentId, cmd.commandHash),
    c = await store.begin(b, s.id, cmd.intentId, g, io());
  if (!c) throw new Error('No claim');
  const p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [b.tenantId]);
    await p.query('SELECT ctp_risk.update_tenant($1::jsonb)', [
      JSON.stringify({
        scope: { kind: 'USER', tenantId: b.tenantId, targetId: b.tenantId },
        kind: 'KILL_SWITCH',
        key: 'kill',
        state: 'PAUSED',
        eventId: randomUUID(),
        expectedEpoch: '0',
        reason: 'TEST_PAUSE',
        evidenceHash: 'a'.repeat(64),
      }),
    ]);
    await p.query('COMMIT');
  } finally {
    await p.query('ROLLBACK').catch(() => {});
    p.release();
  }
  const account = {
      tenantId: b.tenantId,
      connectionId: b.connectionId,
      externalAccountId: b.externalAccountId,
    },
    authorization = {
      commandId: cmd.intentId,
      commandHash: c.commandHash,
      dispatchAttemptId: c.attemptId,
      profile: b.profile,
      account,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1000,
    };
  expect(
    await store.authorize(
      'cancelOrder',
      { command: c.command, authorization },
      { ...io(), profile: b.profile, account, correlationId: randomUUID() },
    ),
  ).toBe(false);
  expect(
    (
      await admin.query<{ started: Date | null }>(
        'SELECT "transportStartedAt" AS started FROM submission_attempt WHERE id=$1',
        [c.attemptId],
      )
    ).rows[0]?.started,
  ).toBeNull();
});
it('fresh complete history restores a durable gap without inventing a new native timestamp', async () => {
  const { b, s } = await submitted(),
    o = observation(s);
  await store.observe(b, s.id, o, io());
  await store.gap(b, s.id, io());
  const restarted = await open();
  try {
    const r = await restarted.complete(b, s.id, o, io());
    expect(r.reconciliation).toBe('CONSISTENT');
    expect(r.status).toBe('SUBMITTED');
    expect((await restarted.read(b, s.id, io())).activeAttemptId).toBeNull();
  } finally {
    await restarted.close();
  }
});
it('CANCEL references current rules after refresh while preserving original PLACE identity', async () => {
  const { b, s } = await submitted();
  await store.observe(b, s.id, observation(s), io());
  await admin.query('UPDATE instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    s.draft.dbRuleId,
  ]);
  const rule = randomUUID();
  await admin.query(
    `INSERT INTO instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity",rules) VALUES($1,$2,2,true,now(),now(),$3,0.01,0.001,0.001,'{"version":"v2"}')`,
    [rule, s.draft.dbInstrumentId, Buffer.alloc(32, 2)],
  );
  const cmd = await store.cancelIntent(b, s.id, 'cancel-refreshed', io());
  expect(cmd.ruleVersion).toBe('v2');
  const g = await grant(s, cmd.intentId, cmd.commandHash);
  expect((await store.begin(b, s.id, cmd.intentId, g, io()))?.operation).toBe('CANCEL');
  expect((await store.read(b, s.id, io())).command.ruleVersion).toBe('v1');
  expect(
    (
      await admin.query<{ rule: string }>(
        'SELECT "ruleVersionId" AS rule FROM order_intent WHERE id=$1',
        [s.intentId],
      )
    ).rows[0]?.rule,
  ).toBe(s.draft.dbRuleId);
  expect(
    (
      await admin.query<{ rule: string }>(
        'SELECT "ruleVersionId" AS rule FROM order_intent WHERE id=$1',
        [cmd.intentId],
      )
    ).rows[0]?.rule,
  ).toBe(rule);
});
it('native UNKNOWN keeps the attempt unresolved until a positive scoped observation', async () => {
  const { b, s, c } = await submitted(),
    o = observation(s, { status: 'UNKNOWN' });
  const r = await store.observe(b, s.id, o, io());
  expect(r.activeAttemptId).toBe(c.attemptId);
  await expect(store.complete(b, s.id, o, io())).rejects.toThrow('ORDER_HISTORY_REQUIRED');
  expect(
    (
      await admin.query<{ status: string }>('SELECT status FROM submission_attempt WHERE id=$1', [
        c.attemptId,
      ])
    ).rows[0]?.status,
  ).toBe('UNKNOWN');
});
it('adopts existing Portfolio fill/fees exactly once without another monetary ledger', async () => {
  const { b, s } = await submitted();
  await store.observe(
    b,
    s.id,
    observation(s, {
      status: 'PARTIALLY_FILLED',
      filledQuantity: '2',
      averageFillPrice: { state: 'AVAILABLE', value: '100' },
    }),
    io(),
  );
  const pb = {
    ...portfolioBinding(),
    tenantId: b.tenantId,
    accountId: b.accountId,
    connectionId: b.connectionId,
    externalAccountId: b.externalAccountId,
  };
  await portfolio.apply(pb, snapshot({ timestamp: s.createdAt - 1 }), 0, io());
  const e = fill({
    instrumentId: s.command.instrumentId,
    internalOrderId: s.id,
    ruleVersion: 'v1',
    timestamp: Date.now(),
    quantity: '2',
    native: {
      fillId: 'trade-1',
      identityScope: 'native-trades',
      exchangeOrderId: 'remote-' + s.id,
    },
    fees: [{ asset: 'USDT', amount: '1', quoteEquivalent: '1' }],
  });
  await portfolio.apply(pb, e, 1, io());
  const book = (
    await admin.query<{ id: string }>('SELECT id FROM ctp_portfolio.book WHERE "tenantId"=$1', [
      b.tenantId,
    ])
  ).rows[0]?.id as string;
  const count = async () =>
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM ledger_transaction WHERE "tenantId"=$1',
          [b.tenantId],
        )
      ).rows[0]?.n as number,
    before = await count();
  const r = await store.adopt(b, s.id, book, e.id, io());
  expect(r.filledQuantity).toBe('2');
  expect(r.executedQuantity).toBe('2');
  expect(await count()).toBe(before);
  const restarted = await open();
  try {
    expect((await restarted.adopt(b, s.id, book, e.id, io())).version).toBe(r.version);
  } finally {
    await restarted.close();
  }
  expect(
    (
      await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM fill WHERE "tenantId"=$1', [
        b.tenantId,
      ])
    ).rows[0]?.n,
  ).toBe(1);
  expect(
    (
      await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM fee WHERE "tenantId"=$1', [
        b.tenantId,
      ])
    ).rows[0]?.n,
  ).toBe(1);
});
it('tenant ownership and exact TESTNET storage binding fail closed', async () => {
  const { b, draft } = await fixture(),
    s = await store.create(b, draft, io());
  for (const forged of [
    { ...b, tenantId: randomUUID() },
    { ...b, externalAccountId: 'forged' },
    { ...b, connectionId: randomUUID() },
    { ...b, mode: 'DEMO' as const, profile: { ...b.profile, environment: 'DEMO' as const } },
  ])
    await expect(store.read(forged, s.id, io())).rejects.toThrow('ORDER_BINDING_DENIED');
});
it('outbox failure rolls back intent, command and client counter', async () => {
  const { b, draft } = await fixture();
  await admin.query(
    `CREATE FUNCTION ctp_execution.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tenantId"='${b.tenantId}'::uuid THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER execution_test_fail BEFORE INSERT ON outbox_event FOR EACH ROW EXECUTE FUNCTION ctp_execution.test_fail()`,
  );
  try {
    await expect(store.create(b, draft, io())).rejects.toThrow();
    expect(
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM order_intent WHERE "tenantId"=$1',
          [b.tenantId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await admin.query<{ counter: string }>(
          'SELECT "clientIdHighWatermark"::text AS counter FROM exchange_account WHERE id=$1',
          [b.accountId],
        )
      ).rows[0]?.counter,
    ).toBe('9007199254740992');
  } finally {
    await admin.query(
      'DROP TRIGGER execution_test_fail ON outbox_event; DROP FUNCTION ctp_execution.test_fail()',
    );
  }
});
it.each(['abort', 'deadline'] as const)(
  'settles real account row lock on %s and frees pool capacity',
  async (mode) => {
    const { b, draft } = await fixture(),
      locker = await admin.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM exchange_account WHERE id=$1 FOR UPDATE', [b.accountId]);
    const controller = new AbortController(),
      timer = mode === 'abort' ? setTimeout(() => controller.abort(), 50) : undefined,
      start = Date.now();
    try {
      await expect(
        store.create(b, draft, io(controller.signal, mode === 'deadline' ? 50 : 2000)),
      ).rejects.toThrow('ORDER_ABORTED');
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      if (timer) clearTimeout(timer);
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect((await store.create(b, draft, io())).status).toBe('CREATED');
  },
);
