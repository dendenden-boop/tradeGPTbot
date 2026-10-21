// Private native acceptance orchestration, not a production runtime export.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { sanitize, workspace } from './docker-test-utils.mjs';

const registry = 'packages/database/test/instrument-registry.integration.test.ts';
const roles = 'packages/database/test/runtime-role-graph.integration.test.ts';
const admission = 'packages/database/test/paper-admission.integration.test.ts';
const nativeAdmission = 'packages/database/test/risk-admission.integration.test.ts';
const nativeFile = /^packages\/(database|auth)\/test\/[^/]+\.integration\.test\.ts$/u;

// Only reviewed files without cluster-role DDL may overlap after the mutator
// barrier. LF normalization permits identical Windows/Linux Git checkouts.
// Any future test/helper change requires an explicit isolation re-review.
export async function verifyAdmissionParallelFiles(root = workspace) {
  for (const [file, expected] of [
    [nativeAdmission, '55a9b37c8da4565bc08d9c64aff7aaadc77e4d7a46e2ad48b6a988e7dd0b8c7c'],
    [
      'packages/database/test/fixtures/risk-certification.ts',
      '6b73c812085a6e1230fa0bc01a34c1525b0ed42c5832c5908056d35e5922f54c',
    ],
    [admission, '53a53a03adff1c1e97093a883b7868392fa94858dd4d96dde46a4388b05d29d3'],
  ]) {
    const text = (await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(
      createHash('sha256').update(text).digest('hex'),
      expected,
      'Native admission overlap requires renewed cluster-role review: ' + file,
    );
  }
}

export function planDatabaseCohorts(files) {
  assert.ok(Array.isArray(files) && files.every((file) => nativeFile.test(file)));
  assert.equal(new Set(files).size, files.length, 'Duplicate native input');
  assert.ok(files.includes(registry) && files.includes(roles), 'Missing isolation contracts');
  const overlap = files.includes(admission) && files.includes(nativeAdmission);
  const main = files
    .filter(
      (file) =>
        file !== registry &&
        file !== roles &&
        file !== admission &&
        (!overlap || file !== nativeAdmission),
    )
    .sort();
  assert.ok(main.length > 0);
  return [
    { id: 'main', files: main, parallel: true },
    { id: 'registry', files: [registry], parallel: true },
    ...(files.includes(admission)
      ? [{ id: 'admission', files: [admission], parallel: true, after: ['main', 'registry'] }]
      : []),
    ...(overlap
      ? [
          {
            id: 'native-admission',
            files: [nativeAdmission],
            parallel: true,
            after: ['main', 'registry'],
          },
        ]
      : []),
    { id: 'roles', files: [roles], parallel: false },
  ];
}

export async function discoverDatabaseFiles(root = workspace) {
  const files = [];
  for (const dir of ['packages/database/test', 'packages/auth/test']) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (!entry.name.endsWith('.integration.test.ts')) continue;
      assert.ok(entry.isFile(), 'Native input must be a regular file');
      files.push(`${dir}/${entry.name}`);
    }
  }
  return files.sort();
}

