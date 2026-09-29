import { createHash, randomBytes } from 'node:crypto';
import type { AuthPrincipal, AuthRepository } from '@ctp/database';
import { describe, expect, it, vi } from 'vitest';
import { MAIL_OPERATION_TIMEOUT_MS, type AuthMailer } from '../src/mail.js';
import type { PasswordHasher } from '../src/password.js';
import type { AuthLimiter } from '../src/rate-limit.js';
import {
  AuthError,
  createAuthService,
  isOpaqueToken,
  normalizeEmail,
  validatePassword,
} from '../src/service.js';

const password = 'a sufficiently long password 🔑';
const context = { ip: '192.0.2.17' };
const email = 'person@example.invalid';
const rawToken = randomBytes(32).toString('base64url');
const principal: AuthPrincipal = {
  userId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  emailNormalized: email,
  role: 'USER',
  createdAt: new Date('2026-09-14T10:00:00Z'),
  lastSeenAt: new Date('2026-09-14T10:00:00Z'),
  idleExpiresAt: new Date('2026-09-14T10:30:00Z'),
  expiresAt: new Date('2026-09-14T22:00:00Z'),
};

function fixture() {
  const repository = {
    signup: vi.fn<AuthRepository['signup']>().mockResolvedValue(true),
    issueVerification: vi.fn<AuthRepository['issueVerification']>().mockResolvedValue(true),
    verifyEmail: vi.fn<AuthRepository['verifyEmail']>().mockResolvedValue(true),
    credentials: vi.fn<AuthRepository['credentials']>().mockResolvedValue({
      userId: principal.userId,
      passwordHash: 'hash-for-test-only',
      sessionEpoch: 2,
      requiresMfa: false,
    }),
    createSession: vi.fn<AuthRepository['createSession']>().mockResolvedValue(principal),
    authenticate: vi.fn<AuthRepository['authenticate']>().mockResolvedValue(principal),
    rotateSession: vi.fn<AuthRepository['rotateSession']>().mockResolvedValue(principal),
    logout: vi.fn<AuthRepository['logout']>().mockResolvedValue(undefined),
    listSessions: vi.fn<AuthRepository['listSessions']>().mockResolvedValue([principal]),
    revokeSession: vi.fn<AuthRepository['revokeSession']>().mockResolvedValue(true),
    revokeAllSessions: vi.fn<AuthRepository['revokeAllSessions']>().mockResolvedValue(undefined),
    issuePasswordReset: vi.fn<AuthRepository['issuePasswordReset']>().mockResolvedValue(true),
    resetPassword: vi.fn<AuthRepository['resetPassword']>().mockResolvedValue(true),
    changePassword: vi.fn<AuthRepository['changePassword']>().mockResolvedValue(true),
    ready: vi.fn<AuthRepository['ready']>().mockResolvedValue(undefined),
    close: vi.fn<AuthRepository['close']>().mockResolvedValue(undefined),
  };
  const hasher = {
    hash: vi.fn<PasswordHasher['hash']>().mockResolvedValue('hash-for-test-only'),
    verify: vi.fn<PasswordHasher['verify']>().mockResolvedValue(true),
    close: vi.fn<PasswordHasher['close']>().mockResolvedValue(undefined),
  };
  const mailer = {
    send: vi.fn<AuthMailer['send']>().mockResolvedValue(undefined),
    ready: vi.fn<AuthMailer['ready']>().mockResolvedValue(undefined),
    close: vi.fn<AuthMailer['close']>().mockResolvedValue(undefined),
  };
  const limiter = {
    consume: vi.fn<AuthLimiter['consume']>().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    ready: vi.fn<AuthLimiter['ready']>().mockResolvedValue(undefined),
    close: vi.fn<AuthLimiter['close']>().mockResolvedValue(undefined),
  };
  const onMailFailure = vi.fn<() => void>();
  const service = createAuthService({
    repository,
    hasher,
    mailer,
    limiter,
    csrfSecret: 'bc'.repeat(32),
    onMailFailure,
  });
  return { service, repository, hasher, mailer, limiter, onMailFailure };
}

