import { paperOwnerSchema } from './configuration-domain.js';
import { Socket } from 'node:net';
import { Client } from 'pg';
import { z } from 'zod';
import { postgresRoleBoundary } from '@ctp/exchange-core';
import { type PaperFundingIo } from './funding-domain.js';
import {
  decodePaperRiskValuationSource,
  type PaperRiskValuationReader,
} from './risk-valuation-domain.js';

/** Read-only coherent inventory/public-price source; no initializer, financial or Risk/dispatch authority. */
export async function createPostgresPaperRiskValuationSource(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
  io?: PaperFundingIo;
}): Promise<PaperRiskValuationReader> {
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
    throw new Error('PAPER_RISK_VALUATION_DATABASE_URL');
  }
  const sockets = new Set<Socket>();
  let closed = false;
  async function tx<T>(
    tenantId: string | null,
    io: PaperFundingIo,
    work: (p: Client) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error('PAPER_RISK_VALUATION_CLOSED');
    if (
      !z
        .strictObject({ signal: z.instanceof(AbortSignal), deadline: z.number().int().safe() })
        .safeParse(io).success
    )
      throw new Error('PAPER_RISK_VALUATION_INPUT');
    if (io.signal.aborted || !Number.isSafeInteger(io.deadline) || io.deadline <= Date.now())
      throw new Error('PAPER_RISK_VALUATION_ABORTED');
    if (sockets.size >= 4) throw new Error('PAPER_RISK_VALUATION_BUSY');
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
        socket.destroy(new Error('PAPER_RISK_VALUATION_ABORTED'));
      }
    };
    io.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, io.deadline - Date.now()));
    try {
      await p.connect();
      if (destroyed || io.signal.aborted) throw new Error('PAPER_RISK_VALUATION_ABORTED');
      await p.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (tenantId) await p.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await work(p);
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('PAPER_RISK_VALUATION_ABORTED');
      committing = true;
      await p.query('COMMIT');
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('PAPER_RISK_VALUATION_UNCERTAIN');
      return result;
    } catch (error) {
      if (!destroyed) await p.query('ROLLBACK').catch(() => {});
      const known = [
        'PAPER_RISK_VALUATION_OWNERSHIP',
        'PAPER_RISK_VALUATION_INPUT',
        'PAPER_RISK_VALUATION_CORRUPT',
        'PAPER_RISK_VALUATION_MISSING',
        'PAPER_RISK_VALUATION_INCOMPLETE',
        'PAPER_RISK_VALUATION_CAPACITY',
        'PAPER_RISK_VALUATION_ROLE_UNSAFE',
        'PAPER_RISK_VALUATION_STALE',
        'PAPER_RISK_VALUATION_MARKET',
      ];
      const code = committing
        ? 'PAPER_RISK_VALUATION_UNCERTAIN'
        : destroyed || io.signal.aborted
          ? 'PAPER_RISK_VALUATION_ABORTED'
          : error instanceof Error && known.includes(error.message)
            ? error.message
            : 'PAPER_RISK_VALUATION_STORE_FAILED';
      throw new Error(code, {
        // eslint-disable-next-line preserve-caught-error -- SQL payloads and connection secrets must not cross the server port.
        cause: new Error('PAPER_RISK_VALUATION_TRANSACTION_FAILED'),
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
    for (const s of sockets) s.destroy(new Error('PAPER_RISK_VALUATION_CLOSED'));
    await Promise.all(closing);
  }
  try {
    await tx(
      null,
      options.io ?? { signal: new AbortController().signal, deadline: Date.now() + 3000 },
      async (p) => {
        const r = await p.query<{ safe: boolean }>(`SELECT current_user=session_user
        AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND pg_has_role(current_user,'ctp_paper_risk_valuation','MEMBER')
        AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
        AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
          AND t.relkind IN('r','p','v','m','f') AND (has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
          OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        AND has_function_privilege(current_user,'ctp_paper.capture_risk_valuation(jsonb)','EXECUTE')
        AND (${postgresRoleBoundary('ctp_paper_risk_valuation', ['ctp_paper.capture_risk_valuation(jsonb)'])}) AS safe
        FROM pg_roles r WHERE r.rolname=current_user`);
        if (r.rows[0]?.safe !== true) throw new Error('PAPER_RISK_VALUATION_ROLE_UNSAFE');
      },
    );
  } catch {
    await close();
    throw new Error('PAPER_RISK_VALUATION_ROLE_UNSAFE');
  }
  async function read(raw: unknown, io: PaperFundingIo) {
    const parsed = paperOwnerSchema.safeParse(raw);
    if (!parsed.success) throw new Error('PAPER_RISK_VALUATION_INPUT');
    const owner = parsed.data;
    const source = await tx(owner.tenantId, io, async (p) => {
      const r = await p.query<{ result: unknown }>(
        'SELECT ctp_paper.capture_risk_valuation($1::jsonb) AS result',
        [JSON.stringify(owner)],
      );
      return decodePaperRiskValuationSource(r.rows[0]?.result, owner, Date.now());
    });
    // Finally/physical settlement may cross the deadline. A prior successful
    // COMMIT cannot return expired or aborted read evidence.
    if (io.signal.aborted || Date.now() >= io.deadline)
      throw new Error('PAPER_RISK_VALUATION_ABORTED');
    if (source.validUntil <= Date.now()) throw new Error('PAPER_RISK_VALUATION_STALE');
    return source;
  }
  return Object.freeze({ read, close });
}
