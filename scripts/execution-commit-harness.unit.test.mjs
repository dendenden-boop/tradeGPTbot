import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { discoverDatabaseFiles, planDatabaseCohorts } from './database-cohorts.mjs';

const writer = 'packages/database/test/paper-execution-commit.integration.test.ts';
it('isolates the financial writer after every mutating cohort and before final role probes', async () => {
  const plan = planDatabaseCohorts(await discoverDatabaseFiles(), { executionStartOverlap: true });
  expect(plan.find((p) => p.id === 'main').files).not.toContain(writer);
  expect(plan.find((p) => p.id === 'execution-commit')).toEqual({
    id: 'execution-commit',
    files: [writer],
    parallel: false,
    after: [
      'main',
      'registry',
      'admission',
      'native-admission',
      'execution-start',
      'execution-preview',
    ],
  });
  expect(plan.findIndex((p) => p.id === 'execution-commit')).toBeLessThan(
    plan.findIndex((p) => p.id === 'roles'),
  );
});
it('requires native non-bypass owner, populated upgrade/redeploy and reset writer proofs', async () => {
  const runner = await readFile(new URL('./test-database.mjs', import.meta.url), 'utf8');
  expect(runner).toContain('executionCommitOwner.numPassedTests, 13');
  expect(runner).toContain(
    "'--outputFile.json=test-results/paper-execution-commit-owner-tests.json'",
  );
  expect(
    runner.match(/verifyPaperExecutionCommitUpgrade\(paperUpgrade, beforeExecutionCommit\)/gu),
  ).toHaveLength(2);
  for (const name of ['admissionReset', 'startedAfterReset', 'reset'])
    expect(runner).toContain(
      'verifyPaperExecutionCommitStorage(' + name + ", { ownership: 'STORAGE_ONLY' })",
    );
});
