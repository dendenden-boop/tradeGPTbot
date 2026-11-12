import { it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cohorts from './database-cohorts.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(
  new URL('./fixtures/execution-start-overlap-worker.mjs', import.meta.url),
);
const ids = [
  'main',
  'registry',
  'admission',
  'native-admission',
  'execution-start',
  'execution-preview',
  'roles',
];
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );
const observe = (p) =>
  p.then(
    (value) => ({ value, error: null }),
    (error) => ({ error }),
  );
async function fixture(modes = {}) {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/preview-slot-'));
  const jobs = ids.map((id) => ({
    id,
    parallel: id !== 'roles',
    ...(['admission', 'native-admission'].includes(id)
      ? { after: ['main', 'registry'] }
      : id === 'execution-start'
        ? { after: ['main', 'registry'], afterAny: ['admission', 'native-admission'] }
        : id === 'execution-preview'
          ? { after: ['execution-start'] }
          : {}),
    binary: process.execPath,
    args: [worker, dir, id, modes[id] ?? 'normal'],
  }));
  return { dir, jobs };
}
async function until(test, pending) {
  const end = Date.now() + 4000;
  while (!(await test())) {
    const done = await Promise.race([pending, delay(10).then(() => null)]);
    if (done) throw done.error ?? Error('Fixture settled before handshake');
    if (Date.now() >= end) throw Error('Preview-slot handshake deadline');
  }
}
const release = (dir, id) => writeFile(path.join(dir, id + '.release'), 'release');
it('moves only preview out of the critical PAPER tail into an explicit post-START slot; legacy serial execution stays serial', async () => {
  const files = (await cohorts.discoverDatabaseFiles()).filter(
      (file) => file !== 'packages/database/test/paper-execution-commit.integration.test.ts',
    ),
    plan = cohorts.planDatabaseCohorts(files, { executionStartOverlap: true });
  expect(plan.map((c) => c.id)).toEqual(ids);
  expect(plan.find((c) => c.id === 'admission').files).toEqual([
    'packages/database/test/paper-admission.integration.test.ts',
    'packages/database/test/paper-started-source.integration.test.ts',
    'packages/database/test/paper-started-risk.integration.test.ts',
  ]);
  expect(plan.find((c) => c.id === 'execution-start').files).toEqual([
    'packages/database/test/paper-execution-start.integration.test.ts',
  ]);
  expect(plan.find((c) => c.id === 'execution-preview')).toEqual({
    id: 'execution-preview',
    files: ['packages/database/test/paper-started-preview.integration.test.ts'],
    parallel: true,
    after: ['execution-start'],
  });
  expect(
    cohorts.planDatabaseCohorts(files).find((c) => c.id === 'execution-preview').parallel,
  ).toBe(false);
  expect(plan.flatMap((c) => c.files).sort()).toEqual(files);
});
it('runs preview only after START physically closes, overlaps remaining PAPER, never exceeds two children, and keeps roles last', async () => {
  const { dir, jobs } = await fixture({
      admission: 'controlled',
      'native-admission': 'controlled',
      'execution-start': 'controlled',
      'execution-preview': 'controlled',
    }),
    c = new AbortController(),
    pending = observe(cohorts.runDatabaseCohorts(jobs, { timeoutMs: 5000, signal: c.signal }));
  try {
    await until(() => exists(path.join(dir, 'native-admission.started')), pending);
    expect(await exists(path.join(dir, 'execution-start.started'))).toBe(false);
    expect(await exists(path.join(dir, 'execution-preview.started'))).toBe(false);
    await release(dir, 'native-admission');
    await until(() => exists(path.join(dir, 'execution-start.started')), pending);
    expect(await exists(path.join(dir, 'execution-preview.started'))).toBe(false);
    await release(dir, 'execution-start');
    await until(() => exists(path.join(dir, 'execution-preview.started')), pending);
    expect(await exists(path.join(dir, 'admission.done'))).toBe(false);
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
    await release(dir, 'execution-preview');
    await until(() => exists(path.join(dir, 'execution-preview.done')), pending);
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
    await release(dir, 'admission');
    const result = await pending;
    expect(result.error).toBeNull();
    const timing = (id) => result.value.completed.find((v) => v.id === id);
    expect(timing('execution-preview').startMs).toBeGreaterThanOrEqual(
      timing('execution-start').settledMs,
    );
    expect(timing('execution-preview').startMs).toBeLessThan(timing('admission').settledMs);
    for (const id of ids.filter((id) => id !== 'roles'))
      expect(timing('roles').startMs).toBeGreaterThanOrEqual(timing(id).settledMs);
    let active = 0;
    for (const [, delta] of result.value.completed
      .flatMap((v) => [
        [v.startMs, 1],
        [v.settledMs, -1],
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      active += delta;
      expect(active).toBeLessThanOrEqual(2);
      expect(active).toBeGreaterThanOrEqual(0);
    }
    expect(active).toBe(0);
  } finally {
    c.abort();
    await pending;
  }
});
it('failed START drains the remaining child and never opens its reused database for preview or roles', async () => {
  const { dir, jobs } = await fixture({ admission: 'hang', 'execution-start': 'fail' });
  await expect(cohorts.runDatabaseCohorts(jobs, { timeoutMs: 5000 })).rejects.toThrow(
    'Native cohort execution-start failed',
  );
  for (const id of ['execution-preview', 'roles'])
    expect(await exists(path.join(dir, id + '.started'))).toBe(false);
  const p = path.join(dir, 'admission.heartbeat'),
    before = await readFile(p, 'utf8');
  await delay(80);
  expect(await readFile(p, 'utf8')).toBe(before);
});
it('failed preview drains the remaining child and never starts role probes', async () => {
  const { dir, jobs } = await fixture({ admission: 'hang', 'execution-preview': 'fail' });
  await expect(cohorts.runDatabaseCohorts(jobs, { timeoutMs: 5000 })).rejects.toThrow(
    'Native cohort execution-preview failed',
  );
  expect(await exists(path.join(dir, 'execution-start.done'))).toBe(true);
  expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
  const p = path.join(dir, 'admission.heartbeat'),
    before = await readFile(p, 'utf8');
  await delay(80);
  expect(await readFile(p, 'utf8')).toBe(before);
});
it('abort after preview starts physically drains both processes before returning', async () => {
  const { dir, jobs } = await fixture({ admission: 'hang', 'execution-preview': 'hang' }),
    c = new AbortController(),
    pending = observe(cohorts.runDatabaseCohorts(jobs, { timeoutMs: 5000, signal: c.signal }));
  try {
    await until(() => exists(path.join(dir, 'execution-preview.heartbeat')), pending);
    c.abort();
    expect((await pending).error).toBeInstanceOf(Error);
    for (const id of ['admission', 'execution-preview']) {
      const p = path.join(dir, id + '.heartbeat'),
        before = await readFile(p, 'utf8');
      await delay(80);
      expect(await readFile(p, 'utf8')).toBe(before);
    }
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
  } finally {
    c.abort();
    await pending;
  }
});
it('rejects a forged preview dependency before process startup and retains the one 480s cap', async () => {
  const { dir, jobs } = await fixture();
  jobs[5].after = ['admission'];
  await expect(cohorts.runDatabaseCohorts(jobs, { timeoutMs: 5000 })).rejects.toThrow();
  expect(await exists(path.join(dir, 'main.started'))).toBe(false);
  jobs[5].after = ['execution-start'];
  await expect(cohorts.runDatabaseCohorts(jobs, { timeoutMs: 480001 })).rejects.toThrow();
  expect(await exists(path.join(dir, 'main.started'))).toBe(false);
});
