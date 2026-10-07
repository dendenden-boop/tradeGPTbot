import { Client } from 'pg';
import { Socket } from 'node:net';
import { z } from 'zod';
import {
  createRuntimeInstrumentRegistry,
  instrumentRecordSchema,
  marketScopeSchema,
  type InstrumentRecord,
  type MarketScope,
  type RegistryIo,
  type RegistryReceipt,
} from '@ctp/exchange-core';

/** Server-only PostgreSQL metadata authority; no tenant/account/mutation grant. */
export async function createPostgresInstrumentRegistry(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
  scope: MarketScope;
  instrumentIds: readonly string[];
  io?: RegistryIo;
}) {
  const scope = marketScopeSchema.parse(options.scope);
  try {
    const u = new URL(options.connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(u.protocol) ||
      !u.username ||
      !u.pathname.slice(1) ||
      u.hash ||
      [...u.searchParams.keys()].some((k) => k !== 'sslmode') ||
      (options.environment === 'production' && u.searchParams.get('sslmode') !== 'verify-full') ||
      (options.environment === 'test' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
    )
      throw new Error();
    z.enum(['test', 'development', 'staging', 'production']).parse(options.environment);
    z.string().max(4096).parse(options.connectionString);
  } catch {
    throw new Error('REGISTRY_DATABASE_URL');
  }
  const sockets = new Set<Socket>();
  let closed = false;
  async function tx<T>(io: RegistryIo, work: (p: Client) => Promise<T>): Promise<T> {
    if (
      closed ||
      io.signal.aborted ||
      !Number.isSafeInteger(io.deadline) ||
      io.deadline <= Date.now()
    )
      throw new Error('REGISTRY_ABORTED');
    if (sockets.size >= 4) throw new Error('REGISTRY_BUSY');
    // Own the physical stream before connect(): Pool.connect() does not expose
    // a pending authentication socket to a caller's abort handler.
    const socket = new Socket();
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const p = new Client({
      connectionString: options.connectionString,
      stream: () => socket,
      connectionTimeoutMillis: 1000,
      statement_timeout: 2000,
      query_timeout: 2500,
      // On the accepted Linux PostgreSQL server profile, detect socket loss
      // during a running statement/lock wait instead of waiting for its reply.
      options:
        '-c idle_in_transaction_session_timeout=3000 -c client_connection_check_interval=100ms',
    });
    p.on('error', () => {});
    let destroyed = false;
    const abort = () => {
      if (!destroyed) {
        destroyed = true;
        socket.destroy(new Error('REGISTRY_ABORTED'));
      }
    };
    io.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, io.deadline - Date.now()));
    try {
      await p.connect();
      if (destroyed || io.signal.aborted) throw new Error('REGISTRY_ABORTED');
      await p.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(p);
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('REGISTRY_ABORTED');
      await p.query('COMMIT');
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('REGISTRY_ABORTED');
      return result;
    } catch (error) {
      if (!destroyed) await p.query('ROLLBACK').catch(() => {});
      throw new Error(
        destroyed ||
          io.signal.aborted ||
          (error instanceof Error && error.message === 'REGISTRY_ABORTED')
          ? 'REGISTRY_ABORTED'
          : 'REGISTRY_STORE_FAILED',
        {
          // eslint-disable-next-line preserve-caught-error -- SQL payloads or connection secrets must never escape the server port.
          cause: new Error('REGISTRY_TRANSACTION_FAILED'),
        },
      );
    } finally {
      clearTimeout(timer);
      io.signal.removeEventListener('abort', abort);
      socket.destroy();
      await p.end().catch(() => {});
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    const closing = [...sockets].map(
      (socket) => new Promise<void>((resolve) => socket.once('close', () => resolve())),
    );
    for (const socket of sockets) socket.destroy(new Error('REGISTRY_CLOSED'));
    await Promise.all(closing);
  }
  try {
    await tx(
      options.io ?? { signal: new AbortController().signal, deadline: Date.now() + 3000 },
      async (p) => {
        const r = await p.query<{ safe: boolean }>(`SELECT current_user=session_user
       AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
       AND pg_has_role(current_user,'ctp_instrument_registry','MEMBER')
       AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_instrument_registry' AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
       AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE x.rolname<>current_user AND x.rolname<>'ctp_instrument_registry' AND pg_has_role(current_user,x.oid,'MEMBER'))
       AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
       AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk','ctp_registry') AND (has_schema_privilege(current_user,n.oid,'CREATE') OR pg_has_role(current_user,n.nspowner,'MEMBER')))
       AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk','ctp_registry') AND t.relkind IN('r','p','v','m','f') AND (pg_has_role(current_user,t.relowner,'MEMBER') OR has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
       AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname IN('ctp_registry','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND has_function_privilege(current_user,f.oid,'EXECUTE') AND f.oid NOT IN('ctp_registry.publish(jsonb,jsonb)'::regprocedure::oid,'ctp_registry.read_current(jsonb,jsonb)'::regprocedure::oid))
       AND has_function_privilege(current_user,'ctp_registry.publish(jsonb,jsonb)','EXECUTE')
       AND has_function_privilege(current_user,'ctp_registry.read_current(jsonb,jsonb)','EXECUTE') AS safe FROM pg_roles r WHERE r.rolname=current_user`);
        if (r.rows[0]?.safe !== true) throw new Error('REGISTRY_ROLE_UNSAFE');
      },
    );
  } catch {
    await close();
    throw new Error('REGISTRY_ROLE_UNSAFE');
  }
  const receipts = z
    .array(
      z.strictObject({
        revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
        record: instrumentRecordSchema,
      }),
    )
    .max(300);
  async function read(ids: readonly string[], io: RegistryIo): Promise<readonly RegistryReceipt[]> {
    return tx(io, async (p) => {
      const r = await p.query<{ result: unknown }>(
        'SELECT ctp_registry.read_current($1::jsonb,$2::jsonb) AS result',
        [JSON.stringify(scope), JSON.stringify(ids)],
      );
      return receipts.parse(r.rows[0]?.result);
    });
  }
  async function publish(
    records: readonly InstrumentRecord[],
    io: RegistryIo,
  ): Promise<readonly RegistryReceipt[]> {
    return tx(io, async (p) => {
      const r = await p.query<{ result: unknown }>(
        'SELECT ctp_registry.publish($1::jsonb,$2::jsonb) AS result',
        [JSON.stringify(scope), JSON.stringify(records)],
      );
      return receipts.parse(r.rows[0]?.result);
    });
  }
  try {
    return await createRuntimeInstrumentRegistry({
      scope,
      instrumentIds: options.instrumentIds,
      store: { read, publish, close },
    });
  } catch (error) {
    await close();
    throw error;
  }
}
