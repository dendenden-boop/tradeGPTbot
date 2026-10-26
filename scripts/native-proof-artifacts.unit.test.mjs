import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
      endTime: window.startedAtMs + 2000,
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
    native: report(1378, 42),
    cohorts: {
      status: 'PASS',
      timeoutMs: 480000,
      elapsedMs: 400000,
      tests: 1378,
      files: 42,
      completed: ['main', 'registry', 'admission', 'native-admission', 'roles'].map((id) => ({
        id,
      })),
    },
  };
}
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
          : { requiredOwnerJob: 'Native migration owners', tests: 1378 }),
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
  const almostExpired = createNativeWindow(identity, started - 1019950);
  await expect(
    run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: remainingNativeBudget(almostExpired),
    }),
  ).rejects.toThrow('Command deadline exceeded');
  expect(Date.now() - started).toBeLessThan(2000);
});
