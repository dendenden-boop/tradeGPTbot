import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ownerReports } from './native-proof-artifacts.mjs';
const cases = (
  readFileSync('packages/database/test/paper-execution-commit.integration.test.ts', 'utf8').match(
    /^it\(/gm,
  ) ?? []
).length;
const runner = readFileSync('scripts/test-database.mjs', 'utf8');
it('requires the exact complete execution-commit owner case count after adding inventory contracts', () => {
  expect(ownerReports['paper-execution-commit']).toBe(cases);
});
it('retains the pre67 selected probe and requires exactly every other current case to be pending', () => {
  expect(Number(runner.match(/executedValuationSeed\.numPendingTests, (\d+)/u)?.[1])).toBe(
    cases - 1,
  );
  expect(runner).toContain('assert.equal(executedValuationSeed.numPassedTests, 1)');
  expect(runner).toContain('assert.equal(executedValuationSeed.numFailedTests, 0)');
});
it('requires the current exact owner count without relaxing success, failed or pending assertions', () => {
  expect(Number(runner.match(/executionCommitOwner\.numPassedTests, (\d+)/u)?.[1])).toBe(cases);
  expect(runner).toContain('assert.equal(executionCommitOwner.success, true)');
  expect(runner).toContain('assert.equal(executionCommitOwner.numFailedTests, 0)');
  expect(runner).toContain('assert.equal(executionCommitOwner.numPendingTests, 0)');
});
