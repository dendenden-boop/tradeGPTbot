import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/index.js';

afterEach(() => vi.unstubAllEnvs());

describe('database connection boundary', () => {
  const base = 'postgresql://runtime:fixture-only-password@127.0.0.1:5432/ctp';
  it('rejects an unknown runtime environment before connecting', async () => {
    await expect(
      createDatabase({ connectionString: base, environment: 'unknown' as 'test' }),
    ).rejects.toMatchObject({ code: 'DATABASE_ENVIRONMENT_INVALID' });
  });
  it.each([
    '',
    'not-a-url',
    'https://runtime:password@127.0.0.1/ctp',
    'postgresql://runtime@127.0.0.1/ctp',
    'postgresql://runtime:password@127.0.0.1/',
    'postgresql://runtime:bad%00password@127.0.0.1/ctp',
    `${base}?sslmode=verify-full&sslmode=disable`,
    `${base}?sslrootcert=C:/private.pem`,
    `${base}?options=-c_statement_timeout=0`,
    `${base}?application_name=unsafe%0A`,
    `${base}#fragment`,
  ])('rejects unsafe DSN %# before opening a connection', async (connectionString) => {
    await expect(createDatabase({ connectionString, environment: 'test' })).rejects.toMatchObject({
      name: 'DatabaseError',
      code: 'DATABASE_URL_INVALID',
      message: 'Database operation failed',
    });
  });
  it.each(['production', 'staging'] as const)(
    'requires verified TLS in %s',
    async (environment) => {
      await expect(createDatabase({ connectionString: base, environment })).rejects.toMatchObject({
        code: 'DATABASE_TLS_REQUIRED',
      });
    },
  );
  it('rejects process-wide TLS disabling before connecting', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    await expect(
      createDatabase({
        connectionString: `${base}?sslmode=verify-full`,
        environment: 'production',
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_TLS_REQUIRED' });
  });
});
