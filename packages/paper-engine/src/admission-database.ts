import { Socket } from 'node:net';
import { Client, type QueryResult, type QueryResultRow } from 'pg';
import { z } from 'zod';
import { postgresRoleBoundary } from '@ctp/exchange-core';
import type { PaperFundingIo } from './funding-domain.js';

const role = 'ctp_paper_risk_admission';
const functions = [
  'ctp_paper.evaluate_and_reserve(jsonb)',
  'ctp_paper.reconcile_admission(jsonb)',
] as const;
const context = z.strictObject({
  signal: z.instanceof(AbortSignal),
  deadline: z.number().int().safe(),
});
const optionsSchema = z.strictObject({
  connectionString: z.string().min(1).max(4096),
  environment: z.enum(['test', 'development', 'staging', 'production']),
  io: context.optional(),
});
export interface PaperAdmissionSql {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}
type Operation = { stop(code: string): void; done: Promise<void> };
const safeCodes = new Set([
  'PAPER_ADMISSION_INPUT',
  'PAPER_ADMISSION_ROLE_UNSAFE',
  'PAPER_ADMISSION_CONFLICT',
  'PAPER_ADMISSION_MISSING',
  'PAPER_ADMISSION_SCOPE',
  'PAPER_ADMISSION_UNSUPPORTED',
  'PAPER_ADMISSION_EVIDENCE',
  'PAPER_ADMISSION_EXPIRED',
  'PAPER_ADMISSION_LIMIT',
]);

