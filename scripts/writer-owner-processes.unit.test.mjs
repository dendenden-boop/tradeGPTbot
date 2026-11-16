import { expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const module = await import('./writer-owner-processes.mjs').catch(() => ({}));
const run = () => {
  expect(module.runOwnedWriterProcesses).toBeTypeOf('function');
  return module.runOwnedWriterProcesses;
};
const job = (id, code) => ({ id, binary: process.execPath, args: ['-e', code] });
it('a synchronous launch failure drains an already started sibling immediately', async () => {
  const bad = {
    id: 'risk',
    binary: process.execPath,
    get args() {
      throw Error('PRIVATE_LAUNCH_FAILURE');
    },
  };
  await expect(
    run()([job('economic', 'setInterval(()=>{},1000)'), bad], { timeoutMs: 2000 }),
  ).rejects.toThrow('WRITER_OWNER_PROCESS_FAILED');
});
it('starts at most two real independent processes and returns only after both physically close', async () => {
  const result = await run()(
    [job('economic', 'setTimeout(()=>{},700)'), job('risk', 'setTimeout(()=>{},900)')],
    { timeoutMs: 5000 },
  );
  expect(result.processes.map((p) => p.id)).toEqual(['economic', 'risk']);
  expect(Math.max(...result.processes.map((p) => p.startMs))).toBeLessThan(
    Math.min(...result.processes.map((p) => p.settledMs)),
  );
  expect(result.elapsedMs).toBeLessThan(5000);
});
it('a delayed second spawn consumes the same original deadline rather than receiving a fresh budget', async () => {
  const second = job('risk', 'setTimeout(()=>{},1800)');
  Object.defineProperty(second, 'args', {
    get() {
      const end = performance.now() + 1800;
      while (performance.now() < end) {
        // Deliberately delay the second spawn; the shared budget must keep running.
      }
      return ['-e', 'setTimeout(()=>{},1800)'];
    },
  });
  await expect(
    run()([job('economic', 'setTimeout(()=>{},500)'), second], { timeoutMs: 3000 }),
  ).rejects.toThrow('WRITER_OWNER_DEADLINE');
});
it('a failed child drains a hanging sibling before rejecting, without retry', async () => {
  const began = performance.now();
  await expect(
    run()(
      [
        job('economic', 'setTimeout(()=>process.exit(7),400)'),
        job('risk', 'setInterval(()=>{},1000)'),
      ],
      { timeoutMs: 5000 },
    ),
  ).rejects.toThrow('WRITER_OWNER_PROCESS_FAILED');
  expect(performance.now() - began).toBeLessThan(5000);
});
it('abort drains both physical processes and an excessive budget fails closed', async () => {
  const execute = run(),
    controller = new AbortController();
  const result = execute(
    [job('economic', 'setInterval(()=>{},1000)'), job('risk', 'setInterval(()=>{},1000)')],
    { timeoutMs: 5000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 400);
  await expect(result).rejects.toThrow('WRITER_OWNER_ABORTED');
  await expect(
    execute([job('economic', ''), job('risk', '')], { timeoutMs: 90001 }),
  ).rejects.toThrow();
});
it('includes earlier provisioning time in the same budget without resetting its clock', async () => {
  await expect(
    run()([job('economic', 'setTimeout(()=>{},400)'), job('risk', 'setTimeout(()=>{},400)')], {
      timeoutMs: 1000,
      budgetStarted: { wall: Date.now() - 800, monotonic: performance.now() - 800 },
    }),
  ).rejects.toThrow('WRITER_OWNER_DEADLINE');
});
it('failure also stops the sibling grandchild heartbeat before returning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ctp-writer-owner-'));
  if (
    path.dirname(root) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('ctp-writer-owner-')
  )
    throw Error('TEST_CLEANUP_SCOPE');
  const marker = path.join(root, 'heartbeat'),
    pidFile = path.join(root, 'pid');
  const grandchild =
    'const fs=require("node:fs");fs.writeFileSync(' +
    JSON.stringify(pidFile) +
    ',String(process.pid));setInterval(()=>fs.writeFileSync(' +
    JSON.stringify(marker) +
    ',String(Date.now())),30);';
  const parent =
    'require("node:child_process").spawn(process.execPath,["-e",' +
    JSON.stringify(grandchild) +
    '],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000);';
  try {
    await expect(
      run()([job('economic', 'setTimeout(()=>process.exit(7),1600)'), job('risk', parent)], {
        timeoutMs: 6000,
      }),
    ).rejects.toThrow('WRITER_OWNER_PROCESS_FAILED');
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    const before = (await stat(marker)).mtimeMs;
    await delay(150);
    expect((await stat(marker)).mtimeMs).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
