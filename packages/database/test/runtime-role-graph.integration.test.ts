import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { createDatabase, createAuthDatabase } from '@ctp/database';
import {
  createPostgresMarketStore,
  createPostgresMarketSnapshots,
  createPostgresInstrumentRegistry,
} from '@ctp/market-data';
import { createPostgresPortfolioStore } from '@ctp/portfolio';
import { createPostgresOrderStore } from '@ctp/order-engine';
import {
  createPostgresControls,
  createPostgresPolicies,
  createPostgresLossJournal,
  createPostgresRiskPortfolioReader,
} from '@ctp/risk-engine';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_ROLE_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_ROLE_VARIABLE_REQUIRED');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 2,
  query_timeout: 5000,
});
afterAll(() => admin.end());
type Options = { connectionString: string; environment: 'test' };
type Handle = { close(): Promise<void> };
const cases: readonly [string, string, (options: Options) => Promise<Handle>][] = [
  ['ctp_api', 'DATABASE_RUNTIME_URL', createDatabase],
  ['ctp_auth', 'DATABASE_AUTH_URL', createAuthDatabase],
  ['ctp_ingest', 'DATABASE_INGEST_URL', createPostgresMarketStore],
  ['ctp_portfolio', 'DATABASE_PORTFOLIO_URL', createPostgresPortfolioStore],
  ['ctp_execution', 'DATABASE_EXECUTION_URL', createPostgresOrderStore],
  [
    'ctp_risk_operator',
    'DATABASE_RISK_OPERATOR_URL',
    (o) => createPostgresControls({ ...o, authority: 'GLOBAL' }),
  ],
  [
    'ctp_risk_control',
    'DATABASE_RISK_CONTROL_URL',
    (o) => createPostgresControls({ ...o, authority: 'TENANT' }),
  ],
  [
    'ctp_risk_policy_operator',
    'DATABASE_RISK_POLICY_OPERATOR_URL',
    (o) => createPostgresPolicies({ ...o, authority: 'PLATFORM' }),
  ],
  [
    'ctp_risk_policy_controller',
    'DATABASE_RISK_POLICY_CONTROLLER_URL',
    (o) => createPostgresPolicies({ ...o, authority: 'USER' }),
  ],
  ['ctp_risk_evidence_collector', 'DATABASE_RISK_EVIDENCE_URL', createPostgresLossJournal],
  ['ctp_market_snapshot', 'DATABASE_MARKET_SNAPSHOT_URL', createPostgresMarketSnapshots],
  ['ctp_risk_snapshot_reader', 'DATABASE_RISK_SNAPSHOT_URL', createPostgresRiskPortfolioReader],
  [
    'ctp_instrument_registry',
    'DATABASE_INSTRUMENT_REGISTRY_URL',
    (o) =>
      createPostgresInstrumentRegistry({
        ...o,
        scope: {
          exchange: 'BINANCE',
          market: 'SPOT',
          environment: 'TESTNET',
          region: 'role-audit',
        },
        instrumentIds: ['BTCUSDT'],
      }),
  ],
];
for (const [group, env, open] of cases) {
  it(`${group} admits its exact unmodified runtime role graph`, async () => {
    const handle = await open({ connectionString: required(env), environment: 'test' });
    await handle.close();
  });
  it(`${group} refuses a LOGIN grouping role at runtime startup`, async () => {
    await admin.query(`ALTER ROLE "${group}" LOGIN`);
    let accepted = false;
    try {
      try {
        const handle = await open({ connectionString: required(env), environment: 'test' });
        accepted = true;
        await handle.close();
      } catch {
        /* Expected only when startup actually denies the altered role graph. */
      }
      expect(accepted).toBe(false);
    } finally {
      await admin.query(`ALTER ROLE "${group}" NOLOGIN`);
    }
  });
  it(`${group} refuses extra private function authority across phase schemas`, async () => {
    const fn =
      group === 'ctp_instrument_registry'
        ? 'ctp_risk.capture_portfolio(jsonb)'
        : 'ctp_registry.publish(jsonb,jsonb)';
    await admin.query(`GRANT EXECUTE ON FUNCTION ${fn} TO "${group}"`);
    let accepted = false;
    try {
      try {
        const handle = await open({ connectionString: required(env), environment: 'test' });
        accepted = true;
        await handle.close();
      } catch {
        /* The positive baseline independently proves startup can succeed. */
      }
      expect(accepted).toBe(false);
    } finally {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${fn} FROM "${group}"`);
    }
  });
  it(`${group} refuses CREATE on the new registry schema`, async () => {
    await admin.query(`GRANT CREATE ON SCHEMA ctp_registry TO "${group}"`);
    let accepted = false;
    try {
      try {
        const handle = await open({ connectionString: required(env), environment: 'test' });
        accepted = true;
        await handle.close();
      } catch {
        /* Expected fail-closed startup. */
      }
      expect(accepted).toBe(false);
    } finally {
      await admin.query(`REVOKE CREATE ON SCHEMA ctp_registry FROM "${group}"`);
    }
  });
  it(`${group} refuses extra private column authority`, async () => {
    const table =
      group === 'ctp_instrument_registry' ? 'ctp_portfolio.book' : 'ctp_registry.current_record';
    const column = group === 'ctp_instrument_registry' ? 'state' : 'record';
    await admin.query(`GRANT SELECT(${column}) ON ${table} TO "${group}"`);
    let accepted = false;
    try {
      try {
        const handle = await open({ connectionString: required(env), environment: 'test' });
        accepted = true;
        await handle.close();
      } catch {
        /* Expected fail-closed startup. */
      }
      expect(accepted).toBe(false);
    } finally {
      await admin.query(`REVOKE SELECT(${column}) ON ${table} FROM "${group}"`);
    }
  });
}

it('all runtime grouping roles plus signer/auth owner have restricted NOLOGIN attributes', async () => {
  const names = [...cases.map(([group]) => group), 'ctp_signer', 'ctp_auth_owner'];
  const rows = await admin.query<{ rolname: string; unsafe: boolean }>(
    `SELECT rolname, rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication AS unsafe FROM pg_roles WHERE rolname=ANY($1::text[])`,
    [names],
  );
  expect(rows.rows).toHaveLength(names.length);
  expect(rows.rows.every((r) => !r.unsafe)).toBe(true);
});

it('private functions expose no PUBLIC execution and pin every SECURITY DEFINER search path', async () => {
  const unsafe = await admin.query(
    `SELECT n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk','ctp_registry') AND (EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') OR (p.prosecdef AND NOT coalesce(p.proconfig @> ARRAY['search_path=pg_catalog'],false)))`,
  );
  expect(unsafe.rows).toEqual([]);
});

it('all private Portfolio and execution authority tables enforce FORCE RLS', async () => {
  const unsafe = await admin.query(
    `SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('ctp_portfolio','ctp_execution','ctp_registry') AND c.relkind IN('r','p') AND NOT(c.relrowsecurity AND c.relforcerowsecurity)`,
  );
  expect(unsafe.rows).toEqual([]);
});
