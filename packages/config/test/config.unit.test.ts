import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/index.js';

const local = {
  DATABASE_URL: 'postgresql://app:local-only-password@127.0.0.1:5432/bootstrap',
  REDIS_URL: 'redis://:local-only-password@127.0.0.1:6379/0',
};

const deployed = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app:m9PvQ2sR6xT4nK8w@database.internal/bootstrap?sslmode=verify-full',
  REDIS_URL: 'rediss://app:v8RmN4qZ7sP2kL6x@redis.internal:6379/0',
};

describe('loadConfig', () => {
  it('returns explicit defaults as an immutable independent value', () => {
    const raw = { ...local };
    const config = loadConfig(raw);
    expect(config).toEqual({
      environment: 'development',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      databaseUrl: local.DATABASE_URL,
      redisUrl: local.REDIS_URL,
      dependencyTimeoutMs: 1000,
      healthCacheMs: 1000,
      shutdownTimeoutMs: 10_000,
      bodyLimitBytes: 16_384,
      requestTimeoutMs: 10_000,
      connectionTimeoutMs: 5000,
      postgresPoolMax: 5,
    });
    expect(Object.isFrozen(config)).toBe(true);
    raw.DATABASE_URL = 'postgres://different.invalid/changed';
    expect(config.databaseUrl).toBe(local.DATABASE_URL);
    expect(() => Reflect.set(config, 'port', 1)).not.toThrow();
    expect(config.port).toBe(3000);
  });

  it('applies supplied settings without string coercion surprises', () => {
    expect(
      loadConfig({
        ...local,
        NODE_ENV: 'test',
        HOST: '::1',
        PORT: '65535',
        LOG_LEVEL: 'debug',
        DEPENDENCY_TIMEOUT_MS: '250',
        HEALTH_CACHE_MS: '0',
        SHUTDOWN_TIMEOUT_MS: '9000',
        BODY_LIMIT_BYTES: '8192',
        REQUEST_TIMEOUT_MS: '3000',
        CONNECTION_TIMEOUT_MS: '2000',
        POSTGRES_POOL_MAX: '2',
      }),
    ).toMatchObject({
      environment: 'test',
      host: '::1',
      port: 65_535,
      logLevel: 'debug',
      dependencyTimeoutMs: 250,
      healthCacheMs: 0,
      shutdownTimeoutMs: 9000,
      bodyLimitBytes: 8192,
      requestTimeoutMs: 3000,
      connectionTimeoutMs: 2000,
      postgresPoolMax: 2,
    });
  });

  it.each([
    '',
    ' ',
    ' 3000',
    '3000 ',
    '\t3000',
    '0',
    '-1',
    '1.5',
    '1e3',
    '0x10',
    '01',
    'NaN',
    'Infinity',
    'false',
    '65536',
    '9007199254740993',
  ])('rejects the invalid port %j', (PORT) => {
    expect(() => loadConfig({ ...local, PORT })).toThrow('Invalid configuration: PORT');
  });

  it.each([
    ['NODE_ENV', 'prod'],
    ['NODE_ENV', ''],
    ['LOG_LEVEL', 'verbose'],
    ['LOG_LEVEL', ' info'],
    ['HOST', ''],
    ['HOST', 'example.com/path'],
    ['HOST', 'bad host'],
    ['HOST', '-invalid'],
    ['DEPENDENCY_TIMEOUT_MS', '1001'],
    ['DEPENDENCY_TIMEOUT_MS', '0'],
    ['HEALTH_CACHE_MS', '5001'],
    ['SHUTDOWN_TIMEOUT_MS', '10001'],
    ['BODY_LIMIT_BYTES', '0'],
    ['REQUEST_TIMEOUT_MS', '0'],
    ['CONNECTION_TIMEOUT_MS', 'Infinity'],
    ['POSTGRES_POOL_MAX', '21'],
  ])('rejects invalid %s', (field, value) => {
    expect(() => loadConfig({ ...local, [field]: value })).toThrow(
      `Invalid configuration: ${field}`,
    );
  });

  it.each([
    ['DATABASE_URL', ''],
    ['DATABASE_URL', 'postgres://localhost'],
    ['DATABASE_URL', 'http://localhost/database'],
    ['DATABASE_URL', 'postgres://app:pw@localhost:0/database'],
    ['DATABASE_URL', 'postgres://app:%broken@localhost/database'],
    ['DATABASE_URL', 'postgres://localhost/database#fragment'],
    ['DATABASE_URL', ' postgres://localhost/database'],
    ['DATABASE_URL', 'postgres://localhost/data base'],
    ['REDIS_URL', ''],
    ['REDIS_URL', 'http://localhost/0'],
    ['REDIS_URL', 'redis://localhost/not-a-number'],
    ['REDIS_URL', 'redis://localhost/-1'],
    ['REDIS_URL', 'redis://localhost/0?rejectUnauthorized=false'],
    ['REDIS_URL', 'redis://localhost/0#fragment'],
  ])('rejects invalid DSN in %s', (field, value) => {
    expect(() => loadConfig({ ...local, [field]: value })).toThrow(
      `Invalid configuration: ${field}`,
    );
  });

  it('reports every missing required field without reading global environment', () => {
    expect(() => loadConfig({})).toThrow('Invalid configuration: DATABASE_URL, REDIS_URL');
  });

  it.each(['staging', 'production'])('requires deployed credentials and TLS in %s', (NODE_ENV) => {
    expect(loadConfig({ ...deployed, NODE_ENV }).environment).toBe(NODE_ENV);
    expect(() => loadConfig({ ...local, NODE_ENV })).toThrow('DATABASE_URL, REDIS_URL');
  });

  it.each([
    ['DATABASE_URL', 'postgres://app:password@db/bootstrap?sslmode=verify-full'],
    [
      'DATABASE_URL',
      'postgres://app:development-only-placeholder@db/bootstrap?sslmode=verify-full',
    ],
    ['DATABASE_URL', 'postgres://app:m9PvQ2sR6xT4nK8w@db/bootstrap'],
    ['DATABASE_URL', 'postgres://app:m9PvQ2sR6xT4nK8w@db/bootstrap?sslmode=require'],
    [
      'DATABASE_URL',
      'postgres://app:m9PvQ2sR6xT4nK8w@db/bootstrap?sslmode=verify-full&sslmode=disable',
    ],
    ['DATABASE_URL', 'postgres://app:m9PvQ2sR6xT4nK8w@db/bootstrap?sslmode=verify-full&ssl=false'],
    [
      'DATABASE_URL',
      'postgres://app:m9PvQ2sR6xT4nK8w@db/bootstrap?sslmode=verify-full&sslrootcert=system',
    ],
    [
      'DATABASE_URL',
      'postgres://app:m9PvQ2sR6xT4nK8w@db/bootstrap?sslmode=verify-full&password=override',
    ],
    ['REDIS_URL', 'redis://app:v8RmN4qZ7sP2kL6x@cache/0'],
    ['REDIS_URL', 'rediss://cache/0'],
    ['REDIS_URL', 'rediss://:replace-me-before-production@cache/0'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ['PGSSLMODE', 'disable'],
  ])('rejects unsafe deployment setting %s', (field, value) => {
    expect(() => loadConfig({ ...deployed, [field]: value })).toThrow(
      `Invalid configuration: ${field}`,
    );
  });

  it('never includes the input, validation issues or cause in ConfigError', () => {
    const canary = 'CANARY_CONFIG_SECRET_3d4f';
    let caught: unknown;
    try {
      loadConfig({ ...local, DATABASE_URL: `https://user:${canary}@invalid/`, PORT: canary });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    if (!(caught instanceof ConfigError)) {
      throw new Error('Expected ConfigError');
    }
    expect(caught.fields).toEqual(['PORT', 'DATABASE_URL']);
    expect(Object.isFrozen(caught.fields)).toBe(true);
    expect(caught.cause).toBeUndefined();
    expect(`${caught.message}${caught.stack}${JSON.stringify(caught)}`).not.toContain(canary);
  });

  it('does not accept inherited values or invoke environment getters', () => {
    const inherited = Object.create(local) as Readonly<Record<string, string | undefined>>;
    expect(() => loadConfig(inherited)).toThrow('DATABASE_URL, REDIS_URL');
    const raw = { ...local };
    let reads = 0;
    Object.defineProperty(raw, 'DATABASE_URL', {
      get() {
        reads += 1;
        throw new Error('CANARY_GETTER_SECRET');
      },
    });
    expect(() => loadConfig(raw)).toThrow('Invalid configuration: DATABASE_URL');
    expect(reads).toBe(0);
  });
});
