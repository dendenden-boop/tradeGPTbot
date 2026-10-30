import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const hash = (s) => createHash('sha256').update(s).digest('hex');
const native = 'packages/database/test/paper-admission.integration.test.ts';
async function normalize() {
  const name = './execution-context-legacy.mjs';
  return (await import(name)).beforeExecutionContext;
}
it('retains all accepted67 native bodies and full runner/proof outside explicit context additions', async () => {
  const before = await normalize();
  for (const [p, h] of [
    [native, '463ae5db6eda9a821a2f1f2c717ebad0ce2eb7e54e830aa6517e0c214ea8ddeb'],
    [
      'scripts/test-database.mjs',
      'f4b20d691c6b8fe9e8feaab401a680c1737b9cf715bd0a76dd8da9f48b3f5cd0',
    ],
    [
      'scripts/native-proof-artifacts.mjs',
      '657f642614951852aa606e32ae7496034996ec0e320e36b4ff17d423fedb0b15',
    ],
  ])
    expect(hash(before(p, read(p)))).toBe(h);
});
it('rejects missing, changed and duplicate context marker boundaries rather than hiding old statement edits', async () => {
  const before = await normalize(),
    source = read(native);
  for (const changed of [
    source.replace('END PAPER EXECUTION CONTEXT TESTS', 'END PAPER EXECUTION CONTEXT OTHER'),
    source.replace('BEGIN PAPER EXECUTION CONTEXT TESTS', 'BEGIN PAPER EXECUTION CONTEXT OTHER'),
    source + '\n// BEGIN PAPER EXECUTION CONTEXT TESTS\n// END PAPER EXECUTION CONTEXT TESTS\n',
  ])
    expect(() => before(native, changed)).toThrow();
  expect(before(native, before(native, source))).toBe(before(native, source));
  expect(hash(before(native, source.replace("'PAUSED'", "'RUNNING'")))).not.toBe(
    hash(before(native, source)),
  );
});
it('requires both actual native scenarios and exact additional counts with original budgets and role boundary', () => {
  const source = read(native),
    block = source
      .split('// BEGIN PAPER EXECUTION CONTEXT TESTS\n')[1]
      .split('// END PAPER EXECUTION CONTEXT TESTS')[0];
  expect(block.match(/it\('paper-execution-context:/gu)).toHaveLength(2);
  expect(block).not.toMatch(
    /CREATE ROLE|ALTER ROLE|GRANT |REVOKE |TRUNCATE |test\.skip|it\.skip/iu,
  );
  const runner = read('scripts/test-database.mjs');
  for (const s of [
    'paperAdmissionOwner.numPassedTests, 69',
    'beforeUnknownTests.numPendingTests, 52',
    'beforeWithdrawalTests.numPendingTests, 67',
    'beforeReleaseTests.numPendingTests, 68',
  ])
    expect(runner).toContain(s);
  expect(read('scripts/native-proof-artifacts.mjs')).toContain('passed(native, 1400, 480000)');
  expect(read('scripts/native-proof-artifacts.mjs')).toContain("'paper-admission': 90000");
  expect(read('scripts/integration-proof.mjs')).toContain('full: 1020000');
});
