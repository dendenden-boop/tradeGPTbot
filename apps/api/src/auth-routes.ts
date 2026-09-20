import { randomBytes } from 'node:crypto';
import { AuthError, isOpaqueToken, type AuthService } from '@ctp/auth';
import type { AuthConfig } from '@ctp/config';
import type { AuthPrincipal } from '@ctp/database';
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface AuthRoutesOptions {
  service: AuthService;
  config: AuthConfig;
  readUser(principal: AuthPrincipal): Promise<{
    id: string;
    emailNormalized: string | null;
    status: string;
    role: string;
    emailVerifiedAt: Date | null;
  }>;
}

const emptyObject = { type: 'object', additionalProperties: false, properties: {} } as const;
const string = { type: 'string' } as const;
const email = { type: 'string', minLength: 3, maxLength: 256 } as const;
const password = { type: 'string', minLength: 15, maxLength: 128 } as const;
const token = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } as const;

function body(properties: Record<string, object>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function schema(properties?: Record<string, object>) {
  return {
    querystring: emptyObject,
    ...(properties === undefined ? {} : { body: body(properties) }),
  };
}

const messages: Record<string, string> = {
  BAD_REQUEST: 'Invalid request',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Request forbidden',
  NOT_FOUND: 'Resource not found',
  RATE_LIMITED: 'Too many requests',
  SERVICE_UNAVAILABLE: 'Service unavailable',
};

/** Register inside an encapsulated plugin so the auth error handler stays local. */
export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const { config, service } = options;
  const prefix = config.cookieSecure ? '__Host-ctp-' : 'ctp-dev-';
  const sessionName = `${prefix}session`;
  const preauthName = `${prefix}preauth`;
  const csrfName = `${prefix}csrf`;
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax' as const,
  };

  await app.register(cookie, { secret: config.csrfSecret, hook: 'onRequest' });

  function session(request: FastifyRequest, required = true): string | undefined {
    const value = request.cookies[sessionName];
    if (value === undefined && !required) return undefined;
    if (!isOpaqueToken(value)) throw new AuthError('UNAUTHENTICATED');
    return value;
  }

  function binding(request: FastifyRequest): string {
    const current = session(request, false);
    if (current !== undefined) return `session:${current}`;
    const unsigned = request.unsignCookie(request.cookies[preauthName] ?? '');
    if (!unsigned.valid || !isOpaqueToken(unsigned.value)) throw new AuthError('FORBIDDEN');
    return `preauth:${unsigned.value}`;
  }

  await app.register(csrf, {
    cookieKey: csrfName,
    cookieOpts: { ...cookieOptions, signed: true, maxAge: 43_200 },
    csrfOpts: { userInfo: true, hmacKey: config.csrfSecret },
    getUserInfo: binding,
    getToken(request) {
      const value = request.headers['x-csrf-token'];
      return typeof value === 'string' && value.length <= 512 ? value : undefined;
    },
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError) {
      if (error.code === 'RATE_LIMITED') reply.header('retry-after', '60');
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: messages[error.code], requestId: request.id },
      });
    }
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'FST_CSRF_MISSING_SECRET' || code === 'FST_CSRF_INVALID_TOKEN') {
      return reply.code(403).send({
        error: { code: 'FORBIDDEN', message: messages['FORBIDDEN'], requestId: request.id },
      });
    }
    // Delegate parser/validation/unexpected errors to the parent's sanitized handler.
    throw error;
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const counts = new Map<string, number>();
    for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
      const name = request.raw.rawHeaders[index]?.toLowerCase();
      if (name === 'origin' || name === 'x-csrf-token')
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count > 1)) throw new AuthError('BAD_REQUEST');
    const rawCookie = request.headers.cookie;
    if (rawCookie !== undefined) {
      if (rawCookie.length > 4096) throw new AuthError('BAD_REQUEST');
      const names = new Set<string>();
      for (const item of rawCookie.split(';')) {
        const name = item.slice(0, item.indexOf('=')).trim();
        if ([sessionName, csrfName, preauthName].includes(name)) {
          if (names.has(name)) throw new AuthError('BAD_REQUEST');
          names.add(name);
        }
      }
    }
    if (request.cookies[sessionName] !== undefined && !isOpaqueToken(request.cookies[sessionName]))
      throw new AuthError('UNAUTHENTICATED');
    const mutation = request.method !== 'GET' && request.method !== 'HEAD';
    const origin = request.headers.origin;
    if (
      (mutation && origin !== config.origin) ||
      (origin !== undefined && origin !== config.origin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      throw new AuthError('FORBIDDEN');
    // Routes without an input object must not silently accept ignored data.
    if (
      request.routeOptions.schema?.body === undefined &&
      (Number(request.headers['content-length'] ?? '0') > 0 ||
        request.headers['transfer-encoding'] !== undefined)
    )
      throw new AuthError('BAD_REQUEST');
  });
  app.addHook('onRequest', (request, reply, done) => {
    if (request.method === 'GET' || request.method === 'HEAD') return done();
    app.csrfProtection(request, reply, done);
  });

  function freshCsrf(request: FastifyRequest, reply: FastifyReply, current?: string): string {
    // Authentication transitions invalidate the old secret and its old identity binding.
    delete request.cookies[csrfName];
    if (current !== undefined) return reply.generateCsrf({ userInfo: `session:${current}` });
    const preauth = randomBytes(32).toString('base64url');
    reply.setCookie(preauthName, preauth, { ...cookieOptions, signed: true, maxAge: 1800 });
    return reply.generateCsrf({ userInfo: `preauth:${preauth}` });
  }

  function clearSession(request: FastifyRequest, reply: FastifyReply) {
    reply.clearCookie(sessionName, cookieOptions);
    return { status: 'ok', csrfToken: freshCsrf(request, reply) };
  }

  function sessionResponse(
    request: FastifyRequest,
    reply: FastifyReply,
    result: { token: string; principal: AuthPrincipal },
  ) {
    reply.setCookie(sessionName, result.token, {
      ...cookieOptions,
      expires: result.principal.expiresAt,
    });
    reply.clearCookie(preauthName, cookieOptions);
    return {
      status: 'authenticated',
      csrfToken: freshCsrf(request, reply, result.token),
      session: {
        id: result.principal.sessionId,
        expiresAt: result.principal.expiresAt.toISOString(),
        idleExpiresAt: result.principal.idleExpiresAt.toISOString(),
      },
    };
  }

  app.get('/api/v1/auth/csrf', { schema: schema() }, async (request, reply) => {
    await service.csrf({ ip: request.ip });
    let userInfo: string;
    try {
      userInfo = binding(request);
    } catch (error) {
      if (!(error instanceof AuthError) || error.code !== 'FORBIDDEN') throw error;
      return { csrfToken: freshCsrf(request, reply) };
    }
    return { csrfToken: reply.generateCsrf({ userInfo }) };
  });
  app.post<{ Body: { email: string; password: string } }>(
    '/api/v1/auth/signup',
    { schema: schema({ email, password }) },
    async (request, reply) => {
      await service.signup({ ip: request.ip }, request.body.email, request.body.password);
      return reply.code(202).send({ status: 'accepted' });
    },
  );
  app.post<{ Body: { email: string } }>(
    '/api/v1/auth/resend-verification',
    { schema: schema({ email }) },
    async (request, reply) => {
      await service.resendVerification({ ip: request.ip }, request.body.email);
      return reply.code(202).send({ status: 'accepted' });
    },
  );
  app.post<{ Body: { token: string } }>(
    '/api/v1/auth/verify-email',
    { schema: schema({ token }) },
    async (request) => {
      await service.verifyEmail({ ip: request.ip }, request.body.token);
      return { status: 'ok' };
    },
  );
  app.post<{ Body: { email: string; password: string } }>(
    '/api/v1/auth/login',
    { schema: schema({ email, password }) },
    async (request, reply) => {
      return sessionResponse(
        request,
        reply,
        await service.login(
          { ip: request.ip },
          request.body.email,
          request.body.password,
          session(request, false),
        ),
      );
    },
  );
  app.post('/api/v1/auth/logout', { schema: schema() }, async (request, reply) => {
    await service.logout({ ip: request.ip }, session(request, false));
    return clearSession(request, reply);
  });
  app.post<{ Body: { email: string } }>(
    '/api/v1/auth/forgot-password',
    { schema: schema({ email }) },
    async (request, reply) => {
      await service.forgotPassword({ ip: request.ip }, request.body.email);
      return reply.code(202).send({ status: 'accepted' });
    },
  );
  app.post<{ Body: { token: string; password: string } }>(
    '/api/v1/auth/reset-password',
    { schema: schema({ token, password }) },
    async (request, reply) => {
      await service.resetPassword({ ip: request.ip }, request.body.token, request.body.password);
      return clearSession(request, reply);
    },
  );
  app.post<{ Body: { oldPassword: string; password: string } }>(
    '/api/v1/auth/change-password',
    { schema: schema({ oldPassword: password, password }) },
    async (request, reply) => {
      await service.changePassword(
        { ip: request.ip },
        session(request)!,
        request.body.oldPassword,
        request.body.password,
      );
      return clearSession(request, reply);
    },
  );
  app.get('/api/v1/auth/sessions', { schema: schema() }, async (request) => {
    const sessions = await service.listSessions({ ip: request.ip }, session(request)!);
    return {
      sessions: sessions.map((item) => ({
        id: item.sessionId,
        createdAt: item.createdAt.toISOString(),
        lastSeenAt: item.lastSeenAt.toISOString(),
        idleExpiresAt: item.idleExpiresAt.toISOString(),
        expiresAt: item.expiresAt.toISOString(),
      })),
    };
  });
  app.post('/api/v1/auth/session/rotate', { schema: schema() }, async (request, reply) => {
    return sessionResponse(
      request,
      reply,
      await service.rotateSession({ ip: request.ip }, session(request)!),
    );
  });
  app.delete<{ Params: { id: string } }>(
    '/api/v1/auth/sessions/:id',
    {
      schema: {
        ...schema(),
        params: body({
          id: {
            ...string,
            pattern:
              '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
          },
        }),
      },
    },
    async (request) => {
      await service.revokeSession({ ip: request.ip }, session(request)!, request.params.id);
      return { status: 'ok' };
    },
  );
  app.post('/api/v1/auth/logout-all', { schema: schema() }, async (request, reply) => {
    await service.revokeAllSessions({ ip: request.ip }, session(request)!);
    return clearSession(request, reply);
  });
  app.get('/api/v1/users/me', { schema: schema() }, async (request) => {
    const principal = await service.authenticate({ ip: request.ip }, session(request)!);
    const user = await options.readUser(principal);
    if (
      user.id !== principal.userId ||
      user.status !== 'ACTIVE' ||
      user.role !== 'USER' ||
      user.emailVerifiedAt === null ||
      user.emailNormalized === null
    )
      throw new AuthError('UNAUTHENTICATED');
    return {
      user: {
        id: user.id,
        email: user.emailNormalized,
        status: user.status,
        role: user.role,
        emailVerifiedAt: user.emailVerifiedAt.toISOString(),
      },
    };
  });
}
