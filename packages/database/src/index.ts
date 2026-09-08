import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolClient } from 'pg';
import { PrismaClient, Prisma } from './generated/client.js';

export { decimalText, type DecimalKind } from './decimal.js';
export type TenantTransaction = Prisma.TransactionClient;

export class DatabaseError extends Error {
  constructor(readonly code: string) {
    super('Database operation failed');
    this.name = 'DatabaseError';
  }
}

function safeCode(error: unknown): string {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ['P2002', 'P2003', 'P2004', 'P2025', 'P2034'].includes(error.code)
  )
    return error.code;
  return 'DATABASE_FAILED';
}

/** The caller supplies a trusted authenticated principal, never a request-body tenantId. */
export async function createDatabase(options: {
  connectionString: string;
  environment: 'development' | 'test' | 'staging' | 'production';
}) {
  if (!['development', 'test', 'staging', 'production'].includes(options.environment)) {
    throw new DatabaseError('DATABASE_ENVIRONMENT_INVALID');
  }
  let url: URL;
  try {
    if (options.connectionString.length > 4096) throw new Error();
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
    !url.pathname.slice(1)
  ) {
    throw new DatabaseError('DATABASE_URL_INVALID');
  }
  if (
    ['staging', 'production'].includes(options.environment) &&
    (url.searchParams.get('sslmode') !== 'verify-full' ||
      decodeURIComponent(url.password).length < 16 ||
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0')
  ) {
    throw new DatabaseError('DATABASE_TLS_REQUIRED');
  }
  let pool: Pool;
  let client: PrismaClient;
  const connections = new Set<PoolClient>();
  try {
    pool = new Pool({
      connectionString: options.connectionString,
      max: 5,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 3000,
      query_timeout: 3500,
      options: '-c idle_in_transaction_session_timeout=5000',
    });
    pool.on('connect', (connection) => {
      connections.add(connection);
      connection.once('end', () => connections.delete(connection));
    });
    client = new PrismaClient({
      adapter: new PrismaPg(pool, {
        disposeExternalPool: true,
        // A disconnected idle connection is discarded by pg; the next operation reports a safe failure.
        onPoolError: () => {},
        onConnectionError: () => {},
      }),
      log: [],
      errorFormat: 'minimal',
    });
  } catch {
    throw new DatabaseError('DATABASE_URL_INVALID');
  }
  const disconnect = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.$disconnect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Only connections owned by this handle; end() destroys a stalled active socket.
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
  };
  try {
    const roles = await client.$queryRaw<{ privileged: boolean }[]>`
      SELECT current_user <> session_user OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb
        OR has_schema_privilege(current_user, 'public', 'CREATE')
        OR EXISTS (SELECT 1 FROM pg_roles inherited
          WHERE (inherited.rolsuper OR inherited.rolbypassrls OR inherited.rolcreaterole OR inherited.rolcreatedb)
            AND pg_has_role(current_user, inherited.oid, 'MEMBER'))
        OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p')
            AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS privileged
      FROM pg_roles r WHERE r.rolname=current_user`;
    if (roles.length !== 1 || roles[0]?.privileged !== false)
      throw new DatabaseError('DATABASE_ROLE_UNSAFE');
  } catch (error) {
    await disconnect().catch(() => {});
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError(safeCode(error));
  }
  let closing: Promise<void> | undefined;
  return Object.freeze({
    async withTenant<T>(
      tenantId: string,
      operation: (transaction: TenantTransaction) => Promise<T>,
    ): Promise<T> {
      if (
        typeof tenantId !== 'string' ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.exec(
          tenantId,
        )?.[0] !== tenantId
      ) {
        throw new DatabaseError('TENANT_ID_INVALID');
      }
      if (closing) throw new DatabaseError('DATABASE_CLOSED');
      try {
        return await client.$transaction(
          async (transaction) => {
            await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
            return operation(transaction);
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 1000,
            timeout: 5000,
          },
        );
      } catch (error) {
        // No automatic retries: callers must decide whether a whole transaction is replay-safe.
        throw new DatabaseError(safeCode(error));
      }
    },
    close(): Promise<void> {
      closing ??= disconnect();
      return closing;
    },
  });
}
