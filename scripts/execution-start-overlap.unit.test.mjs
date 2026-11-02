import { it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cohorts from './database-cohorts.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  worker = fileURLToPath(new URL('./fixtures/execution-start-overlap-worker.mjs', import.meta.url));
const paths = [
  'packages/auth/test/rate-limit.integration.test.ts',
  'packages/database/test/instrument-registry.integration.test.ts',
  'packages/database/test/paper-admission.integration.test.ts',
  'packages/database/test/risk-admission.integration.test.ts',
  'packages/database/test/paper-execution-start.integration.test.ts',
  'packages/database/test/runtime-role-graph.integration.test.ts',
];
const initial = ['main', 'registry'],
  after = [...initial, 'native-admission'];
const observe = (p) =>
  p.then(
    (value) => ({ value, error: null }),
    (error) => ({ error }),
  );
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );
async function fixture(modes = {}) {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/start-overlap-'));
  return {
    dir,
    jobs: [...initial, 'admission', 'native-admission', 'execution-start', 'roles'].map((id) => ({
      id,
      parallel: id !== 'roles',
      ...(['admission', 'native-admission'].includes(id)
        ? { after: initial }
        : id === 'execution-start'
          ? { after }
          : {}),
      binary: process.execPath,
      args: [worker, dir, id, modes[id] ?? 'normal'],
    })),
  };
}
async function until(test, pending) {
  const end = Date.now() + 3000;
  while (!(await test())) {
    const done = await Promise.race([pending, delay(10).then(() => null)]);
    if (done) throw done.error ?? Error('Probe settled too early');
    if (Date.now() >= end) throw Error('Overlap fixture handshake deadline');
  }
}
it('reviewed execution-start overlap is explicit and retains the original serial plan as the default', () => {
  const plan = cohorts.planDatabaseCohorts(paths, { executionStartOverlap: true });
  expect(plan.find((c) => c.id === 'execution-start')).toEqual({
    id: 'execution-start',
    files: [paths[4]],
    parallel: true,
    after,
  });
  expect(cohorts.planDatabaseCohorts(paths).find((c) => c.id === 'execution-start').parallel).toBe(
    false,
  );
  expect(plan.flatMap((c) => c.files).sort()).toEqual([...paths].sort());
});
it('execution-start overlaps the remaining PAPER child only after native-admission physically closes, before final roles and within two children', async () => {
  const { dir, jobs } = await fixture({
      admission: 'controlled',
      'native-admission': 'controlled',
      'execution-start': 'controlled',
    }),
    controller = new AbortController(),
    pending = observe(
      cohorts.runDatabaseCohorts(jobs, { timeoutMs: 4000, signal: controller.signal }),
    );
  try {
    await until(() => exists(path.join(dir, 'native-admission.started')), pending);
    expect(await exists(path.join(dir, 'execution-start.started'))).toBe(false);
    await writeFile(path.join(dir, 'native-admission.release'), 'release');
    await until(() => exists(path.join(dir, 'execution-start.started')), pending);
    expect(await exists(path.join(dir, 'admission.done'))).toBe(false);
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
    await writeFile(path.join(dir, 'execution-start.release'), 'release');
    await until(() => exists(path.join(dir, 'execution-start.done')), pending);
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
    await writeFile(path.join(dir, 'admission.release'), 'release');
    const r = await pending;
    expect(r.error).toBeNull();
    const entry = (id) => r.value.completed.find((e) => e.id === id);
    expect(entry('execution-start').startMs).toBeGreaterThanOrEqual(
      entry('native-admission').settledMs,
    );
    expect(entry('execution-start').startMs).toBeLessThan(entry('admission').settledMs);
    for (const id of [...initial, 'admission', 'native-admission', 'execution-start'])
      expect(entry('roles').startMs).toBeGreaterThanOrEqual(entry(id).settledMs);
    let active = 0;
    for (const [, delta] of r.value.completed
      .flatMap((c) => [
        [c.startMs, 1],
        [c.settledMs, -1],
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      active += delta;
      expect(active).toBeLessThanOrEqual(2);
    }
    expect(active).toBe(0);
  } finally {
    controller.abort();
    await pending;
  }
});
it('failing execution-start physically drains its PAPER sibling and never starts roles', async () => {
  const { dir, jobs } = await fixture({ admission: 'hang', 'execution-start': 'fail' });
  await expect(cohorts.runDatabaseCohorts(jobs, { timeoutMs: 3000 })).rejects.toThrow(
    'Native cohort execution-start failed',
  );
  const file = path.join(dir, 'admission.heartbeat'),
    before = await readFile(file, 'utf8');
  await delay(80);
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
});
it('failed native-admission cannot start queued execution-start or roles', async () => {
  const { dir, jobs } = await fixture({ admission: 'hang', 'native-admission': 'fail' });
  await expect(cohorts.runDatabaseCohorts(jobs, { timeoutMs: 3000 })).rejects.toThrow(
    'Native cohort native-admission failed',
  );
  expect(await exists(path.join(dir, 'execution-start.started'))).toBe(false);
  expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
});
it.each(['abort', 'deadline'])(
  'reviewed execution-start %s drains both children and a descendant without starting roles',
  async (kind) => {
    const { dir, jobs } = await fixture({ admission: 'hang', 'execution-start': 'tree' }),
      controller = new AbortController(),
      pending = observe(
        cohorts.runDatabaseCohorts(jobs, {
          timeoutMs: kind === 'deadline' ? 2000 : 4000,
          signal: controller.signal,
        }),
      );
    try {
      await until(() => exists(path.join(dir, 'descendant.heartbeat')), pending);
      if (kind === 'abort') controller.abort();
      expect((await pending).error?.message).toMatch(/deadline|abort/u);
      for (const id of ['admission', 'execution-start', 'descendant']) {
        const file = path.join(dir, id + '.heartbeat'),
          before = await readFile(file, 'utf8');
        await delay(80);
        expect(await readFile(file, 'utf8')).toBe(before);
      }
      expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
    } finally {
      controller.abort();
      await pending;
    }
  },
);
it('new overlap requires reviewed native/helper fingerprints and rejects any changed input', async () => {
  expect(cohorts.verifyExecutionStartParallelFiles).toBeTypeOf('function');
  await cohorts.verifyExecutionStartParallelFiles(root);
  const { dir } = await fixture();
  const files = [
    'packages/database/test/paper-execution-start.integration.test.ts',
    'packages/database/test/fixtures/paper-execution-start.ts',
    'packages/database/test/fixtures/native-default-port.ts',
    'packages/paper-engine/test/frame-fixture.ts',
    'packages/risk-engine/test/fixtures.ts',
    'packages/order-engine/test/fixtures.ts',
  ];
  for (const file of files) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(
      path.join(dir, file),
      (await readFile(path.join(root, file), 'utf8'))
        .replaceAll('\r\n', '\n')
        .replaceAll('\n', '\r\n'),
    );
  }
  await cohorts.verifyExecutionStartParallelFiles(dir);
  for (const file of files) {
    const p = path.join(dir, file),
      before = await readFile(p, 'utf8');
    await writeFile(p, before + '\n// unreviewed input\n');
    await expect(cohorts.verifyExecutionStartParallelFiles(dir)).rejects.toThrow(
      /renewed cluster-role review/u,
    );
    await writeFile(p, before);
  }
});