function privateError(code: string) {
  return new Error(code, { cause: new Error('PAPER_ADMISSION_PRIVATE_FAILURE') });
}
async function settles(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Internal transport, deliberately absent from every package entrypoint. Only
 * the fixed admission implementation may supply SQL work; no public factory
 * accepts this callback, a client, a role or an RPC override. Successful transport
 * is not Risk evaluation, source certification, a grant or dispatch authority. */
export async function openPaperAdmissionDatabase(raw: unknown) {
  let settings: z.infer<typeof optionsSchema>;
  try {
    settings = optionsSchema.parse(raw);
    const u = new URL(settings.connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(u.protocol) ||
      !decodeURIComponent(u.username) ||
      !decodeURIComponent(u.password) ||
      !decodeURIComponent(u.pathname.slice(1)) ||
      u.pathname.slice(1).includes('/') ||
      u.hash ||
      [...u.searchParams.keys()].some((k) => k !== 'sslmode') ||
      [...u.searchParams.keys()].length > 1 ||
      (['staging', 'production'].includes(settings.environment) &&
        (u.searchParams.get('sslmode') !== 'verify-full' ||
          process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0')) ||
      (settings.environment === 'test' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
    )
      throw Error('invalid');
  } catch {
    throw privateError('PAPER_ADMISSION_DATABASE_URL');
  }
  const active = new Set<Operation>();
  let closed = false,
    broken = false;
  async function transaction<T>(
    tenantId: string | null,
    rawIo: PaperFundingIo,
    work: (sql: PaperAdmissionSql) => Promise<T>,
  ): Promise<T> {
    if (closed || broken) throw privateError('PAPER_ADMISSION_CLOSED');
    const parsed = context.safeParse(rawIo);
    if (!parsed.success || (tenantId !== null && !z.uuid().safeParse(tenantId).success))
      throw privateError('PAPER_ADMISSION_INPUT');
    const io = parsed.data,
      deadline = Math.min(io.deadline, Date.now() + 3000);
    if (io.signal.aborted || deadline <= Date.now()) throw privateError('PAPER_ADMISSION_ABORTED');
    if (active.size >= 4) throw privateError('PAPER_ADMISSION_BUSY');
    const socket = new Socket();
    socket.on('error', () => {});
    const physicalClose = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let interrupted: string | null = null,
      committing = false,
      committed = false;
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    // A close can race any await, including a non-I/O internal calculation.
    // Observe the rejection immediately while retaining actual wire promises.
    void aborted.catch(() => {});
    const op: Operation = {
      done,
      stop(code) {
        if (interrupted !== null) return;
        interrupted = code;
        socket.destroy(privateError(code));
        rejectAbort(privateError(code));
      },
    };
    active.add(op);
    const abort = () => op.stop('PAPER_ADMISSION_ABORTED');
    io.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
    const pending = new Set<Promise<unknown>>();
    const guard = () => {
      if (closed && interrupted === null) op.stop('PAPER_ADMISSION_CLOSED');
      if ((io.signal.aborted || Date.now() >= deadline) && interrupted === null) abort();
      if (interrupted !== null) throw privateError(interrupted);
    };
    async function wire<R>(promise: Promise<R>): Promise<R> {
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return Promise.race([promise, aborted]);
    }
    let client: Client | undefined, result: T | undefined, failure: Error | undefined;
    try {
      client = new Client({
        connectionString: settings.connectionString,
        stream: () => socket,
        connectionTimeoutMillis: 1000,
        statement_timeout: 2000,
        query_timeout: 2500,
        options:
          '-c idle_in_transaction_session_timeout=3000 -c client_connection_check_interval=100ms',
      });
      client.on('error', () => {});
      const p = client;
      const sql: PaperAdmissionSql = {
        query<R extends QueryResultRow>(text: string, values?: readonly unknown[]) {
          guard();
          return wire(p.query<R>(text, values ? [...values] : undefined));
        },
      };
      guard();
      await wire(p.connect());
      await sql.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (tenantId !== null)
        await sql.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId.toLowerCase()]);
      result = await Promise.race([Promise.resolve().then(() => work(sql)), aborted]);
      guard();
      // From this point a failed/aborted response cannot prove COMMIT was absent.
      committing = true;
      await wire(p.query('COMMIT'));
      committed = true;
      guard();
    } catch (error) {
      const code = committing
        ? 'PAPER_ADMISSION_UNCERTAIN'
        : (interrupted ??
          (error instanceof Error && safeCodes.has(error.message)
            ? error.message
            : 'PAPER_ADMISSION_STORE_FAILED'));
      failure = privateError(code);
      if (!interrupted && client && !committing) {
        try {
          await wire(client.query('ROLLBACK'));
        } catch {
          /* Physical destruction follows. */
        }
      }
    } finally {
      clearTimeout(timer);
      io.signal.removeEventListener('abort', abort);
      // Force the owned physical stream closed even if pg's cleanup promise
      // cannot complete. No slot is released merely because the caller timed out.
      socket.destroy();
      const ended = client ? Promise.resolve().then(() => client!.end()) : Promise.resolve();
      const [physical, queries, end] = await Promise.all([
        settles(physicalClose, 1000),
        settles(Promise.allSettled([...pending]), 3000),
        settles(ended, 1000),
      ]);
      if (!physical || !queries || !end) {
        broken = true;
        failure = privateError(
          committing ? 'PAPER_ADMISSION_UNCERTAIN' : 'PAPER_ADMISSION_CLOSE_FAILED',
        );
      }
      active.delete(op);
      finish();
    }
    if (failure) throw failure;
    if (!committed || io.signal.aborted || closed || Date.now() >= deadline)
      throw privateError(committing ? 'PAPER_ADMISSION_UNCERTAIN' : 'PAPER_ADMISSION_ABORTED');
    return result as T;
  }
  async function close() {
    closed = true;
    const pending = [...active];
    for (const op of pending) op.stop('PAPER_ADMISSION_CLOSED');
    await Promise.all(pending.map((op) => op.done));
    if (broken) throw privateError('PAPER_ADMISSION_CLOSE_FAILED');
  }
  try {
    await transaction(
      null,
      settings.io ?? { signal: new AbortController().signal, deadline: Date.now() + 3000 },
      async (sql) => {
        const r = await sql.query<{ safe: boolean }>(`SELECT current_user=session_user
        AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND pg_has_role(current_user,'${role}','MEMBER')
        AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
        AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
          AND t.relkind IN('r','p','v','m','f') AND (has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
          OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        AND has_function_privilege(current_user,'ctp_paper.evaluate_and_reserve(jsonb)','EXECUTE')
        AND has_function_privilege(current_user,'ctp_paper.reconcile_admission(jsonb)','EXECUTE')
        AND (${postgresRoleBoundary(role, [...functions])}) AS safe
        FROM pg_roles r WHERE r.rolname=current_user`);
        if (r.rows[0]?.safe !== true) throw privateError('PAPER_ADMISSION_ROLE_UNSAFE');
      },
    );
  } catch (error) {
    await close().catch(() => {});
    throw new Error(
      error instanceof Error &&
        ['PAPER_ADMISSION_ABORTED', 'PAPER_ADMISSION_UNCERTAIN'].includes(error.message)
        ? error.message
        : 'PAPER_ADMISSION_ROLE_UNSAFE',
      {
        // eslint-disable-next-line preserve-caught-error -- Startup SQL, hostnames and credential diagnostics remain private.
        cause: new Error('PAPER_ADMISSION_AUTHORITY_FAILED'),
      },
    );
  }
  return Object.freeze({ transaction, close });
}
