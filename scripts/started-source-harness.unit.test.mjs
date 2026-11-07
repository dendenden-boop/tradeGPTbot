import fs from 'node:fs';
import { expect, it } from 'vitest';
import * as cohorts from './database-cohorts.mjs';
import { ownerReports } from './native-proof-artifacts.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const source = 'packages/database/test/paper-started-source.integration.test.ts';
it('started-source gets a complete independent nine-case owner process within 90 seconds', () => {
  expect(ownerReports['paper-started-source']).toBe(9);
  const runner = read('scripts/test-database.mjs');
  expect(runner).toContain('--outputFile.json=test-results/paper-started-source-owner-tests.json');
  expect(runner).toContain('startedSourceOwner.numPassedTests, 9');
  expect(runner).toContain('verifyPaperStartedSourceStorage(startedSourceDb');
  expect(read('scripts/native-proof-artifacts.mjs')).toContain("'paper-started-source': 90000");
});
it('started-source uses the PAPER tail while the original START retains the first drained scheduling slot', async () => {
  const files = (await cohorts.discoverDatabaseFiles()).filter(
    (file) => file !== 'packages/database/test/paper-started-risk.integration.test.ts',
  );
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
  expect(plan.find((c) => c.id === 'execution-start')).toEqual({
    id: 'execution-start',
    files: ['packages/database/test/paper-execution-start.integration.test.ts'],
    parallel: true,
    after: ['main', 'registry'],
    afterAny: ['admission', 'native-admission'],
  });
  expect(plan.flatMap((c) => c.files).sort()).toEqual(files);
  expect(plan.find((c) => c.id === 'admission').files).toEqual([
    'packages/database/test/paper-admission.integration.test.ts',
    source,
  ]);
  expect(plan.find((c) => c.id === 'main').files).not.toContain(source);
  expect(cohorts.verifyStartedSourceParallelFiles).toBeTypeOf('function');
  await cohorts.verifyStartedSourceParallelFiles();
});
it('started-source requires populated62 upgrade and both reset storage checks', () => {
  const runner = read('scripts/test-database.mjs');
  expect(runner).toContain("'202611030001_paper_started_execution_source'");
  expect(
    runner.match(/verifyPaperStartedSourceUpgrade\(paperUpgrade, beforeStartedSource\)/gu),
  ).toHaveLength(2);
  expect(runner).toContain(
    "verifyPaperStartedSourceStorage(admissionReset, { ownership: 'STORAGE_ONLY' })",
  );
  expect(runner).toContain(
    "verifyPaperStartedSourceStorage(startedAfterReset, { ownership: 'STORAGE_ONLY' })",
  );
  expect(runner).toContain("verifyPaperStartedSourceStorage(reset, { ownership: 'STORAGE_ONLY' })");
  expect(read('scripts/native-proof-artifacts.mjs')).toContain('native.numPassedTests < 1418');
  expect(read('scripts/native-proof-artifacts.mjs')).toContain('cohorts.files < 44');
});
