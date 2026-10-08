import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_CERTIFICATION_RUNNER_REQUIRED');
const url = process.env['DATABASE_MIGRATION_URL'];
if (!url) throw new Error('ISOLATED_CERTIFICATION_DATABASE_REQUIRED');
const admin = new Pool({ connectionString: url, max: 1, query_timeout: 5000 });
afterAll(async () => {
  await admin.end();
});

it.each([
  'capture_sources(jsonb)',
  'next_identity(jsonb)',
  'insert_certificate(jsonb,text)',
  'read_certificate(jsonb)',
  'publish_observation(text)',
])('provides the physical certification prerequisite %s', async (signature) => {
  const r = await admin.query<{ present: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='ctp_certification' AND f.oid=to_regprocedure($1)) AS present",
    ['ctp_certification.' + signature],
  );
  expect(r.rows[0]?.present).toBe(true);
});
