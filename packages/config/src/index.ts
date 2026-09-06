import { isIP } from 'node:net';

import { z } from 'zod';

const fields = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'LOG_LEVEL',
  'DATABASE_URL',
  'REDIS_URL',
  'DEPENDENCY_TIMEOUT_MS',
  'HEALTH_CACHE_MS',
  'SHUTDOWN_TIMEOUT_MS',
  'BODY_LIMIT_BYTES',
  'REQUEST_TIMEOUT_MS',
  'CONNECTION_TIMEOUT_MS',
  'POSTGRES_POOL_MAX',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'PGSSLMODE',
] as const;

type ConfigField = (typeof fields)[number];

/** Deliberately contains field names only, never Zod issues, input, or a cause. */
export class ConfigError extends Error {
  public readonly fields: readonly ConfigField[];

  public constructor(invalidFields: readonly ConfigField[]) {
    const safeFields = fields.filter((field) => invalidFields.includes(field));
    super(`Invalid configuration: ${safeFields.join(', ')}`);
    this.name = 'ConfigError';
    this.fields = Object.freeze(safeFields);
  }
}

function integerSetting(defaultValue: number, maximum: number, minimum = 1) {
  return z
    .string()
    .regex(/^(?:0|[1-9]\d*)$/u)
    .default(String(defaultValue))
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));
}

function parseUrl(value: string): URL | undefined {
  if (value.length > 4096 || /\s/u.test(value)) {
    return undefined;
  }

  try {
    const url = new URL(value);
    // Decode once here so malformed percent escapes cannot reach a driver.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    decodeURIComponent(url.pathname);
    if (!url.hostname || url.hash || (url.port !== '' && Number(url.port) < 1)) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

const databaseUrl = z.string().refine((value) => {
  const url = parseUrl(value);
  return (
    url !== undefined &&
    (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
    url.pathname.length > 1 &&
    !url.pathname.slice(1).includes('/')
  );
});

const redisUrl = z.string().refine((value) => {
  const url = parseUrl(value);
  return (
    url !== undefined &&
    (url.protocol === 'redis:' || url.protocol === 'rediss:') &&
    /^\/(?:0|[1-9]\d*)?$/u.test(url.pathname || '/') &&
    url.search === ''
  );
});

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  HOST: z
    .string()
    .min(1)
    .max(253)
    .refine(
      (value) =>
        isIP(value) !== 0 ||
        value.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu.test(label)),
    )
    .default('127.0.0.1'),
  PORT: integerSetting(3000, 65_535),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  DEPENDENCY_TIMEOUT_MS: integerSetting(1000, 1000),
  HEALTH_CACHE_MS: integerSetting(1000, 5000, 0),
  SHUTDOWN_TIMEOUT_MS: integerSetting(10_000, 10_000),
  BODY_LIMIT_BYTES: integerSetting(16_384, 1_048_576),
  REQUEST_TIMEOUT_MS: integerSetting(10_000, 120_000),
  CONNECTION_TIMEOUT_MS: integerSetting(5000, 30_000),
  POSTGRES_POOL_MAX: integerSetting(5, 20),
  NODE_TLS_REJECT_UNAUTHORIZED: z.enum(['0', '1']).optional(),
  PGSSLMODE: z
    .enum(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'])
    .optional(),
});

export interface AppConfig {
  readonly environment: z.infer<typeof schema>['NODE_ENV'];
  readonly host: string;
  readonly port: number;
  readonly logLevel: z.infer<typeof schema>['LOG_LEVEL'];
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly dependencyTimeoutMs: number;
  readonly healthCacheMs: number;
  readonly shutdownTimeoutMs: number;
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly postgresPoolMax: number;
}

function hasDeploymentPassword(url: URL): boolean {
  const password = decodeURIComponent(url.password);
  const username = decodeURIComponent(url.username);
  return (
    password.length >= 16 &&
    password.trim() === password &&
    password.toLowerCase() !== username.toLowerCase() &&
    !/(?:password|change[-_ ]?me|replace[-_ ]?me|example|development|local[-_ ]only|dev[-_ ]only)/iu.test(
      password,
    )
  );
}

/** The caller provides environment input explicitly; this module never reads process.env. */
export function loadConfig(raw: Readonly<Record<string, string | undefined>>): AppConfig {
  const input: Partial<Record<ConfigField, unknown>> = {};
  for (const field of fields) {
    try {
      // Inherited properties and accessors are not environment values.
      const descriptor = Object.getOwnPropertyDescriptor(raw, field);
      if (descriptor !== undefined && !('value' in descriptor)) {
        throw new ConfigError([field]);
      }
      input[field] = descriptor?.value as unknown;
    } catch {
      throw new ConfigError([field]);
    }
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    const invalid = fields.filter((field) =>
      result.error.issues.some((issue) => issue.path[0] === field),
    );
    throw new ConfigError(invalid);
  }

  const value = result.data;
  if (value.NODE_ENV === 'production' || value.NODE_ENV === 'staging') {
    const postgres = new URL(value.DATABASE_URL);
    const redis = new URL(value.REDIS_URL);
    const invalid: ConfigField[] = [];

    if (
      !postgres.username ||
      !hasDeploymentPassword(postgres) ||
      postgres.searchParams.getAll('sslmode').length !== 1 ||
      postgres.searchParams.get('sslmode') !== 'verify-full' ||
      [...postgres.searchParams.keys()].some(
        (key) => key !== 'sslmode' && key !== 'application_name',
      )
    ) {
      invalid.push('DATABASE_URL');
    }
    if (redis.protocol !== 'rediss:' || !hasDeploymentPassword(redis)) {
      invalid.push('REDIS_URL');
    }
    if (value.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      invalid.push('NODE_TLS_REJECT_UNAUTHORIZED');
    }
    if (value.PGSSLMODE !== undefined && value.PGSSLMODE !== 'verify-full') {
      invalid.push('PGSSLMODE');
    }
    if (invalid.length !== 0) {
      throw new ConfigError(invalid);
    }
  }

  return Object.freeze({
    environment: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    redisUrl: value.REDIS_URL,
    dependencyTimeoutMs: value.DEPENDENCY_TIMEOUT_MS,
    healthCacheMs: value.HEALTH_CACHE_MS,
    shutdownTimeoutMs: value.SHUTDOWN_TIMEOUT_MS,
    bodyLimitBytes: value.BODY_LIMIT_BYTES,
    requestTimeoutMs: value.REQUEST_TIMEOUT_MS,
    connectionTimeoutMs: value.CONNECTION_TIMEOUT_MS,
    postgresPoolMax: value.POSTGRES_POOL_MAX,
  });
}
