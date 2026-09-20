export class DatabaseError extends Error {
  constructor(readonly code: string) {
    super('Database operation failed');
    this.name = 'DatabaseError';
  }
}

export type DatabaseOptions = {
  connectionString: string;
  environment: 'development' | 'test' | 'staging' | 'production';
};

export function validateDatabaseOptions(options: DatabaseOptions): void {
  if (!['development', 'test', 'staging', 'production'].includes(options.environment)) {
    throw new DatabaseError('DATABASE_ENVIRONMENT_INVALID');
  }
  let url: URL;
  try {
    if (
      options.connectionString.length > 4096 ||
      /\s/u.test(options.connectionString) ||
      [...options.connectionString].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      throw new Error();
    url = new URL(options.connectionString);
    for (const part of [url.username, url.password, url.pathname]) {
      if (
        [...decodeURIComponent(part)].some(
          (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
        )
      )
        throw new Error();
    }
  } catch {
    throw new DatabaseError('DATABASE_URL_INVALID');
  }
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (
      seen.has(key) ||
      !['sslmode', 'application_name'].includes(key) ||
      value.length > 64 ||
      /^[a-zA-Z0-9_-]+$/u.exec(value)?.[0] !== value
    ) {
      throw new DatabaseError('DATABASE_URL_INVALID');
    }
    seen.add(key);
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hash ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    !url.pathname.slice(1) ||
    url.pathname.slice(1).includes('/') ||
    (url.port !== '' && Number(url.port) < 1)
  ) {
    throw new DatabaseError('DATABASE_URL_INVALID');
  }
  if (
    ['staging', 'production'].includes(options.environment) &&
    (url.searchParams.get('sslmode') !== 'verify-full' ||
      decodeURIComponent(url.password).length < 16 ||
      decodeURIComponent(url.password).toLowerCase() ===
        decodeURIComponent(url.username).toLowerCase() ||
      /(?:password|change[-_ ]?me|replace[-_ ]?me|example|development|local[-_ ]only|dev[-_ ]only)/iu.test(
        decodeURIComponent(url.password),
      ) ||
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0')
  ) {
    throw new DatabaseError('DATABASE_TLS_REQUIRED');
  }
}
