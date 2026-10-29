import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyAdmissionParallelFiles } from './database-cohorts.mjs';
import { beforePreparationInventory } from './preparation-inventory-legacy.mjs';

const read = (p) =>
  beforePreparationInventory(
    p,
    fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
  );
const hash = (s) => createHash('sha256').update(s).digest('hex');
const nativeFile = 'packages/database/test/paper-admission.integration.test.ts';
it('retains the accepted62 native fixture and all runner statements outside explicit additions', async () => {
  const { beforeExecutionRiskSource } = await import('./execution-risk-source-legacy.mjs');
  expect(hash(beforeExecutionRiskSource(nativeFile, read(nativeFile)))).toBe(
    '51f36f2078b2ffd909a1736277bc2f3c7d660a035cf0f2e30a72a6554234b1d9',
  );
  const old = read('scripts/prepared-execution-source-legacy.mjs');
  expect(old).toContain('source = beforeExecutionRiskSource(file, source)');
  for (const bad of [
    'OTHER',
    'TESTS\n// END PAPER EXECUTION RISK TESTS\n// BEGIN PAPER EXECUTION RISK TESTS',
  ]) {
    expect(() =>
      beforeExecutionRiskSource(
        nativeFile,
        read(nativeFile).replace(
          'BEGIN PAPER EXECUTION RISK TESTS',
          'BEGIN PAPER EXECUTION RISK ' + bad,
        ),
      ),
    ).toThrow();
  }
  await verifyAdmissionParallelFiles();
});
it('adds three real native cases without changing owner or full deadlines', () => {
  expect(read(nativeFile).match(/it\('paper-execution-risk:/gu)).toHaveLength(3);
  const block = read(nativeFile)
    .split('// BEGIN PAPER EXECUTION RISK TESTS\n')[1]
    .split('// END PAPER EXECUTION RISK TESTS')[0];
  expect(block).not.toMatch(
    /CREATE ROLE|ALTER ROLE|GRANT |REVOKE |TRUNCATE |test\.skip|it\.skip/iu,
  );
  const runner = read('scripts/test-database.mjs');
  for (const s of [
    'paperAdmissionOwner.numPassedTests, 65',
    'beforeUnknownTests.numPendingTests, 48',
    'beforeWithdrawalTests.numPendingTests, 63',
    'beforeReleaseTests.numPendingTests, 64',
    'verifyPaperExecutionRiskUpgrade(paperUpgrade, beforePaperExecutionRisk)',
  ])
    expect(runner).toContain(s);
  expect(read('scripts/native-proof-artifacts.mjs')).toContain('passed(native, 1396, 480000)');
  expect(read('scripts/native-proof-artifacts.mjs')).toContain("'paper-admission': 90000");
  expect(read('scripts/integration-proof.mjs')).toContain('full: 1020000');
});
it('checks populated59 deploy/redeploy without inventing rows or changing the mutation RPC', () => {
  const upgrade = read('scripts/paper-execution-risk-upgrade.mjs');
  expect(upgrade).toContain('before.functions.length, 221');
  expect(upgrade).toContain('after.functions.length, 223');
  expect(upgrade).toContain('assert.deepEqual(after.rows, before.rows)');
  expect(upgrade).toContain('reconcile_admission_v59');
  expect(upgrade).toContain('has_function_privilege');
  const sql = read(
    'packages/database/prisma/migrations/202610280001_paper_execution_risk_source/migration.sql',
  );
  expect(sql).not.toMatch(
    /CREATE TABLE|ALTER TABLE|CREATE ROLE|CREATE FUNCTION ctp_paper\.evaluate_and_reserve/iu,
  );
});
