// Test-only reconstruction. Preserve all accepted native statements and deadlines.
import { beforePreparationInventory } from './preparation-inventory-legacy.mjs';
export function beforeExecutionRiskSource(file, source) {
  source = beforePreparationInventory(file, source);
  const expected =
    file === 'packages/database/test/paper-admission.integration.test.ts'
      ? ['TESTS']
      : file === 'scripts/test-database.mjs'
        ? ['IMPORT', 'MIGRATION', 'OWNER', 'UPGRADE', 'RESET_AFTER', 'FLAGS']
        : [];
  if (expected.length) {
    const blocks = [
      ...source.matchAll(
        /^[ \t]*\/\/ BEGIN PAPER EXECUTION RISK ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER EXECUTION RISK \1\n/gm,
      ),
    ];
    if (blocks.length || source.includes('// BEGIN PAPER EXECUTION RISK ')) {
      if (
        blocks.length !== expected.length ||
        blocks.some((b, i) => b[1] !== expected[i]) ||
        (source.match(/\/\/ BEGIN PAPER EXECUTION RISK /gu) ?? []).length !== expected.length
      )
        throw Error('PAPER_EXECUTION_RISK_BLOCKS');
      for (const b of blocks) source = source.replace(b[0], '');
    }
  }
  if (file === 'scripts/test-database.mjs')
    source = source
      .replace('paperAdmissionOwner.numPassedTests, 65', 'paperAdmissionOwner.numPassedTests, 62')
      .replace('beforeUnknownTests.numPendingTests, 48', 'beforeUnknownTests.numPendingTests, 45')
      .replace(
        'beforeWithdrawalTests.numPendingTests, 63',
        'beforeWithdrawalTests.numPendingTests, 60',
      )
      .replace('beforeReleaseTests.numPendingTests, 64', 'beforeReleaseTests.numPendingTests, 61');
  if (file === 'scripts/native-proof-artifacts.mjs')
    source = source
      .replace("'paper-admission': 65", "'paper-admission': 62")
      .replace('passed(native, 1396, 480000)', 'passed(native, 1393, 480000)');
  return source;
}
