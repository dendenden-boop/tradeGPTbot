import type { AppConfig } from '@ctp/config';
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
  'AggregateError',
  'ConfigError',
  'LifecycleError',
]);

const errorCodes = new Set([
  'EADDRINUSE',
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR',
  'ERR_SERVER_NOT_RUNNING',
  'ERR_STREAM_DESTROYED',
  'FST_ERR_CTP_INVALID_JSON_BODY',
  'FST_ERR_CTP_EMPTY_JSON_BODY',
  'FST_ERR_CTP_BODY_TOO_LARGE',
  'FST_ERR_VALIDATION',
  'CONFIG_INVALID',
  'STARTUP_FAILED',
  'SHUTDOWN_TIMEOUT',
  'SHUTDOWN_FAILED',
  'UNKNOWN_ERROR',
]);

function readProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  try {
    return Reflect.get(value, key) as unknown;
  } catch {
    return undefined;
  }
}

/** Error text, stack, nested causes and arbitrary codes are never telemetry fields. */
export function safeError(error: unknown): Readonly<{ type: string; code: string }> {
  const name = readProperty(error, 'name') ?? readProperty(error, 'type');
  const code = readProperty(error, 'code');
  return Object.freeze({
    type: typeof name === 'string' && errorTypes.has(name) ? name : 'Error',
    code:
      name === 'ConfigError'
        ? 'CONFIG_INVALID'
        : typeof code === 'string' && errorCodes.has(code)
          ? code
          : 'UNKNOWN_ERROR',
  });
}

function serializeRequest(request: unknown): Record<string, unknown> {
  const raw = readProperty(request, 'raw');
  const method = readProperty(request, 'method') ?? readProperty(raw, 'method');
  // Only the server's registered route template is eligible, never the incoming URL.
  const path = readProperty(readProperty(request, 'routeOptions'), 'url');
  const result: Record<string, unknown> = {};
  if (
    typeof method === 'string' &&
    /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)$/u.test(method)
  ) {
    result['method'] = method;
  }
  if (typeof path === 'string' && path.length <= 1024 && /^\/[a-zA-Z0-9/:*_.-]*$/u.test(path)) {
    result['path'] = path;
  }
  return result;
}

function serializeResponse(response: unknown): Record<string, unknown> {
  const status = readProperty(response, 'statusCode');
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? { statusCode: status }
    : {};
}

const sensitiveFields = [
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'set-cookie',
  'headers',
  'rawHeaders',
  'body',
  'password',
  'passphrase',
  'secret',
  'apiKey',
  'apiSecret',
  'accessToken',
  'refreshToken',
  'token',
  'credentials',
  'databaseUrl',
  'redisUrl',
  'DATABASE_URL',
  'REDIS_URL',
  'config',
];

/** Call sites supply static messages and allowlisted event fields, never raw payloads. */
export function createLogger(
  options: { level: AppConfig['logLevel']; environment: AppConfig['environment'] },
  destination?: DestinationStream,
): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level,
    base: { service: 'api', environment: options.environment },
    serializers: {
      err: safeError,
      error: safeError,
      req: serializeRequest,
      request: serializeRequest,
      res: serializeResponse,
      response: serializeResponse,
    },
    redact: {
      paths: sensitiveFields.flatMap((field) => [
        `["${field}"]`,
        `*["${field}"]`,
        `*.*["${field}"]`,
        `*.*.*["${field}"]`,
      ]),
      censor: '[REDACTED]',
    },
  };

  return destination === undefined ? pino(loggerOptions) : pino(loggerOptions, destination);
}
