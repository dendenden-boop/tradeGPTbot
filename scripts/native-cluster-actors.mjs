// Server-generated test actors only. Never accepts an external account/credential.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const nativeClusterActorGroups = Object.freeze({
  DATABASE_RUNTIME_URL: 'ctp_api',
  DATABASE_AUTH_URL: 'ctp_auth',
  DATABASE_INGEST_URL: 'ctp_ingest',
  DATABASE_PORTFOLIO_URL: 'ctp_portfolio',
  DATABASE_EXECUTION_URL: 'ctp_execution',
  DATABASE_RISK_CONTROL_URL: 'ctp_risk_control',
  DATABASE_RISK_OPERATOR_URL: 'ctp_risk_operator',
  DATABASE_RISK_POLICY_OPERATOR_URL: 'ctp_risk_policy_operator',
  DATABASE_RISK_POLICY_CONTROLLER_URL: 'ctp_risk_policy_controller',
  DATABASE_RISK_EVIDENCE_URL: 'ctp_risk_evidence_collector',
  DATABASE_MARKET_SNAPSHOT_URL: 'ctp_market_snapshot',
  DATABASE_MARKET_TRADE_URL: 'ctp_market_trade',
  DATABASE_RISK_SNAPSHOT_URL: 'ctp_risk_snapshot_reader',
  DATABASE_INSTRUMENT_REGISTRY_URL: 'ctp_instrument_registry',
  DATABASE_RISK_CERTIFICATION_URL: 'ctp_risk_certifier',
  DATABASE_RISK_OBSERVATION_URL: 'ctp_risk_observer',
  DATABASE_RISK_ADMISSION_URL: 'ctp_risk_admission',
  DATABASE_PAPER_ADMISSION_URL: 'ctp_paper_risk_admission',
  DATABASE_PAPER_CONFIGURATION_URL: 'ctp_paper_configuration',
  DATABASE_PAPER_FUNDING_URL: 'ctp_paper_funding',
  DATABASE_PAPER_PORTFOLIO_URL: 'ctp_paper_portfolio_reader',
  DATABASE_PAPER_BOOK_URL: 'ctp_paper_book_initializer',
  DATABASE_PAPER_BOOK_SOURCE_URL: 'ctp_paper_book_source',
  DATABASE_PAPER_RISK_PORTFOLIO_URL: 'ctp_paper_risk_portfolio',
  DATABASE_PAPER_RISK_VALUATION_URL: 'ctp_paper_risk_valuation',
  DATABASE_PAPER_RISK_LOSS_URL: 'ctp_paper_risk_loss',
  DATABASE_PAPER_ORDER_RISK_URL: 'ctp_paper_order_risk',
  DATABASE_PAPER_RUNTIME_OBSERVER_URL: 'ctp_paper_runtime_observer',
  DATABASE_PAPER_RUNTIME_READER_URL: 'ctp_paper_runtime_reader',
  DATABASE_PAPER_RISK_AUTHORITY_URL: 'ctp_paper_risk_authority',
  DATABASE_PAPER_RISK_CONTEXT_URL: 'ctp_paper_risk_context',
  DATABASE_PAPER_TENANT_RISK_CONTEXT_URL: 'ctp_paper_tenant_risk_context',
});
const flags =
  'rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code) => {
  throw Error(code);
};
const fixed = "rolname LIKE 'ctp_%' AND rolname<>'ctp_test' AND rolname !~ '^ctp_p2_'";
export async function nativeRoleCatalog(client, fixedOnly = false) {
  const roles = (
    await client.query(
      `SELECT ${flags} FROM pg_roles ${fixedOnly ? 'WHERE ' + fixed : ''} ORDER BY rolname COLLATE "C"`,
    )
  ).rows;
  const members = (
    await client.query(
      `SELECT r.rolname AS role,m.rolname AS member,a.admin_option AS admin,a.inherit_option AS inherit,a.set_option AS set FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member ${fixedOnly ? "WHERE m.rolname LIKE 'ctp_%' AND m.rolname<>'ctp_test' AND m.rolname !~ '^ctp_p2_'" : ''} ORDER BY m.rolname COLLATE "C",r.rolname COLLATE "C",a.admin_option,a.inherit_option,a.set_option`,
    )
  ).rows;
  return { roles, members };
}
export const nativeRoleCatalogHash = async (client) => hash(await nativeRoleCatalog(client));
export function nativeActorRegistrations(env, { primaryPort, database }) {
  try {
    assert.match(database, /^ctp_p2_fresh_[a-f0-9]{12}$/u);
    const suffix = database.slice(-12);
    assert.deepEqual(
      Object.keys(env)
        .filter((k) => k.startsWith('DATABASE_'))
        .sort(),
      ['DATABASE_MIGRATION_URL', ...Object.keys(nativeClusterActorGroups)].sort(),
    );
    const actors = [];
    for (const key of ['DATABASE_MIGRATION_URL', ...Object.keys(nativeClusterActorGroups)]) {
      const url = new URL(env[key]);
      assert.equal(url.protocol, 'postgresql:');
      assert.equal(url.hostname, '127.0.0.1');
      assert.equal(url.port, String(primaryPort));
      assert.equal(url.pathname, '/' + database);
      assert.equal(url.search, '');
      assert.equal(url.hash, '');
      if (!/^[a-f0-9]{48}$/u.test(url.password)) fail('NATIVE_CLUSTER_ACTOR_PROFILE');
      if (key === 'DATABASE_MIGRATION_URL') {
        assert.equal(url.username, 'ctp_test');
        continue;
      }
      assert.match(url.username, /^ctp_p2_[a-z0-9_]+_[a-f0-9]{12}$/u);
      assert(url.username.endsWith('_' + suffix));
      actors.push({
        key,
        name: url.username,
        password: url.password,
        group: nativeClusterActorGroups[key],
      });
    }
    assert.equal(new Set(actors.map((a) => a.name)).size, actors.length);
    return actors;
  } catch {
    fail('NATIVE_CLUSTER_ACTOR_PROFILE');
  }
}
async function actor(client, name) {
  const rows = (await client.query(`SELECT ${flags} FROM pg_roles WHERE rolname=$1`, [name])).rows;
  const membership = (
    await client.query(
      'SELECT r.rolname AS role,a.admin_option AS admin,a.inherit_option AS inherit,a.set_option AS set FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE m.rolname=$1 ORDER BY r.rolname COLLATE "C"',
      [name],
    )
  ).rows;
  return { rows, membership };
}
export async function cloneNativeClusterActors(primary, secondary, env, profile) {
  const registrations = nativeActorRegistrations(env, profile);
  const before = await nativeRoleCatalog(primary, true),
    target = await nativeRoleCatalog(secondary, true);
  try {
    assert.deepEqual(target, before);
  } catch {
    fail('NATIVE_CLUSTER_FIXED_ROLE_GRAPH');
  }
  const sources = [];
  for (const a of registrations) {
    const source = await actor(primary, a.name),
      r = source.rows[0];
    if (
      source.rows.length !== 1 ||
      r.rolcanlogin !== true ||
      r.rolsuper ||
      r.rolcreaterole ||
      r.rolcreatedb ||
      r.rolreplication ||
      r.rolbypassrls ||
      r.rolinherit !== true ||
      r.rolconnlimit !== -1 ||
      r.rolvaliduntil !== null ||
      r.rolconfig !== null
    )
      fail('NATIVE_CLUSTER_ACTOR_SOURCE');
    try {
      assert.deepEqual(source.membership, [
        { role: a.group, admin: false, inherit: true, set: true },
      ]);
    } catch {
      fail('NATIVE_CLUSTER_ACTOR_SOURCE');
    }
    sources.push(source);
  }
  for (const [a, index] of registrations.map((a, index) => [a, index])) {
    await secondary.query(
      `CREATE ROLE "${a.name}" LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${a.password}'`,
    );
    await secondary.query(`GRANT "${a.group}" TO "${a.name}"`);
    try {
      assert.deepEqual(await actor(secondary, a.name), sources[index]);
    } catch {
      fail('NATIVE_CLUSTER_ACTOR_TARGET');
    }
  }
  return Object.freeze({ actors: registrations.length, fixedRoleGraphHash: hash(before) });
}
