import { expect, it, vi } from 'vitest';
import * as scheduler from './role-scoped-cohorts.mjs';
import { discoverDatabaseFiles, planDatabaseCohorts } from './database-cohorts.mjs';

function required(name) {
  const value = scheduler[name];
  expect(typeof value, `CERTIFIED_NATIVE_CLUSTER_${name}_REQUIRED`).toBe('function');
  return value;
}
function endpoint(side) {
  return {
    project:
      side === 'primary' ? 'ctp-integration-901-aabbcc112233' : 'ctp-integration-901-aabbcc112232',
    containerId: (side === 'primary' ? 'a' : 'b').repeat(64),
    port: side === 'primary' ? 34001 : 34002,
  };
}
function database(id, roles = new Map()) {
  const query = vi.fn(async (sql, values = []) => {
    if (sql === 'SELECT system_identifier::text AS id FROM pg_control_system()')
      return { rows: [{ id }] };
    const name = /"(ctp_cluster_probe_[a-f0-9]{12})"/u.exec(sql)?.[1];
    if (sql.startsWith('CREATE ROLE ')) {
      if (!name || roles.has(name)) throw Error('DUPLICATE_OR_UNOWNED_PROBE_ROLE');
      roles.set(name, false);
      return { rows: [] };
    }
    if (sql.startsWith('ALTER ROLE ')) {
      if (!roles.has(name)) throw Error('MISSING_PROBE_ROLE');
      roles.set(name, sql.endsWith(' LOGIN'));
      return { rows: [] };
    }
    if (sql === 'SELECT rolcanlogin FROM pg_roles WHERE rolname=$1')
      return { rows: roles.has(values[0]) ? [{ rolcanlogin: roles.get(values[0]) }] : [] };
    if (sql.startsWith('DROP ROLE ')) {
      if (!roles.delete(name)) throw Error('MISSING_PROBE_ROLE');
      return { rows: [] };
    }
    throw Error('UNREVIEWED_NATIVE_ISOLATION_QUERY');
  });
  return { query, roles };
}
function fixture() {
  return {
    primary: database('9007199254740992'),
    secondary: database('9007199254740993'),
    primaryEndpoint: endpoint('primary'),
    secondaryEndpoint: endpoint('secondary'),
  };
}

it('retains the conservative single-cluster barrier when no physical isolation is certified', async () => {
  const original = planDatabaseCohorts(await discoverDatabaseFiles(), {
    executionStartOverlap: true,
  });
  const plan = await scheduler.planRoleScopedCohorts(original);
  expect(plan.find((c) => c.id === 'main').after).toEqual(['registry']);
  expect(plan.find((c) => c.id === 'main-scoped').after).toEqual(['main', 'registry']);
});

it('requires an explicit certified secondary-cluster planner and bounded physical executor', () => {
  for (const name of [
    'createNativeClusterIsolation',
    'assertNativeClusterIsolation',
    'planClusterIsolatedCohorts',
    'runClusterIsolatedCohorts',
  ])
    required(name);
});

it('rejects two databases or ports on the same physical PostgreSQL system before role probes', async () => {
  const f = fixture();
  f.secondary = database('9007199254740992');
  await expect(required('createNativeClusterIsolation')(f)).rejects.toThrow(
    'NATIVE_CLUSTER_ISOLATION',
  );
  expect(
    [...f.primary.query.mock.calls, ...f.secondary.query.mock.calls].some(([sql]) =>
      sql.startsWith('CREATE ROLE '),
    ),
  ).toBe(false);
});

it('rejects a reused container or project before querying an endpoint', async () => {
  for (const field of ['containerId', 'project', 'port']) {
    const f = fixture();
    f.secondaryEndpoint[field] = f.primaryEndpoint[field];
    await expect(required('createNativeClusterIsolation')(f)).rejects.toThrow(
      'NATIVE_CLUSTER_ISOLATION',
    );
    expect(f.primary.query).not.toHaveBeenCalled();
    expect(f.secondary.query).not.toHaveBeenCalled();
  }
});

it('compares native system identifiers losslessly and proves cross-cluster role independence', async () => {
  const f = fixture();
  const certificate = await required('createNativeClusterIsolation')(f);
  expect(certificate.primary.systemIdentifier).toBe('9007199254740992');
  expect(certificate.secondary.systemIdentifier).toBe('9007199254740993');
  expect(required('assertNativeClusterIsolation')(certificate)).toBe(certificate);
  expect(Object.isFrozen(certificate)).toBe(true);
  expect(Object.isFrozen(certificate.primary)).toBe(true);
  expect(
    f.primary.query.mock.calls.some(
      ([sql]) => sql.startsWith('ALTER ROLE ') && sql.endsWith(' LOGIN'),
    ),
  ).toBe(true);
  expect(f.primary.roles.size).toBe(0);
  expect(f.secondary.roles.size).toBe(0);
});

it('rejects a forged or deserialized certificate instead of trusting reported project or system IDs', async () => {
  const check = required('assertNativeClusterIsolation');
  expect(() => check({ primary: endpoint('primary'), secondary: endpoint('secondary') })).toThrow(
    'NATIVE_CLUSTER_ISOLATION',
  );
  const certificate = await required('createNativeClusterIsolation')(fixture());
  expect(() => check(JSON.parse(JSON.stringify(certificate)))).toThrow('NATIVE_CLUSTER_ISOLATION');
});

it('rejects misrouted probes even if two different system IDs were reported and drains owned roles', async () => {
  const f = fixture();
  f.secondary = database('9007199254740993', f.primary.roles);
  await expect(required('createNativeClusterIsolation')(f)).rejects.toThrow();
  expect(f.primary.roles.size).toBe(0);
});

it('releases independent reviewed work after registry only while preserving all files and final financial barriers', async () => {
  const certificate = await required('createNativeClusterIsolation')(fixture());
  const original = planDatabaseCohorts(await discoverDatabaseFiles(), {
    executionStartOverlap: true,
  });
  const plan = await required('planClusterIsolatedCohorts')(original, certificate);
  expect(plan.find((c) => c.id === 'main').after).toEqual(['registry']);
  expect(plan.find((c) => c.id === 'main-scoped').after).toEqual(['registry']);
  expect(plan.find((c) => c.id === 'admission').after).toEqual(['registry', 'main-scoped']);
  expect(plan.find((c) => c.id === 'native-admission').after).toEqual(['registry', 'main-scoped']);
  expect(plan.flatMap((c) => c.files).sort()).toEqual(original.flatMap((c) => c.files).sort());
  expect(plan.find((c) => c.id === 'execution-commit').after).toContain('main');
  expect(plan.find((c) => c.id === 'execution-commit').after).toContain('main-scoped');
  expect(plan.at(-1).after).toEqual(plan.slice(0, -1).map((c) => c.id));
});
