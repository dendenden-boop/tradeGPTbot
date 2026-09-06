import { describe, expect, it } from 'vitest';

import { createLogger, safeError } from '../src/index.js';

function capture(level: 'trace' | 'info' | 'warn' | 'silent' = 'trace') {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger(
      { environment: 'test', level },
      {
        write(line) {
          lines.push(line);
        },
      },
    ),
  };
}

describe('safeError', () => {
  it('preserves useful allowlisted classification while dropping nested errors', () => {
    const secret = 'CANARY_NESTED_EXCEPTION_SECRET';
    const error = Object.assign(new TypeError(secret, { cause: new Error(secret) }), {
      code: 'ECONNREFUSED',
      headers: { Authorization: secret },
      body: { credentials: secret },
      url: `postgres://user:${secret}@db/database`,
    });
    expect(safeError(error)).toEqual({ type: 'TypeError', code: 'ECONNREFUSED' });
    expect(JSON.stringify(safeError(error))).not.toContain(secret);
    expect(Object.isFrozen(safeError(error))).toBe(true);
  });

  it.each([
    undefined,
    null,
    'CANARY_THROWN_STRING',
    42,
    false,
    { name: 'CANARY_NAME', code: 'CANARY_CODE' },
  ])('classifies unknown thrown values without copying input', (error) => {
    expect(safeError(error)).toEqual({ type: 'Error', code: 'UNKNOWN_ERROR' });
  });

  it('survives throwing property accessors and does not serialize prototypes', () => {
    const error: unknown = Object.create({
      toJSON() {
        throw new Error('CANARY_PROTOTYPE_SECRET');
      },
      get name() {
        throw new Error('CANARY_GETTER_SECRET');
      },
      get code() {
        throw new Error('CANARY_GETTER_SECRET');
      },
    });
    expect(safeError(error)).toEqual({ type: 'Error', code: 'UNKNOWN_ERROR' });
  });
});

describe('createLogger', () => {
  it('omits arbitrary raw URL paths when no registered route template exists', () => {
    const { logger, lines } = capture();
    logger.info(
      { req: { method: 'GET', url: '/CANARY_PATH_SECRET?password=CANARY_QUERY_SECRET' } },
      'request_completed',
    );
    expect(lines.join('')).not.toContain('CANARY_');
    expect(JSON.parse(lines.join('')) as unknown).toMatchObject({ req: { method: 'GET' } });
  });
  it('writes structured logs with stable service and request child context', () => {
    const { logger, lines } = capture();
    logger
      .child({ requestId: '025c6726-b69a-4e4c-a23b-dc5730693b5b' })
      .info({ statusCode: 200 }, 'request_completed');
    expect(lines).toHaveLength(1);
    const output: unknown = JSON.parse(lines.join(''));
    expect(output).toMatchObject({
      level: 30,
      service: 'api',
      environment: 'test',
      requestId: '025c6726-b69a-4e4c-a23b-dc5730693b5b',
      statusCode: 200,
      msg: 'request_completed',
    });
    expect(output).not.toHaveProperty('hostname');
    expect(output).not.toHaveProperty('pid');
  });

  it('applies severity filtering including silent', () => {
    const { logger, lines } = capture('warn');
    logger.info('filtered');
    logger.warn('visible');
    expect(lines).toHaveLength(1);
    expect(lines.join('')).toContain('visible');
    const silent = capture('silent');
    silent.logger.fatal('filtered');
    expect(silent.lines).toHaveLength(0);
  });

  it('strips request query, authority, headers and bodies and reduces responses', () => {
    const { logger, lines } = capture();
    const secret = 'CANARY_HTTP_SECRET_e21f';
    logger.info(
      {
        req: {
          method: 'GET',
          routeOptions: { url: '/health/live' },
          url: `http://user:${secret}@example.invalid/health/live?token=${secret}#${secret}`,
          headers: { Authorization: `Bearer ${secret}`, cookie: secret },
          body: { nested: { secret } },
          raw: { headers: { cookie: secret } },
        },
        res: { statusCode: 200, headers: { 'set-cookie': secret }, body: secret },
      },
      'request_completed',
    );
    expect(lines.join('')).not.toContain(secret);
    const output: unknown = JSON.parse(lines.join(''));
    expect(output).toMatchObject({
      req: { method: 'GET', path: '/health/live' },
      res: { statusCode: 200 },
    });
    expect(output).not.toHaveProperty('req.url');
    expect(output).not.toHaveProperty('req.headers');
    expect(output).not.toHaveProperty('res.body');
  });

  it('serializes errors safely in development and production', () => {
    const secret = 'CANARY_ERROR_SECRET_c072';
    for (const environment of ['development', 'production'] as const) {
      const lines: string[] = [];
      const logger = createLogger(
        { level: 'info', environment },
        { write: (line) => lines.push(line) },
      );
      const err = Object.assign(new Error(secret, { cause: new Error(secret) }), {
        code: 'ETIMEDOUT',
        body: { secret },
        stack: secret,
      });
      logger.error({ err, error: err }, 'dependency_failed');
      expect(lines.join('')).not.toContain(secret);
      const output: unknown = JSON.parse(lines.join(''));
      expect(output).toMatchObject({
        err: { type: 'Error', code: 'ETIMEDOUT' },
        error: { type: 'Error', code: 'ETIMEDOUT' },
      });
    }
  });

  it('redacts accidental known credential fields without changing caller objects', () => {
    const { logger, lines } = capture();
    const secret = 'CANARY_CREDENTIAL_SECRET_f91a';
    const event = {
      databaseUrl: `postgres://user:${secret}@localhost/database`,
      redisUrl: `redis://:${secret}@localhost/0`,
      authorization: secret,
      credentials: { secret },
      metadata: { nested: { apiKey: secret, headers: { Cookie: secret } } },
    };
    logger.warn(event, 'accidental_secret_fields');
    expect(lines.join('')).not.toContain(secret);
    expect(event.metadata.nested.apiKey).toBe(secret);
    expect(event.authorization).toBe(secret);
  });

  it('does not copy unrelated prototype properties into request/error logs', () => {
    const { logger, lines } = capture();
    const req: unknown = Object.assign(
      Object.create({ password: 'CANARY_PROTOTYPE_SECRET' }) as object,
      {
        method: 'GET',
        routeOptions: { url: '/health/ready' },
        url: '/health/ready?token=CANARY_PROTOTYPE_SECRET',
      },
    );
    logger.info({ req }, 'request_completed');
    expect(lines.join('')).not.toContain('CANARY_PROTOTYPE_SECRET');
    expect(JSON.parse(lines.join('')) as unknown).toMatchObject({
      req: { method: 'GET', path: '/health/ready' },
    });
  });
});
