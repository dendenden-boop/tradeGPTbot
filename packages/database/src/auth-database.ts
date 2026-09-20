import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  DatabaseError,
  validateDatabaseOptions,
  type DatabaseOptions,
} from './connection-options.js';

export interface AuthPrincipal {
  userId: string;
  emailNormalized: string;
  role: 'USER' | 'ADMIN';
  sessionId: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  expiresAt: Date;
}

export interface AuthCredentials {
  userId: string;
  passwordHash: string;
  sessionEpoch: number;
  requiresMfa: boolean;
}

export type SessionSummary = Pick<
  AuthPrincipal,
  'sessionId' | 'createdAt' | 'lastSeenAt' | 'idleExpiresAt' | 'expiresAt'
>;

export interface AuthRepository {
  signup(input: {
    emailNormalized: string;
    passwordHash: string;
    verificationTokenHash: Buffer;
  }): Promise<boolean>;
  issueVerification(input: { emailNormalized: string; tokenHash: Buffer }): Promise<boolean>;
  verifyEmail(tokenHash: Buffer): Promise<boolean>;
  credentials(emailNormalized: string): Promise<AuthCredentials | null>;
  createSession(input: {
    userId: string;
    expectedPasswordHash: string;
    expectedSessionEpoch: number;
    tokenHash: Buffer;
    previousTokenHash?: Buffer;
  }): Promise<AuthPrincipal | null>;
  authenticate(tokenHash: Buffer): Promise<AuthPrincipal | null>;
  rotateSession(input: { tokenHash: Buffer; newTokenHash: Buffer }): Promise<AuthPrincipal | null>;
  logout(tokenHash: Buffer): Promise<void>;
  listSessions(tokenHash: Buffer): Promise<SessionSummary[]>;
  revokeSession(input: { tokenHash: Buffer; sessionId: string }): Promise<boolean>;
  revokeAllSessions(tokenHash: Buffer): Promise<void>;
  issuePasswordReset(input: { emailNormalized: string; tokenHash: Buffer }): Promise<boolean>;
  resetPassword(input: { tokenHash: Buffer; passwordHash: string }): Promise<boolean>;
  changePassword(input: {
    tokenHash: Buffer;
    expectedPasswordHash: string;
    passwordHash: string;
  }): Promise<boolean>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

/** Only this pool can invoke the pre-tenant functions; it has no raw application-table access. */
export async function createAuthDatabase(options: DatabaseOptions): Promise<AuthRepository> {
  validateDatabaseOptions(options);
  const connections = new Set<PoolClient>();
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 3,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 3000,
    query_timeout: 3500,
    options: '-c idle_in_transaction_session_timeout=5000',
  });
  pool.on('error', () => {});
  pool.on('connect', (connection) => {
    connections.add(connection);
    connection.once('end', () => connections.delete(connection));
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pool.end(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              for (const connection of connections) void connection.end().catch(() => {});
              reject(new DatabaseError('DATABASE_CLOSE_TIMEOUT'));
            }, 8000);
          }),
        ]);
      } catch (error) {
        if (error instanceof DatabaseError) throw error;
        throw new DatabaseError('DATABASE_CLOSE_FAILED');
      } finally {
        clearTimeout(timer);
      }
    })();
    return closing;
  };
  const query = async <T extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> => {
    if (closing) throw new DatabaseError('DATABASE_CLOSED');
    try {
      return (await pool.query<T>(sql, values)).rows;
    } catch {
      // Never return pg messages, SQL, arguments or connection errors to callers/logs.
      throw new DatabaseError('DATABASE_FAILED');
    }
  };
  const boolean = async (sql: string, values: unknown[]): Promise<boolean> => {
    const result = await query<{ result: boolean }>(sql, values);
    if (result.length !== 1 || typeof result[0]?.result !== 'boolean') {
      throw new DatabaseError('DATABASE_RESULT_INVALID');
    }
    return result[0].result;
  };
  const principal = async (sql: string, values: unknown[]): Promise<AuthPrincipal | null> => {
    const rows = await query<AuthPrincipal>(sql, values);
    return rows[0] ?? null;
  };
  const ready = async (): Promise<void> => {
    const roles = await query<{ safe: boolean }>(`
      SELECT current_user = session_user AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
        AND pg_has_role(current_user, 'ctp_auth', 'MEMBER')
        AND NOT pg_has_role(current_user, 'ctp_api', 'MEMBER')
        AND NOT pg_has_role(current_user, 'ctp_auth_owner', 'MEMBER')
        AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
        AND NOT has_schema_privilege(current_user, 'ctp_auth', 'CREATE')
        AND NOT EXISTS (SELECT 1 FROM pg_roles boundary
          WHERE boundary.rolname IN ('ctp_auth','ctp_auth_owner')
            AND (boundary.rolsuper OR boundary.rolbypassrls OR boundary.rolcreaterole
              OR boundary.rolcreatedb OR boundary.rolreplication OR boundary.rolcanlogin
              OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=boundary.oid)))
        AND NOT EXISTS (SELECT 1 FROM pg_roles inherited
          WHERE (inherited.rolsuper OR inherited.rolbypassrls OR inherited.rolcreaterole OR inherited.rolcreatedb OR inherited.rolreplication)
            AND pg_has_role(current_user, inherited.oid, 'MEMBER'))
        AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p')
            AND (pg_has_role(current_user,c.relowner,'MEMBER')
              OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
              OR has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER')))
        AS safe FROM pg_roles r WHERE r.rolname=current_user`);
    if (roles.length !== 1 || roles[0]?.safe !== true)
      throw new DatabaseError('DATABASE_ROLE_UNSAFE');
    const version = await query<{ version: number }>('SELECT ctp_auth.schema_version() AS version');
    if (version.length !== 1 || version[0]?.version !== 4)
      throw new DatabaseError('DATABASE_SCHEMA_INVALID');
  };
  try {
    await ready();
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return Object.freeze({
    signup: (input) =>
      boolean('SELECT ctp_auth.signup($1,$2,$3) AS result', [
        input.emailNormalized,
        input.passwordHash,
        input.verificationTokenHash,
      ]),
    issueVerification: (input) =>
      boolean('SELECT ctp_auth.issue_verification($1,$2) AS result', [
        input.emailNormalized,
        input.tokenHash,
      ]),
    verifyEmail: (tokenHash) => boolean('SELECT ctp_auth.verify_email($1) AS result', [tokenHash]),
    async credentials(emailNormalized) {
      return (
        (
          await query<AuthCredentials>('SELECT * FROM ctp_auth.credentials($1)', [emailNormalized])
        )[0] ?? null
      );
    },
    createSession: (input) =>
      principal('SELECT * FROM ctp_auth.create_session($1,$2,$3,$4,$5)', [
        input.userId,
        input.expectedPasswordHash,
        input.expectedSessionEpoch,
        input.tokenHash,
        input.previousTokenHash ?? null,
      ]),
    authenticate: (tokenHash) => principal('SELECT * FROM ctp_auth.authenticate($1)', [tokenHash]),
    rotateSession: (input) =>
      principal('SELECT * FROM ctp_auth.rotate_session($1,$2)', [
        input.tokenHash,
        input.newTokenHash,
      ]),
    async logout(tokenHash) {
      await query('SELECT ctp_auth.logout($1)', [tokenHash]);
    },
    listSessions: (tokenHash) =>
      query<SessionSummary>('SELECT * FROM ctp_auth.list_sessions($1)', [tokenHash]),
    revokeSession: (input) =>
      boolean('SELECT ctp_auth.revoke_session($1,$2) AS result', [
        input.tokenHash,
        input.sessionId,
      ]),
    async revokeAllSessions(tokenHash) {
      await query('SELECT ctp_auth.revoke_all_sessions($1)', [tokenHash]);
    },
    issuePasswordReset: (input) =>
      boolean('SELECT ctp_auth.issue_password_reset($1,$2) AS result', [
        input.emailNormalized,
        input.tokenHash,
      ]),
    resetPassword: (input) =>
      boolean('SELECT ctp_auth.reset_password($1,$2) AS result', [
        input.tokenHash,
        input.passwordHash,
      ]),
    changePassword: (input) =>
      boolean('SELECT ctp_auth.change_password($1,$2,$3) AS result', [
        input.tokenHash,
        input.expectedPasswordHash,
        input.passwordHash,
      ]),
    ready,
    close,
  } satisfies AuthRepository);
}
