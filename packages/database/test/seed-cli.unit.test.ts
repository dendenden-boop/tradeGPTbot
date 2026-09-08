import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('development seed CLI boundary', () => {
  it.each([
    ['production', 'postgresql://fixture:secret-fixture@127.0.0.1:1/ctp'],
    ['staging', 'postgresql://fixture:secret-fixture@127.0.0.1:1/ctp'],
    ['', 'postgresql://fixture:secret-fixture@127.0.0.1:1/ctp'],
    ['development', 'postgresql://fixture:secret-fixture@example.invalid/ctp'],
    ['development', 'postgresql://fixture:secret-fixture@127.0.0.1:1/production'],
    ['development', 'postgresql://fixture:secret-fixture@127.0.0.1:1/ctp?options=unsafe'],
    ['development', ''],
  ])('refuses an unsafe target without leaking configuration (%#)', (environment, url) => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../../scripts/seed-development.mjs', import.meta.url))],
      {
        env: { ...process.env, NODE_ENV: environment, DATABASE_MIGRATION_URL: url },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toContain('Development seed failed');
    expect(child.stderr).not.toMatch(/secret-fixture|postgresql:\/\/|PrismaClient|ECONN/);
  });
});
