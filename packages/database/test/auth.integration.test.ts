import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthDatabase, createDatabase, type AuthRepository } from '../src/index.js';

const project = process.env['CTP_TEST_PROJECT'];
if (
  process.env['NODE_ENV'] !== 'test' ||
  !project ||
  !/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(project)
) {
  throw new Error('Authentication storage tests require the isolated integration runner');
}
function isolatedUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing isolated runner variable: ${name}`);
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || !/^\/ctp_p2_fresh_[a-f0-9]+$/u.test(url.pathname)) {
    throw new Error('Expected the owned disposable database');
  }
  return value;
}
const adminUrl = isolatedUrl('DATABASE_MIGRATION_URL');
const authUrl = isolatedUrl('DATABASE_AUTH_URL');
const runtimeUrl = isolatedUrl('DATABASE_RUNTIME_URL');
if ([authUrl, runtimeUrl].some((url) => new URL(url).pathname !== new URL(adminUrl).pathname)) {
  throw new Error('Authentication storage connections must share the disposable database');
}
const admin = new Pool({ connectionString: adminUrl, max: 3, query_timeout: 7000 });
const authSql = new Pool({ connectionString: authUrl, max: 2, query_timeout: 7000 });
const runtime = new Pool({ connectionString: runtimeUrl, max: 2, query_timeout: 7000 });
let repository: AuthRepository;
const hash = () => randomBytes(32);
// These tests exercise SQL transitions; Argon2 verification is tested in @ctp/auth.
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQxMjM0NTY3OA$' + 'A'.repeat(43);
const replacementHash = passwordHash.replace(/A/gu, 'B');
async function user(verified = true) {
  const emailNormalized = `${randomUUID()}@auth-fixture.invalid`;
  const verificationTokenHash = hash();
  expect(await repository.signup({ emailNormalized, passwordHash, verificationTokenHash })).toBe(
    true,
  );
  if (verified) expect(await repository.verifyEmail(verificationTokenHash)).toBe(true);
  const row = await admin.query<{ id: string }>(
    'SELECT id FROM public."user" WHERE "emailNormalized"=$1',
    [emailNormalized],
  );
  const userId = row.rows[0]?.id;
  if (!userId) throw new Error('Fixture user missing');
  return { emailNormalized, verificationTokenHash, userId };
}
async function session(account: Awaited<ReturnType<typeof user>>) {
  const credentials = await repository.credentials(account.emailNormalized);
  if (!credentials) throw new Error('Fixture credentials missing');
  const tokenHash = hash();
  const principal = await repository.createSession({
    userId: account.userId,
    expectedPasswordHash: credentials.passwordHash,
    expectedSessionEpoch: credentials.sessionEpoch,
    tokenHash,
  });
  if (!principal) throw new Error('Fixture session missing');
  return { tokenHash, principal };
}

async function waitForBlockedLogin(): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const result = await admin.query<{ blocked: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'
        AND query LIKE 'SELECT * FROM ctp_auth.create_session%') AS blocked`,
      [new URL(authUrl).username],
    );
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Expected the concurrent login to wait for its User lock');
}

