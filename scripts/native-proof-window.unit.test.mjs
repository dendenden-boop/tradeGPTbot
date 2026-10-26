import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { integrationProof, requireDatabaseProofReport } from './integration-proof.mjs';
import { requireRealServicesSuccess } from './real-services-gate.mjs';

const clock = 1800000000000;
const identity = { runId: '123', attempt: '1', sha: 'a'.repeat(40) };
const load = async () => {
  const module = await import('./native-proof-window.mjs').catch(() => null);
  expect(module, 'NATIVE_SHARED_WINDOW_MISSING').not.toBeNull();
  return module;
};

it.each(
  ['test-integration.mjs', 'test-database.mjs'].flatMap((file) =>
    ['owners', 'cohorts'].map((scope) => ({ file, scope })),
  ),
)(
  'actual $file rejects $scope without the common window before Docker or SQL',
  ({ file, scope }) => {
    const env = { ...process.env };
    for (const key of ['CTP_NATIVE_WINDOW', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA'])
      delete env[key];
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(file, import.meta.url)), `--proof=${scope}`],
      { env, encoding: 'utf8', windowsHide: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NATIVE_WINDOW_INVALID');
    expect(result.stderr).not.toContain('Install the required executable');
  },
);

it.each(['failure', 'cancelled', 'skipped', '', 'unknown'])(
  'rejects owner job result %s',
  (owners) => {
    expect(() =>
      requireRealServicesSuccess({ native: 'success', owners, auth: 'success', smoke: 'success' }),
    ).toThrow('REAL_SERVICES_INCOMPLETE');
  },
);

it.each(['owners', 'cohorts'])('requires explicit isolated native scope %s', (mode) => {
  expect(integrationProof([`--proof=${mode}`])).toMatchObject({
    mode,
    timeoutMs: 1020000,
    dependencies: true,
    databaseArgs: [`--proof=${mode}`],
  });
});

it('does not accept the former three-result gate without an owner result', () => {
  expect(() =>
    requireRealServicesSuccess({ native: 'success', auth: 'success', smoke: 'success' }),
  ).toThrow('REAL_SERVICES_INCOMPLETE');
});

it('never gives the second native group a fresh 1020s allowance', async () => {
  const { createNativeWindow, remainingNativeBudget } = await load();
  const window = createNativeWindow(identity, clock);
  expect(window).toMatchObject({ ...identity, startedAtMs: clock, deadlineMs: clock + 1020000 });
  expect(remainingNativeBudget(window, clock + 945000)).toBe(75000);
  expect(remainingNativeBudget(window, clock + 1019999)).toBe(1);
  expect(() => remainingNativeBudget(window, clock + 1020000)).toThrow('NATIVE_WINDOW_EXPIRED');
  expect(() => remainingNativeBudget(window, clock - 1)).toThrow('NATIVE_WINDOW_INVALID');
});

it.each(['runId', 'attempt', 'sha'])('rejects a shared window from a different %s', async (key) => {
  const { createNativeWindow, readNativeWindow } = await load();
  const window = createNativeWindow(identity, clock);
  expect(() =>
    readNativeWindow(JSON.stringify(window), { ...identity, [key]: 'wrong' }, clock),
  ).toThrow('NATIVE_WINDOW_INVALID');
});

it.each(['budgetMs', 'deadlineMs', 'startedAtMs', 'extra'])(
  'rejects modified or ambiguous shared window field %s',
  async (field) => {
    const { createNativeWindow, readNativeWindow } = await load();
    const window = createNativeWindow(identity, clock);
    expect(() =>
      readNativeWindow(JSON.stringify({ ...window, [field]: Infinity }), identity, clock),
    ).toThrow('NATIVE_WINDOW_INVALID');
  },
);

it('rejects two successful isolated reports outside the one common deadline', async () => {
  const { createNativeWindow, requireNativeWindowReports } = await load();
  const window = createNativeWindow(identity, clock);
  const report = (scope, project) => ({
    status: 'PARTIAL',
    proofScope: scope,
    project,
    nativeWindow: window,
    startedAt: new Date(clock + 1000).toISOString(),
    completedAt: new Date(clock + 900000).toISOString(),
    ownerSuites: scope === 'owners' ? 'COMPLETE' : 'DELEGATED',
    nativeCohorts: scope === 'cohorts' ? 'COMPLETE' : 'DELEGATED',
    isolatedReset: scope === 'cohorts' ? 'PASS' : 'DELEGATED',
  });
  const owners = report('owners', 'ctp-integration-1-111111111111');
  const cohorts = report('cohorts', 'ctp-integration-2-222222222222');
  expect(() => requireNativeWindowReports(owners, cohorts, window)).not.toThrow();
  expect(() =>
    requireNativeWindowReports(owners, { ...cohorts, project: owners.project }, window),
  ).toThrow('NATIVE_PROOFS_INCOMPLETE');
  expect(() =>
    requireNativeWindowReports(
      owners,
      {
        ...cohorts,
        completedAt: new Date(clock + 1020001).toISOString(),
      },
      window,
    ),
  ).toThrow('NATIVE_PROOFS_INCOMPLETE');
  expect(() =>
    requireNativeWindowReports({ ...owners, ownerSuites: 'DELEGATED' }, cohorts, window),
  ).toThrow('NATIVE_PROOFS_INCOMPLETE');
  expect(() =>
    requireNativeWindowReports(owners, { ...cohorts, isolatedReset: 'DELEGATED' }, window),
  ).toThrow('NATIVE_PROOFS_INCOMPLETE');
});

it.each(['owners', 'cohorts'])('rejects an unspecified or falsely complete %s report', (mode) => {
  expect(() =>
    requireDatabaseProofReport(
      {
        status: 'PASS',
        proofScope: mode,
        authenticatedRuntime: 'PASS',
        authenticationHardening: 'PASS',
      },
      mode,
    ),
  ).toThrow('INTEGRATION_PROOF_INCOMPLETE');
});

it('keeps owners and cohorts mandatory in separate VMs with a common budget producer', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('native-window:');
  expect(workflow).toContain('native-owners:');
  expect(
    workflow.match(/CTP_NATIVE_WINDOW: \$\{\{ needs.native-window.outputs.window \}\}/gu),
  ).toHaveLength(3);
  expect(workflow).toContain('needs: [native, native-owners, auth, smoke, native-window]');
  expect(workflow).toContain('run: pnpm test:integration --proof=owners');
  expect(workflow).toContain('run: pnpm test:integration --proof=cohorts');
});
