import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const password = 'a'.repeat(48);
const base = `postgresql://ctp_test:${password}@127.0.0.1:1/ctp_test`;
const owned = 'ctp-integration-1-123456abcdef';
describe('disposable database runner target guard', () => {
  it.each([
    ['test', '', base],
    ['test', 'ctp-local', base],
    ['test', `${owned}/../ctp`, base],
    ['production', owned, base],
    ['test', owned, base.replace('/ctp_test', '/ctp')],
    ['test', owned, base.replace('127.0.0.1', 'example.invalid')],
    ['test', owned, `not-a-url-${password}`],
  ])(
    'rejects an unrelated or malformed target before Docker/SQL (%#)',
    (environment, project, url) => {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../../../scripts/test-database.mjs', import.meta.url))],
        {
          env: {
            ...process.env,
            NODE_ENV: environment,
            CTP_TEST_PROJECT: project,
            DATABASE_MIGRATION_URL: url,
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stdout).toBe('');
      expect(child.stderr).toMatch(/Database (tests require|runner requires)/);
      expect(child.stderr).not.toContain(password);
      expect(child.stderr).not.toContain('postgresql://');
    },
  );
});
