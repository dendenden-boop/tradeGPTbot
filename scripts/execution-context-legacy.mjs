// Test-only reconstruction of published61 bodies; never used by runtime.
import { beforeAdmissionFixturePort } from './admission-port-lifetime-legacy.mjs';
export function beforeExecutionContext(file, source) {
  source = beforeAdmissionFixturePort(file, source);
  if (file === 'packages/database/test/paper-admission.integration.test.ts') {
    const blocks = [
      ...source.matchAll(
        /^\/\/ BEGIN PAPER EXECUTION CONTEXT TESTS\n[\s\S]*?^\/\/ END PAPER EXECUTION CONTEXT TESTS\n/gm,
      ),
    ];
    if (source.includes('// BEGIN PAPER EXECUTION CONTEXT ')) {
      if (
        blocks.length !== 1 ||
        (source.match(/\/\/ BEGIN PAPER EXECUTION CONTEXT /gu) ?? []).length !== 1
      )
        throw Error('PAPER_EXECUTION_CONTEXT_BLOCKS');
      source = source.replace(blocks[0][0], '');
    }
  }
  if (file === 'scripts/test-database.mjs')
    source = source
      .replace('paperAdmissionOwner.numPassedTests, 69', 'paperAdmissionOwner.numPassedTests, 67')
      .replace('beforeUnknownTests.numPendingTests, 52', 'beforeUnknownTests.numPendingTests, 50')
      .replace(
        'beforeWithdrawalTests.numPendingTests, 67',
        'beforeWithdrawalTests.numPendingTests, 65',
      )
      .replace('beforeReleaseTests.numPendingTests, 68', 'beforeReleaseTests.numPendingTests, 66');
  if (file === 'scripts/native-proof-artifacts.mjs')
    source = source
      .replace("'paper-admission': 69", "'paper-admission': 67")
      .replace('passed(native, 1400, 480000)', 'passed(native, 1398, 480000)');
  return source;
}
