// Test-only reconstruction of accepted65-case fixture and proof producers.
import { beforeOrderFixturePort } from './order-fixture-port-legacy.mjs';
import { beforeBookUpgradeRecovery } from './book-upgrade-recovery-legacy.mjs';
import { beforeExecutionContext } from './execution-context-legacy.mjs';
export function beforePreparationInventory(file, source) {
  source = beforeExecutionContext(file, source);
  source = beforeBookUpgradeRecovery(file, source);
  source = beforeOrderFixturePort(file, source);
  const expected =
    file === 'packages/database/test/paper-admission.integration.test.ts'
      ? ['TESTS']
      : file === 'scripts/test-database.mjs'
        ? ['IMPORT', 'MIGRATION', 'OWNER', 'UPGRADE', 'RESET_AFTER', 'FLAGS']
        : [];
  if (expected.length) {
    const blocks = [
      ...source.matchAll(
        /^[ \t]*\/\/ BEGIN PAPER PREPARATION INVENTORY ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER PREPARATION INVENTORY \1\n/gm,
      ),
    ];
    if (blocks.length || source.includes('// BEGIN PAPER PREPARATION INVENTORY ')) {
      if (
        blocks.length !== expected.length ||
        blocks.some((b, i) => b[1] !== expected[i]) ||
        (source.match(/\/\/ BEGIN PAPER PREPARATION INVENTORY /gu) ?? []).length !== expected.length
      )
        throw Error('PAPER_PREPARATION_INVENTORY_BLOCKS');
      for (const b of blocks) source = source.replace(b[0], '');
    }
  }
  if (file === 'scripts/test-database.mjs')
    source = source
      .replace('paperAdmissionOwner.numPassedTests, 67', 'paperAdmissionOwner.numPassedTests, 65')
      .replace('beforeUnknownTests.numPendingTests, 50', 'beforeUnknownTests.numPendingTests, 48')
      .replace(
        'beforeWithdrawalTests.numPendingTests, 65',
        'beforeWithdrawalTests.numPendingTests, 63',
      )
      .replace('beforeReleaseTests.numPendingTests, 66', 'beforeReleaseTests.numPendingTests, 64');
  if (file === 'scripts/native-proof-artifacts.mjs')
    source = source
      .replace("'paper-admission': 67", "'paper-admission': 65")
      .replace('passed(native, 1398, 480000)', 'passed(native, 1396, 480000)');
  return source;
}
