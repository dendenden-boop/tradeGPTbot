import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_ADMISSION_RUNNER_REQUIRED');
const url = process.env['DATABASE_MIGRATION_URL'];
if (!url) throw new Error('ISOLATED_ADMISSION_DATABASE_REQUIRED');
const admin = new Pool({ connectionString: url, max: 1, query_timeout: 5000 });
afterAll(() => admin.end());
it.each(['prepare(jsonb)', 'persist(jsonb,text)'])(
  'provides atomic production admission SQL contract %s',
  async (signature) => {
    const r = await admin.query<{ present: boolean }>(
      'SELECT to_regprocedure($1) IS NOT NULL AS present',
      ['ctp_admission.' + signature],
    );
    expect(r.rows[0]?.present).toBe(true);
  },
);
