// Private CI evidence validation; never a runtime authority or financial grant.
export const ownerReports = Object.freeze({
  'risk-certification': 14,
  'risk-admission': 95,
  'paper-configuration': 35,
  'paper-funding': 43,
  'paper-portfolio': 38,
  'market-trades': 40,
  'paper-market-frames': 14,
  'paper-order-drafts': 29,
  'paper-book': 32,
  'paper-book-source': 37,
  'paper-risk-portfolio': 44,
  'paper-risk-loss': 26,
  'paper-order-risk': 19,
  'paper-risk-authority': 78,
  'paper-risk-evaluation': 3,
  'paper-reservation-storage': 30,
  'paper-reservation-state': 34,
  'paper-runtime': 49,
  'paper-admission': 61,
});

// Exact existing process limits in test-database.mjs, not a new allowance.
// A cross-file contract checks every entry against its real run() invocation.
const ownerDeadlines = Object.freeze({
  'risk-certification': 120000,
  'risk-admission': 120000,
  'paper-configuration': 90000,
  'paper-funding': 90000,
  'paper-portfolio': 90000,
  'market-trades': 120000,
  'paper-market-frames': 90000,
  'paper-order-drafts': 90000,
  'paper-book': 90000,
  'paper-book-source': 90000,
  'paper-risk-portfolio': 90000,
  'paper-risk-loss': 90000,
  'paper-order-risk': 90000,
  'paper-risk-authority': 90000,
  'paper-risk-evaluation': 30000,
  'paper-reservation-storage': 30000,
  'paper-reservation-state': 30000,
  'paper-runtime': 90000,
  'paper-admission': 90000,
});

export function requireNativeTestArtifacts(owners, native, cohorts, window) {
  const fail = () => {
    throw new Error('NATIVE_TEST_EVIDENCE_INCOMPLETE');
  };
  if (
    !owners ||
    Object.keys(owners).sort().join(',') !== Object.keys(ownerReports).sort().join(',')
  )
    fail();
  function passed(report, minimum, timeout) {
    if (
      !report ||
      report.success !== true ||
      report.numFailedTests !== 0 ||
      report.numPendingTests !== 0 ||
      report.numPassedTests < minimum ||
      report.numTotalTests !== report.numPassedTests ||
      !Array.isArray(report.testResults) ||
      !report.testResults.length ||
      !Number.isSafeInteger(report.startTime) ||
      report.startTime < window.startedAtMs
    )
      fail();
    let total = 0,
      end = report.startTime;
    for (const file of report.testResults) {
      if (
        file.status !== 'passed' ||
        !Array.isArray(file.assertionResults) ||
        !Number.isFinite(file.startTime) ||
        !Number.isFinite(file.endTime) ||
        file.startTime < report.startTime ||
        file.endTime < file.startTime ||
        file.endTime > window.deadlineMs ||
        file.assertionResults.some((a) => a.status !== 'passed')
      )
        fail();
      total += file.assertionResults.length;
      end = Math.max(end, file.endTime);
    }
    if (total !== report.numPassedTests || end - report.startTime > timeout) fail();
  }
  for (const [name, minimum] of Object.entries(ownerReports))
    passed(owners[name], minimum, ownerDeadlines[name]);
  passed(native, 1392, 480000);
  if (
    !cohorts ||
    cohorts.status !== 'PASS' ||
    cohorts.timeoutMs !== 480000 ||
    !Number.isFinite(cohorts.elapsedMs) ||
    cohorts.elapsedMs <= 0 ||
    cohorts.elapsedMs > 480000 ||
    cohorts.tests !== native.numPassedTests ||
    cohorts.files !== native.testResults.length ||
    cohorts.files < 42 ||
    !Array.isArray(cohorts.completed) ||
    cohorts.completed
      .map((c) => c.id)
      .sort()
      .join(',') !== 'admission,main,native-admission,registry,roles'
  )
    fail();
}
