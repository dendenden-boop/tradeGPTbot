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

async function exerciseProgress(deliveryDelayMs = 0, witnessReadyAfterMs = 0) {
  await mkdir(path.join(root, 'test-results/cohort-unit'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-results/cohort-unit/native-progress-'));
  const fixture = path.join(dir, 'progress.test.mjs'),
    config = path.join(dir, 'vitest.config.ts'),
    reporter = path.join(dir, 'progress-reporter.mjs');
  await writeFile(
    fixture,
    `import {it,expect} from 'vitest';import {writeFile,readFile} from 'node:fs/promises';import {setTimeout as wait} from 'node:timers/promises';
it('completed native owner progress witness',async()=>{if(${witnessReadyAfterMs}>0){const start=Number(await readFile(new URL('./start.at',import.meta.url),'utf8'));await wait(Math.max(0,start+${witnessReadyAfterMs}-Date.now()));}expect(2+2).toBe(4)});
it('blocked native owner progress witness',async()=>{await writeFile(new URL('./blocked.ready',import.meta.url),String(Date.now()));await new Promise(()=>{})});
`,
  );
  const portable = (s) => s.replaceAll('\\', '/');
  await writeFile(
    reporter,
    `import {VerboseReporter} from 'vitest/reporters';
import {writeFile} from 'node:fs/promises';
import {setTimeout as wait} from 'node:timers/promises';
export default class ProgressReporter extends VerboseReporter {
  async onTestCaseResult(test) {
    const witness=test.task.name==='completed native owner progress witness';
    if(witness) await wait(${deliveryDelayMs});
    super.onTestCaseResult(test);
    if(witness && test.result().state==='passed') {
      await new Promise((resolve,reject)=>this.ctx.logger.outputStream.write('',error=>error?reject(error):resolve()));
      await writeFile(new URL('./progress.ready',import.meta.url),String(Date.now()));
    }
  }
}
`,
  );
  await writeFile(
    config,
    `import native from ${JSON.stringify(portable(path.join(root, 'vitest.database.config.ts')))};
export default {...native,test:{...native.test,include:[${JSON.stringify(portable(fixture))}],reporters:[${JSON.stringify(portable(reporter))},'json'],outputFile:{json:${JSON.stringify(portable(path.join(dir, 'complete.json')))}}}};
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
  await writeFile(path.join(dir, 'start.at'), String(Date.now()));
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
    while (
      !(await exists(path.join(dir, 'blocked.ready'))) ||
      !(await exists(path.join(dir, 'progress.ready')))
    ) {
      const early = await Promise.race([observed, wait(10).then(() => null)]);
      if (early?.error) throw early.error;
      if (Date.now() >= end) throw Error('Native progress fixture startup deadline');
    }
    // The real VerboseReporter acknowledged its completed-case stdout flush.
    // The later case is still blocked; the original startup deadline bounds both.
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
    const markers = Object.fromEntries(
      await Promise.all(
        ['start.at', 'blocked.ready', 'progress.ready'].map(async (name) => [
          name,
          await readFile(path.join(dir, name), 'utf8').then(
            (v) => Number(v) || null,
            () => null,
          ),
        ]),
      ),
    );
    await writeFile(path.join(dir, 'timing.json'), JSON.stringify(markers));
    logger.mockRestore();
  }
}
it(
  'retains completed native case progress when a later case is physically interrupted',
  () => exerciseProgress(),
  15000,
);
it(
  'retains completed native progress when parent output delivery exceeds the old fixed drain',
  () => exerciseProgress(1000),
  15000,
);
it(
  'keeps six-second startup independent of delayed delivery within the original eight-second cohort',
  () => exerciseProgress(1000, 5200),
  15000,
);
