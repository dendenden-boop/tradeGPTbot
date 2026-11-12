import { expect, it, vi } from 'vitest';
import {
  nativeActorRegistrations,
  nativeClusterActorGroups,
  cloneNativeClusterActors,
} from './native-cluster-actors.mjs';
const database = 'ctp_p2_fresh_aabbcc112233';
function environment() {
  const env = {
    DATABASE_MIGRATION_URL: `postgresql://ctp_test:${'1'.repeat(48)}@127.0.0.1:34001/${database}`,
  };
  let index = 0;
  for (const key of Object.keys(nativeClusterActorGroups))
    env[key] =
      `postgresql://ctp_p2_actor_${index++}_aabbcc112233:${'2'.repeat(48)}@127.0.0.1:34001/${database}`;
  return env;
}
function flags(name) {
  return {
    rolname: name,
    rolsuper: false,
    rolinherit: true,
    rolcreaterole: false,
    rolcreatedb: false,
    rolcanlogin: true,
    rolreplication: false,
    rolbypassrls: false,
    rolconnlimit: -1,
    rolvaliduntil: null,
    rolconfig: null,
  };
}
function fixture({ unsafe = false, extraMembership = false, fixedMismatch = false } = {}) {
  const env = environment(),
    registered = nativeActorRegistrations(env, { primaryPort: 34001, database });
  function client(source) {
    const roles = new Map(),
      members = new Map();
    if (source)
      for (const a of registered) {
        roles.set(a.name, { ...flags(a.name), ...(unsafe ? { rolsuper: true } : {}) });
        members.set(a.name, [{ role: a.group, admin: extraMembership, inherit: true, set: true }]);
      }
    const query = vi.fn(async (sql, values = []) => {
      if (sql.includes('FROM pg_roles WHERE rolname=$1'))
        return { rows: roles.has(values[0]) ? [roles.get(values[0])] : [] };
      if (sql.includes('FROM pg_auth_members') && sql.includes('WHERE m.rolname=$1'))
        return { rows: members.get(values[0]) ?? [] };
      if (sql.startsWith('SELECT') && sql.includes('FROM pg_roles'))
        return { rows: !source && fixedMismatch ? [{ rolname: 'unreviewed_fixed_role' }] : [] };
      if (sql.startsWith('SELECT') && sql.includes('FROM pg_auth_members')) return { rows: [] };
      if (sql.startsWith('CREATE ROLE ')) {
        const name = /^CREATE ROLE "([a-z0-9_]+)"/u.exec(sql)[1];
        roles.set(name, flags(name));
        return { rows: [] };
      }
      if (sql.startsWith('GRANT ')) {
        const [, group, name] = /^GRANT "([a-z0-9_]+)" TO "([a-z0-9_]+)"$/u.exec(sql);
        members.set(name, [{ role: group, admin: false, inherit: true, set: true }]);
        return { rows: [] };
      }
      throw Error('UNREVIEWED_ACTOR_PROVISION_QUERY');
    });
    return { query, roles, members };
  }
  return { env, registered, primary: client(true), secondary: client(false) };
}
it('binds every fixed actor capability to complete generated primary profiles before provisioning', () => {
  const entries = nativeActorRegistrations(environment(), { primaryPort: 34001, database });
  expect(entries).toHaveLength(32);
  expect(new Set(entries.map((a) => a.name)).size).toBe(32);
  for (const a of entries) expect(a.group).toBe(nativeClusterActorGroups[a.key]);
});
it.each(['port', 'database', 'credentials', 'extra-field', 'duplicate-actor'])(
  'rejects contradictory or caller-added actor profiles before SQL: %s',
  async (kind) => {
    const f = fixture();
    if (kind === 'extra-field') f.env.DATABASE_UNKNOWN_URL = f.env.DATABASE_EXECUTION_URL;
    else if (kind === 'duplicate-actor') f.env.DATABASE_AUTH_URL = f.env.DATABASE_EXECUTION_URL;
    else {
      const u = new URL(f.env.DATABASE_EXECUTION_URL);
      if (kind === 'port') u.port = '34002';
      if (kind === 'database') u.pathname = '/other';
      if (kind === 'credentials') u.password = 'not-server-generated';
      f.env.DATABASE_EXECUTION_URL = u.href;
    }
    await expect(
      cloneNativeClusterActors(f.primary, f.secondary, f.env, { primaryPort: 34001, database }),
    ).rejects.toThrow('NATIVE_CLUSTER_ACTOR_PROFILE');
    expect(f.primary.query).not.toHaveBeenCalled();
    expect(f.secondary.query).not.toHaveBeenCalled();
  },
);
it.each([{ unsafe: true }, { extraMembership: true }, { fixedMismatch: true }])(
  'rejects an unsafe source/graph before creating any secondary login %j',
  async (options) => {
    const f = fixture(options);
    await expect(
      cloneNativeClusterActors(f.primary, f.secondary, f.env, { primaryPort: 34001, database }),
    ).rejects.toThrow(/NATIVE_CLUSTER_(?:ACTOR_SOURCE|FIXED_ROLE_GRAPH)/u);
    expect(f.secondary.query.mock.calls.some(([sql]) => sql.startsWith('CREATE ROLE '))).toBe(
      false,
    );
  },
);
it('creates only matching restricted generated logins and verifies every target membership without returning credentials', async () => {
  const f = fixture(),
    result = await cloneNativeClusterActors(f.primary, f.secondary, f.env, {
      primaryPort: 34001,
      database,
    });
  expect(result.actors).toBe(32);
  expect(result.fixedRoleGraphHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(result)).not.toContain('2'.repeat(48));
  expect(f.secondary.roles.size).toBe(32);
  for (const a of f.registered) {
    expect(f.secondary.roles.get(a.name)).toEqual(flags(a.name));
    expect(f.secondary.members.get(a.name)).toEqual([
      { role: a.group, admin: false, inherit: true, set: true },
    ]);
  }
});
