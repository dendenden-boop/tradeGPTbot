// Private CI child lifetime. A single monotonic budget covers both processes.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { sanitize, workspace } from './docker-test-utils.mjs';

export async function runOwnedWriterProcesses(
  jobs,
  { timeoutMs, signal, secrets = [], echo = false, cwd = workspace, budgetStarted },
) {
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    jobs.map((j) => j.id),
    ['economic', 'risk'],
  );
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 90000);
  const began = budgetStarted?.monotonic ?? performance.now(),
    startedAtMs = budgetStarted?.wall ?? Date.now(),
    controller = new AbortController(),
    states = [];
  let failure;
  const stop = (code) => {
    failure ??= Error(code);
    controller.abort();
  };
  const abort = () => stop('WRITER_OWNER_ABORTED');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  assert(Number.isFinite(began) && began <= performance.now());
  assert(Number.isSafeInteger(startedAtMs) && startedAtMs <= Date.now());
  const timer = setTimeout(
    () => stop('WRITER_OWNER_DEADLINE'),
    Math.max(1, timeoutMs - (performance.now() - began)),
  );
  const expired = () => performance.now() - began >= timeoutMs;
  const launch = (job) =>
    new Promise((resolve, reject) => {
      let startMs, child;
      try {
        const args = job.args;
        if (expired()) stop('WRITER_OWNER_DEADLINE');
        if (controller.signal.aborted) {
          reject(failure);
          return;
        }
        startMs = performance.now() - began;
        child = spawn(job.binary, args, {
          env: job.env ?? process.env,
          cwd,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        stop('WRITER_OWNER_PROCESS_FAILED');
        reject(failure);
        return;
      }
      let output = '',
        done = false,
        cleanup;
      const terminate = () => {
        if (child.pid) {
          try {
            if (process.platform === 'win32')
              execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
                timeout: 2000,
              });
            else process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
        cleanup ??= setTimeout(() => finish(Error('WRITER_OWNER_PHYSICAL_CLOSE_FAILED')), 5000);
      };
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(cleanup);
        controller.signal.removeEventListener('abort', terminate);
        if (echo && output) console.log(sanitize(output, secrets));
        if (error) {
          stop(error.message);
          reject(failure);
        } else {
          states.push({ id: job.id, startMs, settledMs: performance.now() - began });
          resolve();
        }
      };
      controller.signal.addEventListener('abort', terminate, { once: true });
      if (controller.signal.aborted) terminate();
      const receive = (chunk) => {
        output += chunk.toString();
        if (output.length > 2000000) {
          output = output.slice(0, 2000000);
          stop('WRITER_OWNER_OUTPUT_BOUND');
        }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.once('error', () => finish(Error('WRITER_OWNER_PROCESS_FAILED')));
      child.once('close', (code) => {
        if (expired()) stop('WRITER_OWNER_DEADLINE');
        if (code !== 0 && !failure) stop('WRITER_OWNER_PROCESS_FAILED');
        if (!failure && process.platform !== 'win32' && child.pid) {
          let alive = false;
          try {
            process.kill(-child.pid, 0);
            alive = true;
          } catch {
            // ESRCH means this owned process group has already physically closed.
          }
          if (alive) {
            stop('WRITER_OWNER_PROCESS_TREE_ACTIVE');
            terminate();
          }
        }
        finish(failure);
      });
    });
  try {
    const results = await Promise.allSettled(jobs.map(launch));
    if (expired()) stop('WRITER_OWNER_DEADLINE');
    if (failure) throw failure;
    assert(results.every((r) => r.status === 'fulfilled'));
    assert.equal(states.length, 2);
    return {
      timeoutMs,
      startedAtMs,
      completedAtMs: Date.now(),
      elapsedMs: performance.now() - began,
      processes: jobs.map((j) => states.find((p) => p.id === j.id)),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
