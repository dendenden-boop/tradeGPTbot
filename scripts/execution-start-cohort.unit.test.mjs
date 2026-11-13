import { it, expect } from 'vitest';
import { mkdir, mkdtemp, access, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDatabaseCohorts, runDatabaseCohorts } from './database-cohorts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(
  new URL('./fixtures/execution-start-cohort-worker.mjs', import.meta.url),
);
const prefixWorker = fileURLToPath(
  new URL('./fixtures/execution-start-cohort-prefix.cjs', import.meta.url),
);
const start = 'packages/database/test/paper-execution-start.integration.test.ts';
const files = [
  'packages/auth/test/rate-limit.integration.test.ts',
  'packages/database/test/instrument-registry.integration.test.ts',
  'packages/database/test/paper-admission.integration.test.ts',
  'packages/database/test/risk-admission.integration.test.ts',
  start,
  'packages/database/test/runtime-role-graph.integration.test.ts',
];
const before = ['main', 'registry', 'admission', 'native-admission'];
async function setup(mode = 'normal') {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/start-'));
  const jobs = [...before, 'execution-start', 'roles'].map((id) => ({
    id,
    parallel: !['execution-start', 'roles'].includes(id),
    ...(['admission', 'native-admission'].includes(id) ? { after: ['main', 'registry'] } : {}),
    ...(id === 'execution-start' ? { after: before } : {}),
    binary: process.execPath,
    args: [worker, dir, id, id === 'execution-start' ? mode : 'normal'],
  }));
  return { dir, jobs };
}
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );

it('execution-start gets its own serial native stage after both admissions and before role mutation', () => {
  const plan = planDatabaseCohorts(files);
  expect(plan.map(({ id }) => id)).toEqual([...before, 'execution-start', 'roles']);
  expect(plan.find(({ id }) => id === 'execution-start')).toEqual({
    id: 'execution-start',
    files: [start],
    parallel: false,
    after: before,
  });
  expect(plan.flatMap(({ files }) => files).sort()).toEqual([...files].sort());
  expect(planDatabaseCohorts(files.filter((p) => p !== start)).map(({ id }) => id)).toEqual([
    ...before,
    'roles',
  ]);
  expect(() =>
    planDatabaseCohorts(files.filter((p) => p.includes('risk-admission') === false)),
  ).toThrow();
});
it('execution-start physically closes before roles with at most two earlier children and one aggregate budget', async () => {
  const { dir, jobs } = await setup();
  const result = await runDatabaseCohorts(jobs, { timeoutMs: 3000 });
  expect(result.timeoutMs).toBe(3000);
  const entries = Object.fromEntries(result.completed.map((e) => [e.id, e]));
  for (const id of before)
    expect(entries['execution-start'].startMs).toBeGreaterThanOrEqual(entries[id].settledMs);
  expect(entries.roles.startMs).toBeGreaterThanOrEqual(entries['execution-start'].settledMs);
  expect(await exists(path.join(dir, 'roles.done'))).toBe(true);
  let active = 0;
  for (const [, delta] of result.completed
    .flatMap((e) => [
      [e.startMs, 1],
      [e.settledMs, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    active += delta;
    expect(active).toBeLessThanOrEqual(2);
  }
  expect(active).toBe(0);
});
it('execution-start failure cannot start the final role scope', async () => {
  const { dir, jobs } = await setup('fail');
  await expect(runDatabaseCohorts(jobs, { timeoutMs: 3000 })).rejects.toThrow(
    'Native cohort execution-start failed',
  );
  expect(await exists(path.join(dir, 'execution-start.started'))).toBe(true);
  expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
});
it('retains all dependency processes while interruption prefixes load only their required file IO', async () => {
  const normal = await setup(),
    failed = await setup('fail'),
    interrupted = await setup('tree');
  for (const fixture of [normal, failed, interrupted]) {
    expect(fixture.jobs.map(({ id }) => id)).toEqual([...before, 'execution-start', 'roles']);
    expect(fixture.jobs.find(({ id }) => id === 'execution-start').after).toEqual(before);
  }
  for (const fixture of [normal, failed])
    expect(fixture.jobs.every((j) => j.args[0] === worker)).toBe(true);
  for (const job of interrupted.jobs.filter(({ id }) => before.includes(id)))
    expect(job.args).toEqual([prefixWorker, interrupted.dir, job.id]);
  expect(interrupted.jobs.find(({ id }) => id === 'execution-start').args).toEqual([
    worker,
    interrupted.dir,
    'execution-start',
    'tree',
  ]);
  expect(interrupted.jobs.find(({ id }) => id === 'roles').args).toEqual([
    worker,
    interrupted.dir,
    'roles',
    'normal',
  ]);
  expect(interrupted.jobs.every(({ binary }) => binary === process.execPath)).toBe(true);
});
it.each(['abort', 'deadline'])(
  'execution-start %s physically terminates its descendant before returning',
  async (kind) => {
    const { dir, jobs } = await setup('tree'),
      controller = new AbortController();
    const pending = runDatabaseCohorts(jobs, {
      timeoutMs: kind === 'deadline' ? 1800 : 3000,
      signal: controller.signal,
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ error }),
    );
    try {
      const limit = Date.now() + 3000;
      while (!(await exists(path.join(dir, 'descendant.heartbeat')))) {
        const settled = await Promise.race([pending, delay(10).then(() => null)]);
        if (settled) throw settled.error ?? Error('Missing descendant');
        if (Date.now() >= limit) throw Error('Execution-start handshake deadline');
      }
      if (kind === 'abort') controller.abort();
      expect((await pending).error?.message).toMatch(/deadline|abort/u);
      for (const id of ['execution-start', 'descendant']) {
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
