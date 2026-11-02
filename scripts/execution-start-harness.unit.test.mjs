import fs from 'node:fs';
import { it, expect } from 'vitest';
import { ownerReports, requireNativeTestArtifacts } from './native-proof-artifacts.mjs';
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
it('execution-start native owner gets an independent full unfiltered 90s process and same isolated cohort database', () => {
  const source = read('scripts/test-database.mjs');
  expect(
    source.includes('--outputFile.json=test-results/paper-execution-start-owner-tests.json'),
  ).toBe(true);
  expect(source).toContain('executionStartOwner.numPassedTests, 9');
  expect(source).toContain("cohort.id === 'execution-start'");
  expect(ownerReports['paper-execution-start']).toBe(9);
  expect(source).toContain('paperAdmissionOwner.numPassedTests, 69');
  expect(read('scripts/integration-proof.mjs')).toContain('full: 1020000');
});
it('execution-start additive migration has explicit populated61 deploy/redeploy and post-reset validation', () => {
  const source = read('scripts/test-database.mjs');
  expect(source).toContain("'202611020001_paper_execution_start'");
  expect(source).toContain('verifyPaperExecutionStartUpgrade(paperUpgrade, beforeExecutionStart)');
  expect(source).toContain('paperExecutionStartUpgradePreserved: true');
  expect(source).toContain('paperExecutionStartResetValidated: true');
});
it('execution-start evidence fails closed when its separate owner report or cohort is absent', () => {
  expect(ownerReports['paper-execution-start']).toBe(9);
  expect(() => requireNativeTestArtifacts({}, {}, {}, {})).toThrow(
    'NATIVE_TEST_EVIDENCE_INCOMPLETE',
  );
  const proof = read('scripts/native-proof-artifacts.mjs');
  expect(proof).toContain("'paper-execution-start': 90000");
  expect(proof).toContain('native.numPassedTests < 1409');
  expect(proof).toContain('cohorts.files < 43');
});
