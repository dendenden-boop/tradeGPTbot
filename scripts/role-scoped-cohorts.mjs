// Test-only scope scheduler. Original eight-cohort executor stays unchanged.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { sanitize, workspace } from './docker-test-utils.mjs';
import { scopedMainFiles, verifyScopedMainFiles } from './native-main-scopes.mjs';

export async function planRoleScopedCohorts(plan) {
  await verifyScopedMainFiles();
  assert.deepEqual(
    plan.map((c) => c.id),
    [
      'main',
      'registry',
      'admission',
      'native-admission',
      'execution-start',
      'execution-preview',
      'execution-commit',
      'roles',
    ],
  );
  assert.equal(plan[4].parallel, true);
  const scope = new Set(scopedMainFiles),
    original = plan[0].files;
  assert(scopedMainFiles.every((f) => original.includes(f)));
  // Exercise the unchanged 300-instrument publisher without competing native
  // workload on this PostgreSQL server. This strengthens the original barrier;
  // its bounded SQL operations and the aggregate deadline stay unchanged.
  const first = { ...plan[0], after: ['registry'], files: original.filter((f) => !scope.has(f)) };
  assert(first.files.length > 0);
  const late = {
    id: 'main-scoped',
    files: [...scopedMainFiles],
    parallel: true,
    after: ['main', 'registry'],
  };
  const result = [
    first,
    plan[1],
    late,
    ...plan
      .slice(2, -1)
      .map((c) => (c.id === 'execution-commit' ? { ...c, after: [...c.after, 'main-scoped'] } : c)),
  ];
  result.push({ ...plan.at(-1), after: result.map((c) => c.id) });
  assert.deepEqual(result.flatMap((c) => c.files).sort(), plan.flatMap((c) => c.files).sort());
  assert.equal(new Set(result.flatMap((c) => c.files)).size, result.flatMap((c) => c.files).length);
  return result;
}

export const roleScopedShape = [
  { id: 'main', parallel: true, after: ['registry'] },
  { id: 'registry', parallel: true },
  { id: 'main-scoped', parallel: true, after: ['main', 'registry'] },
  { id: 'admission', parallel: true, after: ['main', 'registry'] },
  { id: 'native-admission', parallel: true, after: ['main', 'registry'] },
  {
    id: 'execution-start',
    parallel: true,
    after: ['main', 'registry'],
    afterAny: ['admission', 'native-admission'],
  },
  { id: 'execution-preview', parallel: true, after: ['execution-start'] },
  {
    id: 'execution-commit',
    parallel: false,
    after: [
      'main',
      'registry',
      'admission',
      'native-admission',
      'execution-start',
      'execution-preview',
      'main-scoped',
    ],
  },
  {
    id: 'roles',
    parallel: false,
    after: [
      'main',
      'registry',
      'main-scoped',
      'admission',
      'native-admission',
      'execution-start',
      'execution-preview',
      'execution-commit',
    ],
  },
];
export async function runRoleScopedCohorts(
  jobs,
  { timeoutMs, signal, secrets = [], echo = false, cwd = workspace },
) {
  await verifyScopedMainFiles(cwd);
  assert.deepEqual(
    jobs.map(({ id, parallel, after, afterAny }) => ({
      id,
      parallel,
      ...(after === undefined ? {} : { after }),
      ...(afterAny === undefined ? {} : { afterAny }),
    })),
    roleScopedShape,
  );
  assert.deepEqual(jobs[2].files, [...scopedMainFiles]);
  // BEGIN IDENTICAL PHYSICAL LAUNCHER
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 480000);
  const started = performance.now();
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(stop, timeoutMs);
  const completed = [];
  let firstFailure;
  const run = (job) =>
    new Promise((resolve, reject) => {
      if (controller.signal.aborted || performance.now() - started >= timeoutMs) {
        stop();
        reject(new Error('Native cohort deadline/abort before start'));
        return;
      }
      const startMs = performance.now() - started;
      const child = spawn(job.binary, job.args, {
        env: job.env ?? process.env,
        cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '',
        failure,
        cleanupTimer;
      let terminating = false;
      const terminate = () => {
        if (terminating) return;
        terminating = true;
        failure ??= new Error(`Native cohort ${job.id} deadline/abort`);
        if (child.pid) {
          try {
            if (process.platform === 'win32') {
              execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
                timeout: 2000,
              });
            } else process.kill(-child.pid, 'SIGKILL');
          } catch {
            // A settled tree is harmless; an unkillable child still fails closed.
            child.kill('SIGKILL');
          }
        }
        cleanupTimer ??= setTimeout(
          () => finish(new Error(`Native cohort ${job.id} did not physically close`)),
          5000,
        );
      };
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(cleanupTimer);
        controller.signal.removeEventListener('abort', terminate);
        if (echo && output) console.log(sanitize(output, secrets));
        if (error) {
          firstFailure ??= error;
          stop();
          reject(error);
        } else {
          completed.push({ id: job.id, startMs, settledMs: performance.now() - started });
          resolve();
        }
      };
      controller.signal.addEventListener('abort', terminate, { once: true });
      const receive = (chunk) => {
        output += chunk.toString();
        if (output.length > 2_000_000) {
          output = output.slice(0, 2_000_000);
          failure = new Error(`Native cohort ${job.id} output bound`);
          stop();
        }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.once('error', () => {
        failure = new Error(`Cannot start native cohort ${job.id}`);
        stop();
      });
      child.once('close', (code) => {
        if (code !== 0) failure ??= new Error(`Native cohort ${job.id} failed (${code})`);
        if (controller.signal.aborted || performance.now() - started >= timeoutMs)
          failure ??= new Error(`Native cohort ${job.id} deadline/abort`);
        // Also clean the failed child's own process group, even if its leader
        // exited before a descendant. Sibling cancellation alone is insufficient.
        if (failure) terminate();
        finish(failure);
      });
    });
  // END IDENTICAL PHYSICAL LAUNCHER
  const pending = [...jobs],
    active = new Map(),
    done = new Set();
  try {
    while (done.size < jobs.length) {
      if (controller.signal.aborted)
        throw firstFailure ?? new Error('Native scoped aggregate deadline/abort');
      for (let i = 0; i < pending.length && active.size < 2;) {
        const job = pending[i],
          ready =
            (job.after ?? []).every((id) => done.has(id)) &&
            (!job.afterAny || job.afterAny.some((id) => done.has(id)));
        if (!ready || (!job.parallel && active.size > 0)) {
          i++;
          continue;
        }
        pending.splice(i, 1);
        active.set(
          job.id,
          run(job).then(
            () => ({ id: job.id }),
            (error) => ({ id: job.id, error }),
          ),
        );
        if (!job.parallel) break;
      }
      assert(active.size > 0, 'Unreachable native scoped dependency');
      const outcome = await Promise.race(active.values());
      active.delete(outcome.id);
      if (outcome.error) throw firstFailure ?? outcome.error;
      done.add(outcome.id);
    }
    if (controller.signal.aborted || performance.now() - started >= timeoutMs)
      throw new Error('Native scoped aggregate deadline/abort');
    return { timeoutMs, elapsedMs: performance.now() - started, completed };
  } finally {
    stop();
    await Promise.all(active.values());
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
