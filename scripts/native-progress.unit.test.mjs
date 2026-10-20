import { expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runDatabaseCohorts } from './database-cohorts.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(new URL('./fixtures/database-cohort-worker.mjs', import.meta.url));
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

it('retains completed native case progress when a later case is physically interrupted', async () => {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/native-progress-'));
  const fixture = path.join(dir, 'progress.test.mjs'),
    config = path.join(dir, 'vitest.config.ts');
  await writeFile(
    fixture,
    `import {it,expect} from 'vitest';import {writeFile} from 'node:fs/promises';
it('completed native owner progress witness',()=>{expect(2+2).toBe(4)});
it('blocked native owner progress witness',async()=>{await writeFile(new URL('./blocked.ready',import.meta.url),'ready');await new Promise(()=>{})});
`,
  );
  const portable = (s) => s.replaceAll('\\', '/');
  await writeFile(
    config,
    `import native from ${JSON.stringify(portable(path.join(root, 'vitest.database.config.ts')))};
export default {...native,test:{...native.test,include:[${JSON.stringify(portable(fixture))}],outputFile:{json:${JSON.stringify(portable(path.join(dir, 'complete.json')))}}}};
`,
  );
  const controller = new AbortController(),
    output = [];
  const logger = vi.spyOn(console, 'log').mockImplementation((text) => output.push(String(text)));
  const jobs = ['main', 'registry', 'roles'].map((id, index) => ({
    id,
    parallel: index < 2,
    binary: process.execPath,
    args:
      id === 'main'
        ? [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config]
        : [worker, dir, id, id === 'registry' ? 'hang' : 'serial'],
    env: { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' },
  }));
  const observed = runDatabaseCohorts(jobs, {
    timeoutMs: 8000,
    signal: controller.signal,
    echo: true,
  }).then(
    (value) => ({ value, error: null }),
    (error) => ({ error }),
  );
  try {
    const end = Date.now() + 6000;
    while (!(await exists(path.join(dir, 'blocked.ready')))) {
      const early = await Promise.race([observed, wait(10).then(() => null)]);
      if (early?.error) throw early.error;
      if (Date.now() >= end) throw Error('Native progress fixture startup deadline');
    }
    // Let the real parent reporter drain the already completed first case's
    // IPC event; the second case remains blocked, so no complete module exists.
    await wait(250);
    controller.abort();
    expect((await observed).error).toMatchObject({
      message: expect.stringMatching(/abort|deadline/u),
    });
    const captured = output.join('\n');
    await writeFile(path.join(dir, 'partial.log'), captured);
    expect(await exists(path.join(dir, 'complete.json'))).toBe(false);
    expect(await exists(path.join(dir, 'roles.started'))).toBe(false);
    expect(captured).toContain('completed native owner progress witness');
    const heartbeat = path.join(dir, 'registry.heartbeat'),
      before = await readFile(heartbeat, 'utf8');
    await wait(80);
    expect(await readFile(heartbeat, 'utf8')).toBe(before);
  } finally {
    controller.abort();
    await observed;
    logger.mockRestore();
  }
}, 15000);
