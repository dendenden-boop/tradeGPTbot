import { expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  discoverDatabaseFiles,
  planDatabaseCohorts,
  runDatabaseCohorts,
} from './database-cohorts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(
  new URL('./fixtures/execution-start-overlap-worker.mjs', import.meta.url),
);
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );
async function fixture(mode = 'normal') {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/execution-writer-'));
  const jobs = planDatabaseCohorts(await discoverDatabaseFiles(), {
    executionStartOverlap: true,
  }).map((p) => ({
    ...p,
    binary: process.execPath,
    args: [worker, dir, p.id, p.id === 'execution-commit' ? mode : 'normal'],
  }));
  return { dir, jobs };
}
it('runs every one of eight actual planned cohorts and closes all mutators before the financial writer and roles', async () => {
  const { jobs } = await fixture(),
    r = await runDatabaseCohorts(jobs, { timeoutMs: 5000 });
  expect(r.completed.map((c) => c.id).sort()).toEqual(jobs.map((c) => c.id).sort());
  const timing = (id) => r.completed.find((c) => c.id === id),
    writer = timing('execution-commit');
  for (const id of [
    'main',
    'registry',
    'admission',
    'native-admission',
    'execution-start',
    'execution-preview',
  ])
    expect(writer.startMs).toBeGreaterThanOrEqual(timing(id).settledMs);
  expect(timing('roles').startMs).toBeGreaterThanOrEqual(writer.settledMs);
});
it('rejects a failed financial writer and never starts the final role mutation scope', async () => {
  const { dir, jobs } = await fixture('fail');
  // The existing failure fixture awaits this file before its intentional exit7.
  await writeFile(path.join(dir, 'admission.heartbeat'), 'test-only failure handshake');
  await expect(runDatabaseCohorts(jobs, { timeoutMs: 5000 })).rejects.toThrow(
    'Native cohort execution-commit failed',
  );
  expect(await exists(path.join(dir, 'execution-commit.started'))).toBe(true);
  expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
});
it('aborts a physically active writer before any role probe and waits until its heartbeat stops', async () => {
  const { dir, jobs } = await fixture('hang'),
    c = new AbortController();
  const pending = runDatabaseCohorts(jobs, { timeoutMs: 5000, signal: c.signal }).then(
    (value) => ({ value, error: null }),
    (error) => ({ error }),
  );
  try {
    const heartbeat = path.join(dir, 'execution-commit.heartbeat'),
      end = Date.now() + 4000;
    while (!(await exists(heartbeat))) {
      const settled = await Promise.race([pending, delay(10).then(() => null)]);
      if (settled) throw settled.error ?? Error('Writer did not start');
      if (Date.now() >= end) throw Error('Writer fixture handshake deadline');
    }
    c.abort();
    expect((await pending).error).toBeInstanceOf(Error);
    const before = await readFile(heartbeat, 'utf8');
    await delay(80);
    expect(await readFile(heartbeat, 'utf8')).toBe(before);
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
  } finally {
    c.abort();
    await pending;
  }
});
