import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('database acceptance parent leaves bounded owner/upgrade room beyond serial native and Auth child deadlines', () => {
  const read = (name: string) =>
    readFileSync(new URL('../../../scripts/' + name, import.meta.url), 'utf8');
  const integration = read('test-integration.mjs'),
    database = read('test-database.mjs');
  const deadline = (source: string, marker: string) => {
    const index = source.indexOf(marker);
    expect(index, marker).toBeGreaterThanOrEqual(0);
    const value = /timeoutMs:\s*([\d_]+)/u.exec(source.slice(index, index + 2000))?.[1];
    expect(value, marker).toBeDefined();
    return Number(value?.replaceAll('_', ''));
  };
  const parent = deadline(integration, "['scripts/test-database.mjs']"),
    native = deadline(database, '// Whole serial suite budget;'),
    auth = deadline(database, "['scripts/test-auth-runtime.mjs']"),
    hardening = deadline(database, "['scripts/test-auth-hardening.mjs']");
  expect([native, auth, hardening]).toEqual([300000, 120000, 180000]);
  // Their sum already consumed the former entire parent budget, leaving no
  // time for populated migrations, non-BYPASSRLS owner repeats or cleanup.
  expect(parent).toBeGreaterThanOrEqual(native + auth + hardening + 90000);
  expect(parent).toBeLessThanOrEqual(900000);
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  expect(workflow.slice(workflow.indexOf('  docker:'))).toContain('timeout-minutes: 20');
  expect(parent).toBeLessThan(20 * 60000);
});
