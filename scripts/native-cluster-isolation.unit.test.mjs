import { expect, it, vi } from 'vitest';
import * as scheduler from './role-scoped-cohorts.mjs';
import { discoverDatabaseFiles, planDatabaseCohorts } from './database-cohorts.mjs';
import { mkdir, mkdtemp, access, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

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

const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(new URL('./fixtures/cluster-isolated-worker.mjs', import.meta.url));
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
async function physical() {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/isolated-'));
  const isolation = await required('createNativeClusterIsolation')(fixture());
  const original = planDatabaseCohorts(await discoverDatabaseFiles(), {
    executionStartOverlap: true,
  });
  const plan = await required('planClusterIsolatedCohorts')(original, isolation);
  const jobs = plan.map((p) => {
    const primary = ['main', 'registry', 'roles'].includes(p.id);
    const database =
      p.id === 'registry'
        ? 'ctp_p2_registry_cohort_aabbcc112233'
        : p.id === 'main-scoped'
          ? 'ctp_p2_fresh_aabbcc112232'
          : p.id === 'admission'
            ? 'ctp_p2_admission_cohort_aabbcc112233'
            : ['execution-start', 'execution-preview', 'execution-commit'].includes(p.id)
              ? 'ctp_p2_execution_start_cohort_aabbcc112233'
              : 'ctp_p2_fresh_aabbcc112233';
    return {
      ...p,
      database,
      cluster: primary ? 'PRIMARY' : 'SECONDARY',
      binary: process.execPath,
      args: [worker, dir, p.id, 'normal'],
      env: {
        ...process.env,
        DATABASE_MIGRATION_URL: `postgresql://ctp_test:${'1'.repeat(48)}@127.0.0.1:${primary ? 34001 : 34002}/${database}`,
      },
    };
  });
  return { dir, isolation, jobs };
}
async function waitFile(dir, name, pending) {
  const end = Date.now() + 3500;
  while (!(await exists(path.join(dir, name)))) {
    const result = await Promise.race([pending, delay(10).then(() => null)]);
    if (result) throw result.error ?? Error('UNEXPECTED_EARLY_ISOLATED_COMPLETION');
    if (Date.now() >= end) throw Error('ISOLATED_PHYSICAL_HANDSHAKE_DEADLINE');
  }
}
it('retains the entire existing bounded physical launcher and cleanup bytes', () => {
  const block = (file) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const begin = source.indexOf('  // BEGIN IDENTICAL PHYSICAL LAUNCHER'),
      end = source.indexOf('  // END IDENTICAL PHYSICAL LAUNCHER');
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    return source.slice(begin, end);
  };
  expect(block('./cluster-isolated-cohorts.mjs')).toBe(block('./role-scoped-cohorts.mjs'));
});
it('rejects mismatched physical routing with an issued certificate before any native child starts', async () => {
  const { isolation, jobs } = await physical();
  for (const job of jobs) job.args = ['-e', 'process.exit(0)'];
  jobs.find((j) => j.id === 'main-scoped').env.DATABASE_MIGRATION_URL =
    'postgresql://ctp_test:unit@127.0.0.1:34001/ctp_p2_fresh_aabbcc112232';
  await expect(
    required('runClusterIsolatedCohorts')(jobs, { timeoutMs: 5000, isolation }),
  ).rejects.toThrow('NATIVE_CLUSTER_ROUTE');
});
it('physically overlaps certified independent domains only after registry closes and retains both final barriers', async () => {
  const { dir, isolation, jobs } = await physical(),
    controller = new AbortController();
  for (const job of jobs) if (['main', 'admission'].includes(job.id)) job.args[3] = 'controlled';
  const pending = required('runClusterIsolatedCohorts')(jobs, {
    timeoutMs: 5000,
    isolation,
    signal: controller.signal,
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await waitFile(dir, 'admission.started', pending);
    expect(await exists(path.join(dir, 'main.started'))).toBe(true);
    expect(await exists(path.join(dir, 'main.done'))).toBe(false);
    expect(await readFile(path.join(dir, 'registry.done'), 'utf8')).toBe('done');
    expect(await readFile(path.join(dir, 'main-scoped.done'), 'utf8')).toBe('done');
    await writeFile(path.join(dir, 'main.release'), 'release');
    await waitFile(dir, 'execution-preview.done', pending);
    expect(await exists(path.join(dir, 'admission.done'))).toBe(false);
    expect(await exists(path.join(dir, 'execution-commit.started'))).toBe(false);
    await writeFile(path.join(dir, 'admission.release'), 'release');
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.value.timeoutMs).toBe(5000);
    const times = new Map(result.value.completed.map((c) => [c.id, c]));
    expect(times.get('main-scoped').startMs).toBeLessThan(times.get('main').settledMs);
    expect(times.get('roles').startMs).toBeGreaterThanOrEqual(
      times.get('execution-commit').settledMs,
    );
    let active = 0;
    for (const [, delta] of result.value.completed
      .flatMap((c) => [
        [c.startMs, 1],
        [c.settledMs, -1],
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      active += delta;
      expect(active).toBeGreaterThanOrEqual(0);
      expect(active).toBeLessThanOrEqual(2);
    }
    expect(active).toBe(0);
  } finally {
    controller.abort();
    await pending;
  }
});
it('abort physically closes both independent-domain children and a descendant before returning', async () => {
  const { dir, isolation, jobs } = await physical(),
    controller = new AbortController();
  jobs.find((j) => j.id === 'main').args[3] = 'tree';
  jobs.find((j) => j.id === 'main-scoped').args[3] = 'hang';
  const pending = required('runClusterIsolatedCohorts')(jobs, {
    timeoutMs: 5000,
    isolation,
    signal: controller.signal,
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    for (const id of ['main', 'main-scoped', 'descendant'])
      await waitFile(dir, id + '.heartbeat', pending);
    controller.abort();
    const result = await pending;
    expect(result.error).toBeInstanceOf(Error);
    const ids = ['main', 'main-scoped', 'descendant'];
    const beats = await Promise.all(
      ids.map((id) => readFile(path.join(dir, id + '.heartbeat'), 'utf8')),
    );
    await delay(70);
    expect(
      await Promise.all(ids.map((id) => readFile(path.join(dir, id + '.heartbeat'), 'utf8'))),
    ).toEqual(beats);
    expect(await exists(path.join(dir, 'execution-commit.started'))).toBe(false);
  } finally {
    controller.abort();
    await pending;
  }
});
