import { expect, it } from 'vitest';
import { mkdir, mkdtemp, access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverDatabaseFiles, planDatabaseCohorts } from './database-cohorts.mjs';
import { planRoleScopedCohorts, runRoleScopedCohorts } from './role-scoped-cohorts.mjs';

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
