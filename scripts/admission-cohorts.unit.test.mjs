import { expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import * as cohorts from './database-cohorts.mjs';
const admission = 'packages/database/test/paper-admission.integration.test.ts';
const registry = 'packages/database/test/instrument-registry.integration.test.ts';
const roles = 'packages/database/test/runtime-role-graph.integration.test.ts';
const other = 'packages/auth/test/rate-limit.integration.test.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(new URL('./fixtures/admission-cohort-worker.mjs', import.meta.url));
async function temp() {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  return mkdtemp(path.join(root, 'test-results/cohort-unit/admission-'));
}
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
async function until(test) {
  const deadline = Date.now() + 3000;
  while (!(await test())) {
    if (Date.now() > deadline) throw Error('Admission fixture handshake deadline');
    await delay(10);
  }
}
const jobs = (dir, modes) =>
  ['main', 'registry', 'admission', 'roles'].map((id, index) => ({
    id,
    parallel: id !== 'roles',
    ...(id === 'admission' ? { after: 'registry' } : {}),
    binary: process.execPath,
    args: [worker, dir, id, modes[index]],
  }));
it('isolates admission from every old main file and preserves the original two initial cohorts', () => {
  expect(cohorts.planDatabaseCohorts([other, registry, admission, roles])).toEqual([
    { id: 'main', parallel: true, files: [other] },
    { id: 'registry', parallel: true, files: [registry] },
    { id: 'admission', parallel: true, after: 'registry', files: [admission] },
    { id: 'roles', parallel: false, files: [roles] },
  ]);
});
it('starts admission after physical registry close, overlaps main, and delays roles until all close', async () => {
  const dir = await temp();
  const result = await cohorts.runDatabaseCohorts(
    jobs(dir, ['normal', 'normal', 'normal', 'normal']),
    { timeoutMs: 3000 },
  );
  expect(result.completed).toHaveLength(4);
  const byId = Object.fromEntries(result.completed.map((x) => [x.id, x]));
  expect(byId.admission.startMs).toBeGreaterThanOrEqual(byId.registry.settledMs);
  expect(byId.admission.startMs).toBeLessThan(byId.main.settledMs);
  for (const id of ['main', 'registry', 'admission'])
    expect(byId.roles.startMs).toBeGreaterThanOrEqual(byId[id].settledMs);
  const edges = result.completed
    .flatMap((x) => [
      [x.startMs, 1],
      [x.settledMs, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  for (const [, delta] of edges) {
    active += delta;
    expect(active).toBeLessThanOrEqual(2);
  }
  expect(active).toBe(0);
});
it('failure before the dependency settles never starts queued admission or roles', async () => {
  const dir = await temp();
  await expect(
    cohorts.runDatabaseCohorts(jobs(dir, ['hang', 'fail', 'normal', 'normal']), {
      timeoutMs: 3000,
    }),
  ).rejects.toThrow();
  expect(await exists(path.join(dir, 'main.started'))).toBe(true);
  expect(await exists(path.join(dir, 'registry.started'))).toBe(true);
  expect(await exists(path.join(dir, 'admission.started'))).toBe(false);
  expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
});
it('admission failure physically cancels main and never starts role mutation', async () => {
  const dir = await temp();
  const pending = cohorts.runDatabaseCohorts(jobs(dir, ['hang', 'normal', 'fail', 'normal']), {
    timeoutMs: 3000,
  });
  await expect(pending).rejects.toThrow(/admission/u);
  expect(await exists(path.join(dir, 'admission.started'))).toBe(true);
  expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
  const heartbeat = path.join(dir, 'main.heartbeat'),
    before = await readFile(heartbeat, 'utf8');
  await delay(80);
  expect(await readFile(heartbeat, 'utf8')).toBe(before);
});
it.each(['abort', 'deadline'])(
  '%s physically closes admission and descendants under the original aggregate budget',
  async (kind) => {
    const dir = await temp(),
      controller = new AbortController();
    const pending = cohorts.runDatabaseCohorts(jobs(dir, ['hang', 'normal', 'tree', 'normal']), {
      timeoutMs: kind === 'deadline' ? 2000 : 3000,
      signal: controller.signal,
    });
    const observed = pending.then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    await Promise.race([
      until(() => exists(path.join(dir, 'descendant.heartbeat'))),
      observed.then(({ error }) => {
        throw error ?? Error('ADMISSION_NOT_STARTED');
      }),
    ]);
    if (kind === 'abort') controller.abort();
    expect((await observed).error).toMatchObject({
      message: expect.stringMatching(/abort|deadline/u),
    });
    for (const id of ['main', 'admission', 'descendant']) {
      const file = path.join(dir, id + '.heartbeat'),
        before = await readFile(file, 'utf8');
      await delay(80);
      expect(await readFile(file, 'utf8')).toBe(before);
    }
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
  },
);
it('rejects an arbitrary dependency and keeps the 480-second aggregate cap', async () => {
  const dir = await temp(),
    work = jobs(dir, ['hang', 'hang', 'hang', 'normal']);
  work[2].after = 'main';
  await expect(cohorts.runDatabaseCohorts(work, { timeoutMs: 3000 })).rejects.toThrow();
  expect(await exists(path.join(dir, 'main.started'))).toBe(false);
  await expect(
    cohorts.runDatabaseCohorts(jobs(dir, ['hang', 'hang', 'hang', 'normal']), {
      timeoutMs: 480001,
    }),
  ).rejects.toThrow();
});
