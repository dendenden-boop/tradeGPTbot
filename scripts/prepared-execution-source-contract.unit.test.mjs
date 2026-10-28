import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforePreparedExecutionSource } from './prepared-execution-source-legacy.mjs';
import { verifyAdmissionParallelFiles } from './database-cohorts.mjs';

const file = 'packages/database/test/paper-admission.integration.test.ts';
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const hash = (s) => createHash('sha256').update(s).digest('hex');

it('retains every accepted61 native case, statement and cleanup after removing only the new case', () => {
  expect(hash(beforePreparedExecutionSource(file, read(file)))).toBe(
    '690274b24433a82ee1abd276a98337278b3340868a0f292ea315bb59384e2edc',
  );
  expect(
    hash(
      beforePreparedExecutionSource('scripts/test-database.mjs', read('scripts/test-database.mjs')),
    ),
  ).toBe('39480eb69aba08a9b1c88f8e51da439adc036b7222661832b961362240b424bd');
});

it('rejects extra or renamed prepared-source reconstruction blocks', () => {
  const s = read(file);
  for (const bad of [
    s + '// BEGIN PAPER PREPARED SOURCE OTHER\nchanged\n// END PAPER PREPARED SOURCE OTHER\n',
    s.replaceAll('PAPER PREPARED SOURCE TESTS', 'PAPER PREPARED SOURCE OTHER'),
  ])
    expect(() => beforePreparedExecutionSource(file, bad)).toThrow('PAPER_PREPARED_SOURCE_BLOCKS');
  expect(beforePreparedExecutionSource('unrelated.ts', s)).toBe(s);
});

it('requires the additional real native case and exact incremented proof counts with the old budgets', () => {
  const native = read(file),
    runner = read('scripts/test-database.mjs'),
    proof = read('scripts/native-proof-artifacts.mjs');
  expect(native.match(/it\('paper-prepared-source:/gu)).toHaveLength(1);
  for (const check of [
    'paperAdmissionOwner.numPassedTests, 62',
    'beforeUnknownTests.numPendingTests, 45',
    'beforeWithdrawalTests.numPendingTests, 60',
    'beforeReleaseTests.numPendingTests, 61',
  ])
    expect(runner).toContain(check);
  expect(proof).toContain("'paper-admission': 62");
  expect(proof).toContain("'paper-admission': 90000");
  expect(proof).toContain('passed(native, 1393, 480000)');
  expect(read('scripts/integration-proof.mjs')).toContain('full: 1020000');
});

it('renews the complete five-file non-DDL overlap isolation review', async () => {
  await verifyAdmissionParallelFiles();
  const block = read(file)
    .split('// BEGIN PAPER PREPARED SOURCE TESTS\n')[1]
    .split('// END PAPER PREPARED SOURCE TESTS')[0];
  expect(block).not.toMatch(
    /CREATE ROLE|ALTER ROLE|GRANT |REVOKE |TRUNCATE |test\.skip|it\.skip/iu,
  );
  expect(block).toContain('await nextFixtureMarketObservation(f);');
  expect(block).toContain('await runtimeEvidence(f);');
  expect(block).toContain('await reader.close();');
  expect(block).toContain('await journal.stopBeforeStart(stopRequest(request), io());');
  expect(block).toContain('expect(await withdrawalInventory(f)).toEqual(stopped);');
});

it('keeps compiled source authority server-only and checks malformed deployment options', () => {
  const clean = read('scripts/test-clean-install.mjs');
  expect(read('packages/paper-engine/src/risk.ts')).toContain(
    'createPostgresPaperPreparedExecutionSource',
  );
  expect(read('packages/paper-engine/src/index.ts')).not.toContain(
    'createPostgresPaperPreparedExecutionSource',
  );
  expect(clean).toContain("typeof paperRisk.createPostgresPaperPreparedExecutionSource,'function'");
  expect(clean).toContain("'createPostgresPaperPreparedExecutionSource' in paper,false");
  expect(clean).toContain(
    "paperRisk.createPostgresPaperPreparedExecutionSource({connectionString:'https://example.invalid',environment:'test'}),/PAPER_ADMISSION_DATABASE_URL/",
  );
});
