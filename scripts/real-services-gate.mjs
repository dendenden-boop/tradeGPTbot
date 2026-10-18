import { fileURLToPath } from 'node:url';
import path from 'node:path';

// GitHub supplies these results. Missing/skipped/cancelled evidence is never PASS.
export function requireRealServicesSuccess(results) {
  if (
    results === null ||
    typeof results !== 'object' ||
    Array.isArray(results) ||
    Object.keys(results).sort().join(',') !== 'auth,native,smoke' ||
    results.native !== 'success' ||
    results.auth !== 'success' ||
    results.smoke !== 'success'
  )
    throw new Error('REAL_SERVICES_INCOMPLETE');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireRealServicesSuccess({
      native: process.env.CTP_NATIVE_RESULT,
      auth: process.env.CTP_AUTH_RESULT,
      smoke: process.env.CTP_SMOKE_RESULT,
    });
    console.log(
      'Real services gate PASS: native, isolated Auth and container suites completed successfully.',
    );
  } catch {
    console.error('REAL_SERVICES_INCOMPLETE');
    process.exitCode = 1;
  }
}
