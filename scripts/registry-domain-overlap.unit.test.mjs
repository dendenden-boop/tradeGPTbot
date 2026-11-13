import { expect, it } from 'vitest';
import * as runner from './cluster-isolated-cohorts.mjs';
import { createNativeClusterIsolation } from './native-cluster-isolation.mjs';
import { discoverDatabaseFiles, planDatabaseCohorts } from './database-cohorts.mjs';
import { mkdir, mkdtemp, readFile, writeFile, access, copyFile } from 'node:fs/promises';
import {
  registryDomainInputPins,
  verifyRegistryDomainInputs,
} from './registry-domain-independence.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const required = (name) => {
  expect(typeof runner[name], 'REGISTRY_DOMAIN_' + name + '_REQUIRED').toBe('function');
  return runner[name];
};
function database(id, roles = new Map([['ctp_instrument_registry', false]])) {
  const calls = [];
  return {
    roles,
    calls,
    async query(sql, values = []) {
      calls.push([sql, values]);
      if (sql === 'SELECT system_identifier::text AS id FROM pg_control_system()')
        return { rows: [{ id }] };
      const name =
        /"(ctp_cluster_probe_[a-f0-9]{12})"/u.exec(sql)?.[1] ?? 'ctp_instrument_registry';
      if (sql.startsWith('CREATE ROLE ')) {
        if (roles.has(name)) throw Error('DUPLICATE_ROLE');
        roles.set(name, false);
      } else if (sql.startsWith('ALTER ROLE ')) {
        if (!roles.has(name)) throw Error('MISSING_ROLE');
        roles.set(name, sql.endsWith(' LOGIN'));
      } else if (sql.startsWith('DROP ROLE ')) {
        if (!roles.delete(name)) throw Error('MISSING_ROLE');
      } else if (sql === 'SELECT rolcanlogin FROM pg_roles WHERE rolname=$1')
        return { rows: roles.has(values[0]) ? [{ rolcanlogin: roles.get(values[0]) }] : [] };
      else throw Error('UNREVIEWED_ROLE_QUERY');
      return { rows: [] };
    },
  };
}
async function fixture() {
  const primary = database('9007199254740992'),
    secondary = database('9007199254740993');
  const endpoint = (second) => ({
    project: second ? 'ctp-integration-901-aabbcc112232' : 'ctp-integration-901-aabbcc112233',
    containerId: (second ? 'b' : 'a').repeat(64),
    port: second ? 34002 : 34001,
  });
  const isolation = await createNativeClusterIsolation({
    primary,
    secondary,
    primaryEndpoint: endpoint(false),
    secondaryEndpoint: endpoint(true),
  });
  primary.calls.length = secondary.calls.length = 0;
  return { primary, secondary, isolation };
}
it('requires a separate issued proof before registry can overlap a secondary native-admission process', () => {
  for (const name of [
    'proveRegistryIndependence',
    'assertRegistryIndependence',
    'planRegistryIsolatedCohorts',
    'runRegistryIsolatedCohorts',
  ])
    required(name);
});
it('observes the actual registry group unsafe only on PRIMARY and restores it before issuing a process-local token', async () => {
  const f = await fixture(),
    proof = await required('proveRegistryIndependence')(f);
  expect(proof.evidence).toEqual({
    version: 'native-registry-independence-v1',
    before: { primary: false, secondary: false },
    during: { primary: true, secondary: false },
    after: { primary: false, secondary: false },
  });
  expect(required('assertRegistryIndependence')(proof, f.isolation)).toBe(proof);
  expect(f.primary.roles).toEqual(new Map([['ctp_instrument_registry', false]]));
  expect(f.secondary.roles).toEqual(new Map([['ctp_instrument_registry', false]]));
});
it('rejects serialized or transplanted registry proofs instead of authorizing an early process', async () => {
  const f = await fixture(),
    proof = await required('proveRegistryIndependence')(f),
    other = await fixture();
  for (const p of [{}, JSON.parse(JSON.stringify(proof))])
    expect(() => required('assertRegistryIndependence')(p, f.isolation)).toThrow();
  expect(() => required('assertRegistryIndependence')(proof, other.isolation)).toThrow();
});
it('rejects a preexisting unsafe registry role without altering or repairing external state', async () => {
  const f = await fixture();
  f.primary.roles.set('ctp_instrument_registry', true);
  await expect(required('proveRegistryIndependence')(f)).rejects.toThrow(
    'NATIVE_REGISTRY_INDEPENDENCE',
  );
  expect(f.primary.calls.some(([q]) => q.startsWith('ALTER ROLE '))).toBe(false);
});
it('changes only the native-admission dependency after proof and preserves every original test plus final financial barriers', async () => {
  const f = await fixture(),
    proof = await required('proveRegistryIndependence')(f);
  const original = planDatabaseCohorts(await discoverDatabaseFiles(), {
    executionStartOverlap: true,
  });
  const old = await runner.planClusterIsolatedCohorts(original, f.isolation);
  const next = await required('planRegistryIsolatedCohorts')(original, f.isolation, proof);
  expect(next.map((j) => j.id)).toEqual(old.map((j) => j.id));
  for (const job of next)
    expect(job).toEqual(
      job.id === 'native-admission'
        ? { ...old.find((j) => j.id === job.id), after: [] }
        : old.find((j) => j.id === job.id),
    );
  expect(next.flatMap((j) => j.files).sort()).toEqual(old.flatMap((j) => j.files).sort());
});
it('retains conservative registry barriers without the new issued proof', async () => {
  const f = await fixture(),
    original = planDatabaseCohorts(await discoverDatabaseFiles(), { executionStartOverlap: true });
  await expect(required('planRegistryIsolatedCohorts')(original, f.isolation, {})).rejects.toThrow(
    'NATIVE_REGISTRY_INDEPENDENCE',
  );
  const plan = await runner.planClusterIsolatedCohorts(original, f.isolation);
  expect(plan.find((j) => j.id === 'native-admission').after).toEqual(['registry', 'main-scoped']);
});

