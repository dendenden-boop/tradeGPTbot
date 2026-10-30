import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyAdmissionParallelFiles } from './database-cohorts.mjs';
import { beforeExecutionContext } from './execution-context-legacy.mjs';
const read = (p) =>
  beforeExecutionContext(
    p,
    fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
  );
const hash = (s) => createHash('sha256').update(s).digest('hex');
const file = 'packages/database/test/paper-admission.integration.test.ts';
it('preserves all accepted65 native statements and runner/proof bodies outside explicit additions', async () => {
  const { beforePreparationInventory } = await import('./preparation-inventory-legacy.mjs');
  expect(hash(beforePreparationInventory(file, read(file)))).toBe(
    'd87035ad233495cd0ffaae5bd021b6694f4bf775f069e4dbe5cdfa1cff70c92c',
  );
  expect(
    hash(
      beforePreparationInventory('scripts/test-database.mjs', read('scripts/test-database.mjs')),
    ),
  ).toBe('ae951e917b7c0e3e7f09b197eabd1bf8291291386a10e6f1781b66ec5598653a');
  expect(
    hash(
      beforePreparationInventory(
        'scripts/native-proof-artifacts.mjs',
        read('scripts/native-proof-artifacts.mjs'),
      ),
    ),
  ).toBe('67a2a7d8fa78b3a08f849b77d8c514ba2000c459955ad8db026f86cf74061e2c');
  expect(() =>
    beforePreparationInventory(
      file,
      read(file).replaceAll(
        'PAPER PREPARATION INVENTORY TESTS',
        'PAPER PREPARATION INVENTORY OTHER',
      ),
    ),
  ).toThrow();
  await verifyAdmissionParallelFiles();
});
it('requires two real native cases, exact increased counters and unchanged original budgets', () => {
  expect(read(file).match(/it\('paper-preparation-inventory:/gu)).toHaveLength(2);
  const block = read(file)
    .split('// BEGIN PAPER PREPARATION INVENTORY TESTS\n')[1]
    .split('// END PAPER PREPARATION INVENTORY TESTS')[0];
  expect(block).not.toMatch(
    /CREATE ROLE|ALTER ROLE|GRANT |REVOKE |TRUNCATE |test\.skip|it\.skip/iu,
  );
  for (const s of [
    'paperAdmissionOwner.numPassedTests, 67',
    'beforeUnknownTests.numPendingTests, 50',
    'beforeWithdrawalTests.numPendingTests, 65',
    'beforeReleaseTests.numPendingTests, 66',
    'verifyPreparationInventoryUpgrade(paperUpgrade, beforePreparationInventory)',
  ])
    expect(read('scripts/test-database.mjs')).toContain(s);
  expect(read('scripts/native-proof-artifacts.mjs')).toContain('passed(native, 1398, 480000)');
  expect(read('scripts/native-proof-artifacts.mjs')).toContain("'paper-admission': 90000");
  expect(read('scripts/integration-proof.mjs')).toContain('full: 1020000');
});
it('verifies populated60→61 identity/ACL retention and production-only export without granting authority', () => {
  const u = read('scripts/preparation-inventory-upgrade.mjs');
  for (const s of [
    'before.functions.length, 223',
    'after.functions.length, 225',
    'assert.deepEqual(after.rows, before.rows)',
    'reconcile_admission_v60',
    'has_function_privilege',
  ])
    expect(u).toContain(s);
  expect(
    read(
      'packages/database/prisma/migrations/202610290001_paper_preparation_inventory/migration.sql',
    ),
  ).not.toMatch(
    /CREATE TABLE|ALTER TABLE|CREATE ROLE|CREATE FUNCTION ctp_paper\.evaluate_and_reserve/iu,
  );
  const clean = read('scripts/test-clean-install.mjs');
  expect(clean).toContain(
    "typeof paperRisk.createPostgresPaperPreparationInventorySource,'function'",
  );
  expect(clean).toContain("'createPostgresPaperPreparationInventorySource' in paper,false");
  expect(clean).toContain(
    "paperRisk.createPostgresPaperPreparationInventorySource({connectionString:'https://example.invalid',environment:'test'}),/PAPER_ADMISSION_DATABASE_URL/",
  );
});