async function liveGrant(tenantId: string): Promise<string> {
  const accountId = randomUUID();
  const connectionId = randomUUID();
  const credentialId = randomUUID();
  const riskProfileId = randomUUID();
  const grantId = randomUUID();
  await admin.query(
    `INSERT INTO public.exchange_account
    (id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode","clientIdEpoch","updatedAt")
    VALUES ($1::uuid,$2,'BINANCE','LIVE',$1::text,'fixture','fixture','auth-test',now())`,
    [accountId, tenantId],
  );
  await admin.query(
    `INSERT INTO public.exchange_connection
    (id,"tenantId","accountId",mode,label,permissions,"updatedAt")
    VALUES ($1,$2,$3,'LIVE','auth-fixture','{}',now())`,
    [connectionId, tenantId, accountId],
  );
  await admin.query(
    `INSERT INTO public.encrypted_credential
    (id,"tenantId","connectionId",version,ciphertext,nonce,tag,"wrappedDek","kmsKeyId","kmsKeyVersion","encryptionVersion","aadVersion")
    VALUES ($1,$2,$3,1,$4,$5,$6,$4,'fixture-only','1',1,1)`,
    [credentialId, tenantId, connectionId, hash(), Buffer.alloc(12, 1), Buffer.alloc(16, 2)],
  );
  await admin.query(
    `INSERT INTO public.risk_profile
    (id,"tenantId",name,version,"policyHash","valuationAsset","maxNotional","maxDailyLoss","maxDrawdownRate","maxOpenOrders",policy,"effectiveAt")
    VALUES ($1,$2,'auth-fixture',1,$3,'USDT',100,10,0.1,1,'{}',now())`,
    [riskProfileId, tenantId, hash()],
  );
  await admin.query(
    `INSERT INTO public.live_grant
    (id,"tenantId","connectionId","credentialId","riskProfileId",mode,"credentialVersion","permissionsVersion","riskPolicyVersion","permissionEpoch","stepUpAt","expiresAt")
    VALUES ($1,$2,$3,$4,$5,'LIVE',1,1,1,1,now(),now()+interval '5 minutes')`,
    [grantId, tenantId, connectionId, credentialId, riskProfileId],
  );
  return grantId;
}

beforeAll(async () => {
  repository = await createAuthDatabase({ connectionString: authUrl, environment: 'test' });
});
afterAll(async () => {
  const results = await Promise.allSettled([
    repository?.close(),
    admin.end(),
    authSql.end(),
    runtime.end(),
  ]);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
});

