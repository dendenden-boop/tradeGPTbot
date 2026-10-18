import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('database acceptance parent leaves bounded owner/upgrade room beyond aggregate native and Auth child deadlines', () => {
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
    native = deadline(database, '// Whole native suite budget;'),
    auth = deadline(database, "['scripts/test-auth-runtime.mjs']"),
    hardening = deadline(database, "['scripts/test-auth-hardening.mjs']");
  // With 1138 cases and the extra owner/upgrade stage, two independent runs
  // passed native assertions but exhausted the 900s parent during Auth.
  // This aggregate is separate from each test/transaction/abort deadline.
  expect([native, auth, hardening]).toEqual([480000, 120000, 180000]);
  const config = readFileSync(
    new URL('../../../vitest.database.config.ts', import.meta.url),
    'utf8',
  );
  expect(config).toContain('testTimeout: 15000');
  expect(config).toContain('hookTimeout: 30000');
  // Preserve room for populated migrations, non-BYPASSRLS owner repeats and
  // cleanup as well as the complete SQL/Auth sequence.
  expect(parent).toBeGreaterThanOrEqual(native + auth + hardening + 240000);
  expect(parent).toBeLessThanOrEqual(1020000);
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const nativeJob = workflow.slice(workflow.indexOf('  native:'), workflow.indexOf('  smoke:'));
  expect(nativeJob).toContain('timeout-minutes: 20');
  expect(nativeJob).toContain('run: pnpm test:integration');
  // Reserve three minutes within the unchanged native job cap for setup and cleanup.
  expect(parent + 180000).toBeLessThanOrEqual(20 * 60000);
});
