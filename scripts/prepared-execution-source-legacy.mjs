// Test-only reconstruction of the accepted61-case fixture and proof counters.
// New readonly composition coverage is verified independently. Never remove or
// rewrite a historical test, assertion, process deadline or migration.
import { beforeExecutionRiskSource } from './execution-risk-source-legacy.mjs';
export function beforePreparedExecutionSource(file, source) {
  source = beforeExecutionRiskSource(file, source);
  if (file === 'packages/database/test/paper-admission.integration.test.ts') {
    const blocks = [
      ...source.matchAll(
        /^[ \t]*\/\/ BEGIN PAPER PREPARED SOURCE ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER PREPARED SOURCE \1\n/gm,
      ),
    ];
    if (blocks.length === 0) return source;
    if (blocks.length !== 1 || blocks[0][1] !== 'TESTS')
      throw Error('PAPER_PREPARED_SOURCE_BLOCKS');
    return source.replace(blocks[0][0], '');
  }
  if (file === 'scripts/test-database.mjs')
    return source
      .replace('paperAdmissionOwner.numPassedTests, 62', 'paperAdmissionOwner.numPassedTests, 61')
      .replace('beforeUnknownTests.numPendingTests, 45', 'beforeUnknownTests.numPendingTests, 44')
      .replace(
        'beforeWithdrawalTests.numPendingTests, 60',
        'beforeWithdrawalTests.numPendingTests, 59',
      )
      .replace('beforeReleaseTests.numPendingTests, 61', 'beforeReleaseTests.numPendingTests, 60');
  if (file === 'scripts/native-proof-artifacts.mjs')
    return source
      .replace("'paper-admission': 62", "'paper-admission': 61")
      .replace('passed(native, 1393, 480000)', 'passed(native, 1392, 480000)');
  return source;
}