describe('authentication database boundary', () => {
  it('separates function-only auth, tenant runtime and migration roles', async () => {
    await repository.ready();
    const database = await createDatabase({ connectionString: runtimeUrl, environment: 'test' });
    try {
      await database.ready();
    } finally {
      await database.close();
    }
    await expect(
      createAuthDatabase({ connectionString: runtimeUrl, environment: 'test' }),
    ).rejects.toMatchObject({ code: 'DATABASE_ROLE_UNSAFE' });
    await expect(
      createAuthDatabase({ connectionString: adminUrl, environment: 'test' }),
    ).rejects.toMatchObject({ code: 'DATABASE_ROLE_UNSAFE' });
    await expect(
      createDatabase({ connectionString: authUrl, environment: 'test' }),
    ).rejects.toMatchObject({ code: 'DATABASE_ROLE_UNSAFE' });
    await expect(authSql.query('SELECT * FROM public."user"')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      authSql.query('SELECT "tokenHash" FROM public.user_session'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      authSql.query('SELECT ciphertext FROM public.two_factor_config'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(authSql.query('SELECT ctp_auth._hash_valid($1)', [hash()])).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      runtime.query('SELECT ctp_auth.credentials($1)', ['unknown@auth-fixture.invalid']),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('SELECT "passwordHash" FROM public."user"')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(runtime.query('UPDATE public."user" SET role=\'ADMIN\'')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('retains FORCE RLS and locks down function owners, search_path and PUBLIC execute', async () => {
    const functions = await admin.query<{
      owner: string;
      config: string[];
      publicExecute: boolean;
    }>(`
      SELECT r.rolname AS owner,p.proconfig AS config,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS "publicExecute"
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='ctp_auth'`);
    expect(functions.rows.length).toBeGreaterThan(15);
    for (const row of functions.rows) {
      expect(row.owner).toBe('ctp_auth_owner');
      expect(row.config).toContain('search_path=pg_catalog');
      expect(row.publicExecute).toBe(false);
    }
    const owner = (
      await admin.query<{ safe: boolean }>(
        `SELECT NOT (rolcanlogin OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb) AS safe FROM pg_roles WHERE rolname='ctp_auth_owner'`,
      )
    ).rows[0];
    expect(owner?.safe).toBe(true);
    const secretGrants = await admin.query<{ allowed: boolean }>(`SELECT
      has_column_privilege('ctp_auth_owner','public.two_factor_config','ciphertext','SELECT')
      OR has_column_privilege('ctp_auth_owner','public.recovery_code','codeHash','SELECT')
      OR has_column_privilege('ctp_auth_owner','public.encrypted_credential','ciphertext','SELECT') AS allowed`);
    expect(secretGrants.rows[0]?.allowed).toBe(false);
    const tables = await admin.query<{ forced: boolean }>(
      `SELECT relrowsecurity AND relforcerowsecurity AS forced FROM pg_class WHERE oid IN ('public.user'::regclass,'public.user_session'::regclass,'public.email_verification_token'::regclass,'public.password_reset_token'::regclass)`,
    );
    expect(tables.rows).toHaveLength(4);
    expect(tables.rows.every((row) => row.forced)).toBe(true);
  });

  it('fails readiness when its function owner acquires inherited privileges', async () => {
    try {
      await admin.query('GRANT ctp_api TO ctp_auth_owner');
      await expect(repository.ready()).rejects.toMatchObject({ code: 'DATABASE_ROLE_UNSAFE' });
      await expect(
        createAuthDatabase({ connectionString: authUrl, environment: 'test' }),
      ).rejects.toMatchObject({ code: 'DATABASE_ROLE_UNSAFE' });
    } finally {
      await admin.query('REVOKE ctp_api FROM ctp_auth_owner');
    }
    await repository.ready();
  });

  it('creates USER only, hides unverified credentials and makes verification single use under races', async () => {
    const account = await user(false);
    expect(await repository.credentials(account.emailNormalized)).toBeNull();
    expect(
      await repository.signup({
        emailNormalized: account.emailNormalized,
        passwordHash: replacementHash,
        verificationTokenHash: hash(),
      }),
    ).toBe(false);
    const result = await Promise.all([
      repository.verifyEmail(account.verificationTokenHash),
      repository.verifyEmail(account.verificationTokenHash),
    ]);
    expect(result.sort()).toEqual([false, true]);
    const active = await session(account);
    expect(active.principal.role).toBe('USER');
    expect(active.principal.emailNormalized).toBe(account.emailNormalized);
    expect(await repository.credentials(account.emailNormalized)).toMatchObject({
      passwordHash,
      sessionEpoch: 0,
      requiresMfa: false,
    });
  });

  it('invalidates replaced verification tokens and enforces server expiry', async () => {
    const account = await user(false);
    const next = hash();
    expect(
      await repository.issueVerification({
        emailNormalized: account.emailNormalized,
        tokenHash: next,
      }),
    ).toBe(true);
    expect(await repository.verifyEmail(account.verificationTokenHash)).toBe(false);
    await admin.query(
      'UPDATE public.email_verification_token SET "createdAt"=now()-interval \'1 hour\',"expiresAt"=now()-interval \'1 second\' WHERE "tokenHash"=$1',
      [next],
    );
    expect(await repository.verifyEmail(next)).toBe(false);
    expect(await repository.credentials(account.emailNormalized)).toBeNull();
  });

  it('stores only token hashes and bounds session idle and absolute lifetimes', async () => {
    const active = await session(await user());
    expect(active.principal.expiresAt.getTime() - active.principal.createdAt.getTime()).toBe(
      12 * 60 * 60 * 1000,
    );
    expect(active.principal.idleExpiresAt.getTime() - active.principal.createdAt.getTime()).toBe(
      30 * 60 * 1000,
    );
    const authenticated = await repository.authenticate(active.tokenHash);
    expect(authenticated?.sessionId).toBe(active.principal.sessionId);
    expect(authenticated?.expiresAt).toEqual(active.principal.expiresAt);
    const row = (
      await admin.query<{ tokenHash: Buffer }>(
        'SELECT "tokenHash" FROM public.user_session WHERE id=$1',
        [active.principal.sessionId],
      )
    ).rows[0];
    expect(row?.tokenHash).toEqual(active.tokenHash);
    expect(Object.keys(active.principal)).not.toContain('tokenHash');
    await admin.query(
      'UPDATE public.user_session SET "idleExpiresAt"=now()-interval \'1 second\' WHERE id=$1',
      [active.principal.sessionId],
    );
    expect(await repository.authenticate(active.tokenHash)).toBeNull();
    expect(
      await repository.rotateSession({ tokenHash: active.tokenHash, newTokenHash: hash() }),
    ).toBeNull();
  });

  it('rotates once under replay while preserving absolute expiry', async () => {
    const active = await session(await user());
    const newTokens = [hash(), hash()];
    const rotations = await Promise.all(
      newTokens.map((newTokenHash) =>
        repository.rotateSession({ tokenHash: active.tokenHash, newTokenHash }),
      ),
    );
    expect(rotations.filter(Boolean)).toHaveLength(1);
    const rotated = rotations.find((result) => result !== null);
    expect(rotated?.expiresAt).toEqual(active.principal.expiresAt);
    expect(await repository.authenticate(active.tokenHash)).toBeNull();
    const newSessions = await Promise.all(newTokens.map((token) => repository.authenticate(token)));
    expect(newSessions.filter(Boolean)).toHaveLength(1);
  });

  it('rejects absolute expiry even when an idle deadline is still in the future', async () => {
    const active = await session(await user());
    await admin.query(
      `UPDATE public.user_session SET "createdAt"=now()-interval '13 hours',
        "expiresAt"=now()-interval '1 second',"idleExpiresAt"=now()+interval '10 minutes'
        WHERE id=$1`,
      [active.principal.sessionId],
    );
    expect(await repository.authenticate(active.tokenHash)).toBeNull();
    expect(await repository.listSessions(active.tokenHash)).toEqual([]);
    expect(
      await repository.rotateSession({ tokenHash: active.tokenHash, newTokenHash: hash() }),
    ).toBeNull();
  });

  it('isolates session listing/revocation and ignores a foreign previous login token', async () => {
    const alice = await user();
    const bob = await user();
    const a = await session(alice);
    const b = await session(bob);
    expect((await repository.listSessions(a.tokenHash)).map((s) => s.sessionId)).toEqual([
      a.principal.sessionId,
    ]);
    expect(
      await repository.revokeSession({ tokenHash: a.tokenHash, sessionId: b.principal.sessionId }),
    ).toBe(false);
    const newToken = hash();
    expect(
      await repository.createSession({
        userId: alice.userId,
        expectedPasswordHash: passwordHash,
        expectedSessionEpoch: 0,
        tokenHash: newToken,
        previousTokenHash: b.tokenHash,
      }),
    ).not.toBeNull();
    expect(await repository.authenticate(b.tokenHash)).not.toBeNull();
    expect(
      await repository.revokeSession({ tokenHash: a.tokenHash, sessionId: a.principal.sessionId }),
    ).toBe(true);
    expect(await repository.authenticate(a.tokenHash)).toBeNull();
    await repository.logout(b.tokenHash);
    await repository.logout(b.tokenHash);
    expect(await repository.authenticate(b.tokenHash)).toBeNull();
  });

  it('logout-all advances the epoch so an in-flight password verification cannot create a session', async () => {
    const account = await user();
    const first = await session(account);
    const second = await session(account);
    const staleCredentials = await repository.credentials(account.emailNormalized);
    await repository.revokeAllSessions(first.tokenHash);
    expect(await repository.authenticate(first.tokenHash)).toBeNull();
    expect(await repository.authenticate(second.tokenHash)).toBeNull();
    expect(
      await repository.createSession({
        userId: account.userId,
        expectedPasswordHash: passwordHash,
        expectedSessionEpoch: staleCredentials?.sessionEpoch ?? -1,
        tokenHash: hash(),
      }),
    ).toBeNull();
    expect(await repository.credentials(account.emailNormalized)).toMatchObject({
      sessionEpoch: 1,
    });
  });

  it('reset is single use, invalidates stale credentials and all sessions', async () => {
    const account = await user();
    const active = await session(account);
    const tokenHash = hash();
    expect(
      await repository.issuePasswordReset({ emailNormalized: account.emailNormalized, tokenHash }),
    ).toBe(true);
    const resets = await Promise.all([
      repository.resetPassword({ tokenHash, passwordHash: replacementHash }),
      repository.resetPassword({ tokenHash, passwordHash: replacementHash }),
    ]);
    expect(resets.sort()).toEqual([false, true]);
    expect(await repository.authenticate(active.tokenHash)).toBeNull();
    expect(await repository.credentials(account.emailNormalized)).toMatchObject({
      passwordHash: replacementHash,
      sessionEpoch: 1,
    });
    expect(
      await repository.createSession({
        userId: account.userId,
        expectedPasswordHash: passwordHash,
        expectedSessionEpoch: 0,
        tokenHash: hash(),
      }),
    ).toBeNull();
  });

  it('resend reset invalidates its predecessor and rejects expired reset tokens', async () => {
    const account = await user();
    const first = hash();
    const next = hash();
    await repository.issuePasswordReset({
      emailNormalized: account.emailNormalized,
      tokenHash: first,
    });
    await repository.issuePasswordReset({
      emailNormalized: account.emailNormalized,
      tokenHash: next,
    });
    expect(
      await repository.resetPassword({ tokenHash: first, passwordHash: replacementHash }),
    ).toBe(false);
    const stored = (
      await admin.query<{ lifetime: number }>(
        'SELECT EXTRACT(EPOCH FROM ("expiresAt"-"createdAt"))::integer AS lifetime FROM public.password_reset_token WHERE "tokenHash"=$1',
        [next],
      )
    ).rows[0];
    expect(stored?.lifetime).toBe(15 * 60);
    await admin.query(
      'UPDATE public.password_reset_token SET "createdAt"=now()-interval \'1 hour\',"expiresAt"=now()-interval \'1 second\' WHERE "tokenHash"=$1',
      [next],
    );
    expect(await repository.resetPassword({ tokenHash: next, passwordHash: replacementHash })).toBe(
      false,
    );
  });

  it('rechecks the password and epoch after waiting for a concurrent reset to commit', async () => {
    const account = await user();
    const tokenHash = hash();
    await repository.issuePasswordReset({ emailNormalized: account.emailNormalized, tokenHash });
    const writer = await admin.connect();
    let pending: ReturnType<AuthRepository['createSession']> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM public."user" WHERE id=$1 FOR UPDATE', [account.userId]);
      pending = repository.createSession({
        userId: account.userId,
        expectedPasswordHash: passwordHash,
        expectedSessionEpoch: 0,
        tokenHash: hash(),
      });
      await waitForBlockedLogin();
      const reset = await writer.query<{ changed: boolean }>(
        'SELECT ctp_auth.reset_password($1,$2) AS changed',
        [tokenHash, replacementHash],
      );
      expect(reset.rows[0]?.changed).toBe(true);
      await writer.query('COMMIT');
      expect(await pending).toBeNull();
      expect(await repository.credentials(account.emailNormalized)).toMatchObject({
        passwordHash: replacementHash,
        sessionEpoch: 1,
      });
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await pending;
    }
  });

  it('password change requires the current hash and consumes outstanding resets', async () => {
    const account = await user();
    const active = await session(account);
    const tokenHash = hash();
    await repository.issuePasswordReset({ emailNormalized: account.emailNormalized, tokenHash });
    expect(
      await repository.changePassword({
        tokenHash: active.tokenHash,
        expectedPasswordHash: 'wrong',
        passwordHash: replacementHash,
      }),
    ).toBe(false);
    expect(await repository.authenticate(active.tokenHash)).not.toBeNull();
    expect(
      await repository.changePassword({
        tokenHash: active.tokenHash,
        expectedPasswordHash: passwordHash,
        passwordHash: replacementHash,
      }),
    ).toBe(true);
    expect(await repository.authenticate(active.tokenHash)).toBeNull();
    expect(await repository.resetPassword({ tokenHash, passwordHash })).toBe(false);
  });

  it("password reset atomically revokes only that tenant's LIVE grants", async () => {
    const alice = await user();
    const bob = await user();
    const aGrant = await liveGrant(alice.userId);
    const bGrant = await liveGrant(bob.userId);
    const tokenHash = hash();
    await repository.issuePasswordReset({ emailNormalized: alice.emailNormalized, tokenHash });
    expect(await repository.resetPassword({ tokenHash, passwordHash: replacementHash })).toBe(true);
    const grants = await admin.query<{ id: string; revokedAt: Date | null }>(
      'SELECT id,"revokedAt" FROM public.live_grant WHERE id=ANY($1::uuid[])',
      [[aGrant, bGrant]],
    );
    expect(grants.rows.find((grant) => grant.id === aGrant)?.revokedAt).toBeInstanceOf(Date);
    expect(grants.rows.find((grant) => grant.id === bGrant)?.revokedAt).toBeNull();
  });

  it('fails closed when an account is suspended or promoted to ADMIN', async () => {
    const account = await user();
    const active = await session(account);
    await admin.query('UPDATE public."user" SET status=\'SUSPENDED\' WHERE id=$1', [
      account.userId,
    ]);
    expect(await repository.authenticate(active.tokenHash)).toBeNull();
    expect(await repository.credentials(account.emailNormalized)).toBeNull();
    await admin.query("UPDATE public.\"user\" SET status='ACTIVE',role='ADMIN' WHERE id=$1", [
      account.userId,
    ]);
    expect(await repository.credentials(account.emailNormalized)).toMatchObject({
      requiresMfa: true,
    });
    expect(await repository.authenticate(active.tokenHash)).toBeNull();
    expect(
      await repository.createSession({
        userId: account.userId,
        expectedPasswordHash: passwordHash,
        expectedSessionEpoch: 0,
        tokenHash: hash(),
      }),
    ).toBeNull();
  });

  it('fails closed for enabled MFA without reading encrypted secrets', async () => {
    const account = await user();
    const active = await session(account);
    await admin.query(
      `INSERT INTO public.two_factor_config
      ("tenantId",ciphertext,nonce,tag,"wrappedDek","kmsKeyId","kmsKeyVersion","encryptionVersion","aadVersion","enabledAt","updatedAt")
      VALUES ($1,$2,$3,$4,$2,'fixture-only','1',1,1,now(),now())`,
      [account.userId, hash(), Buffer.alloc(12, 1), Buffer.alloc(16, 2)],
    );
    expect(await repository.credentials(account.emailNormalized)).toMatchObject({
      requiresMfa: true,
    });
    expect(await repository.authenticate(active.tokenHash)).toBeNull();
    expect(
      await repository.createSession({
        userId: account.userId,
        expectedPasswordHash: passwordHash,
        expectedSessionEpoch: 0,
        tokenHash: hash(),
      }),
    ).toBeNull();
    const reset = hash();
    await repository.issuePasswordReset({
      emailNormalized: account.emailNormalized,
      tokenHash: reset,
    });
    expect(
      await repository.resetPassword({ tokenHash: reset, passwordHash: replacementHash }),
    ).toBe(true);
    expect(await repository.credentials(account.emailNormalized)).toMatchObject({
      passwordHash: replacementHash,
      sessionEpoch: 1,
      requiresMfa: true,
    });
    expect(
      await repository.createSession({
        userId: account.userId,
        expectedPasswordHash: replacementHash,
        expectedSessionEpoch: 1,
        tokenHash: hash(),
      }),
    ).toBeNull();
  });

  it('rechecks MFA after waiting for a concurrent User lock', async () => {
    const account = await user();
    const writer = await admin.connect();
    let pending: ReturnType<AuthRepository['createSession']> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM public."user" WHERE id=$1 FOR UPDATE', [account.userId]);
      pending = repository.createSession({
        userId: account.userId,
        expectedPasswordHash: passwordHash,
        expectedSessionEpoch: 0,
        tokenHash: hash(),
      });
      await waitForBlockedLogin();
      await writer.query(
        `INSERT INTO public.two_factor_config
        ("tenantId",ciphertext,nonce,tag,"wrappedDek","kmsKeyId","kmsKeyVersion","encryptionVersion","aadVersion","enabledAt","updatedAt")
        VALUES ($1,$2,$3,$4,$2,'fixture-only','1',1,1,now(),now())`,
        [account.userId, hash(), Buffer.alloc(12, 1), Buffer.alloc(16, 2)],
      );
      await writer.query('COMMIT');
      expect(await pending).toBeNull();
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await pending;
    }
  });

  it('never exposes PostgreSQL input or error diagnostics through its repository', async () => {
    await expect(
      repository.signup({
        emailNormalized: 'secret-input\n@invalid',
        passwordHash,
        verificationTokenHash: hash(),
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_FAILED', message: 'Database operation failed' });
    expect(await repository.authenticate(Buffer.alloc(31))).toBeNull();
    expect(await repository.verifyEmail(hash())).toBe(false);
  });
});
