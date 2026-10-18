import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { requireRealServicesSuccess } from './real-services-gate.mjs';
import {
  databaseProof,
  integrationProof,
  requireDatabaseProofReport,
} from './integration-proof.mjs';

it('requires a separate Auth result before accepting the isolated CI proof', () => {
  expect(() => requireRealServicesSuccess({ native: 'success', smoke: 'success' })).toThrow(
    'REAL_SERVICES_INCOMPLETE',
  );
});

it('gives Auth its own environment and budget under the existing required gate', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('name: Auth runtime and faults');
  expect(workflow).toContain('needs: [native, auth, smoke]');
  expect(workflow).toContain('run: pnpm test:integration --proof=auth');
  expect(workflow).toContain('CTP_AUTH_RESULT: ${{ needs.auth.result }}');
});

it('isolated Auth retains the database reset proof after creating real Auth data', async () => {
  const runner = await readFile(new URL('./test-database.mjs', import.meta.url), 'utf8');
  const isolated = runner.slice(
    runner.indexOf('async function runIsolatedAuthenticationProof()'),
    runner.indexOf('\ntry {\n  await prepareDatabaseProof();'),
  );
  expect(isolated.indexOf('await runAuthenticationAcceptance()')).toBeGreaterThanOrEqual(0);
  expect(isolated.indexOf('await resetDatabaseProof(fresh)')).toBeGreaterThan(
    isolated.indexOf('await runAuthenticationAcceptance()'),
  );
  expect(isolated).toContain('isolatedReset:');
});

it.each([
  [[], 'full', true, 1020000],
  [['--proof=full'], 'full', true, 1020000],
  [['--proof=database'], 'database', true, 1020000],
  [['--proof=auth'], 'auth', false, 360000],
  [['--database-only'], 'full', false, 1020000],
])(
  'selects an explicit bounded proof without changing legacy Auth coverage %#',
  (args, mode, dependencies, timeoutMs) => {
    const proof = integrationProof(args);
    expect(proof).toMatchObject({ mode, dependencies, timeoutMs });
    expect(proof.databaseArgs).toEqual(mode === 'full' ? [] : [`--proof=${mode}`]);
    expect(databaseProof(proof.databaseArgs).mode).toBe(mode);
  },
);

it.each([
  null,
  {},
  [false],
  ['--proof=unknown'],
  ['--skip-auth'],
  ['--proof=auth', '--proof=database'],
  ['--database-only', '--proof=auth'],
  ['--proof=database', '--skip-owners'],
])('rejects ambiguous or unsupported proof selection before resource setup %#', (args) => {
  expect(() => integrationProof(args)).toThrow('INTEGRATION_PROOF_ARGS');
  expect(() => databaseProof(args)).toThrow('INTEGRATION_PROOF_ARGS');
});

it('cannot use the legacy dependency flag as a database-child Auth bypass', () => {
  expect(() => databaseProof(['--database-only'])).toThrow('INTEGRATION_PROOF_ARGS');
  expect(integrationProof(['--database-only']).mode).toBe('full');
});

it('retains independent Auth room when the former serial parent has only 75 seconds left', () => {
  const database = integrationProof(['--proof=database']);
  const auth = integrationProof(['--proof=auth']);
  expect(database.timeoutMs - 945000).toBe(75000);
  expect(auth.timeoutMs).toBe(120000 + 180000 + 60000);
  expect(database.timeoutMs).toBe(1020000);
});

it('does not permit a caller to append a script or change a selected deadline', () => {
  const proof = integrationProof(['--proof=auth']);
  expect(() => proof.databaseArgs.push('--skip-auth')).toThrow();
  expect(() => {
    proof.timeoutMs = Infinity;
  }).toThrow();
});

const full = {
  status: 'PASS',
  proofScope: 'full',
  authenticatedRuntime: 'PASS',
  authenticationHardening: 'PASS',
};
const database = {
  status: 'PASS',
  proofScope: 'database',
  authenticatedRuntime: 'DELEGATED',
  authenticationHardening: 'DELEGATED',
  requiredAuthJob: 'Auth runtime and faults',
};
const auth = { ...full, proofScope: 'auth' };
it.each([
  [full, 'full'],
  [database, 'database'],
  [auth, 'auth'],
])('accepts only a matching explicit report scope %#', (report, mode) => {
  expect(() => requireDatabaseProofReport(report, mode)).not.toThrow();
});
it.each([
  [null, 'auth'],
  [{ ...auth, status: 'FAIL' }, 'auth'],
  [{ ...auth, authenticatedRuntime: 'RUNNING' }, 'auth'],
  [{ ...auth, authenticationHardening: undefined }, 'auth'],
  [{ ...auth, tests: 1257 }, 'auth'],
  [database, 'full'],
  [database, 'auth'],
  [{ ...database, requiredAuthJob: undefined }, 'database'],
  [{ ...database, authenticatedRuntime: 'PASS' }, 'database'],
  [{ ...full, requiredAuthJob: 'Auth runtime and faults' }, 'full'],
  [full, 'unknown'],
])('rejects stale, partial or falsely complete report evidence %#', (report, mode) => {
  expect(() => requireDatabaseProofReport(report, mode)).toThrow('INTEGRATION_PROOF_INCOMPLETE');
});

it.each(['test-integration.mjs', 'test-database.mjs'])(
  'actual %s rejects unknown proof before opening Docker or SQL',
  (file) => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(file, import.meta.url)), '--proof=unknown'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('INTEGRATION_PROOF_ARGS');
    expect(result.stderr).not.toContain('Install the required executable');
  },
);
