// REGISTRY_DOMAIN_EARLY_NATIVE: explicit additional profile; legacy barriers remain.
// Certified test-only two-cluster schedule. No production export.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { sanitize, workspace } from './docker-test-utils.mjs';
import {
  scopedMainFiles,
  scopedMainDatabaseName,
  verifyScopedMainFiles,
} from './native-main-scopes.mjs';
import { planRoleScopedCohorts } from './role-scoped-cohorts.mjs';
import { assertNativeClusterIsolation } from './native-cluster-isolation.mjs';
import {
  assertRegistryIndependence,
  verifyRegistryDomainInputs,
} from './registry-domain-independence.mjs';
export {
  proveRegistryIndependence,
  assertRegistryIndependence,
} from './registry-domain-independence.mjs';

function requireClusterRoutes(jobs, isolation) {
  try {
    const main = jobs.find((j) => j.id === 'main').database;
    assert.match(main, /^ctp_p2_fresh_[a-f0-9]{12}$/u);
    const suffix = main.slice(-12);
    for (const job of jobs) {
      const primary = ['main', 'registry', 'roles'].includes(job.id);
      const expected =
        job.id === 'registry'
          ? 'ctp_p2_registry_cohort_' + suffix
          : job.id === 'main-scoped'
            ? scopedMainDatabaseName(main)
            : job.id === 'admission'
              ? 'ctp_p2_admission_cohort_' + suffix
              : ['execution-start', 'execution-preview', 'execution-commit'].includes(job.id)
                ? 'ctp_p2_execution_start_cohort_' + suffix
                : main;
      assert.equal(job.cluster, primary ? 'PRIMARY' : 'SECONDARY');
      assert.equal(job.database, expected);
      assert(Object.hasOwn(job.env, 'DATABASE_MIGRATION_URL'));
      for (const [key, value] of Object.entries(job.env))
        if (key.startsWith('DATABASE_')) {
          const url = new URL(value);
          assert.equal(url.protocol, 'postgresql:');
          assert.equal(url.hostname, '127.0.0.1');
          assert.equal(url.port, String((primary ? isolation.primary : isolation.secondary).port));
          assert.equal(url.pathname, '/' + expected);
          assert.equal(url.search, '');
          assert.equal(url.hash, '');
          assert(
            url.username === 'ctp_test' ||
              (url.username.startsWith('ctp_p2_') && url.username.endsWith('_' + suffix)),
          );
          assert.match(url.password, /^[a-f0-9]{48}$/u);
        }
    }
  } catch {
    throw Error('NATIVE_CLUSTER_ROUTE');
  }
}

export const clusterIsolatedShape = [
  { id: 'main', parallel: true, after: ['registry'] },
  { id: 'registry', parallel: true },
  { id: 'main-scoped', parallel: true, after: ['registry'] },
  { id: 'admission', parallel: true, after: ['registry', 'main-scoped'] },
  { id: 'native-admission', parallel: true, after: ['registry', 'main-scoped'] },
  {
    id: 'execution-start',
    parallel: true,
    after: ['registry', 'main-scoped'],
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

export async function planClusterIsolatedCohorts(original, isolation) {
  assertNativeClusterIsolation(isolation);
  const result = await planRoleScopedCohorts(original);
  return result.map((c) =>
    c.id === 'main-scoped'
      ? { ...c, after: ['registry'] }
      : ['admission', 'native-admission', 'execution-start'].includes(c.id)
        ? { ...c, after: ['registry', 'main-scoped'] }
        : c,
  );
}

export async function runClusterIsolatedCohorts(
  jobs,
  { timeoutMs, signal, secrets = [], echo = false, cwd = workspace, isolation, registryProof },
) {
  assertNativeClusterIsolation(isolation);
  if (registryProof !== undefined) {
    assertRegistryIndependence(registryProof, isolation);
    await verifyRegistryDomainInputs(cwd);
  }
  await verifyScopedMainFiles(cwd);
  assert.deepEqual(
    jobs.map(({ id, parallel, after, afterAny }) => ({
      id,
      parallel,
      ...(after === undefined ? {} : { after }),
      ...(afterAny === undefined ? {} : { afterAny }),
    })),
    registryProof === undefined ? clusterIsolatedShape : registryIsolatedShape,
  );
  assert.deepEqual(jobs[2].files, [...scopedMainFiles]);
  requireClusterRoutes(jobs, isolation);
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
    return {
      timeoutMs,
      elapsedMs: performance.now() - started,
      completed,
      ...(registryProof === undefined ? {} : { registryIndependence: registryProof.evidence }),
    };
  } finally {
    stop();
    await Promise.all(active.values());
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

// An explicit extra profile; the original conservative API/shape is unchanged.
export const registryIsolatedShape = clusterIsolatedShape.map((job) =>
  job.id === 'native-admission' ? { ...job, after: [] } : job,
);
export async function planRegistryIsolatedCohorts(original, isolation, registryProof) {
  assertRegistryIndependence(registryProof, isolation);
  await verifyRegistryDomainInputs();
  return (await planClusterIsolatedCohorts(original, isolation)).map((job) =>
    job.id === 'native-admission' ? { ...job, after: [] } : job,
  );
}
export async function runRegistryIsolatedCohorts(jobs, options) {
  assertRegistryIndependence(options.registryProof, options.isolation);
  return runClusterIsolatedCohorts(jobs, options);
}
