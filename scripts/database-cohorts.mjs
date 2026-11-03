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
const executionStart = 'packages/database/test/paper-execution-start.integration.test.ts';
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
    [admission, 'c9fe097d55c5e8d2e61d0311a99b5d44595a53e01f8ec1b17c364bd1030ed374'],
    [
      'packages/database/test/fixtures/registry-commit-proxy.ts',
      'a64aefc8526cea37cc6f218c407ee730d82e58f504d8a111888d03ca0a915af4',
    ],
    [
      'packages/database/test/fixtures/public-market-ports.ts',
      '14a264544e3bdb8cdb635a9f8311f3ccc686abea52822e9b5027d91da3ef11f7',
    ],
    [
      'packages/database/test/fixtures/order-fixture-port.ts',
      '7314b93a91e28e704167af54f160a88251938822f83a25765882903f2474bd94',
    ],
    [
      'packages/database/test/fixtures/admission-fixture-port.ts',
      '19418d89ab6119a3ef45783376ecfa926bd0588d9fa82a1238c940284ecdd09f',
    ],
    [
      'packages/database/test/fixtures/native-default-port.ts',
      '66cff560b81dbc3678e9f8028dcd8f5bb25c8de9e46c37e2e4880143234ef39b',
    ],
  ]) {
    const text = (await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(
      createHash('sha256').update(text).digest('hex'),
      expected,
      'Native admission overlap requires renewed cluster-role review: ' + file,
    );
  }
}

// START has an independent DB and no cluster-role DDL. Review every executable
// fixture input before enabling its overlap with the remaining PAPER process.
export async function verifyExecutionStartParallelFiles(root = workspace) {
  for (const [file, expected] of [
    [executionStart, '2c47c4bfe6bb7fa1774488b7020bb78af6b2780b2ff6d9e14d870c76ca1e0298'],
    [
      'packages/database/test/fixtures/paper-execution-start.ts',
      '806e35264ce573a11a995c161233d1ad875983639773d22b555427364b107f5b',
    ],
    [
      'packages/database/test/fixtures/native-default-port.ts',
      '66cff560b81dbc3678e9f8028dcd8f5bb25c8de9e46c37e2e4880143234ef39b',
    ],
    [
      'packages/paper-engine/test/frame-fixture.ts',
      '1ed49e8898124c61e9ca2ba56f8cfbda39589ff79bacc642de5f1c3c93be1d62',
    ],
    [
      'packages/risk-engine/test/fixtures.ts',
      'bec4bb8c658e9c4c1afc381791a8feef7299536464eb4b06ade981e2e7738a4f',
    ],
    [
      'packages/order-engine/test/fixtures.ts',
      '28990b2e46d9c1b7fc462187dd1687cf8401e432c3214aaa0972b10e4b4ad717',
    ],
  ]) {
    const source = (await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      expected,
      'Execution-start overlap requires renewed cluster-role review: ' + file,
    );
    assert(
      !/\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|DATABASE)\b|\bGRANT\s|\bREVOKE\s/iu.test(source),
      'Execution-start overlap cannot mutate cluster roles',
    );
  }
}

export function planDatabaseCohorts(files, { executionStartOverlap = false } = {}) {
  assert.equal(typeof executionStartOverlap, 'boolean');
  assert.ok(Array.isArray(files) && files.every((file) => nativeFile.test(file)));
  assert.equal(new Set(files).size, files.length, 'Duplicate native input');
  assert.ok(files.includes(registry) && files.includes(roles), 'Missing isolation contracts');
  const overlap = files.includes(admission) && files.includes(nativeAdmission);
  const hasStart = files.includes(executionStart);
  assert.ok(!executionStartOverlap || hasStart, 'Missing reviewed execution-start input');
  assert.ok(!hasStart || overlap, 'Execution-start requires both admission isolation contracts');
  const main = files
    .filter(
      (file) =>
        file !== registry &&
        file !== roles &&
        file !== admission &&
        file !== executionStart &&
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
    ...(hasStart
      ? [
          {
            id: 'execution-start',
            files: [executionStart],
            parallel: executionStartOverlap,
            after: executionStartOverlap
              ? ['main', 'registry']
              : ['main', 'registry', 'admission', 'native-admission'],
            ...(executionStartOverlap ? { afterAny: ['admission', 'native-admission'] } : {}),
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
  const hasStart = jobs.length === 6;
  const hasStartOverlap = hasStart && jobs[4].parallel === true;
  const hasAdmission = jobs.length === 4 || jobs.length === 5 || hasStart;
  const hasOverlap = jobs.length === 5 || hasStart;
  assert.deepEqual(
    jobs.map(({ id, parallel, after, afterAny }) => ({
      id,
      parallel,
      ...(after === undefined ? {} : { after }),
      ...(afterAny === undefined ? {} : { afterAny }),
    })),
    [
      { id: 'main', parallel: true },
      { id: 'registry', parallel: true },
      ...(hasAdmission ? [{ id: 'admission', parallel: true, after: ['main', 'registry'] }] : []),
      ...(hasOverlap
        ? [{ id: 'native-admission', parallel: true, after: ['main', 'registry'] }]
        : []),
      ...(hasStart
        ? [
            {
              id: 'execution-start',
              parallel: hasStartOverlap,
              after: hasStartOverlap
                ? ['main', 'registry']
                : ['main', 'registry', 'admission', 'native-admission'],
              ...(hasStartOverlap ? { afterAny: ['admission', 'native-admission'] } : {}),
            },
          ]
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
      const paper = run(jobs[2]);
      const native = run(jobs[3]);
      // Reuse the first physically settled slot. START owns an independent DB;
      // the still-running sibling remains under the same two-child/deadline cap.
      const children = [paper, native];
      if (hasStartOverlap) children.push(Promise.race([paper, native]).then(() => run(jobs[4])));
      const overlap = await Promise.allSettled(children);
      const failure = overlap.find((result) => result.status === 'rejected');
      if (failure) throw firstFailure ?? failure.reason;
    } else if (hasAdmission) await run(jobs[2]);
    // The legacy serial plan reuses the admission DB after both children close.
    // Reviewed overlap instead uses its own DB and the first settled slot.
    // The existing owner90s/aggregate480s/shared1020s budgets are unchanged.
    if (hasStart && !hasStartOverlap) await run(jobs[4]);
    await run(jobs.at(-1));
    if (controller.signal.aborted || performance.now() - started >= timeoutMs)
      throw new Error('Native cohort aggregate deadline/abort');
    return { timeoutMs, elapsedMs: performance.now() - started, completed };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
