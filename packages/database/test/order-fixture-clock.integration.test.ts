import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_ORDER_CLOCK_RUNNER_REQUIRED');
const url = process.env['DATABASE_MIGRATION_URL'];
if (!url) throw new Error('ISOLATED_ORDER_CLOCK_VARIABLE_REQUIRED');
const database = new Pool({ connectionString: url, max: 1, query_timeout: 2500 });
afterAll(() => database.end());

it('native normal order fixture effective time cannot round into the future at a sub-millisecond boundary', async () => {
  // Exercise the actual producer expression against PostgreSQL's own precision
  // conversion, with a fixed clock. No sleeps, admissions, writes or retries.
  const text = await readFile(
    new URL('./order-engine.integration.test.ts', import.meta.url),
    'utf8',
  );
  const match = text.match(
    /CASE WHEN \$4 THEN now\(\)\+interval '1 minute' ELSE (.+?) END,now\(\),\$3/u,
  );
  if (!match?.[1]) throw new Error('NORMAL_RULE_FIXTURE_EXPRESSION_REQUIRED');
  const expression = match[1].replaceAll('now()', 'probe.at');
  const rows = await database.query<{ native_rounds_future: boolean; fixture_future: boolean }>(
    `WITH probe AS (SELECT $1::timestamptz AS at)
     SELECT probe.at::timestamptz(3)>probe.at AS native_rounds_future,
       (${expression})::timestamptz(3)>probe.at AS fixture_future FROM probe`,
    ['2026-10-13 00:00:00.0006+00'],
  );
  expect(rows.rows).toEqual([{ native_rounds_future: true, fixture_future: false }]);
});
