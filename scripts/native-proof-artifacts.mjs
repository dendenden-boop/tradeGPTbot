// Private CI evidence validation; never a runtime authority or financial grant.
// BEGIN ROLE SCOPED NATIVE IMPORT
import { requireRoleScopedEvidence } from './role-scoped-evidence.mjs';
// END ROLE SCOPED NATIVE IMPORT
// BEGIN CERTIFIED CLUSTER EVIDENCE_IMPORT
import { requireClusterIsolatedEvidence } from './cluster-isolated-evidence.mjs';
const retainedRoleScopedEvidence = requireRoleScopedEvidence;
// END CERTIFIED CLUSTER EVIDENCE_IMPORT
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
  'paper-admission': 69,
  // BEGIN PAPER EXECUTION START REPORT
  'paper-execution-start': 9,
  // END PAPER EXECUTION START REPORT
  // BEGIN PAPER STARTED SOURCE REPORT
  'paper-started-source': 9,
  // END PAPER STARTED SOURCE REPORT
  // BEGIN PAPER STARTED RISK REPORT
  'paper-started-risk': 8,
  // END PAPER STARTED RISK REPORT
  // BEGIN PAPER STARTED PREVIEW REPORT
  'paper-started-preview': 6,
  // END PAPER STARTED PREVIEW REPORT
  // BEGIN PAPER EXECUTED VALUATION REPORT_COUNT
  // BEGIN PAPER EXECUTED BOOK REPORT_COUNT
  // BEGIN PAPER HISTORICAL INVENTORY REPORT_COUNT
  'paper-execution-commit': 35,
  // END PAPER HISTORICAL INVENTORY REPORT_COUNT
  // END PAPER EXECUTED BOOK REPORT_COUNT
  // END PAPER EXECUTED VALUATION REPORT_COUNT
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
  // BEGIN PAPER EXECUTION START DEADLINE
  'paper-execution-start': 90000,
  // END PAPER EXECUTION START DEADLINE
  // BEGIN PAPER STARTED SOURCE DEADLINE
  'paper-started-source': 90000,
  // END PAPER STARTED SOURCE DEADLINE
  // BEGIN PAPER STARTED RISK DEADLINE
  'paper-started-risk': 90000,
  // END PAPER STARTED RISK DEADLINE
  // BEGIN PAPER STARTED PREVIEW DEADLINE
  'paper-started-preview': 90000,
  // END PAPER STARTED PREVIEW DEADLINE
  'paper-execution-commit': 90000,
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
  passed(native, 1400, 480000);
  // BEGIN CERTIFIED CLUSTER EVIDENCE_SELECT
  const requireRoleScopedEvidence = cohorts?.nativeClusterIsolation
    ? requireClusterIsolatedEvidence
    : retainedRoleScopedEvidence;
  // END CERTIFIED CLUSTER EVIDENCE_SELECT
  // BEGIN ROLE SCOPED NATIVE EVIDENCE
  try {
    requireRoleScopedEvidence(cohorts, native);
  } catch {
    fail();
  }
  // END ROLE SCOPED NATIVE EVIDENCE
  // BEGIN PAPER EXECUTION START EVIDENCE
  if (
    native.numPassedTests < 1409 ||
    !cohorts ||
    cohorts.files < 43 ||
    !Array.isArray(cohorts.completed) ||
    cohorts.completed.filter((c) => c.id === 'execution-start').length !== 1
  )
    fail();
  // END PAPER EXECUTION START EVIDENCE
  // BEGIN PAPER STARTED SOURCE EVIDENCE
  if (native.numPassedTests < 1418 || !cohorts || cohorts.files < 44) fail();
  // END PAPER STARTED SOURCE EVIDENCE
  // BEGIN PAPER STARTED RISK EVIDENCE
  if (native.numPassedTests < 1426 || !cohorts || cohorts.files < 45) fail();
  // END PAPER STARTED RISK EVIDENCE
  // BEGIN PAPER STARTED PREVIEW EVIDENCE
  if (native.numPassedTests < 1432 || cohorts.files < 46) fail();
  const preview = cohorts.completed.filter((c) => c.id === 'execution-preview');
  const started = cohorts.completed.find((c) => c.id === 'execution-start');
  const roles = cohorts.completed.find((c) => c.id === 'roles');
  if (
    preview.length !== 1 ||
    !roles ||
    !Number.isFinite(preview[0].startMs) ||
    !Number.isFinite(preview[0].settledMs) ||
    !Number.isFinite(started.settledMs) ||
    !Number.isFinite(roles.startMs) ||
    preview[0].startMs < 0 ||
    preview[0].settledMs < preview[0].startMs ||
    preview[0].startMs < started.settledMs ||
    roles.startMs < preview[0].settledMs
  )
    fail();
  // END PAPER STARTED PREVIEW EVIDENCE
  const commit = cohorts.completed.filter((c) => c.id === 'execution-commit');
  if (
    native.numPassedTests < 1492 ||
    cohorts.files < 49 ||
    commit.length !== 1 ||
    !roles ||
    !preview[0] ||
    !Number.isFinite(commit[0].startMs) ||
    !Number.isFinite(commit[0].settledMs) ||
    commit[0].startMs < preview[0].settledMs ||
    commit[0].settledMs < commit[0].startMs ||
    roles.startMs < commit[0].settledMs
  )
    fail();
  for (const id of [
    'main',
    'registry',
    'admission',
    'native-admission',
    'execution-start',
    'execution-preview',
  ]) {
    const predecessors = cohorts.completed.filter((c) => c.id === id);
    if (
      predecessors.length !== 1 ||
      !Number.isFinite(predecessors[0].settledMs) ||
      commit[0].startMs < predecessors[0].settledMs
    )
      fail();
  }
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
      // BEGIN PAPER STARTED PREVIEW LEGACY_PLAN
      .filter((c) => c.id !== 'execution-preview')
      // END PAPER STARTED PREVIEW LEGACY_PLAN
      // BEGIN ROLE SCOPED NATIVE LEGACY_PLAN
      .filter((c) => c.id !== 'main-scoped')
      // END ROLE SCOPED NATIVE LEGACY_PLAN
      .filter((c) => c.id !== 'execution-commit')
      // BEGIN PAPER EXECUTION START LEGACY_PLAN
      .filter((c) => c.id !== 'execution-start')
      // END PAPER EXECUTION START LEGACY_PLAN
      .map((c) => c.id)
      .sort()
      .join(',') !== 'admission,main,native-admission,registry,roles'
  )
    fail();
}
