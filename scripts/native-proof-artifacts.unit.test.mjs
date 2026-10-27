import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { ownerReports, requireNativeTestArtifacts } from './native-proof-artifacts.mjs';
import { createNativeWindow, remainingNativeBudget } from './native-proof-window.mjs';
import { run } from './docker-test-utils.mjs';

const identity = { runId: '123', attempt: '1', sha: 'a'.repeat(40) };
const window = createNativeWindow(identity, 1800000000000);
function report(total, files = 1) {
  return {
    success: true,
    numPassedTests: total,
    numTotalTests: total,
    numFailedTests: 0,
    numPendingTests: 0,
    startTime: window.startedAtMs + 1000,
    testResults: Array.from({ length: files }, (_, index) => ({
      status: 'passed',
      name: `file-${index}`,
      startTime: window.startedAtMs + 1000,
      endTime: window.startedAtMs + 2000.25,
      assertionResults: Array.from(
        { length: Math.floor(total / files) + (index < total % files ? 1 : 0) },
        (_, n) => ({ status: 'passed', fullName: `case-${index}-${n}` }),
      ),
    })),
  };
}
function evidence() {
  return {
    owners: Object.fromEntries(
      Object.entries(ownerReports).map(([name, minimum]) => [name, report(minimum)]),
    ),
    native: report(1392, 42),
    cohorts: {
      status: 'PASS',
      timeoutMs: 480000,
      elapsedMs: 400000,
      tests: 1392,
      files: 42,
      completed: ['main', 'registry', 'admission', 'native-admission', 'roles'].map((id) => ({
        id,
      })),
    },
  };
}
it('retains the original 120s admission owner allowance instead of imposing 90s', () => {
  const e = evidence(),
    owner = e.owners['risk-admission'];
  owner.testResults[0].endTime = owner.startTime + 110000;
  expect(() => requireNativeTestArtifacts(e.owners, e.native, e.cohorts, window)).not.toThrow();
});
it('accepts real Vitest fractional millisecond endTime without rounding it away', () => {
  const e = evidence();
  for (const r of [...Object.values(e.owners), e.native])
    for (const file of r.testResults) file.endTime += 0.25;
  expect(() => requireNativeTestArtifacts(e.owners, e.native, e.cohorts, window)).not.toThrow();
});
it('rejects a reservation owner report beyond its original 30s process deadline', () => {
  const e = evidence(),
    owner = e.owners['paper-reservation-state'];
  owner.testResults[0].endTime = owner.startTime + 31000;
  expect(() => requireNativeTestArtifacts(e.owners, e.native, e.cohorts, window)).toThrow(
    'NATIVE_TEST_EVIDENCE_INCOMPLETE',
  );
});
it('matches every artifact owner deadline to its actual unchanged runner invocation', async () => {
  const source = await readFile(new URL('./test-database.mjs', import.meta.url), 'utf8');
  const file = ts.createSourceFile(
    'runner.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const deadlines = new Map();
  function scan(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'run' &&
      node.arguments[1] &&
      ts.isArrayLiteralExpression(node.arguments[1]) &&
      node.arguments[2] &&
      ts.isObjectLiteralExpression(node.arguments[2])
    ) {
      const output = node.arguments[1].elements.find(
        (arg) =>
          ts.isStringLiteral(arg) &&
          /^--outputFile\.json=test-results\/.+-owner-tests\.json$/u.test(arg.text),
      );
      if (output) {
        const name = output.text.slice(
          '--outputFile.json=test-results/'.length,
          -'-owner-tests.json'.length,
        );
        const timeout = node.arguments[2].properties.find(
          (p) => ts.isPropertyAssignment(p) && p.name.getText(file) === 'timeoutMs',
        );
        if (!timeout || !ts.isPropertyAssignment(timeout))
          throw new Error('OWNER_DEADLINE_MISSING');
        deadlines.set(name, Number(timeout.initializer.getText(file)));
      }
    }
    ts.forEachChild(node, scan);
  }
  scan(file);
  expect([...deadlines.keys()].sort()).toEqual(Object.keys(ownerReports).sort());
  for (const [name, limit] of deadlines) {
    expect([30000, 90000, 120000]).toContain(limit);
    const e = evidence(),
      owner = e.owners[name];
    owner.testResults[0].endTime = owner.startTime + limit;
    expect(
      () => requireNativeTestArtifacts(e.owners, e.native, e.cohorts, window),
      name,
    ).not.toThrow();
    owner.testResults[0].endTime++;
    expect(() => requireNativeTestArtifacts(e.owners, e.native, e.cohorts, window), name).toThrow(
      'NATIVE_TEST_EVIDENCE_INCOMPLETE',
    );
  }
});
it('requires all19 real owner reports, all42 native files and a bounded complete cohort report', () => {
  const { owners, native, cohorts } = evidence();
  expect(() => requireNativeTestArtifacts(owners, native, cohorts, window)).not.toThrow();
});
it.each([
  'missing-owner',
  'failed-owner',
  'stale-owner',
  'owner-deadline',
  'missing-cohort',
  'failed-test',
  'pending-test',
  'missing-reset-report',
  'cohort-deadline',
  'forged-total',
])('rejects partial evidence: %s', (defect) => {
  const e = evidence(),
    owner = e.owners['paper-admission'];
  if (defect === 'missing-owner') delete e.owners['paper-admission'];
  if (defect === 'failed-owner') owner.success = false;
  if (defect === 'stale-owner') owner.startTime = window.startedAtMs - 1;
  if (defect === 'owner-deadline') owner.testResults[0].endTime = owner.startTime + 90001;
  if (defect === 'missing-cohort') e.cohorts.completed.pop();
  if (defect === 'failed-test') e.native.testResults[0].assertionResults[0].status = 'failed';
  if (defect === 'pending-test') e.native.numPendingTests = 1;
  if (defect === 'missing-reset-report') e.cohorts = undefined;
  if (defect === 'cohort-deadline') e.cohorts.elapsedMs = 480001;
  if (defect === 'forged-total') e.native.testResults.pop();
  expect(() => requireNativeTestArtifacts(e.owners, e.native, e.cohorts, window)).toThrow(
    'NATIVE_TEST_EVIDENCE_INCOMPLETE',
  );
});
it('actual gate accepts only complete artifacts from both isolated projects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ctp-native-gate-'));
  if (
    path.dirname(root) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('ctp-native-gate-')
  )
    throw new Error('TEST_CLEANUP_SCOPE');
  try {
    const e = evidence();
    const store = async (dir, name, data) => {
      const folder = path.join(root, 'test-results/native-gate', dir);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, name + '.json'), JSON.stringify(data));
    };
    for (const scope of ['owners', 'cohorts']) {
      const data = {
        status: 'PARTIAL',
        proofScope: scope,
        nativeWindow: window,
        project: `ctp-integration-${scope === 'owners' ? 1 : 2}-111111111111`,
        startedAt: new Date(window.startedAtMs + 10).toISOString(),
        completedAt: new Date(window.startedAtMs + 900000).toISOString(),
        ownerSuites: scope === 'owners' ? 'COMPLETE' : 'DELEGATED',
        nativeCohorts: scope === 'cohorts' ? 'COMPLETE' : 'DELEGATED',
        isolatedReset: scope === 'cohorts' ? 'PASS' : 'DELEGATED',
        authenticatedRuntime: 'DELEGATED',
        authenticationHardening: 'DELEGATED',
        requiredAuthJob: 'Auth runtime and faults',
        ...(scope === 'owners'
          ? { requiredNativeJob: 'Native PostgreSQL and real services' }
          : { requiredOwnerJob: 'Native migration owners', tests: 1392 }),
      };
      await store(scope, 'integration', data);
      await store(scope, scope === 'owners' ? 'database-owners' : 'database', data);
    }
    for (const [name, data] of Object.entries(e.owners))
      await store('owners', name + '-owner-tests', data);
    await store('cohorts', 'database-tests', e.native);
    await store('cohorts', 'database-cohorts', e.cohorts);
    const execute = () =>
      spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./real-services-gate.mjs', import.meta.url))],
        {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            GITHUB_RUN_ID: identity.runId,
            GITHUB_RUN_ATTEMPT: identity.attempt,
            GITHUB_SHA: identity.sha,
            CTP_NATIVE_WINDOW: JSON.stringify(window),
            CTP_NATIVE_RESULT: 'success',
            CTP_OWNER_RESULT: 'success',
            CTP_AUTH_RESULT: 'success',
            CTP_SMOKE_RESULT: 'success',
          },
        },
      );
    expect(execute().status).toBe(0);
    await store('cohorts', 'database', { status: 'PARTIAL', isolatedReset: 'DELEGATED' });
    expect(execute().status).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('kills a hung child with only the remaining shared window, not a fresh parent budget', async () => {
  const started = Date.now();
  const almostExpired = createNativeWindow(identity, started - 1019500);
  await expect(
    run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: remainingNativeBudget(almostExpired),
    }),
  ).rejects.toThrow('Command deadline exceeded');
  expect(Date.now() - started).toBeLessThan(2000);
});