it.each(['during-read', 'restore', 'secondary-changed', 'identity-changed', 'missing-role'])(
  'issues no token and restores owned role state after a failed proof: %s',
  async (kind) => {
    const f = await fixture(),
      original = f.primary.query.bind(f.primary);
    f.primary.query = async (sql, values) => {
      if (kind === 'restore' && sql === 'ALTER ROLE ctp_instrument_registry NOLOGIN')
        throw Error('RESTORE_FAILED');
      if (kind === 'identity-changed' && sql.includes('pg_control_system()'))
        return { rows: [{ id: '9007199254740994' }] };
      if (
        kind === 'during-read' &&
        sql.startsWith('SELECT rolcanlogin') &&
        f.primary.roles.get('ctp_instrument_registry')
      )
        throw Error('READ_FAILED');
      const value = await original(sql, values);
      if (kind === 'secondary-changed' && sql === 'ALTER ROLE ctp_instrument_registry LOGIN')
        f.secondary.roles.set('ctp_instrument_registry', true);
      return value;
    };
    if (kind === 'missing-role') f.secondary.roles.delete('ctp_instrument_registry');
    await expect(required('proveRegistryIndependence')(f)).rejects.toThrow(
      'NATIVE_REGISTRY_INDEPENDENCE',
    );
    if (kind !== 'restore') expect(f.primary.roles.get('ctp_instrument_registry')).toBe(false);
  },
);

