import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  nativeWindowIdentity,
  readNativeWindowEvidence,
  requireNativeWindowReports,
} from './native-proof-window.mjs';
import { requireDatabaseProofReport } from './integration-proof.mjs';
import { ownerReports, requireNativeTestArtifacts } from './native-proof-artifacts.mjs';

// GitHub supplies these results. Missing/skipped/cancelled evidence is never PASS.
export function requireRealServicesSuccess(results) {
  if (
    results === null ||
    typeof results !== 'object' ||
    Array.isArray(results) ||
    Object.keys(results).sort().join(',') !== 'auth,native,owners,smoke' ||
    results.native !== 'success' ||
    results.owners !== 'success' ||
    results.auth !== 'success' ||
    results.smoke !== 'success'
  )
    throw new Error('REAL_SERVICES_INCOMPLETE');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireRealServicesSuccess({
      native: process.env.CTP_NATIVE_RESULT,
      owners: process.env.CTP_OWNER_RESULT,
      auth: process.env.CTP_AUTH_RESULT,
      smoke: process.env.CTP_SMOKE_RESULT,
    });
    const window = readNativeWindowEvidence(process.env.CTP_NATIVE_WINDOW, nativeWindowIdentity());
    const load = async (dir, name) =>
      JSON.parse(
        await readFile(path.resolve('test-results/native-gate', dir, `${name}.json`), 'utf8'),
      );
    const owners = await load('owners', 'integration');
    const cohorts = await load('cohorts', 'integration');
    requireNativeWindowReports(owners, cohorts, window);
    const ownerDatabase = await load('owners', 'database-owners');
    const cohortDatabase = await load('cohorts', 'database');
    requireDatabaseProofReport(ownerDatabase, 'owners');
    requireDatabaseProofReport(cohortDatabase, 'cohorts');
    requireNativeWindowReports(ownerDatabase, cohortDatabase, window);
    if (ownerDatabase.project !== owners.project || cohortDatabase.project !== cohorts.project)
      throw new Error('NATIVE_PROOFS_INCOMPLETE');
    const ownerTests = Object.fromEntries(
      await Promise.all(
        Object.keys(ownerReports).map(async (name) => [
          name,
          await load('owners', `${name}-owner-tests`),
        ]),
      ),
    );
    requireNativeTestArtifacts(
      ownerTests,
      await load('cohorts', 'database-tests'),
      await load('cohorts', 'database-cohorts'),
      window,
    );
    console.log(
      'Real services gate PASS: owners, native cohorts/reset, isolated Auth and containers completed successfully within the shared native deadline.',
    );
  } catch {
    console.error('REAL_SERVICES_INCOMPLETE');
    process.exitCode = 1;
  }
}
