import { expect, it } from 'vitest';
import { mkdir, mkdtemp, access, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverDatabaseFiles, planDatabaseCohorts } from './database-cohorts.mjs';
import { planRoleScopedCohorts, runRoleScopedCohorts } from './role-scoped-cohorts.mjs';
import { scopedMainSources, verifyScopedMainFiles } from './native-main-scopes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(
  new URL('./fixtures/execution-start-overlap-worker.mjs', import.meta.url),
);
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
async function fixture() {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/role-scoped-'));
  const original = planDatabaseCohorts(await discoverDatabaseFiles(), {
    executionStartOverlap: true,
  });
  const plan = await planRoleScopedCohorts(original);
  const jobs = plan.map((p) => ({
    ...p,
    binary: process.execPath,
    args: [
      worker,
      dir,
      p.id,
      ['main-scoped', 'admission'].includes(p.id) ? 'controlled' : 'normal',
    ],
  }));
  return { dir, original, plan, jobs };
}
async function waitFile(dir, name, pending) {
  const end = Date.now() + 3500;
  while (!(await exists(path.join(dir, name)))) {
    const result = await Promise.race([pending, delay(10).then(() => null)]);
    if (result) throw result.error ?? Error('Unexpected early scheduler completion');
    if (Date.now() >= end) throw Error('Scoped cohort handshake deadline');
  }
}
it('partitions all original native files exactly once, retaining the full serial writer and role barriers', async () => {
  const { original, plan } = await fixture();
  expect(plan).toHaveLength(9);
  expect(plan.flatMap((c) => c.files).sort()).toEqual(original.flatMap((c) => c.files).sort());
  expect(new Set(plan.flatMap((c) => c.files)).size).toBe(49);
  expect(plan.find((c) => c.id === 'main-scoped').after).toEqual(['main', 'registry']);
  expect(plan.find((c) => c.id === 'execution-commit').after).toContain('main-scoped');
});
it('reuses only a closed scoped slot while preserving the cluster barrier, two-process cap and serial financial writer', async () => {
  const { dir, jobs } = await fixture(),
    controller = new AbortController();
  const pending = runRoleScopedCohorts(jobs, { timeoutMs: 5000, signal: controller.signal }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await waitFile(dir, 'main-scoped.started', pending);
    await waitFile(dir, 'admission.started', pending);
    expect(await readFile(path.join(dir, 'main.done'), 'utf8')).toBe('done');
    expect(await readFile(path.join(dir, 'registry.done'), 'utf8')).toBe('done');
    expect(await exists(path.join(dir, 'native-admission.started'))).toBe(false);
    await writeFile(path.join(dir, 'main-scoped.release'), 'release');
    await waitFile(dir, 'execution-preview.done', pending);
    expect(await exists(path.join(dir, 'admission.done'))).toBe(false);
    expect(await exists(path.join(dir, 'execution-commit.started'))).toBe(false);
    await writeFile(path.join(dir, 'admission.release'), 'release');
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.value.completed).toHaveLength(9);
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

it('physically closes a failed native sibling and a live descendant tree before rejecting', async () => {
  const { dir, jobs } = await fixture();
  for (const job of jobs)
    job.args[3] =
      job.id === 'admission' ? 'tree' : job.id === 'native-admission' ? 'fail' : 'normal';
  jobs.find((job) => job.id === 'native-admission').args[0] = fileURLToPath(
    new URL('./fixtures/scoped-failure-worker.mjs', import.meta.url),
  );
  await expect(runRoleScopedCohorts(jobs, { timeoutMs: 5000 })).rejects.toThrow(
    'Native cohort native-admission failed',
  );
  const beat = path.join(dir, 'descendant.heartbeat');
  const previous = await readFile(beat, 'utf8');
  await delay(80);
  expect(await readFile(beat, 'utf8')).toBe(previous);
  expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
  expect(await exists(path.join(dir, 'execution-commit.started'))).toBe(false);
});

it('aborts the actual scoped process, drains its physical heartbeat and never starts the writer or roles', async () => {
  const { dir, jobs } = await fixture(),
    controller = new AbortController();
  jobs.find((job) => job.id === 'main-scoped').args[3] = 'hang';
  const pending = runRoleScopedCohorts(jobs, { timeoutMs: 5000, signal: controller.signal }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await waitFile(dir, 'main-scoped.heartbeat', pending);
    controller.abort();
    expect((await pending).error).toBeInstanceOf(Error);
    const beat = path.join(dir, 'main-scoped.heartbeat'),
      before = await readFile(beat, 'utf8');
    await delay(80);
    expect(await readFile(beat, 'utf8')).toBe(before);
    expect(await exists(path.join(dir, 'execution-commit.started'))).toBe(false);
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
  } finally {
    controller.abort();
    await pending;
  }
});

it('retains the exact existing physical launch, timeout, bounded output and process-tree teardown implementation', async () => {
  const old = (
    await readFile(new URL('./database-cohorts.mjs', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n');
  const next = (
    await readFile(new URL('./role-scoped-cohorts.mjs', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n');
  const start = old.indexOf('  assert.ok(Number.isSafeInteger(timeoutMs)'),
    end = old.indexOf('  try {\n    const main = run(jobs[0]);', start);
  const actual = next
    .split('  // BEGIN IDENTICAL PHYSICAL LAUNCHER\n')[1]
    .split('  // END IDENTICAL PHYSICAL LAUNCHER')[0];
  expect(createHash('sha256').update(actual).digest('hex')).toBe(
    createHash('sha256').update(old.slice(start, end)).digest('hex'),
  );
});

it('rejects changed transitive fixture inputs before permitting any scoped native overlap', async () => {
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/scoped-proof-'));
  for (const file of Object.keys(scopedMainSources)) {
    const target = path.join(dir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, file), target);
  }
  expect((await verifyScopedMainFiles(dir)).sources).toBe(41);
  const file = Object.keys(scopedMainSources).find((file) => file.includes('/fixtures/'));
  await writeFile(
    path.join(dir, file),
    (await readFile(path.join(dir, file), 'utf8')) + '\n// ALTER ROLE ctp_execution LOGIN\n',
  );
  await expect(verifyScopedMainFiles(dir)).rejects.toThrow('requires renewed cluster-role review');
});
