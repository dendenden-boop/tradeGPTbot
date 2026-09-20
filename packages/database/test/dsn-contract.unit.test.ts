import { Pool } from 'pg';
import type * as Pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@ctp/config';
import { createAuthDatabase, createDatabase } from '../src/index.js';

vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof Pg>();
  return {
    ...actual,
    Pool: vi.fn(() => {
      throw new Error('Unexpected network boundary');
    }),
  };
});
afterEach(() => vi.clearAllMocks());

const base = 'postgresql://runtime:m9PvQ2sR6xT4nK8w@127.0.0.1:5432/ctp?sslmode=verify-full';
const cases = [
  { name: 'decoded control character', url: base.replace('m9Pv', 'm9%00Pv') },
  { name: 'duplicate application name', url: `${base}&application_name=one&application_name=two` },
  { name: 'application name whitespace', url: `${base}&application_name=unsafe%20value` },
  { name: 'unbounded application name', url: `${base}&application_name=${'x'.repeat(65)}` },
  { name: 'zero port', url: base.replace(':5432/', ':0/') },
  { name: 'nested database path', url: base.replace('/ctp?', '/ctp/other?') },
  { name: 'trimmed leading whitespace', url: `\n${base}` },
  {
    name: 'placeholder deployment password',
    url: base.replace('m9PvQ2sR6xT4nK8w', 'change-me-placeholder-value'),
  },
];

describe('phase 1 config and phase 2/3 database DSN contract', () => {
  it.each(cases)('all reject $name before network access', async ({ name, url }) => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: url,
        REDIS_URL: 'rediss://runtime:v8RmN4qZ7sP2kL6x@127.0.0.1:6379/0',
      }),
    ).toThrow('Invalid configuration: DATABASE_URL');
    for (const create of [createDatabase, createAuthDatabase]) {
      await expect(
        create({ connectionString: url, environment: 'production' }),
      ).rejects.toMatchObject({
        name: 'DatabaseError',
        message: 'Database operation failed',
        code:
          name === 'placeholder deployment password'
            ? 'DATABASE_TLS_REQUIRED'
            : 'DATABASE_URL_INVALID',
      });
    }
    expect(Pool).not.toHaveBeenCalled();
  });
});
