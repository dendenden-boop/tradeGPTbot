// Test orchestration only. Default/legacy runs still execute every stage inline.
const parentDeadlines = Object.freeze({
  full: 1020000,
  database: 1020000,
  auth: 360000,
  owners: 1020000,
  cohorts: 1020000,
});

function plan(args, allowLegacy) {
  if (!Array.isArray(args) || args.length > 1 || args.some((arg) => typeof arg !== 'string'))
    throw new Error('INTEGRATION_PROOF_ARGS');
  const legacy = allowLegacy && args[0] === '--database-only';
  const mode =
    args.length === 0 || legacy
      ? 'full'
      : /^--proof=(full|database|auth|owners|cohorts)$/u.exec(args[0])?.[1];
  if (!mode) throw new Error('INTEGRATION_PROOF_ARGS');
  return Object.freeze({
    mode,
    dependencies: mode !== 'auth' && !legacy,
    databaseArgs: Object.freeze(mode === 'full' ? [] : [`--proof=${mode}`]),
    timeoutMs: parentDeadlines[mode],
  });
}

export const integrationProof = (args) => plan(args, true);
export const databaseProof = (args) => plan(args, false);

// A successful partial process must not masquerade as full acceptance.
export function requireDatabaseProofReport(report, mode) {
  const delegated = ['database', 'owners', 'cohorts'].includes(mode);
  const partial = ['owners', 'cohorts'].includes(mode);
  if (
    !Object.hasOwn(parentDeadlines, mode) ||
    !report ||
    typeof report !== 'object' ||
    Array.isArray(report) ||
    report.status !== (partial ? 'PARTIAL' : 'PASS') ||
    report.proofScope !== mode ||
    report.authenticatedRuntime !== (delegated ? 'DELEGATED' : 'PASS') ||
    report.authenticationHardening !== (delegated ? 'DELEGATED' : 'PASS') ||
    (delegated
      ? report.requiredAuthJob !== 'Auth runtime and faults'
      : report.requiredAuthJob !== undefined) ||
    (mode === 'auth' && report.tests !== undefined) ||
    (mode === 'owners' &&
      (report.ownerSuites !== 'COMPLETE' ||
        report.nativeCohorts !== 'DELEGATED' ||
        report.isolatedReset !== 'DELEGATED' ||
        report.tests !== undefined ||
        report.requiredNativeJob !== 'Native PostgreSQL and real services')) ||
    (mode === 'cohorts' &&
      (report.ownerSuites !== 'DELEGATED' ||
        report.nativeCohorts !== 'COMPLETE' ||
        report.isolatedReset !== 'PASS' ||
        report.requiredOwnerJob !== 'Native migration owners'))
  )
    throw new Error('INTEGRATION_PROOF_INCOMPLETE');
}