const root = fileURLToPath(new URL('../', import.meta.url));
it('drains the peer proof read before restoring a temporarily unsafe role or returning a failed proof', async () => {
  const f = await fixture(),
    readPrimary = f.primary.query.bind(f.primary),
    readSecondary = f.secondary.query.bind(f.secondary);
  let release,
    entered,
    settled = false;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  f.primary.query = async (sql, values) => {
    if (sql.startsWith('SELECT rolcanlogin') && f.primary.roles.get('ctp_instrument_registry'))
      throw Error('PROBE_READ_FAILED');
    return readPrimary(sql, values);
  };
  f.secondary.query = (sql, values) => {
    if (sql.startsWith('SELECT rolcanlogin') && f.primary.roles.get('ctp_instrument_registry')) {
      entered();
      return new Promise((resolve) => {
        release = () => resolve({ rows: [{ rolcanlogin: false }] });
      });
    }
    return readSecondary(sql, values);
  };
  const pending = required('proveRegistryIndependence')(f).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    },
  );
  try {
    await waiting;
    await delay(10);
    expect(f.primary.roles.get('ctp_instrument_registry')).toBe(true);
    expect(settled).toBe(false);
  } finally {
    release();
    await pending;
  }
  const result = await pending;
  expect(result.error).toBeInstanceOf(Error);
  expect(f.primary.roles.get('ctp_instrument_registry')).toBe(false);
});
const worker = fileURLToPath(new URL('./fixtures/registry-domain-worker.mjs', import.meta.url));
const oldWorker = fileURLToPath(new URL('./fixtures/cluster-isolated-worker.mjs', import.meta.url));
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
async function physical() {
  const f = await fixture(),
    registryProof = await required('proveRegistryIndependence')(f);
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/registry-'));
  const original = planDatabaseCohorts(await discoverDatabaseFiles(), {
    executionStartOverlap: true,
  });
  const plan = await required('planRegistryIsolatedCohorts')(original, f.isolation, registryProof);
  const jobs = plan.map((p) => {
    const primary = ['registry', 'main', 'roles'].includes(p.id);
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
    const early = ['registry', 'native-admission'].includes(p.id);
    return {
      ...p,
      database,
      cluster: primary ? 'PRIMARY' : 'SECONDARY',
      binary: process.execPath,
      args: [early ? worker : oldWorker, dir, p.id, early ? 'controlled' : 'normal'],
      env: {
        ...process.env,
        DATABASE_MIGRATION_URL: `postgresql://ctp_test:${'1'.repeat(48)}@127.0.0.1:${primary ? 34001 : 34002}/${database}`,
      },
    };
  });
  return { ...f, registryProof, dir, jobs };
}
async function waitFile(f, name, pending) {
  const end = Date.now() + 3500;
  while (!(await exists(path.join(f.dir, name)))) {
    const result = await Promise.race([pending, delay(5).then(() => null)]);
    if (result) throw result.error ?? Error('EARLY_OVERLAP_COMPLETION');
    if (Date.now() >= end) throw Error('REGISTRY_DOMAIN_HANDSHAKE_DEADLINE');
  }
}
function start(f, timeoutMs = 5000) {
  const controller = new AbortController();
  const pending = required('runRegistryIsolatedCohorts')(f.jobs, {
    timeoutMs,
    signal: controller.signal,
    isolation: f.isolation,
    registryProof: f.registryProof,
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return { controller, pending };
}
it('physically overlaps only independent registry/admission, keeps both final barriers and never exceeds two live children', async () => {
  const f = await physical(),
    { controller, pending } = start(f);
  try {
    await waitFile(f, 'registry.heartbeat', pending);
    await waitFile(f, 'native-admission.heartbeat', pending);
    for (const id of [
      'main',
      'main-scoped',
      'admission',
      'execution-start',
      'execution-commit',
      'roles',
    ])
      expect(await exists(path.join(f.dir, id + '.started'))).toBe(false);
    await writeFile(path.join(f.dir, 'registry.release'), 'release');
    await waitFile(f, 'execution-preview.done', pending);
    expect(await exists(path.join(f.dir, 'native-admission.done'))).toBe(false);
    expect(await exists(path.join(f.dir, 'execution-commit.started'))).toBe(false);
    await writeFile(path.join(f.dir, 'native-admission.release'), 'release');
    const result = await pending;
    expect(result.error).toBeUndefined();
    const times = new Map(result.value.completed.map((t) => [t.id, t]));
    expect(times.get('native-admission').startMs).toBeLessThan(times.get('registry').settledMs);
    expect(times.get('execution-commit').startMs).toBeGreaterThanOrEqual(
      times.get('native-admission').settledMs,
    );
    expect(times.get('roles').startMs).toBeGreaterThanOrEqual(
      times.get('execution-commit').settledMs,
    );
    let active = 0;
    for (const [, delta] of result.value.completed
      .flatMap((t) => [
        [t.startMs, 1],
        [t.settledMs, -1],
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
it.each(['abort', 'failure', 'deadline'])(
  'physically drains both early children and a descendant on %s, without starting a writer or roles',
  async (kind) => {
    const f = await physical();
    f.jobs.find((j) => j.id === 'registry').args[3] = 'tree';
    f.jobs.find((j) => j.id === 'native-admission').args[3] = kind === 'failure' ? 'fail' : 'hang';
    const { controller, pending } = start(f, 5000);
    try {
      for (const id of ['registry', 'native-admission', 'descendant'])
        await waitFile(f, id + '.heartbeat', pending);
      if (kind === 'abort') controller.abort();
      const result = await pending;
      expect(result.error).toBeInstanceOf(Error);
      const ids = ['registry', 'native-admission', 'descendant'];
      const before = await Promise.all(
        ids.map(async (id) =>
          (await exists(path.join(f.dir, id + '.heartbeat')))
            ? readFile(path.join(f.dir, id + '.heartbeat'), 'utf8')
            : null,
        ),
      );
      expect(before.every((value) => value !== null)).toBe(true);
      await delay(70);
      const after = await Promise.all(
        ids.map(async (id) =>
          (await exists(path.join(f.dir, id + '.heartbeat')))
            ? readFile(path.join(f.dir, id + '.heartbeat'), 'utf8')
            : null,
        ),
      );
      expect(after).toEqual(before);
      expect(await exists(path.join(f.dir, 'execution-commit.started'))).toBe(false);
      expect(await exists(path.join(f.dir, 'roles.started'))).toBe(false);
    } finally {
      controller.abort();
      await pending;
    }
  },
);
it('refuses early execution after any reviewed registry or admission fixture changes', async () => {
  const files = [
    ...new Set([
      ...Object.keys(registryDomainInputPins),
      'packages/database/test/risk-admission.integration.test.ts',
      'packages/database/test/paper-admission.integration.test.ts',
      'packages/database/test/fixtures/risk-certification.ts',
      'packages/database/test/fixtures/registry-commit-proxy.ts',
      'packages/database/test/fixtures/public-market-ports.ts',
      'packages/database/test/fixtures/order-fixture-port.ts',
      'packages/database/test/fixtures/admission-fixture-port.ts',
      'packages/database/test/fixtures/native-default-port.ts',
    ]),
  ];
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/input-review-'));
  for (const file of files) {
    const destination = path.join(dir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, file), destination);
  }
  await expect(verifyRegistryDomainInputs(dir)).resolves.toBeUndefined();
  for (const file of files) {
    const destination = path.join(dir, file),
      original = await readFile(destination, 'utf8');
    try {
      await writeFile(destination, '// unreviewed\n' + original);
      await expect(verifyRegistryDomainInputs(dir), file).rejects.toThrow();
    } finally {
      await writeFile(destination, original);
    }
  }
});
it.each(['port', 'cluster', 'database', 'proof'])(
  'rejects mismatched early routing or proof before starting children: %s',
  async (kind) => {
    const f = await physical(),
      job = f.jobs.find((j) => j.id === 'native-admission');
    if (kind === 'port')
      job.env.DATABASE_MIGRATION_URL = job.env.DATABASE_MIGRATION_URL.replace(':34002/', ':34001/');
    if (kind === 'cluster') job.cluster = 'PRIMARY';
    if (kind === 'database') job.database = 'ctp_p2_fresh_aabbcc112232';
    if (kind === 'proof') f.registryProof = JSON.parse(JSON.stringify(f.registryProof));
    const result = await start(f).pending;
    expect(result.error).toBeInstanceOf(Error);
    expect(await exists(path.join(f.dir, 'registry.started'))).toBe(false);
    expect(await exists(path.join(f.dir, 'native-admission.started'))).toBe(false);
  },
);
