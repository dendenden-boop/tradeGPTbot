import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@ctp/config';
import fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
  type RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';
import type { DependencyHealth, HealthService } from './health.js';

interface ApplicationState {
  started: boolean;
  draining: boolean;
}

const states = new WeakMap<FastifyInstance, ApplicationState>();
const requestIdPattern = /^[a-zA-Z0-9-]{1,64}$/;

const readinessSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'dependencies'],
  properties: {
    status: { type: 'string', enum: ['ready', 'not_ready'] },
    dependencies: {
      type: 'object',
      additionalProperties: false,
      required: ['postgres', 'redis'],
      properties: {
        postgres: { type: 'string', enum: ['up', 'down'] },
        redis: { type: 'string', enum: ['up', 'down'] },
      },
    },
  },
} as const;

function unavailable(): DependencyHealth {
  return {
    status: 'not_ready',
    dependencies: { postgres: 'down', redis: 'down' },
  };
}

function errorEnvelope(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } };
}

function responseHeaders(requestId: string): Record<string, string> {
  return {
    'x-request-id': requestId,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'cache-control': 'no-store',
  };
}

/** Mark readiness unavailable before closing the listening socket. */
export function beginDrain(app: FastifyInstance): void {
  const state = states.get(app);
  if (state) state.draining = true;
}

export interface BuildAppOptions {
  config: AppConfig;
  logger: Logger;
  health: HealthService;
}

export function buildApp({ config, logger, health }: BuildAppOptions): FastifyInstance {
  const state: ApplicationState = { started: false, draining: false };
  const app = fastify<RawServerDefault>({
    loggerInstance: logger,
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    requestIdHeader: false,
    genReqId(request) {
      const candidate = request.headers['x-request-id'];
      return typeof candidate === 'string' && requestIdPattern.test(candidate)
        ? candidate
        : randomUUID();
    },
    frameworkErrors(error, request: FastifyRequest, reply: FastifyReply) {
      // Router failures occur before normal hooks and may otherwise echo the URL.
      const badRequest =
        error.code === 'FST_ERR_BAD_URL' || error.code === 'FST_ERR_MAX_PARAM_LENGTH';
      const started = performance.now();
      reply.headers(responseHeaders(request.id));
      reply.raw.once('finish', () => {
        request.log.info(
          {
            event: 'http_request_completed',
            requestId: request.id,
            method: request.method,
            route: 'unmatched',
            statusCode: reply.statusCode,
            durationMs: Math.round((performance.now() - started) * 100) / 100,
          },
          'HTTP request completed',
        );
      });
      void reply
        .code(badRequest ? 400 : 500)
        .send(
          errorEnvelope(
            badRequest ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
            badRequest ? 'Invalid request' : 'Internal server error',
            request.id,
          ),
        );
    },
    bodyLimit: config.bodyLimitBytes,
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.connectionTimeoutMs,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 1_000,
    forceCloseConnections: 'idle',
    // Our onRequest gate preserves the common error envelope during draining.
    return503OnClosing: false,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    trustProxy: false,
    exposeHeadRoutes: false,
    http: { maxHeaderSize: 16_384 },
  });
  states.set(app, state);

  app.addHook('onReady', (done) => {
    state.started = true;
    done();
  });
  app.addHook('preClose', (done) => {
    beginDrain(app);
    done();
  });
  app.addHook('onClose', async () => {
    await health.close();
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.headers(responseHeaders(request.id));
    if (state.draining && request.routeOptions.url !== '/health/live') {
      if (request.routeOptions.url === '/health/ready') {
        return reply.code(503).send(unavailable());
      }
      return reply
        .code(503)
        .send(errorEnvelope('SERVICE_UNAVAILABLE', 'Service is shutting down', request.id));
    }
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    // A request that began before close() must not become a new idle keep-alive socket.
    if (state.draining) {
      reply.raw.shouldKeepAlive = false;
      reply.header('connection', 'close');
    }
    done(null, payload);
  });

  app.addHook('onResponse', async (request, reply) => {
    // Only route templates are recorded: an unmatched URL can contain credentials.
    request.log.info(
      {
        event: 'http_request_completed',
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 100) / 100,
      },
      'HTTP request completed',
    );
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(errorEnvelope('NOT_FOUND', 'Route not found', request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply
        .code(413)
        .send(errorEnvelope('PAYLOAD_TOO_LARGE', 'Request body is too large', request.id));
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply
        .code(415)
        .send(errorEnvelope('UNSUPPORTED_MEDIA_TYPE', 'Unsupported content type', request.id));
    }
    if (
      code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' ||
      code === 'FST_ERR_BAD_URL' ||
      code === 'FST_ERR_VALIDATION'
    ) {
      return reply.code(400).send(errorEnvelope('BAD_REQUEST', 'Invalid request', request.id));
    }
    if (code === 'FST_ERR_HANDLER_TIMEOUT') {
      return reply
        .code(503)
        .send(errorEnvelope('SERVICE_UNAVAILABLE', 'Request deadline exceeded', request.id));
    }
    return reply
      .code(500)
      .send(errorEnvelope('INTERNAL_ERROR', 'Internal server error', request.id));
  });

  app.get(
    '/health/live',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: { status: { type: 'string', const: 'ok' } },
          },
        },
      },
    },
    (_request, reply) => reply.send({ status: 'ok' }),
  );

  app.get(
    '/health/ready',
    { schema: { response: { 200: readinessSchema, 503: readinessSchema } } },
    async (_request, reply) => {
      if (!state.started || state.draining) return reply.code(503).send(unavailable());
      let result: DependencyHealth;
      try {
        result = await health.check();
      } catch {
        result = unavailable();
      }
      if (state.draining) result = unavailable();
      return reply.code(result.status === 'ready' ? 200 : 503).send(result);
    },
  );

  return app;
}