describe('auth service security boundaries', () => {
  it('normalizes only supported email syntax and rejects header injection and ambiguous addresses', () => {
    expect(normalizeEmail(' Person+tag@Example.Invalid ')).toBe('person+tag@example.invalid');
    for (const value of [
      'a\r\nbcc:x@example.invalid',
      'x\0@example.invalid',
      'a..b@example.invalid',
      'a@localhost',
      'ü@example.invalid',
      `${'a'.repeat(65)}@example.invalid`,
      'a@-example.invalid',
      'a@example..invalid',
    ]) {
      expect(() => normalizeEmail(value)).toThrow(AuthError);
    }
  });
  it('counts Unicode password characters without trimming or normalization and bounds byte size', () => {
    expect(() => validatePassword('🔑'.repeat(15))).not.toThrow();
    expect(() => validatePassword('🔑'.repeat(128))).not.toThrow();
    expect(() => validatePassword(' '.repeat(15))).not.toThrow();
    for (const value of ['x'.repeat(14), 'x'.repeat(129), '🔑'.repeat(129), `abcdefghijklmn\ud800`])
      expect(() => validatePassword(value)).toThrow(AuthError);
  });
  it('accepts only canonical 256-bit tokens', () => {
    expect(isOpaqueToken(rawToken)).toBe(true);
    for (const token of [
      '',
      'a'.repeat(42),
      'a'.repeat(44),
      '+'.repeat(43),
      'a'.repeat(43),
      `${rawToken}=`,
    ])
      expect(isOpaqueToken(token)).toBe(false);
  });
  it('hashes passwords and token digests before storage while sending the raw token only to mail', async () => {
    const { service, hasher, mailer, repository } = fixture();
    await service.signup(context, ' PERSON@EXAMPLE.INVALID ', password);
    expect(hasher.hash).toHaveBeenCalledWith(password);
    await vi.waitFor(() => expect(mailer.send).toHaveBeenCalledOnce());
    const sent = mailer.send.mock.calls[0]!;
    expect(sent.slice(0, 2)).toEqual(['verify-email', email]);
    expect(isOpaqueToken(sent[2])).toBe(true);
    expect(repository.signup).toHaveBeenCalledWith({
      emailNormalized: email,
      passwordHash: 'hash-for-test-only',
      verificationTokenHash: createHash('sha256').update(sent[2]).digest(),
    });
    await service.close();
  });
  it('does equal password-hash work on duplicate signup and returns no account state', async () => {
    const { service, repository, hasher, mailer } = fixture();
    repository.signup.mockResolvedValue(false);
    expect(await service.signup(context, email, password)).toBeUndefined();
    expect(hasher.hash).toHaveBeenCalledOnce();
    expect(mailer.send).not.toHaveBeenCalled();
    await service.close();
  });
  it('never reveals unknown addresses through resend or password recovery responses', async () => {
    const { service, repository, mailer } = fixture();
    repository.issueVerification.mockResolvedValue(false);
    repository.issuePasswordReset.mockResolvedValue(false);
    expect(await service.resendVerification(context, email)).toBeUndefined();
    expect(await service.forgotPassword(context, email)).toBeUndefined();
    expect(mailer.ready).toHaveBeenCalledTimes(2);
    expect(mailer.send).not.toHaveBeenCalled();
    await service.close();
  });
  it('fails before account lookup when SMTP is unavailable', async () => {
    const { service, repository, mailer, hasher } = fixture();
    mailer.ready.mockRejectedValue(new Error('smtp-password-and-recipient-secret'));
    await expect(service.signup(context, email, password)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
    });
    await expect(service.forgotPassword(context, email)).rejects.toThrow('SERVICE_UNAVAILABLE');
    expect(repository.signup).not.toHaveBeenCalled();
    expect(repository.issuePasswordReset).not.toHaveBeenCalled();
    expect(hasher.hash).not.toHaveBeenCalled();
    await service.close();
  });
  it('preserves generic acceptance after recipient-specific SMTP rejection and reports only a static event', async () => {
    const { service, mailer, onMailFailure } = fixture();
    mailer.send.mockRejectedValue(new Error('recipient-and-raw-token-secret'));
    await expect(service.forgotPassword(context, email)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(onMailFailure).toHaveBeenCalledWith());
    await service.close();
  });
  it('bounds asynchronous mail admission before account lookup', async () => {
    const { service, mailer, repository } = fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mailer.send.mockReturnValue(pending);
    await Promise.all(Array.from({ length: 8 }, () => service.forgotPassword(context, email)));
    await expect(service.forgotPassword(context, email)).rejects.toThrow('SERVICE_UNAVAILABLE');
    expect(repository.issuePasswordReset).toHaveBeenCalledTimes(8);
    finish();
    await service.close();
  });

  it.each(['eligible', 'unknown', 'suppressed', 'send-failed'] as const)(
    'does not expose %s recovery eligibility through an associated capacity probe',
    async (state) => {
      const { service, mailer, repository } = fixture();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const candidate = 'candidate@example.invalid';
      repository.issuePasswordReset.mockImplementation(({ emailNormalized }) =>
        Promise.resolve(
          emailNormalized.startsWith('controlled-') ||
            (emailNormalized === candidate && (state === 'eligible' || state === 'send-failed')),
        ),
      );
      mailer.send.mockImplementation(async (_kind, recipient) => {
        if (recipient === candidate && state === 'send-failed') throw new Error('SMTP_REJECTED');
        await pending;
      });
      try {
        await Promise.all(
          Array.from({ length: 7 }, (_, index) =>
            service.forgotPassword(context, `controlled-${index}@example.invalid`),
          ),
        );
        await expect(service.forgotPassword(context, candidate)).resolves.toBeUndefined();
        // Delivery errors must not reveal eligibility by freeing this eighth slot either.
        await Promise.resolve();
        await Promise.resolve();
        await expect(
          service.forgotPassword(context, 'known-absent@example.invalid'),
        ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', statusCode: 503 });
        expect(repository.issuePasswordReset).toHaveBeenCalledTimes(8);
      } finally {
        finish();
        await service.close();
      }
    },
  );

  it.each(['no-op', 'delivered', 'rejected'] as const)(
    'retains %s mail admission for the complete public hold interval',
    async (outcome) => {
      vi.useFakeTimers();
      const { service, mailer, repository } = fixture();
      repository.issuePasswordReset.mockResolvedValue(outcome !== 'no-op');
      if (outcome === 'rejected') mailer.send.mockRejectedValue(new Error('SMTP_REJECTED'));
      try {
        await Promise.all(Array.from({ length: 8 }, () => service.forgotPassword(context, email)));
        await vi.advanceTimersByTimeAsync(MAIL_OPERATION_TIMEOUT_MS - 1);
        await expect(service.forgotPassword(context, email)).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
        });
        expect(repository.issuePasswordReset).toHaveBeenCalledTimes(8);
        await vi.advanceTimersByTimeAsync(1);
        await expect(service.forgotPassword(context, email)).resolves.toBeUndefined();
        expect(repository.issuePasswordReset).toHaveBeenCalledTimes(9);
      } finally {
        await service.close();
        vi.useRealTimers();
      }
    },
  );

  it('keeps the delivery bound when a transport outlives the public hold interval', async () => {
    vi.useFakeTimers();
    const { service, mailer, repository } = fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mailer.send.mockReturnValue(pending);
    try {
      await Promise.all(Array.from({ length: 8 }, () => service.forgotPassword(context, email)));
      await vi.advanceTimersByTimeAsync(MAIL_OPERATION_TIMEOUT_MS);
      await expect(service.forgotPassword(context, email)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
      expect(repository.issuePasswordReset).toHaveBeenCalledTimes(8);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      await expect(service.forgotPassword(context, email)).resolves.toBeUndefined();
    } finally {
      finish();
      await service.close();
      vi.useRealTimers();
    }
  });

  it('cancels admission padding on close without keeping the process alive or admitting work', async () => {
    vi.useFakeTimers();
    const { service, repository } = fixture();
    repository.issuePasswordReset.mockResolvedValue(false);
    try {
      await Promise.all(Array.from({ length: 8 }, () => service.forgotPassword(context, email)));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(8);
      await service.close();
      expect(vi.getTimerCount()).toBe(0);
      await expect(service.forgotPassword(context, email)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
      await service.close();
      expect(repository.close).toHaveBeenCalledOnce();
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it('does not retain admission padding after failures before account lookup', async () => {
    const { service, mailer, repository } = fixture();
    mailer.ready.mockRejectedValue(new Error('SMTP_UNAVAILABLE'));
    try {
      for (let index = 0; index < 8; index += 1)
        await expect(service.forgotPassword(context, email)).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
        });
      expect(repository.issuePasswordReset).not.toHaveBeenCalled();
      mailer.ready.mockResolvedValue(undefined);
      repository.issuePasswordReset.mockResolvedValue(false);
      await expect(service.forgotPassword(context, email)).resolves.toBeUndefined();
    } finally {
      await service.close();
    }
  });
  it('keeps native hash work and database lookups behind rate limiting', async () => {
    const { service, limiter, repository, hasher } = fixture();
    limiter.consume.mockResolvedValue({ allowed: false, retryAfterMs: 899_125 });
    await expect(service.login(context, email, password)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
    });
    expect(repository.credentials).not.toHaveBeenCalled();
    expect(hasher.verify).not.toHaveBeenCalled();
    await service.close();
  });
  it('fails closed on Redis failure and stores no IP or mailbox in rate keys', async () => {
    const { service, limiter } = fixture();
    await service.login(context, email, password);
    const buckets = limiter.consume.mock.calls[0]![0];
    expect(buckets).toHaveLength(3);
    expect(JSON.stringify(buckets)).not.toContain(email);
    expect(JSON.stringify(buckets)).not.toContain(context.ip);
    expect(
      buckets.every((bucket) => /^auth:[a-z-]+(?::[a-z-]+)?:[a-f0-9]{64}$/.test(bucket.key)),
    ).toBe(true);
    limiter.consume.mockRejectedValue(new Error('redis://private-credential'));
    await expect(service.login(context, email, password)).rejects.toThrow('SERVICE_UNAVAILABLE');
    await service.close();
  });
  it('uses the dummy hash path for unknown, unverified, or inactive accounts', async () => {
    const { service, repository, hasher } = fixture();
    repository.credentials.mockResolvedValue(null);
    await expect(service.login(context, email, password)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      statusCode: 401,
    });
    expect(hasher.verify).toHaveBeenCalledWith(null, password);
    expect(repository.createSession).not.toHaveBeenCalled();
    await service.close();
  });
  it('rejects a wrong password and MFA-required accounts without creating sessions', async () => {
    const { service, repository, hasher } = fixture();
    hasher.verify.mockResolvedValueOnce(false);
    await expect(service.login(context, email, password)).rejects.toThrow('UNAUTHENTICATED');
    repository.credentials.mockResolvedValue({
      userId: principal.userId,
      passwordHash: 'hash-for-test-only',
      sessionEpoch: 2,
      requiresMfa: true,
    });
    await expect(service.login(context, email, password)).rejects.toThrow('UNAUTHENTICATED');
    expect(repository.createSession).not.toHaveBeenCalled();
    await service.close();
  });
  it('creates unpredictable sessions with a CAS snapshot and revokes the previous token atomically', async () => {
    const { service, repository } = fixture();
    const first = await service.login(context, email, password, rawToken);
    const second = await service.login(context, email, password);
    expect(isOpaqueToken(first.token)).toBe(true);
    expect(first.token).not.toBe(second.token);
    expect(repository.createSession.mock.calls[0]![0]).toEqual({
      userId: principal.userId,
      expectedPasswordHash: 'hash-for-test-only',
      expectedSessionEpoch: 2,
      tokenHash: createHash('sha256').update(first.token).digest(),
      previousTokenHash: createHash('sha256').update(rawToken).digest(),
    });
    repository.createSession.mockResolvedValue(null);
    await expect(service.login(context, email, password)).rejects.toThrow('UNAUTHENTICATED');
    await service.close();
  });
  it('does not turn invalid, expired, consumed verification or reset tokens into success', async () => {
    const { service, repository } = fixture();
    repository.verifyEmail.mockResolvedValue(false);
    repository.resetPassword.mockResolvedValue(false);
    await expect(service.verifyEmail(context, rawToken)).rejects.toThrow('BAD_REQUEST');
    await expect(service.resetPassword(context, rawToken, password)).rejects.toThrow('BAD_REQUEST');
    await expect(service.resetPassword(context, 'invalid', password)).rejects.toThrow(
      'BAD_REQUEST',
    );
    expect(repository.resetPassword).toHaveBeenCalledOnce();
    await service.close();
  });
  it('changes passwords only after current-session authentication, password verification and CAS', async () => {
    const { service, repository, hasher } = fixture();
    await service.changePassword(context, rawToken, password, `${password} new`);
    expect(hasher.verify).toHaveBeenCalledWith('hash-for-test-only', password);
    expect(repository.changePassword).toHaveBeenCalledWith({
      tokenHash: createHash('sha256').update(rawToken).digest(),
      expectedPasswordHash: 'hash-for-test-only',
      passwordHash: 'hash-for-test-only',
    });
    repository.changePassword.mockResolvedValue(false);
    await expect(
      service.changePassword(context, rawToken, password, `${password} new`),
    ).rejects.toThrow('UNAUTHENTICATED');
    await service.close();
  });
  it('bounds password-change guesses across source IPs by the authenticated account', async () => {
    const { service, limiter, hasher, repository } = fixture();
    limiter.consume
      .mockResolvedValueOnce({ allowed: true, retryAfterMs: 0 })
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 899_125 });
    await expect(
      service.changePassword(context, rawToken, password, `${password} new`),
    ).rejects.toThrow('RATE_LIMITED');
    expect(limiter.consume.mock.calls[1]![0].at(-1)).toMatchObject({ limit: 5, windowMs: 900_000 });
    expect(hasher.verify).not.toHaveBeenCalled();
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(repository.changePassword).not.toHaveBeenCalled();
    await service.close();
  });
  it('denies foreign session revocation and does not call the repository for invalid IDs', async () => {
    const { service, repository } = fixture();
    repository.revokeSession.mockResolvedValue(false);
    await expect(
      service.revokeSession(context, rawToken, principal.sessionId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    await expect(service.revokeSession(context, rawToken, '../another-account')).rejects.toThrow(
      'BAD_REQUEST',
    );
    expect(repository.revokeSession).toHaveBeenCalledOnce();
    await service.close();
  });
  it('refuses revoked sessions across reads, rotation and logout-all', async () => {
    const { service, repository } = fixture();
    repository.authenticate.mockResolvedValue(null);
    repository.rotateSession.mockResolvedValue(null);
    await expect(service.authenticate(context, rawToken)).rejects.toThrow('UNAUTHENTICATED');
    await expect(service.listSessions(context, rawToken)).rejects.toThrow('UNAUTHENTICATED');
    await expect(service.rotateSession(context, rawToken)).rejects.toThrow('UNAUTHENTICATED');
    await expect(service.revokeAllSessions(context, rawToken)).rejects.toThrow('UNAUTHENTICATED');
    expect(repository.listSessions).not.toHaveBeenCalled();
    expect(repository.revokeAllSessions).not.toHaveBeenCalled();
    await service.close();
  });
  it('allows idempotent anonymous logout without touching the database', async () => {
    const { service, repository } = fixture();
    await service.logout(context);
    expect(repository.logout).not.toHaveBeenCalled();
    await service.logout(context, rawToken);
    expect(repository.logout).toHaveBeenCalledWith(createHash('sha256').update(rawToken).digest());
    await service.close();
  });
  it('closes every resource despite individual failure, coalesces close and rejects new work', async () => {
    const { service, repository, hasher, mailer, limiter } = fixture();
    repository.close.mockRejectedValue(new Error('database password'));
    const closing = service.close();
    expect(service.close()).toBe(closing);
    await expect(closing).rejects.toThrow('SERVICE_UNAVAILABLE');
    for (const close of [repository.close, hasher.close, mailer.close, limiter.close])
      expect(close).toHaveBeenCalledOnce();
    await expect(service.csrf(context)).rejects.toThrow('SERVICE_UNAVAILABLE');
  });
  it('waits for in-flight email before closing transports', async () => {
    const { service, mailer } = fixture();
    let finish!: () => void;
    mailer.send.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await service.forgotPassword(context, email);
    const closing = service.close();
    expect(mailer.close).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(mailer.close).toHaveBeenCalledOnce();
  });
  it('still closes the remaining ports if a dependency throws synchronously', async () => {
    const { service, repository, hasher, mailer, limiter } = fixture();
    repository.close.mockImplementation(() => {
      throw new Error('backend-secret');
    });
    await expect(service.close()).rejects.toThrow('SERVICE_UNAVAILABLE');
    for (const close of [repository.close, hasher.close, mailer.close, limiter.close])
      expect(close).toHaveBeenCalledOnce();
  });
  it('probes core resources independently of email and sanitizes readiness failures', async () => {
    const { service, repository, limiter, mailer } = fixture();
    repository.ready.mockRejectedValue(new Error('database-secret'));
    await expect(service.ready()).rejects.toThrow('SERVICE_UNAVAILABLE');
    expect(limiter.ready).toHaveBeenCalledOnce();
    expect(mailer.ready).not.toHaveBeenCalled();
    await service.emailReady();
    expect(mailer.ready).toHaveBeenCalledOnce();
    await service.close();
  });
  it('keeps verified login and session operations available throughout SMTP failure and recovery', async () => {
    const { service, mailer, repository } = fixture();
    mailer.ready.mockRejectedValue(new Error('smtp-credential-canary'));
    await expect(service.ready()).resolves.toBeUndefined();
    await expect(service.emailReady()).rejects.toThrow('SERVICE_UNAVAILABLE');
    await expect(service.login(context, email, password)).resolves.toMatchObject({ principal });
    await expect(service.authenticate(context, rawToken)).resolves.toEqual(principal);
    await expect(service.logout(context, rawToken)).resolves.toBeUndefined();
    for (const operation of [
      () => service.signup(context, email, password),
      () => service.resendVerification(context, email),
      () => service.forgotPassword(context, email),
    ])
      await expect(operation()).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        statusCode: 503,
      });
    expect(repository.signup).not.toHaveBeenCalled();
    expect(repository.issueVerification).not.toHaveBeenCalled();
    expect(repository.issuePasswordReset).not.toHaveBeenCalled();
    mailer.ready.mockResolvedValue(undefined);
    await expect(service.emailReady()).resolves.toBeUndefined();
    await expect(service.forgotPassword(context, email)).resolves.toBeUndefined();
    await service.close();
  });
  it('propagates the actual limiter wait and explicitly orders coarse and identity scopes', async () => {
    const { service, limiter, hasher } = fixture();
    limiter.consume.mockResolvedValue({ allowed: false, retryAfterMs: 123_456 });
    await expect(service.login(context, email, password)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 123_456,
    });
    expect(limiter.consume.mock.calls[0]![0].map(({ scope }) => scope)).toEqual([
      'ip',
      'operation',
      'identity',
    ]);
    expect(hasher.verify).not.toHaveBeenCalled();
    await service.close();
  });
  it.each(['active', 'unknown', 'pending', 'suspended', 'mfa'] as const)(
    'keeps public rejection work and email readiness independent of %s account state',
    async (state) => {
      const { service, repository, hasher, mailer, limiter } = fixture();
      if (['unknown', 'pending', 'suspended'].includes(state))
        repository.credentials.mockResolvedValue(null);
      if (state === 'mfa')
        repository.credentials.mockResolvedValue({
          userId: principal.userId,
          passwordHash: 'hash-for-test-only',
          sessionEpoch: 2,
          requiresMfa: true,
        });
      hasher.verify.mockResolvedValue(false);
      await expect(service.login(context, email, password)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        statusCode: 401,
      });
      expect(hasher.verify).toHaveBeenCalledOnce();
      expect(mailer.ready).not.toHaveBeenCalled();
      expect(repository.createSession).not.toHaveBeenCalled();
      expect(limiter.consume).toHaveBeenCalledOnce();
      repository.signup.mockResolvedValue(false);
      repository.issueVerification.mockResolvedValue(false);
      repository.issuePasswordReset.mockResolvedValue(false);
      await expect(service.signup(context, email, password)).resolves.toBeUndefined();
      await expect(service.resendVerification(context, email)).resolves.toBeUndefined();
      await expect(service.forgotPassword(context, email)).resolves.toBeUndefined();
      expect(hasher.hash).toHaveBeenCalledOnce();
      expect(mailer.ready).toHaveBeenCalledTimes(3);
      expect(mailer.send).not.toHaveBeenCalled();
      await service.close();
    },
  );
});
