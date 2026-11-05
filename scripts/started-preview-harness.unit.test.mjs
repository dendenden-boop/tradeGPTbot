import fs from 'node:fs';
import { expect, it } from 'vitest';
import * as cohorts from './database-cohorts.mjs';
import { ownerReports } from './native-proof-artifacts.mjs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const native = 'packages/database/test/paper-started-preview.integration.test.ts';
it('preview owns a separate unfiltered six-case 90s restricted-owner process', () => {
  expect(ownerReports['paper-started-preview']).toBe(6);
  const runner = read('scripts/test-database.mjs');
  expect(runner).toContain('--outputFile.json=test-results/paper-started-preview-owner-tests.json');
  expect(runner).toContain('startedPreviewOwner.numPassedTests, 6');
  expect(read('scripts/native-proof-artifacts.mjs')).toContain("'paper-started-preview': 90000");
});
it('preview remains in the bounded PAPER tail with original START on its independent first-settled slot', async () => {
  const files = await cohorts.discoverDatabaseFiles(),
    plan = cohorts.planDatabaseCohorts(files, { executionStartOverlap: true });
  expect(plan.find((c) => c.id === 'admission').files).toEqual([
    'packages/database/test/paper-admission.integration.test.ts',
    'packages/database/test/paper-started-source.integration.test.ts',
    'packages/database/test/paper-started-risk.integration.test.ts',
    native,
  ]);
  expect(plan.find((c) => c.id === 'execution-start').files).toEqual([
    'packages/database/test/paper-execution-start.integration.test.ts',
  ]);
  expect(plan.find((c) => c.id === 'main').files).not.toContain(native);
  expect(plan.flatMap((c) => c.files).sort()).toEqual(files);
  expect(cohorts.verifyStartedPreviewParallelFiles).toBeTypeOf('function');
  await cohorts.verifyStartedPreviewParallelFiles();
});
it('preview is fingerprint-reviewed and raises evidence minimums without relaxing any published native budget', () => {
  const runner = read('scripts/test-database.mjs'),
    proof = read('scripts/native-proof-artifacts.mjs');
  expect(runner).toContain('await verifyStartedPreviewParallelFiles();');
  expect(proof).toContain('native.numPassedTests < 1432');
  expect(proof).toContain('cohorts.files < 46');
  expect(read('scripts/native-proof-window.mjs')).toContain('const budgetMs = 1020000');
  expect(proof).toContain('cohorts.timeoutMs !== 480000');
});
