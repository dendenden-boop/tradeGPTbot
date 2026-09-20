import { DatabaseError, validateDatabaseOptions } from './connection-options.js';
export { DatabaseError } from './connection-options.js';
export {
  createAuthDatabase,
  type AuthRepository,
  type AuthPrincipal,
  type AuthCredentials,
  type SessionSummary,
} from './auth-database.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolClient } from 'pg';
import { PrismaClient, Prisma } from './generated/client.js';
import { DecimalInputError, validateDecimalArguments } from './decimal-guard.js';

export { decimalText, type DecimalKind } from './decimal.js';
export type TenantTransaction = Parameters<
  Parameters<ReturnType<typeof withDecimalGuard>['$transaction']>[0]
>[0];

function withDecimalGuard(client: PrismaClient) {
  return client.$extends({
    name: 'canonical-decimal-input',
    query: {
      $allModels: {
        $allOperations({ model, args, query }) {
          validateDecimalArguments(model, args);
          return query(args);
        },
      },
    },
  });
}

function safeCode(error: unknown): string {
  if (error instanceof DecimalInputError) return 'DATABASE_DECIMAL_INVALID';
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
  validateDatabaseOptions(options);
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
  const checkRole = async () => {
    const roles = await client.$queryRaw<{ privileged: boolean }[]>`
      SELECT current_user <> session_user OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
        OR NOT pg_has_role(current_user, 'ctp_api', 'MEMBER')
        OR EXISTS (SELECT 1 FROM pg_roles boundary WHERE boundary.rolname IN ('ctp_auth','ctp_auth_owner')
          AND pg_has_role(current_user,boundary.oid,'MEMBER'))
        OR has_schema_privilege(current_user, 'public', 'CREATE')
        OR EXISTS (SELECT 1 FROM pg_roles inherited
          WHERE (inherited.rolsuper OR inherited.rolbypassrls OR inherited.rolcreaterole OR inherited.rolcreatedb OR inherited.rolreplication)
            AND pg_has_role(current_user, inherited.oid, 'MEMBER'))
        OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p')
            AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS privileged
      FROM pg_roles r WHERE r.rolname=current_user`;
    if (roles.length !== 1 || roles[0]?.privileged !== false)
      throw new DatabaseError('DATABASE_ROLE_UNSAFE');
  };
  try {
    await checkRole();
  } catch (error) {
    await disconnect().catch(() => {});
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError(safeCode(error));
  }
  let closing: Promise<void> | undefined;
  const guardedClient = withDecimalGuard(client);
  return Object.freeze({
    async ready(): Promise<void> {
      if (closing) throw new DatabaseError('DATABASE_CLOSED');
      try {
        await checkRole();
        // Parsing verifies migration 004 and the safe User column grants without reading tenant data.
        await client.$queryRaw`SELECT id,"emailNormalized",status,role,"emailVerifiedAt" FROM public."user" LIMIT 0`;
      } catch (error) {
        if (error instanceof DatabaseError) throw error;
        throw new DatabaseError(safeCode(error));
      }
    },
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
        return await guardedClient.$transaction(
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
