import { expect, it } from 'vitest';
import * as cohorts from './database-cohorts.mjs';
import { mkdir, mkdtemp, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const registry = 'packages/database/test/instrument-registry.integration.test.ts';
const roles = 'packages/database/test/runtime-role-graph.integration.test.ts';
const other = 'packages/auth/test/rate-limit.integration.test.ts';
const files = [other, registry, roles];
const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(new URL('./fixtures/database-cohort-worker.mjs', import.meta.url));
const temp = async () => {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  return mkdtemp(path.join(root, 'test-results/cohort-unit/run-'));
};
const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  );
const until = async (test) => {
  const end = Date.now() + 3000;
  while (!(await test())) {
    if (Date.now() > end) throw new Error('Fixture handshake deadline');
    await delay(10);
  }
};
const jobs = (dir, modes, wait = '0') =>
  ['main', 'registry', 'roles'].map((id, index) => ({
    id,
    parallel: index < 2,
    binary: process.execPath,
    args: [worker, dir, id, modes[index], wait],
  }));
const report = (file) => ({
  success: true,
  startTime: 1,
  numTotalTestSuites: 1,
  numPassedTestSuites: 1,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  snapshot: { total: 0, didUpdate: false },
  testResults: [
    {
      name: path.join(root, file),
      status: 'passed',
      message: '',
      assertionResults: [
        { fullName: 'immutable test identity', status: 'passed', failureMessages: [] },
      ],
    },
  ],
});

it('native acceptance exposes a complete cohort planner and strict report merger', () => {
  expect(cohorts.planDatabaseCohorts).toBeTypeOf('function');
  expect(cohorts.mergeDatabaseReports).toBeTypeOf('function');
});

it('native acceptance owns parallel and serial children under one bounded deadline', () => {
  expect(cohorts.runDatabaseCohorts).toBeTypeOf('function');
});

it('covers every native file once, including future files, without overlapping role changes', () => {
  const future = 'packages/database/test/future.integration.test.ts';
  const plan = cohorts.planDatabaseCohorts([...files, future]);
  expect(plan).toEqual([
    { id: 'main', parallel: true, files: [other, future].sort() },
    { id: 'registry', parallel: true, files: [registry] },
    { id: 'roles', parallel: false, files: [roles] },
  ]);
  expect(() => cohorts.planDatabaseCohorts([...files, other])).toThrow();
  expect(() => cohorts.planDatabaseCohorts([other, registry])).toThrow();
  expect(() => cohorts.planDatabaseCohorts([...files, '../arbitrary.ts'])).toThrow();
});

it('discovers the actual full native inventory without hardcoded test counts', async () => {
  const actual = await cohorts.discoverDatabaseFiles(root);
  const plan = cohorts.planDatabaseCohorts(actual);
  expect(plan.flatMap((cohort) => cohort.files).sort()).toEqual(actual);
  expect(actual.length).toBeGreaterThanOrEqual(38);
});

it('parallel children handshake and close before the cluster-role child starts', async () => {
  const dir = await temp();
  const result = await cohorts.runDatabaseCohorts(jobs(dir, ['parallel', 'parallel', 'serial']), {
    timeoutMs: 3000,
  });
  expect(result.completed).toHaveLength(3);
  const serial = result.completed.find((item) => item.id === 'roles');
  for (const parallel of result.completed.filter((item) => item.id !== 'roles'))
    expect(serial.startMs).toBeGreaterThanOrEqual(parallel.settledMs);
  expect(await exists(path.join(dir, 'roles.done'))).toBe(true);
});

it('one aggregate deadline includes both parallel and subsequent serial work', async () => {
  const dir = await temp();
  const work = jobs(dir, ['parallel', 'parallel', 'serial'], '1000');
  await expect(cohorts.runDatabaseCohorts(work, { timeoutMs: 1800 })).rejects.toThrow(
    /deadline|abort/u,
  );
  expect(await exists(path.join(dir, 'main.done'))).toBe(true);
  expect(await exists(path.join(dir, 'registry.done'))).toBe(true);
  expect(await exists(path.join(dir, 'roles.done'))).toBe(false);
});

