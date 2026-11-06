import fs from 'node:fs';
import { expect, it } from 'vitest';
import * as cohorts from './database-cohorts.mjs';
import { ownerReports } from './native-proof-artifacts.mjs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const native = 'packages/database/test/paper-started-risk.integration.test.ts';
it('known-START Risk owns a separate eight-case 90s restricted-owner process', () => {
  expect(ownerReports['paper-started-risk']).toBe(8);
  const runner = read('scripts/test-database.mjs');
  expect(runner).toContain('--outputFile.json=test-results/paper-started-risk-owner-tests.json');
  expect(runner).toContain('startedRiskOwner.numPassedTests, 8');
  expect(read('scripts/native-proof-artifacts.mjs')).toContain("'paper-started-risk': 90000");
});
it('known-START Risk joins the reviewed PAPER tail and retains the original START physical slot', async () => {
  const files = await cohorts.discoverDatabaseFiles();
  // BEGIN PAPER EXECUTION COMMIT FIXTURE
  const writerIndex = files.indexOf(
    'packages/database/test/paper-execution-commit.integration.test.ts',
  );
  if (writerIndex >= 0) files.splice(writerIndex, 1);
  // END PAPER EXECUTION COMMIT FIXTURE
  // BEGIN PAPER STARTED PREVIEW FIXTURE
  const previewIndex = files.indexOf(
    'packages/database/test/paper-started-preview.integration.test.ts',
  );
  if (previewIndex >= 0) files.splice(previewIndex, 1);
  // END PAPER STARTED PREVIEW FIXTURE
  const plan = cohorts.planDatabaseCohorts(files, { executionStartOverlap: true });
  expect(plan.find((c) => c.id === 'admission').files).toEqual([
    'packages/database/test/paper-admission.integration.test.ts',
    'packages/database/test/paper-started-source.integration.test.ts',
    native,
  ]);
  expect(plan.find((c) => c.id === 'execution-start').files).toEqual([
    'packages/database/test/paper-execution-start.integration.test.ts',
  ]);
  expect(plan.find((c) => c.id === 'main').files).not.toContain(native);
  expect(plan.flatMap((c) => c.files).sort()).toEqual(files);
  expect(cohorts.verifyStartedRiskParallelFiles).toBeTypeOf('function');
  await cohorts.verifyStartedRiskParallelFiles();
});
it('known-START Risk requires actual populated63 upgrade/redeploy and fresh/populated reset proofs', () => {
  const runner = read('scripts/test-database.mjs');
  expect(runner).toContain("'202611030002_paper_started_risk_source'");
  expect(
    runner.match(/verifyPaperStartedRiskUpgrade\(paperUpgrade, beforeStartedRisk\)/gu),
  ).toHaveLength(2);
  for (const db of ['admissionReset', 'startedAfterReset', 'reset'])
    expect(runner).toContain(
      'verifyPaperStartedRiskStorage(' + db + ", { ownership: 'STORAGE_ONLY' })",
    );
  expect(read('scripts/native-proof-artifacts.mjs')).toContain('native.numPassedTests < 1426');
  expect(read('scripts/native-proof-artifacts.mjs')).toContain('cohorts.files < 45');
});
