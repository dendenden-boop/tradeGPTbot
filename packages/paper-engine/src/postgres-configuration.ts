import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { Client } from 'pg';
import { z } from 'zod';
import { immutable, postgresRoleBoundary } from '@ctp/exchange-core';
import {
  paperConfigurationSchema,
  paperConfigurationReceiptSchema,
  paperOwnerSchema,
  type PaperConfigurationIo,
  type PaperConfigurationStore,
} from './configuration-domain.js';

/** Server-owned configuration persistence only; no funding, Risk or dispatch authority. */
export async function createPostgresPaperConfiguration(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
  io?: PaperConfigurationIo;
}): Promise<PaperConfigurationStore> {
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
    throw new Error('PAPER_CONFIGURATION_DATABASE_URL');
  }
  const sockets = new Set<Socket>();
  let closed = false;
  async function tx<T>(
    tenantId: string | null,
    io: PaperConfigurationIo,
    work: (p: Client) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error('PAPER_CONFIGURATION_CLOSED');
    if (io.signal.aborted || !Number.isSafeInteger(io.deadline) || io.deadline <= Date.now())
      throw new Error('PAPER_CONFIGURATION_ABORTED');
    if (sockets.size >= 4) throw new Error('PAPER_CONFIGURATION_BUSY');
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
        socket.destroy(new Error('PAPER_CONFIGURATION_ABORTED'));
      }
    };
    io.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, io.deadline - Date.now()));
    try {
      await p.connect();
      if (destroyed || io.signal.aborted) throw new Error('PAPER_CONFIGURATION_ABORTED');
      await p.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (tenantId) await p.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await work(p);
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('PAPER_CONFIGURATION_ABORTED');
      committing = true;
      await p.query('COMMIT');
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('PAPER_CONFIGURATION_UNCERTAIN');
      return result;
    } catch (error) {
      if (!destroyed) await p.query('ROLLBACK').catch(() => {});
      const known = [
        'PAPER_CONFIGURATION_CONFLICT',
        'PAPER_CONFIGURATION_OWNERSHIP',
        'PAPER_CONFIGURATION_INPUT',
        'PAPER_CONFIGURATION_CORRUPT',
        'PAPER_CONFIGURATION_MISSING',
        'PAPER_CONFIGURATION_ROLE_UNSAFE',
      ];
      const code = committing
        ? 'PAPER_CONFIGURATION_UNCERTAIN'
        : destroyed || io.signal.aborted
          ? 'PAPER_CONFIGURATION_ABORTED'
          : error instanceof Error && known.includes(error.message)
            ? error.message
            : 'PAPER_CONFIGURATION_STORE_FAILED';
      throw new Error(code, {
        // eslint-disable-next-line preserve-caught-error -- SQL payloads and connection secrets must not cross the server port.
        cause: new Error('PAPER_CONFIGURATION_TRANSACTION_FAILED'),
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
    for (const s of sockets) s.destroy(new Error('PAPER_CONFIGURATION_CLOSED'));
    await Promise.all(closing);
  }
  try {
    await tx(
      null,
      options.io ?? { signal: new AbortController().signal, deadline: Date.now() + 3000 },
      async (p) => {
        const r = await p.query<{ safe: boolean }>(`SELECT current_user=session_user
        AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND pg_has_role(current_user,'ctp_paper_configuration','MEMBER')
        AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
        AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
          AND t.relkind IN('r','p','v','m','f') AND (has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
          OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        AND has_function_privilege(current_user,'ctp_paper.register_configuration(text)','EXECUTE')
        AND has_function_privilege(current_user,'ctp_paper.read_configuration(jsonb)','EXECUTE')
        AND (${postgresRoleBoundary('ctp_paper_configuration', ['ctp_paper.register_configuration(text)', 'ctp_paper.read_configuration(jsonb)'])}) AS safe
        FROM pg_roles r WHERE r.rolname=current_user`);
        if (r.rows[0]?.safe !== true) throw new Error('PAPER_CONFIGURATION_ROLE_UNSAFE');
      },
    );
  } catch {
    await close();
    throw new Error('PAPER_CONFIGURATION_ROLE_UNSAFE');
  }
  function decode(raw: unknown) {
    const wire = z
      .strictObject({
        receiptText: z.string().max(8192),
        hash: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .parse(raw);
    if (createHash('sha256').update(wire.receiptText).digest('hex') !== wire.hash)
      throw new Error('PAPER_CONFIGURATION_CORRUPT');
    return immutable(paperConfigurationReceiptSchema.parse(JSON.parse(wire.receiptText)));
  }
  return Object.freeze({
    async register(raw: unknown, io: PaperConfigurationIo) {
      const c = paperConfigurationSchema.parse(raw);
      return tx(c.owner.tenantId, io, async (p) => {
        const r = await p.query<{ result: unknown }>(
          'SELECT ctp_paper.register_configuration($1::text) AS result',
          [JSON.stringify(c)],
        );
        const receipt = decode(r.rows[0]?.result);
        if (JSON.stringify(receipt.configuration) !== JSON.stringify(c))
          throw new Error('PAPER_CONFIGURATION_CORRUPT');
        return receipt;
      });
    },
    async read(raw: unknown, io: PaperConfigurationIo) {
      const owner = paperOwnerSchema.parse(raw);
      return tx(owner.tenantId, io, async (p) => {
        const r = await p.query<{ result: unknown }>(
          'SELECT ctp_paper.read_configuration($1::jsonb) AS result',
          [JSON.stringify(owner)],
        );
        const receipt = decode(r.rows[0]?.result);
        if (JSON.stringify(receipt.configuration.owner) !== JSON.stringify(owner))
          throw new Error('PAPER_CONFIGURATION_CORRUPT');
        return receipt;
      });
    },
    close,
  });
}
