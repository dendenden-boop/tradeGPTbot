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
  'DATABASE_AUTH_URL',
  'AUTH_ORIGIN',
  'AUTH_CSRF_SECRET',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_REQUIRE_TLS',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM',
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
  if (
    value.length > 4096 ||
    /\s/u.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return undefined;
  }

  try {
    const url = new URL(value);
    // Match the database package boundary: neither malformed escapes nor decoded
    // control/whitespace characters may reach a driver with different URL parsing.
    for (const part of [url.username, url.password, url.pathname]) {
      if (
        [...decodeURIComponent(part)].some(
          (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
        )
      ) {
        return undefined;
      }
    }
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
  if (url === undefined) return false;
  const seen = new Set<string>();
  for (const [key, parameter] of url.searchParams) {
    if (
      seen.has(key) ||
      !['sslmode', 'application_name'].includes(key) ||
      parameter.length > 64 ||
      /^[a-zA-Z0-9_-]+$/u.exec(parameter)?.[0] !== parameter
    )
      return false;
    seen.add(key);
  }
  return (
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

export interface AuthConfig {
  readonly databaseAuthUrl: string;
  readonly origin: string;
  readonly cookieSecure: boolean;
  readonly csrfSecret: string;
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly requireTls: boolean;
    readonly user?: string;
    readonly password?: string;
    readonly from: string;
  };
}

const booleanSetting = z.enum(['true', 'false']).transform((value) => value === 'true');
const headerSafe = (value: string): boolean =>
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const authFields = fields.slice(fields.indexOf('DATABASE_AUTH_URL'));
const authSchema = z.object({
  DATABASE_AUTH_URL: databaseUrl,
  AUTH_ORIGIN: z.string().max(2048),
  AUTH_CSRF_SECRET: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .refine((value) => new Set(value).size >= 8),
  SMTP_HOST: z
    .string()
    .min(1)
    .max(253)
    .refine(
      (value) =>
        isIP(value) !== 0 ||
        value.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu.test(label)),
    ),
  SMTP_PORT: integerSetting(587, 65_535),
  SMTP_SECURE: booleanSetting.default(false),
  SMTP_REQUIRE_TLS: booleanSetting.default(true),
  SMTP_USER: z.string().min(1).max(320).refine(headerSafe).optional(),
  SMTP_PASSWORD: z.string().min(1).max(1024).refine(headerSafe).optional(),
  SMTP_FROM: z
    .string()
    .max(254)
    .regex(/^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d.-]*[a-z\d])?$/iu),
});

/** Required by the real server; health-only unit fixtures use loadConfig separately. */
export function loadAuthConfig(
  raw: Readonly<Record<string, string | undefined>>,
  app: AppConfig,
): AuthConfig {
  const input: Partial<Record<ConfigField, unknown>> = {};
  for (const field of authFields) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(raw, field);
      if (descriptor !== undefined && !('value' in descriptor)) throw new ConfigError([field]);
      input[field] = descriptor?.value as unknown;
    } catch {
      throw new ConfigError([field]);
    }
  }
  const parsed = authSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(
      authFields.filter((field) => parsed.error.issues.some((issue) => issue.path[0] === field)),
    );
  }
  const value = parsed.data;
  const deployed = app.environment === 'production' || app.environment === 'staging';
  const invalid: ConfigField[] = [];
  const origin = parseUrl(value.AUTH_ORIGIN);
  const loopback =
    origin !== undefined && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    origin === undefined ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.pathname !== '/' ||
    value.AUTH_ORIGIN !== origin.origin ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback && !deployed))
  ) {
    invalid.push('AUTH_ORIGIN');
  }
  const database = new URL(value.DATABASE_AUTH_URL);
  const runtime = new URL(app.databaseUrl);
  if (
    !database.username ||
    !database.password ||
    database.username === runtime.username ||
    database.host !== runtime.host ||
    database.pathname !== runtime.pathname ||
    (deployed &&
      (!hasDeploymentPassword(database) || database.searchParams.get('sslmode') !== 'verify-full'))
  ) {
    invalid.push('DATABASE_AUTH_URL');
  }
  if ((value.SMTP_USER === undefined) !== (value.SMTP_PASSWORD === undefined)) {
    invalid.push('SMTP_USER', 'SMTP_PASSWORD');
  }
  if (deployed && !value.SMTP_SECURE && !value.SMTP_REQUIRE_TLS) {
    invalid.push('SMTP_REQUIRE_TLS');
  }
  if (invalid.length > 0) throw new ConfigError(invalid);
  return Object.freeze({
    databaseAuthUrl: value.DATABASE_AUTH_URL,
    origin: value.AUTH_ORIGIN,
    cookieSecure: origin?.protocol === 'https:',
    csrfSecret: value.AUTH_CSRF_SECRET,
    smtp: Object.freeze({
      host: value.SMTP_HOST,
      port: value.SMTP_PORT,
      secure: value.SMTP_SECURE,
      requireTls: value.SMTP_REQUIRE_TLS,
      ...(value.SMTP_USER === undefined ? {} : { user: value.SMTP_USER }),
      ...(value.SMTP_PASSWORD === undefined ? {} : { password: value.SMTP_PASSWORD }),
      from: value.SMTP_FROM,
    }),
  });
}
