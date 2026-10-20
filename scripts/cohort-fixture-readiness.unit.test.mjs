import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runDatabaseCohorts } from './database-cohorts.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(new URL('./fixtures/database-cohort-worker.mjs', import.meta.url));
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
it('tree readiness cannot trigger abort before its delayed sibling has a heartbeat', async () => {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/readiness-'));
  const release = path.join(dir, 'registry.release'),
    controller = new AbortController();
  // Delay the sibling's first instruction deterministically; the original CI
  // failure otherwise depended on which process the OS scheduled first.
  const delayed = `import {existsSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';import {pathToFileURL} from 'node:url';
    while(!existsSync(${JSON.stringify(release)}))await delay(5);
    process.argv=[process.execPath,${JSON.stringify(worker)},${JSON.stringify(dir)},'registry','hang'];await import(pathToFileURL(${JSON.stringify(worker)}).href);`;
  const jobs = ['main', 'registry', 'roles'].map((id, index) => ({
    id,
    parallel: index < 2,
    binary: process.execPath,
    args:
      id === 'registry'
        ? ['--input-type=module', '--eval', delayed]
        : [worker, dir, id, id === 'main' ? 'tree' : 'serial'],
  }));
  const pending = runDatabaseCohorts(jobs, { timeoutMs: 4000, signal: controller.signal }).then(
    () => ({ error: null }),
    (error) => ({ error }),
  );
  const timer = setTimeout(() => {
    void writeFile(release, 'ready');
  }, 1000);
  try {
    const deadline = Date.now() + 3000;
    while (!(await exists(path.join(dir, 'descendant.heartbeat')))) {
      if (Date.now() > deadline) throw Error('Fixture descendant readiness deadline');
      await delay(5);
    }
    controller.abort();
    expect((await pending).error).toMatchObject({
      message: expect.stringMatching(/abort|deadline/u),
    });
    for (const id of ['main', 'registry', 'descendant']) {
      const file = path.join(dir, id + '.heartbeat'),
        before = await readFile(file, 'utf8');
      await delay(80);
      expect(await readFile(file, 'utf8')).toBe(before);
    }
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await pending;
  }
});
