import { it, expect } from 'vitest';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cohorts from './database-cohorts.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(new URL('./fixtures/admission-overlap-worker.mjs', import.meta.url));
const native = 'packages/database/test/risk-admission.integration.test.ts';
const paper = 'packages/database/test/paper-admission.integration.test.ts';
const registry = 'packages/database/test/instrument-registry.integration.test.ts';
const roles = 'packages/database/test/runtime-role-graph.integration.test.ts';
const other = 'packages/auth/test/rate-limit.integration.test.ts';
const files = [other, native, registry, paper, roles];
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
async function temp() {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  return mkdtemp(path.join(root, 'test-results/cohort-unit/overlap-'));
}
const jobs = (dir, modes) =>
  ['main', 'registry', 'admission', 'native-admission', 'roles'].map((id, i) => ({
    id,
    parallel: id !== 'roles',
    ...(['admission', 'native-admission'].includes(id) ? { after: ['main', 'registry'] } : {}),
    binary: process.execPath,
    args: [worker, dir, id, modes[i]],
  }));
const observe = (p) =>
  p.then(
    (value) => ({ value, error: null }),
    (error) => ({ error }),
  );
async function until(test, observed) {
  const end = Date.now() + 3000;
  for (;;) {
    const result = await Promise.race([test().then((ready) => ({ ready })), observed]);
    if (result.error) throw result.error;
    if (result.ready) return;
    if (Date.now() >= end) throw Error('Overlap fixture handshake deadline');
    await wait(10);
  }
}
it('overlaps only the reviewed unchanged native admission file after both shared-role scopes close', () => {
  const plan = cohorts.planDatabaseCohorts(files);
  expect(plan).toEqual([
    { id: 'main', files: [other], parallel: true },
    { id: 'registry', files: [registry], parallel: true },
    { id: 'admission', files: [paper], parallel: true, after: ['main', 'registry'] },
    { id: 'native-admission', files: [native], parallel: true, after: ['main', 'registry'] },
    { id: 'roles', files: [roles], parallel: false },
  ]);
  expect(plan.flatMap((c) => c.files).sort()).toEqual([...files].sort());
  const future = 'packages/database/test/future.integration.test.ts';
  expect(cohorts.planDatabaseCohorts([...files, future])[0].files).toEqual([other, future].sort());
});
it('physically enforces the shared-role barrier, two-child bound, overlap and final role barrier', async () => {
  const dir = await temp(),
    controller = new AbortController();
  const observed = observe(
    cohorts.runDatabaseCohorts(
      jobs(dir, ['controlled', 'controlled', 'controlled', 'controlled', 'normal']),
      { timeoutMs: 3000, signal: controller.signal },
    ),
  );
  try {
    await until(() => exists(path.join(dir, 'registry.started')), observed);
    expect(await exists(path.join(dir, 'admission.started'))).toBe(false);
    await writeFile(path.join(dir, 'main.release'), 'release');
    await until(() => exists(path.join(dir, 'main.done')), observed);
    expect(await exists(path.join(dir, 'native-admission.started'))).toBe(false);
    await writeFile(path.join(dir, 'registry.release'), 'release');
    await until(() => exists(path.join(dir, 'native-admission.started')), observed);
    await until(() => exists(path.join(dir, 'admission.started')), observed);
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
    await writeFile(path.join(dir, 'admission.release'), 'release');
    await until(() => exists(path.join(dir, 'admission.done')), observed);
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
    await writeFile(path.join(dir, 'native-admission.release'), 'release');
    const result = await observed;
    expect(result.error).toBeNull();
    const byId = Object.fromEntries(result.value.completed.map((x) => [x.id, x]));
    for (const id of ['admission', 'native-admission'])
      for (const dependency of ['main', 'registry'])
        expect(byId[id].startMs).toBeGreaterThanOrEqual(byId[dependency].settledMs);
    expect(byId['native-admission'].startMs).toBeLessThan(byId.admission.settledMs);
    for (const id of ['main', 'registry', 'admission', 'native-admission'])
      expect(byId.roles.startMs).toBeGreaterThanOrEqual(byId[id].settledMs);
    let active = 0;
    for (const [, delta] of result.value.completed
      .flatMap((x) => [
        [x.startMs, 1],
        [x.settledMs, -1],
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      active += delta;
      expect(active).toBeLessThanOrEqual(2);
    }
    expect(active).toBe(0);
  } finally {
    controller.abort();
    await observed;
  }
});
it('charges both new-stage children and final roles to one unchanged aggregate deadline', async () => {
  const dir = await temp();
  const result = await cohorts.runDatabaseCohorts(
    jobs(dir, ['normal', 'normal', 'cost', 'cost', 'normal']),
    { timeoutMs: 2200 },
  );
  expect(result.completed).toHaveLength(5);
  expect(result.timeoutMs).toBe(2200);
  expect(result.elapsedMs).toBeLessThan(2200);
});
it('a failing admission physically stops its overlapping native sibling before returning', async () => {
  const dir = await temp();
  await expect(
    cohorts.runDatabaseCohorts(jobs(dir, ['normal', 'normal', 'fail', 'hang', 'normal']), {
      timeoutMs: 3000,
    }),
  ).rejects.toThrow(/admission/u);
  const file = path.join(dir, 'native-admission.heartbeat'),
    before = await readFile(file, 'utf8');
  await wait(80);
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
});
it.each(['abort', 'deadline'])(
  '%s physically closes both overlapping children and a descendant',
  async (kind) => {
    const dir = await temp(),
      controller = new AbortController();
    const observed = observe(
      cohorts.runDatabaseCohorts(jobs(dir, ['normal', 'normal', 'hang', 'tree', 'normal']), {
        timeoutMs: kind === 'deadline' ? 1500 : 3000,
        signal: controller.signal,
      }),
    );
    try {
      await until(() => exists(path.join(dir, 'descendant.heartbeat')), observed);
      if (kind === 'abort') controller.abort();
      expect((await observed).error).toMatchObject({
        message: expect.stringMatching(/deadline|abort/u),
      });
      for (const id of ['admission', 'native-admission', 'descendant']) {
        const file = path.join(dir, id + '.heartbeat'),
          before = await readFile(file, 'utf8');
        await wait(80);
        expect(await readFile(file, 'utf8')).toBe(before);
      }
      expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
    } finally {
      controller.abort();
      await observed;
    }
  },
);
it('fails closed when reviewed overlap inputs or their SQL fixture helper change', async () => {
  expect(cohorts.verifyAdmissionParallelFiles).toBeTypeOf('function');
  await cohorts.verifyAdmissionParallelFiles(root);
  await expect(cohorts.verifyAdmissionParallelFiles(await temp())).rejects.toThrow();
});
