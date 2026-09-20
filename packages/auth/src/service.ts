import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { AuthPrincipal, AuthRepository, SessionSummary } from '@ctp/database';
import type { AuthMailer } from './mail.js';
import type { PasswordHasher } from './password.js';
import type { AuthLimiter } from './rate-limit.js';

export type AuthErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE';

const statuses: Record<AuthErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};

/** Deliberately contains no account, credential, token, or backend error details. */
export class AuthError extends Error {
  readonly statusCode: number;

  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.name = 'AuthError';
    this.statusCode = statuses[code];
  }
}

export interface AuthContext {
  ip: string;
}

export interface AuthSession {
  token: string;
  principal: AuthPrincipal;
}

export interface AuthService {
  csrf(context: AuthContext): Promise<void>;
  signup(context: AuthContext, email: string, password: string): Promise<void>;
  resendVerification(context: AuthContext, email: string): Promise<void>;
  verifyEmail(context: AuthContext, token: string): Promise<void>;
  login(
    context: AuthContext,
    email: string,
    password: string,
    previousToken?: string,
  ): Promise<AuthSession>;
  logout(context: AuthContext, token?: string): Promise<void>;
  forgotPassword(context: AuthContext, email: string): Promise<void>;
  resetPassword(context: AuthContext, token: string, password: string): Promise<void>;
  changePassword(
    context: AuthContext,
    token: string,
    oldPassword: string,
    password: string,
  ): Promise<void>;
  authenticate(context: AuthContext, token: string): Promise<AuthPrincipal>;
  listSessions(context: AuthContext, token: string): Promise<SessionSummary[]>;
  rotateSession(context: AuthContext, token: string): Promise<AuthSession>;
  revokeSession(context: AuthContext, token: string, sessionId: string): Promise<void>;
  revokeAllSessions(context: AuthContext, token: string): Promise<void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface AuthServiceOptions {
  repository: AuthRepository;
  hasher: PasswordHasher;
  mailer: AuthMailer;
  limiter: AuthLimiter;
  csrfSecret: string;
  onMailFailure?: () => void;
}

export function normalizeEmail(value: string): string {
  // A deliberately small ASCII mailbox grammar; addresses are never HTML or headers.
  if (
    typeof value !== 'string' ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new AuthError('BAD_REQUEST');
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      email,
    ) ||
    email.slice(0, email.indexOf('@')).length > 64
  ) {
    throw new AuthError('BAD_REQUEST');
  }
  return email;
}

export function validatePassword(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length > 256 ||
    Buffer.byteLength(password, 'utf8') > 512
  )
    throw new AuthError('BAD_REQUEST');
  const length = Array.from(password).length;
  if (
    length < 15 ||
    length > 128 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(password)
  )
    throw new AuthError('BAD_REQUEST');
}

export function isOpaqueToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(token) &&
    Buffer.from(token, 'base64url').toString('base64url') === token
  );
}

