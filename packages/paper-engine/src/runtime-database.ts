import { Socket } from 'node:net';
import { Client } from 'pg';
import { z } from 'zod';
import { postgresRoleBoundary } from '@ctp/exchange-core';
import type { PaperConfigurationIo } from './configuration-domain.js';

export interface PaperRuntimeDatabaseOptions {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
  io?: PaperConfigurationIo;
}
/** Private fixed-role physical transport; callers cannot override role or RPC. */
export async function openPaperRuntimeDatabase(
  options: PaperRuntimeDatabaseOptions,
  authority: 'OBSERVER' | 'READER',
) {
  const group =
    authority === 'OBSERVER' ? 'ctp_paper_runtime_observer' : 'ctp_paper_runtime_reader';
  const functions =
    authority === 'OBSERVER'
      ? [
          'ctp_paper.publish_runtime_observation(text)',
          'ctp_paper.lookup_runtime_observation(jsonb)',
          'ctp_paper.read_runtime_observation_context(jsonb)',
        ]
      : ['ctp_paper.capture_runtime_observation(jsonb)'];
  try {
    z.strictObject({
      connectionString: z.string().min(1).max(4096),
      environment: z.enum(['test', 'development', 'staging', 'production']),
      io: z
        .strictObject({ signal: z.instanceof(AbortSignal), deadline: z.number().int().safe() })
        .optional(),
    }).parse(options);
    const u = new URL(options.connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(u.protocol) ||
      !u.username ||
      !u.password ||
      !u.pathname.slice(1) ||
      u.pathname.slice(1).includes('/') ||
      u.hash ||
      [...u.searchParams.keys()].some((k) => k !== 'sslmode') ||
      [...u.searchParams.keys()].length > 1 ||
      (['staging', 'production'].includes(options.environment) &&
        (u.searchParams.get('sslmode') !== 'verify-full' ||
          process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0')) ||
      (options.environment === 'test' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
    )
      throw new Error();
  } catch {
    throw new Error('PAPER_RUNTIME_DATABASE_URL');
  }
  const sockets = new Set<Socket>();
  let closed = false;
  async function tx<T>(
    tenantId: string | null,
    io: PaperConfigurationIo,
    work: (p: Client) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error('PAPER_RUNTIME_CLOSED');
    if (
      !z
        .strictObject({ signal: z.instanceof(AbortSignal), deadline: z.number().int().safe() })
        .safeParse(io).success
    )
      throw new Error('PAPER_RUNTIME_INPUT');
    if (io.signal.aborted || !Number.isSafeInteger(io.deadline) || io.deadline <= Date.now())
      throw new Error('PAPER_RUNTIME_ABORTED');
    if (sockets.size >= 4) throw new Error('PAPER_RUNTIME_BUSY');
    const socket = new Socket();
    socket.on('error', () => {});
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const p = new Client({
      connectionString: options.connectionString,
      stream: () => socket,
      connectionTimeoutMillis: 1000,
      statement_timeout: 2000,
      query_timeout: 2500,
      options:
        '-c idle_in_transaction_session_timeout=3000 -c client_connection_check_interval=100ms',
    });
    p.on('error', () => {});
    let destroyed = false,
      committing = false;
    const abort = () => {
      if (!destroyed) {
        destroyed = true;
        socket.destroy(new Error('PAPER_RUNTIME_ABORTED'));
      }
    };
    io.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, io.deadline - Date.now()));
    try {
      await p.connect();
      if (destroyed || io.signal.aborted) throw new Error('PAPER_RUNTIME_ABORTED');
      await p.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (tenantId) await p.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await work(p);
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('PAPER_RUNTIME_ABORTED');
      committing = true;
      await p.query('COMMIT');
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('PAPER_RUNTIME_UNCERTAIN');
      return result;
    } catch (error) {
      if (!destroyed) await p.query('ROLLBACK').catch(() => {});
      const known = [
        'PAPER_RUNTIME_EPOCH',
        'PAPER_RUNTIME_ORDERING',
        'PAPER_RUNTIME_OWNERSHIP',
        'PAPER_RUNTIME_INPUT',
        'PAPER_RUNTIME_CORRUPT',
        'PAPER_RUNTIME_MISSING',
        'PAPER_RUNTIME_INCOMPLETE',
        'PAPER_RUNTIME_MARKET',
        'PAPER_RUNTIME_CAPACITY',
        'PAPER_RUNTIME_ROLE_UNSAFE',
        'PAPER_RUNTIME_STALE',
      ];
      const code = committing
        ? 'PAPER_RUNTIME_UNCERTAIN'
        : destroyed || io.signal.aborted
          ? 'PAPER_RUNTIME_ABORTED'
          : error instanceof Error && known.includes(error.message)
            ? error.message
            : 'PAPER_RUNTIME_STORE_FAILED';
      throw new Error(code, {
        // eslint-disable-next-line preserve-caught-error -- SQL payloads and connection secrets must not cross the server port.
        cause: new Error('PAPER_RUNTIME_TRANSACTION_FAILED'),
      });
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
      (s) => new Promise<void>((resolve) => s.once('close', () => resolve())),
    );
    for (const s of sockets) s.destroy(new Error('PAPER_RUNTIME_CLOSED'));
    await Promise.all(closing);
  }
  try {
    await tx(
      null,
      options.io ?? { signal: new AbortController().signal, deadline: Date.now() + 3000 },
      async (p) => {
        const r = await p.query<{ safe: boolean }>(`SELECT current_user=session_user
        AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND pg_has_role(current_user,'${group}','MEMBER')
        AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
        AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
          AND t.relkind IN('r','p','v','m','f') AND (has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
          OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        AND (${functions.map((fn) => `has_function_privilege(current_user,'${fn}','EXECUTE')`).join(' AND ')})
        AND (${postgresRoleBoundary(group, functions)}) AS safe
        FROM pg_roles r WHERE r.rolname=current_user`);
        if (r.rows[0]?.safe !== true) throw new Error('PAPER_RUNTIME_ROLE_UNSAFE');
      },
    );
  } catch {
    await close();
    throw new Error('PAPER_RUNTIME_ROLE_UNSAFE');
  }
  return Object.freeze({ tx, close });
}