// Report validation is independent of child exit status. A partial/stale report
// cannot turn an interrupted invocation into acceptance.
export function mergeDatabaseReports(plan, reports, root = workspace) {
  assert.equal(reports.length, plan.length);
  const expected = plan.flatMap((cohort) => cohort.files);
  assert.equal(new Set(expected).size, expected.length);
  const results = [];
  const seen = new Set();
  const countKeys = [
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numTotalTests',
    'numPassedTests',
  ];
  const totals = Object.fromEntries(countKeys.map((key) => [key, 0]));
  for (const [index, report] of reports.entries()) {
    assert.equal(report.success, true, 'Incomplete native report');
    for (const key of [
      'numFailedTestSuites',
      'numPendingTestSuites',
      'numFailedTests',
      'numPendingTests',
      'numTodoTests',
    ])
      assert.equal(report[key], 0, key);
    for (const key of countKeys) {
      assert.ok(Number.isSafeInteger(report[key]) && report[key] > 0, key);
      totals[key] += report[key];
    }
    assert.equal(report.numTotalTests, report.numPassedTests);
    assert.equal(report.numTotalTestSuites, report.numPassedTestSuites);
    assert.ok(Number.isSafeInteger(report.startTime) && report.startTime > 0);
    assert.ok(
      report.snapshot &&
        Object.values(report.snapshot).every(
          (value) => value === 0 || value === false || (Array.isArray(value) && value.length === 0),
        ),
      'Unexpected snapshot work',
    );
    assert.ok(Array.isArray(report.testResults));
    const actual = [];
    let assertions = 0;
    for (const result of report.testResults) {
      const name = path.relative(root, result.name).replaceAll('\\', '/');
      assert.ok(nativeFile.test(name) && !seen.has(name), 'Duplicate or unexpected native file');
      seen.add(name);
      actual.push(name);
      assert.equal(result.status, 'passed');
      assert.ok(!result.message);
      assert.ok(Array.isArray(result.assertionResults) && result.assertionResults.length > 0);
      const names = new Set();
      for (const assertion of result.assertionResults) {
        assert.equal(assertion.status, 'passed');
        assert.ok(typeof assertion.fullName === 'string' && assertion.fullName.length > 0);
        assert.ok(!names.has(assertion.fullName), 'Duplicate assertion identity');
        assert.deepEqual(assertion.failureMessages, []);
        names.add(assertion.fullName);
        assertions++;
      }
      results.push(result);
    }
    assert.deepEqual(actual.sort(), [...plan[index].files].sort(), 'Incomplete cohort coverage');
    assert.equal(assertions, report.numPassedTests);
  }
  assert.deepEqual([...seen].sort(), [...expected].sort());
  return {
    ...reports[0],
    ...totals,
    startTime: Math.min(...reports.map((report) => report.startTime)),
    testResults: results.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function runDatabaseCohorts(
  jobs,
  { timeoutMs, signal, secrets = [], echo = false, cwd = workspace },
) {
  const hasAdmission = jobs.length === 4 || jobs.length === 5;
  const hasOverlap = jobs.length === 5;
  assert.deepEqual(
    jobs.map(({ id, parallel, after }) => ({
      id,
      parallel,
      ...(after === undefined ? {} : { after }),
    })),
    [
      { id: 'main', parallel: true },
      { id: 'registry', parallel: true },
      ...(hasAdmission ? [{ id: 'admission', parallel: true, after: ['main', 'registry'] }] : []),
      ...(hasOverlap
        ? [{ id: 'native-admission', parallel: true, after: ['main', 'registry'] }]
        : []),
      { id: 'roles', parallel: false },
    ],
  );
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
  try {
    const main = run(jobs[0]);
    const registry = run(jobs[1]);
    // Legacy main tests also temporarily ALTER shared grouping roles. A
    // separate database cannot isolate those cluster-wide attributes.
    // Close BOTH cluster mutator scopes first. The reviewed native admission
    // file then overlaps PAPER admission on separate databases, with no more
    // than two children. Role probes remain last; the one budget is unchanged.
    const parallel = await Promise.allSettled([main, registry]);
    const failure = parallel.find((result) => result.status === 'rejected');
    if (failure) throw firstFailure ?? failure.reason;
    if (hasOverlap) {
      const overlap = await Promise.allSettled([run(jobs[2]), run(jobs[3])]);
      const failure = overlap.find((result) => result.status === 'rejected');
      if (failure) throw firstFailure ?? failure.reason;
    } else if (hasAdmission) await run(jobs[2]);
    await run(jobs.at(-1));
    if (controller.signal.aborted || performance.now() - started >= timeoutMs)
      throw new Error('Native cohort aggregate deadline/abort');
    return { timeoutMs, elapsedMs: performance.now() - started, completed };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