it('failure stops a running sibling and never starts serial role changes', async () => {
  const dir = await temp();
  await expect(
    cohorts.runDatabaseCohorts(jobs(dir, ['fail', 'hang', 'serial']), { timeoutMs: 3000 }),
  ).rejects.toThrow();
  expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
  const heartbeat = path.join(dir, 'registry.heartbeat');
  const before = await readFile(heartbeat, 'utf8');
  await delay(80);
  expect(await readFile(heartbeat, 'utf8')).toBe(before);
});

it.each(['abort', 'deadline'])(
  '%s physically stops owned child and descendant before returning',
  async (kind) => {
    const dir = await temp();
    const controller = new AbortController();
    const pending = cohorts.runDatabaseCohorts(jobs(dir, ['tree', 'hang', 'serial']), {
      timeoutMs: kind === 'deadline' ? 2000 : 3000,
      signal: controller.signal,
    });
    // Attach the rejection handler immediately, before awaiting fixture startup.
    const rejection = expect(pending).rejects.toThrow(/deadline|abort/u);
    await until(() => exists(path.join(dir, 'descendant.heartbeat')));
    if (kind === 'abort') controller.abort();
    await rejection;
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
    for (const id of ['main', 'registry', 'descendant']) {
      const heartbeat = path.join(dir, `${id}.heartbeat`);
      const before = await readFile(heartbeat, 'utf8');
      await delay(80);
      expect(await readFile(heartbeat, 'utf8')).toBe(before);
    }
  },
);

it('pre-abort starts no process and invalid orchestration cannot extend the 480s cap', async () => {
  const dir = await temp();
  await expect(
    cohorts.runDatabaseCohorts(jobs(dir, ['hang', 'hang', 'serial']), {
      timeoutMs: 1000,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(await exists(path.join(dir, 'main.started'))).toBe(false);
  await expect(
    cohorts.runDatabaseCohorts(jobs(dir, ['hang', 'hang', 'serial']), { timeoutMs: 480001 }),
  ).rejects.toThrow();
});

it('merges complete reports with original assertion identities and exact summed counts', () => {
  const plan = cohorts.planDatabaseCohorts(files);
  const reports = plan.map((cohort) => report(cohort.files[0]));
  const merged = cohorts.mergeDatabaseReports(plan, reports, root);
  expect(merged.numPassedTests).toBe(3);
  expect(merged.numTotalTestSuites).toBe(3);
  expect(merged.testResults).toHaveLength(3);
  expect(
    merged.testResults.every(
      (file) => file.assertionResults[0].fullName === 'immutable test identity',
    ),
  ).toBe(true);
});

it.each([
  'missing-report',
  'missing-file',
  'duplicate-file',
  'unexpected-file',
  'duplicate-assertion',
  'skipped',
  'failed',
  'count-mismatch',
  'incomplete',
  'snapshot-update',
])('fails closed for %s without producing merged acceptance', (fault) => {
  const plan = cohorts.planDatabaseCohorts(files);
  const reports = plan.map((cohort) => report(cohort.files[0]));
  const first = reports[0];
  if (fault === 'missing-report') reports.pop();
  if (fault === 'missing-file') first.testResults = [];
  if (fault === 'duplicate-file') reports[1].testResults = first.testResults;
  if (fault === 'unexpected-file')
    first.testResults[0].name = path.join(root, 'packages/database/test/extra.integration.test.ts');
  if (fault === 'duplicate-assertion') {
    first.testResults[0].assertionResults.push(first.testResults[0].assertionResults[0]);
    first.numPassedTests++;
    first.numTotalTests++;
  }
  if (fault === 'skipped') first.testResults[0].assertionResults[0].status = 'pending';
  if (fault === 'failed') first.testResults[0].assertionResults[0].status = 'failed';
  if (fault === 'count-mismatch') first.numPassedTests++;
  if (fault === 'incomplete') first.success = false;
  if (fault === 'snapshot-update') first.snapshot.didUpdate = true;
  expect(() => cohorts.mergeDatabaseReports(plan, reports, root)).toThrow();
});