function tokenHash(token: string, code: AuthErrorCode = 'UNAUTHENTICATED'): Buffer {
  if (!isOpaqueToken(token)) throw new AuthError(code);
  return createHash('sha256').update(token, 'ascii').digest();
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { repository, hasher, mailer, limiter } = options;
  if (!/^[a-f0-9]{64}$/i.test(options.csrfSecret)) throw new AuthError('SERVICE_UNAVAILABLE');
  const rateKey = Buffer.from(options.csrfSecret, 'hex');
  const pendingMail = new Set<Promise<void>>();
  let mailReservations = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  function open(): void {
    if (closed) throw new AuthError('SERVICE_UNAVAILABLE');
  }

  async function backend<T>(operation: () => Promise<T>): Promise<T> {
    open();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('SERVICE_UNAVAILABLE');
    }
  }

  function key(scope: string, value: string): string {
    return `auth:${scope}:${createHmac('sha256', rateKey).update(scope).update('\0').update(value).digest('hex')}`;
  }

  async function limit(context: AuthContext, operation: string, identity?: string): Promise<void> {
    const sensitive = [
      'signup',
      'login',
      'forgot-password',
      'resend-verification',
      'reset-password',
      'change-password',
      'change-password-account',
    ].includes(operation);
    // A global IP budget prevents distributing work over many endpoint-specific buckets.
    const buckets = [
      { key: key('ip', context.ip), limit: 120, windowMs: 60_000 },
      {
        key: key(`${operation}:ip`, context.ip),
        limit: sensitive ? 20 : 60,
        windowMs: sensitive ? 900_000 : 60_000,
      },
    ];
    if (identity !== undefined)
      buckets.push({
        key: key(`${operation}:identity`, identity),
        limit: sensitive ? 5 : 30,
        windowMs: sensitive ? 900_000 : 60_000,
      });
    if (!(await backend(() => limiter.consume(buckets)))) throw new AuthError('RATE_LIMITED');
  }

  async function mailOperation(
    operation: () => Promise<{ send: boolean; token: string; email: string }>,
    kind: 'verify-email' | 'reset-password',
  ): Promise<void> {
    open();
    if (mailReservations >= 8) throw new AuthError('SERVICE_UNAVAILABLE');
    mailReservations += 1;
    let queued = false;
    try {
      // Check transport before knowing whether the account exists, preserving generic responses.
      await backend(() => mailer.ready());
      const result = await operation();
      if (!result.send) return;
      const sending = Promise.resolve()
        .then(() => mailer.send(kind, result.email, result.token))
        .catch(() => {
          try {
            options.onMailFailure?.();
          } catch {
            /* Diagnostics cannot change account responses. */
          }
        });
      pendingMail.add(sending);
      queued = true;
      void sending.finally(() => {
        pendingMail.delete(sending);
        mailReservations -= 1;
      });
      return;
    } finally {
      // A queued send retains its reservation until the transport has settled.
      if (!queued) mailReservations -= 1;
    }
  }

  async function principal(token: string): Promise<AuthPrincipal> {
    const result = await backend(() => repository.authenticate(tokenHash(token)));
    if (!result) throw new AuthError('UNAUTHENTICATED');
    return result;
  }

  return {
    async csrf(context) {
      await limit(context, 'csrf');
    },
    async signup(context, rawEmail, password) {
      const email = normalizeEmail(rawEmail);
      validatePassword(password);
      await limit(context, 'signup', email);
      await mailOperation(async () => {
        const passwordHash = await backend(() => hasher.hash(password));
        const token = randomBytes(32).toString('base64url');
        const send = await backend(() =>
          repository.signup({
            emailNormalized: email,
            passwordHash,
            verificationTokenHash: tokenHash(token),
          }),
        );
        return { send, token, email };
      }, 'verify-email');
    },
    async resendVerification(context, rawEmail) {
      const email = normalizeEmail(rawEmail);
      await limit(context, 'resend-verification', email);
      await mailOperation(async () => {
        const token = randomBytes(32).toString('base64url');
        const send = await backend(() =>
          repository.issueVerification({ emailNormalized: email, tokenHash: tokenHash(token) }),
        );
        return { send, token, email };
      }, 'verify-email');
    },
    async verifyEmail(context, token) {
      const hash = tokenHash(token, 'BAD_REQUEST');
      await limit(context, 'verify-email', token);
      if (!(await backend(() => repository.verifyEmail(hash)))) throw new AuthError('BAD_REQUEST');
    },
    async login(context, rawEmail, password, previousToken) {
      const email = normalizeEmail(rawEmail);
      validatePassword(password);
      await limit(context, 'login', email);
      const credentials = await backend(() => repository.credentials(email));
      const verified = await backend(() =>
        hasher.verify(credentials?.passwordHash ?? null, password),
      );
      // No password-only fallback for accounts whose assurance policy requires MFA.
      if (!credentials || !verified || credentials.requiresMfa)
        throw new AuthError('UNAUTHENTICATED');
      const token = randomBytes(32).toString('base64url');
      const result = await backend(() =>
        repository.createSession({
          userId: credentials.userId,
          expectedPasswordHash: credentials.passwordHash,
          expectedSessionEpoch: credentials.sessionEpoch,
          tokenHash: tokenHash(token),
          ...(previousToken === undefined ? {} : { previousTokenHash: tokenHash(previousToken) }),
        }),
      );
      if (!result) throw new AuthError('UNAUTHENTICATED');
      return { token, principal: result };
    },
    async logout(context, token) {
      await limit(context, 'logout');
      if (token !== undefined) await backend(() => repository.logout(tokenHash(token)));
    },
    async forgotPassword(context, rawEmail) {
      const email = normalizeEmail(rawEmail);
      await limit(context, 'forgot-password', email);
      await mailOperation(async () => {
        const token = randomBytes(32).toString('base64url');
        const send = await backend(() =>
          repository.issuePasswordReset({ emailNormalized: email, tokenHash: tokenHash(token) }),
        );
        return { send, token, email };
      }, 'reset-password');
    },
    async resetPassword(context, token, password) {
      const hash = tokenHash(token, 'BAD_REQUEST');
      validatePassword(password);
      await limit(context, 'reset-password', token);
      const passwordHash = await backend(() => hasher.hash(password));
      if (!(await backend(() => repository.resetPassword({ tokenHash: hash, passwordHash }))))
        throw new AuthError('BAD_REQUEST');
    },
    async changePassword(context, token, oldPassword, password) {
      validatePassword(oldPassword);
      validatePassword(password);
      await limit(context, 'change-password');
      const user = await principal(token);
      await limit(context, 'change-password-account', user.userId);
      const credentials = await backend(() => repository.credentials(user.emailNormalized));
      const verified = await backend(() =>
        hasher.verify(credentials?.passwordHash ?? null, oldPassword),
      );
      if (!credentials || !verified || credentials.requiresMfa)
        throw new AuthError('UNAUTHENTICATED');
      const passwordHash = await backend(() => hasher.hash(password));
      if (
        !(await backend(() =>
          repository.changePassword({
            tokenHash: tokenHash(token),
            expectedPasswordHash: credentials.passwordHash,
            passwordHash,
          }),
        ))
      )
        throw new AuthError('UNAUTHENTICATED');
    },
    async authenticate(context, token) {
      await limit(context, 'authenticate');
      return principal(token);
    },
    async listSessions(context, token) {
      await limit(context, 'sessions');
      await principal(token);
      return backend(() => repository.listSessions(tokenHash(token)));
    },
    async rotateSession(context, token) {
      await limit(context, 'rotate');
      const newToken = randomBytes(32).toString('base64url');
      const result = await backend(() =>
        repository.rotateSession({
          tokenHash: tokenHash(token),
          newTokenHash: tokenHash(newToken),
        }),
      );
      if (!result) throw new AuthError('UNAUTHENTICATED');
      return { token: newToken, principal: result };
    },
    async revokeSession(context, token, sessionId) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId))
        throw new AuthError('BAD_REQUEST');
      await limit(context, 'revoke');
      await principal(token);
      if (
        !(await backend(() => repository.revokeSession({ tokenHash: tokenHash(token), sessionId })))
      )
        throw new AuthError('NOT_FOUND');
    },
    async revokeAllSessions(context, token) {
      await limit(context, 'logout-all');
      await principal(token);
      await backend(() => repository.revokeAllSessions(tokenHash(token)));
    },
    async ready() {
      await backend(async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => repository.ready()),
          Promise.resolve().then(() => limiter.ready()),
          Promise.resolve().then(() => mailer.ready()),
        ]);
        if (results.some((result) => result.status === 'rejected'))
          throw new AuthError('SERVICE_UNAVAILABLE');
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...pendingMail]);
        const results = await Promise.allSettled([
          Promise.resolve().then(() => repository.close()),
          Promise.resolve().then(() => hasher.close()),
          Promise.resolve().then(() => mailer.close()),
          Promise.resolve().then(() => limiter.close()),
        ]);
        if (results.some((result) => result.status === 'rejected'))
          throw new AuthError('SERVICE_UNAVAILABLE');
      })();
      return closing;
    },
  };
}
