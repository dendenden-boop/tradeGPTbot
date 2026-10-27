// Test-only reconstruction of published58 contracts. New59 coverage is checked
// independently; retain every historical assertion, hash and process deadline.
export function beforePaperAttemptJournal(file, source) {
  if (
    [
      'packages/database/test/paper-admission.integration.test.ts',
      'scripts/test-database.mjs',
    ].includes(file)
  )
    source = source.replace(
      /^[ \t]*\/\/ BEGIN PAPER ATTEMPT JOURNAL ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER ATTEMPT JOURNAL \1\n/gm,
      '',
    );
  if (file === 'scripts/test-database.mjs')
    source = source
      .replace('paperAdmissionOwner.numPassedTests, 61', 'paperAdmissionOwner.numPassedTests, 53')
      .replace('beforeUnknownTests.numPendingTests, 44', 'beforeUnknownTests.numPendingTests, 36')
      .replace(
        'beforeWithdrawalTests.numPendingTests, 59',
        'beforeWithdrawalTests.numPendingTests, 51',
      )
      .replace('beforeReleaseTests.numPendingTests, 60', 'beforeReleaseTests.numPendingTests, 52');
  if (file === 'scripts/native-proof-artifacts.mjs')
    source = source
      .replace("'paper-admission': 61", "'paper-admission': 53")
      .replace('passed(native, 1392, 480000)', 'passed(native, 1384, 480000)');
  return source;
}
