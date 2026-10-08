import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  createPostgresPolicies,
  policyFingerprint,
  policyLimitsText,
  riskLimitsSchema,
  intersectRiskLimits,
  type PostgresPolicies,
  type PolicyUpdate,
} from '@ctp/risk-engine';
import { fixture as riskFixture } from '../../risk-engine/test/fixtures.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('Policy tests require isolated runner');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('Missing isolated policy variable');
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
const open = (authority: 'PLATFORM' | 'USER') =>
  createPostgresPolicies({
    connectionString: required(
      authority === 'PLATFORM'
        ? 'DATABASE_RISK_POLICY_OPERATOR_URL'
        : 'DATABASE_RISK_POLICY_CONTROLLER_URL',
    ),
    environment: 'test',
    authority,
  });
let operator: PostgresPolicies, controller: PostgresPolicies;
const request = (
  scope: PolicyUpdate['scope'],
  expectedVersion = '0',
  mode: PolicyUpdate['mode'] = 'TESTNET',
): PolicyUpdate => ({
  scope,
  mode,
  eventId: randomUUID(),
  expectedVersion,
  reason: 'ISOLATED_POLICY_TEST',
  limits: riskLimitsSchema.parse(riskFixture().user),
});
const sqlPayload = (p: PolicyUpdate) => {
  const { limits, ...identity } = p;
  return JSON.stringify({
    ...identity,
    limitsText: policyLimitsText(limits),
    limitsHash: policyFingerprint(limits),
  });
};
async function tenant() {
  const id = randomUUID();
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized","updatedAt") VALUES($1,$2,now())',
    [id, id + '@example.invalid'],
  );
  return id;
}
beforeAll(async () => {
  operator = await open('PLATFORM');
  controller = await open('USER');
  const head = await admin.query<{ version: string }>(
    "SELECT version::text FROM ctp_risk.policy_head WHERE scope='PLATFORM' AND mode='TESTNET'",
  );
  await operator.update(request({ kind: 'PLATFORM' }, head.rows[0]?.version ?? '0'), io());
});
afterAll(async () => {
  await operator?.close();
  await controller?.close();
  await admin.end();
});
it('durable policy exact replay/conflict survives A to B to A and process restart', async () => {
  const id = await tenant(),
    a = request({ kind: 'USER', tenantId: id });
  expect(await controller.update(a, io())).toEqual({
    version: '1',
    eventId: a.eventId,
    replayed: false,
  });
  await controller.update(
    {
      ...request(a.scope, '1'),
      limits: {
        ...a.limits,
        maxUserExposure: riskLimitsSchema.parse({ ...a.limits, maxUserExposure: '400' })
          .maxUserExposure,
      },
    },
    io(),
  );
  await controller.update({ ...request(a.scope, '2'), limits: a.limits }, io());
  const restarted = await open('USER');
  try {
    expect(await restarted.update(a, io())).toEqual({
      version: '1',
      eventId: a.eventId,
      replayed: true,
    });
    expect((await restarted.read(id, 'TESTNET', io()))[1]).toMatchObject({
      version: '3',
      limitsHash: policyFingerprint(a.limits),
    });
    await expect(restarted.update({ ...a, reason: 'CONFLICT' }, io())).rejects.toThrow(
      'RISK_POLICY_CONFLICT',
    );
    await expect(restarted.update(request(a.scope, '1'), io())).rejects.toThrow(
      'RISK_POLICY_STALE',
    );
  } finally {
    await restarted.close();
  }
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM ctp_risk.policy_revision WHERE "tenantId"=$1',
        [id],
      )
    ).rows[0]?.n,
  ).toBe(3);
});
it('concurrent policy CAS has exactly one winner', async () => {
  const id = await tenant(),
    scope = { kind: 'USER' as const, tenantId: id };
  const results = await Promise.allSettled([
    controller.update(request(scope), io()),
    controller.update(request(scope), io()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect((await controller.read(id, 'TESTNET', io()))[1]?.version).toBe('1');
});
it('concurrent exact replay creates one immutable revision', async () => {
  const p = request({ kind: 'USER', tenantId: await tenant() });
  const results = await Promise.all(Array.from({ length: 8 }, () => controller.update(p, io())));
  expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  expect(new Set(results.map((r) => r.version))).toEqual(new Set(['1']));
});
it('TESTNET and DEMO policy heads do not collapse', async () => {
  const id = await tenant(),
    scope = { kind: 'USER' as const, tenantId: id };
  await operator.update(request({ kind: 'PLATFORM' }, '0', 'DEMO'), io());
  await controller.update(request(scope), io());
  const demo = request(scope, '0', 'DEMO');
  await controller.update(
    { ...demo, limits: riskLimitsSchema.parse({ ...demo.limits, maxUserExposure: '99' }) },
    io(),
  );
  expect((await controller.read(id, 'TESTNET', io()))[1]?.limits.maxUserExposure).toBe('500');
  expect((await controller.read(id, 'DEMO', io()))[1]?.limits.maxUserExposure).toBe('99');
});
it('missing platform or user policy fails closed without defaults', async () => {
  const id = await tenant();
  await expect(controller.read(id, 'TESTNET', io())).rejects.toThrow('RISK_POLICY_MISSING');
  await expect(operator.read(null, 'LIVE', io())).rejects.toThrow('RISK_POLICY_MISSING');
  await controller.update(request({ kind: 'USER', tenantId: id }, '0', 'LIVE'), io());
  await expect(controller.read(id, 'LIVE', io())).rejects.toThrow('RISK_POLICY_MISSING');
});
it('policy read supplies current platform/user intersection and preserves exact decimals', async () => {
  const id = await tenant(),
    p = request({ kind: 'USER', tenantId: id });
  await controller.update(
    {
      ...p,
      limits: riskLimitsSchema.parse({
        ...p.limits,
        maxUserExposure: '9007199254740993.000000000000000001',
        minLiquidityNotional: '50.000000000000000001',
      }),
    },
    io(),
  );
  const heads = await controller.read(id, 'TESTNET', io());
  expect(heads[1]?.limits.maxUserExposure).toBe('9007199254740993.000000000000000001');
  expect(intersectRiskLimits(heads[0]?.limits, heads[1]?.limits)).toMatchObject({
    maxUserExposure: '500',
    minLiquidityNotional: '50.000000000000000001',
  });
});
it('different valuation currencies reject current-policy assembly', async () => {
  const id = await tenant(),
    p = request({ kind: 'USER', tenantId: id });
  await controller.update({ ...p, limits: { ...p.limits, valuationAsset: 'USD' } }, io());
  await expect(controller.read(id, 'TESTNET', io())).rejects.toThrow('RISK_POLICY_CURRENCY');
});
it('SQL policy history and head identity cannot be rewritten or removed', async () => {
  const id = await tenant();
  await controller.update(request({ kind: 'USER', tenantId: id }), io());
  for (const sql of [
    'DELETE FROM ctp_risk.policy_revision WHERE "tenantId"=$1',
    'UPDATE ctp_risk.policy_revision SET version=2 WHERE "tenantId"=$1',
    'DELETE FROM ctp_risk.policy_head WHERE "tenantId"=$1',
    'UPDATE ctp_risk.policy_head SET version=0 WHERE "tenantId"=$1',
    'UPDATE ctp_risk.policy_head SET target=gen_random_uuid(),version=version+1 WHERE "tenantId"=$1',
  ])
    await expect(admin.query(sql, [id])).rejects.toMatchObject({ code: '23514' });
});
it('raw SQL publisher cannot authorize another tenant or platform scope', async () => {
  const a = await tenant(),
    b = await tenant();
  const pool = new Pool({
    connectionString: required('DATABASE_RISK_POLICY_CONTROLLER_URL'),
    max: 1,
  });
  const p = await pool.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [a]);
    await expect(
      p.query('SELECT ctp_risk.update_user_policy($1::jsonb)', [
        sqlPayload(request({ kind: 'USER', tenantId: b })),
      ]),
    ).rejects.toThrow('RISK_POLICY_SCOPE');
    await p.query('ROLLBACK');
    await expect(
      p.query('SELECT ctp_risk.update_platform_policy($1::jsonb)', [
        sqlPayload(request({ kind: 'PLATFORM' })),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(p.query('SELECT * FROM ctp_risk.policy_revision')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      p.query('SELECT ctp_risk.write_policy($1::jsonb,$2,$3::uuid)', [
        sqlPayload(request({ kind: 'USER', tenantId: a })),
        'USER',
        a,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await p.query('ROLLBACK').catch(() => {});
    p.release();
    await pool.end();
  }
});
it('SQL rejects unknown constraints, noncanonical decimals and tampered content hashes', async () => {
  const valid = request({ kind: 'PLATFORM' }, '1');
  const wire = JSON.parse(sqlPayload(valid)) as Record<string, unknown>;
  for (const limits of [
    { ...valid.limits, futureConstraint: '1' },
    { ...valid.limits, maxUserExposure: '1e3' },
    { ...valid.limits, maxUserExposure: 500 },
    { ...valid.limits, maxDrawdownRate: '1.000000000000000001' },
    { ...valid.limits, maxEvidenceAgeMs: 0 },
  ]) {
    const text = JSON.stringify(limits);
    const digest = (
      await admin.query<{ hash: string }>(
        "SELECT encode(sha256(convert_to($1,'UTF8')),'hex') hash",
        [text],
      )
    ).rows[0]?.hash;
    await expect(
      admin.query('SELECT ctp_risk.update_platform_policy($1::jsonb)', [
        JSON.stringify({ ...wire, eventId: randomUUID(), limitsText: text, limitsHash: digest }),
      ]),
    ).rejects.toThrow('RISK_POLICY_INPUT');
  }
  await expect(
    admin.query('SELECT ctp_risk.update_platform_policy($1::jsonb)', [
      JSON.stringify({ ...wire, limitsHash: 'a'.repeat(64) }),
    ]),
  ).rejects.toThrow('RISK_POLICY_INPUT');
  await expect(
    admin.query('SELECT ctp_risk.update_user_policy($1::jsonb)', [
      JSON.stringify({ ...wire, scope: { kind: null, tenantId: await tenant() } }),
    ]),
  ).rejects.toThrow('RISK_POLICY_INPUT');
});
it.each([
  'DATABASE_MIGRATION_URL',
  'DATABASE_RUNTIME_URL',
  'DATABASE_AUTH_URL',
  'DATABASE_INGEST_URL',
  'DATABASE_PORTFOLIO_URL',
  'DATABASE_EXECUTION_URL',
  'DATABASE_RISK_CONTROL_URL',
  'DATABASE_RISK_OPERATOR_URL',
  'DATABASE_RISK_POLICY_OPERATOR_URL',
])('policy controller rejects mixed or wrong authority %s', async (key) => {
  await expect(
    createPostgresPolicies({
      connectionString: required(key),
      environment: 'test',
      authority: 'USER',
    }),
  ).rejects.toThrow('RISK_POLICY_ROLE_UNSAFE');
});
it('policy controller role has no Risk, execution or monetary writes', async () => {
  const role = new URL(required('DATABASE_RISK_POLICY_CONTROLLER_URL')).username;
  const r = await admin.query<{ safe: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN('public','ctp_execution','ctp_risk','ctp_portfolio') AND t.relkind IN('r','p') AND (has_table_privilege($1,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege($1,t.oid,'INSERT,UPDATE'))) safe`,
    [role],
  );
  expect(r.rows[0]?.safe).toBe(true);
});
it.each(['DIRECT_EXECUTION_GRANT', 'MIXED_PORTFOLIO_ROLE'] as const)(
  'SQL policy writer rejects %s without relying on factory checks',
  async (kind) => {
    const id = await tenant(),
      role = 'ctp_policy_boundary_' + randomUUID().replaceAll('-', ''),
      url = new URL(required('DATABASE_RISK_POLICY_CONTROLLER_URL'));
    url.username = role;
    url.password = randomUUID();
    const membership =
      kind === 'DIRECT_EXECUTION_GRANT'
        ? `GRANT ctp_execution TO "${role}"; GRANT EXECUTE ON FUNCTION ctp_risk.update_user_policy(jsonb) TO "${role}"`
        : `GRANT ctp_risk_policy_controller,ctp_portfolio TO "${role}"`;
    await admin.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${url.password}'; ${membership}`,
    );
    const pool = new Pool({ connectionString: url.toString(), max: 1 }),
      p = await pool.connect();
    try {
      await p.query('BEGIN');
      await p.query("SELECT set_config('app.tenant_id',$1,true)", [id]);
      await expect(
        p.query('SELECT ctp_risk.update_user_policy($1::jsonb)', [
          sqlPayload(request({ kind: 'USER', tenantId: id })),
        ]),
      ).rejects.toThrow('RISK_POLICY_ROLE_UNSAFE');
    } finally {
      await p.query('ROLLBACK').catch(() => {});
      p.release();
      await pool.end();
      const revoke =
        kind === 'DIRECT_EXECUTION_GRANT'
          ? `REVOKE EXECUTE ON FUNCTION ctp_risk.update_user_policy(jsonb) FROM "${role}"; REVOKE ctp_execution FROM "${role}"`
          : `REVOKE ctp_risk_policy_controller,ctp_portfolio FROM "${role}"`;
      await admin.query(`${revoke}; DROP ROLE "${role}"`);
    }
  },
);
it('policy CAS remains lossless above the JavaScript integer range', async () => {
  const id = await tenant(),
    p = request({ kind: 'USER', tenantId: id }),
    version = '9007199254740993';
  await admin.query(
    `INSERT INTO ctp_risk.policy_revision(scope,target,"tenantId",mode,version,id,payload,"limitsText","limitsHash") VALUES('USER',$1,$1,'TESTNET',$2::bigint,$3,$4::jsonb,$5,decode($6,'hex'));`,
    [
      id,
      version,
      p.eventId,
      sqlPayload(p),
      policyLimitsText(p.limits),
      policyFingerprint(p.limits),
    ],
  );
  await admin.query(
    `INSERT INTO ctp_risk.policy_head(scope,target,"tenantId",mode,version,id) VALUES('USER',$1,$1,'TESTNET',$2::bigint,$3)`,
    [id, version, p.eventId],
  );
  expect(await controller.update(request(p.scope, version), io())).toMatchObject({
    version: '9007199254740994',
  });
  expect((await controller.read(id, 'TESTNET', io()))[1]?.version).toBe('9007199254740994');
});
it.each(['EXTRA_FUNCTION', 'SCHEMA_CREATE', 'MIXED_ROLE'] as const)(
  'policy startup rejects %s authority escalation',
  async (kind) => {
    const role = 'ctp_policy_' + randomUUID().replaceAll('-', ''),
      url = new URL(required('DATABASE_RISK_POLICY_CONTROLLER_URL'));
    url.username = role;
    url.password = randomUUID();
    const extra =
      kind === 'EXTRA_FUNCTION'
        ? `GRANT EXECUTE ON FUNCTION ctp_risk.valid_limits(jsonb) TO "${role}"`
        : kind === 'SCHEMA_CREATE'
          ? `GRANT CREATE ON SCHEMA ctp_risk TO "${role}"`
          : `GRANT ctp_execution TO "${role}"`;
    await admin.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${url.password}'; GRANT ctp_risk_policy_controller TO "${role}"; ${extra}`,
    );
    try {
      await expect(
        createPostgresPolicies({
          connectionString: url.toString(),
          environment: 'test',
          authority: 'USER',
        }),
      ).rejects.toThrow('RISK_POLICY_ROLE_UNSAFE');
    } finally {
      const revoke =
        kind === 'EXTRA_FUNCTION'
          ? `REVOKE EXECUTE ON FUNCTION ctp_risk.valid_limits(jsonb) FROM "${role}"`
          : kind === 'SCHEMA_CREATE'
            ? `REVOKE CREATE ON SCHEMA ctp_risk FROM "${role}"`
            : `REVOKE ctp_execution FROM "${role}"`;
      await admin.query(
        `${revoke}; REVOKE ctp_risk_policy_controller FROM "${role}"; DROP ROLE "${role}"`,
      );
    }
  },
);
async function waiter() {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (
      (
        await admin.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) waiting",
        )
      ).rows[0]?.waiting
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Expected physical policy lock waiter');
}
it('physical policy read observes a committed replacement even with inherited REPEATABLE READ', async () => {
  const id = await tenant(),
    initial = request({ kind: 'USER', tenantId: id });
  await controller.update(initial, io());
  const role = 'ctp_policy_rr_' + randomUUID().replaceAll('-', ''),
    url = new URL(required('DATABASE_RISK_POLICY_CONTROLLER_URL'));
  url.username = role;
  url.password = randomUUID();
  await admin.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${url.password}'; GRANT ctp_risk_policy_controller TO "${role}"; ALTER ROLE "${role}" SET default_transaction_isolation='repeatable read'`,
  );
  let reader: PostgresPolicies | undefined;
  const locker = await admin.connect();
  try {
    reader = await createPostgresPolicies({
      connectionString: url.toString(),
      environment: 'test',
      authority: 'USER',
    });
    await locker.query('BEGIN');
    await locker.query("SELECT set_config('app.tenant_id',$1,true)", [id]);
    await locker.query('SELECT ctp_risk.update_user_policy($1::jsonb)', [
      sqlPayload(request(initial.scope, '1')),
    ]);
    const reading = reader.read(id, 'TESTNET', io());
    try {
      await waiter();
      await locker.query('COMMIT');
      expect((await reading)[1]?.version).toBe('2');
    } finally {
      await locker.query('ROLLBACK').catch(() => {});
      await reading.catch(() => {});
    }
  } finally {
    await locker.query('ROLLBACK').catch(() => {});
    locker.release();
    await reader?.close();
    await admin.query(`REVOKE ctp_risk_policy_controller FROM "${role}"; DROP ROLE "${role}"`);
  }
});
it.each(['PLATFORM', 'USER'] as const)(
  'physical %s policy replacement waits for earlier permit COMMIT',
  async (authority) => {
    const id = await tenant(),
      locker = await admin.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT pg_advisory_xact_lock_shared(1129599058,12)');
    await locker.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('ctp:risk:'||$1,0))", [
      id,
    ]);
    const platform = (await operator.read(null, 'TESTNET', io()))[0];
    if (!platform) throw new Error('Missing platform fixture');
    const p = request(
      authority === 'PLATFORM' ? { kind: 'PLATFORM' } : { kind: 'USER', tenantId: id },
      authority === 'PLATFORM' ? platform.version : '0',
    );
    let settled = false;
    const writing = (authority === 'PLATFORM' ? operator : controller)
      .update(p, io())
      .finally(() => {
        settled = true;
      });
    try {
      await waiter();
      expect(settled).toBe(false);
      await locker.query('COMMIT');
      expect(await writing).toMatchObject({ replayed: false });
    } finally {
      await locker.query('ROLLBACK').catch(() => {});
      locker.release();
      await writing.catch(() => {});
    }
  },
);
it.each(['abort', 'deadline'] as const)(
  'physical policy lock settles on %s without phantom revision',
  async (mode) => {
    const id = await tenant(),
      locker = await admin.connect(),
      abort = new AbortController();
    await locker.query('BEGIN');
    await locker.query('SELECT pg_advisory_xact_lock(1129599058,12)');
    const timer = mode === 'abort' ? setTimeout(() => abort.abort(), 50) : undefined,
      start = Date.now();
    try {
      await expect(
        controller.update(
          request({ kind: 'USER', tenantId: id }),
          io(abort.signal, mode === 'abort' ? 2000 : 50),
        ),
      ).rejects.toThrow('RISK_POLICY_ABORTED');
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      if (timer) clearTimeout(timer);
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect(await controller.update(request({ kind: 'USER', tenantId: id }), io())).toMatchObject({
      version: '1',
      replayed: false,
    });
  },
);
