import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { controlScopeSchema, controlUpdateSchema, type ControlUpdate } from './controls.js';
export interface ControlIo {
  signal: AbortSignal;
  deadline: number;
}
const storedEpoch = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((e) => /^[1-9][0-9]{0,18}$/.test(e) && BigInt(e) <= 9223372036854775807n);
const state = z.enum(['PAUSED', 'RUNNING', 'OPEN', 'CLOSED', 'HALF_OPEN']);
const resultSchema = z.strictObject({ epoch: storedEpoch, state, replayed: z.boolean() });
const headFieldsSchema = z.strictObject({
  scope: controlScopeSchema,
  kind: z.enum(['KILL_SWITCH', 'CIRCUIT']),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  state,
  epoch: storedEpoch,
});
const headSchema = headFieldsSchema.superRefine((h, c) => {
  if (
    h.kind === 'KILL_SWITCH'
      ? h.key !== 'kill' || !['RUNNING', 'PAUSED'].includes(h.state)
      : !['OPEN', 'CLOSED', 'HALF_OPEN'].includes(h.state)
  )
    c.addIssue({ code: 'custom', message: 'RISK_CONTROL_STATE' });
});
export type ControlHead = z.infer<typeof headSchema>;
export interface PostgresControls {
  update(request: ControlUpdate, context: ControlIo): Promise<z.infer<typeof resultSchema>>;
  read(tenantId: string | null, context: ControlIo): Promise<readonly ControlHead[]>;
  close(): Promise<void>;
}
/** Server-only factory. Credentials and scope authorization belong to server composition. */
export async function createPostgresControls(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
  authority: 'GLOBAL' | 'TENANT';
}): Promise<PostgresControls> {
  try {
    z.strictObject({
      connectionString: z.string().max(4096),
      environment: z.enum(['test', 'development', 'staging', 'production']),
      authority: z.enum(['GLOBAL', 'TENANT']),
    }).parse(options);
    const url = new URL(options.connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.username ||
      !url.pathname.slice(1) ||
      url.hash ||
      [...url.searchParams.keys()].some((k) => k !== 'sslmode') ||
      (options.environment === 'production' && url.searchParams.get('sslmode') !== 'verify-full') ||
      (options.environment === 'test' &&
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
      throw new Error();
  } catch {
    throw new Error('RISK_CONTROL_DATABASE_URL');
  }
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 4,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 10000,
    statement_timeout: 2000,
    query_timeout: 2500,
    options: '-c idle_in_transaction_session_timeout=3000',
  });
  pool.on('error', () => {});
  const sockets = new Set<PoolClient>();
  pool.on('connect', (p) => {
    sockets.add(p);
    p.once('end', () => sockets.delete(p));
  });
  let closed = false;
  async function tx<T>(
    tenantId: string | null,
    context: ControlIo,
    work: (p: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error('RISK_CONTROL_CLOSED');
    if (
      context.signal.aborted ||
      !Number.isSafeInteger(context.deadline) ||
      context.deadline <= Date.now()
    )
      throw new Error('RISK_CONTROL_ABORTED');
    let p: PoolClient | undefined,
      destroyed = false;
    const abort = () => {
      if (!destroyed) {
        destroyed = true;
        p?.release(true);
      }
    };
    context.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, context.deadline - Date.now()));
    try {
      p = await pool.connect();
      if (destroyed || context.signal.aborted) {
        p.release(true);
        p = undefined;
        throw new Error('RISK_CONTROL_ABORTED');
      }
      await p.query('BEGIN');
      if (tenantId) await p.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const value = await work(p);
      if (destroyed || context.signal.aborted) throw new Error('RISK_CONTROL_ABORTED');
      await p.query('COMMIT');
      if (destroyed || context.signal.aborted) throw new Error('RISK_CONTROL_ABORTED');
      return value;
    } catch (error) {
      if (p && !destroyed) await p.query('ROLLBACK').catch(() => {});
      const message =
        error instanceof Error && /^RISK_CONTROL_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'RISK_CONTROL_STORE_FAILED';
      throw new Error(destroyed || context.signal.aborted ? 'RISK_CONTROL_ABORTED' : message, {
        // eslint-disable-next-line preserve-caught-error -- PostgreSQL errors can include secrets and tenant data.
        cause: new Error('RISK_CONTROL_TRANSACTION_FAILED'),
      });
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      if (p && !destroyed) p.release();
    }
  }
  try {
    await tx(
      null,
      { signal: new AbortController().signal, deadline: Date.now() + 3000 },
      async (p) => {
        const expected = options.authority === 'GLOBAL' ? 'ctp_risk_operator' : 'ctp_risk_control';
        const allowed =
          options.authority === 'GLOBAL'
            ? ['ctp_risk.update_global(jsonb)', 'ctp_risk.read_global()']
            : [
                'ctp_risk.update_tenant(jsonb)',
                'ctp_risk.read_tenant(uuid)',
                'ctp_risk.read_global()',
              ];
        const r = await p.query<{ safe: boolean }>(
          `SELECT current_user=session_user AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication) AND pg_has_role(current_user,$1,'MEMBER')
        AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE x.rolname<>current_user AND x.rolname<>$1 AND pg_has_role(current_user,x.oid,'MEMBER'))
        AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND (has_schema_privilege(current_user,n.oid,'CREATE') OR pg_has_role(current_user,n.nspowner,'MEMBER')))
        AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND t.relkind IN('r','p','v','m','f') AND (pg_has_role(current_user,t.relowner,'MEMBER') OR has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='ctp_risk' AND has_function_privilege(current_user,f.oid,'EXECUTE') AND f.oid NOT IN(SELECT unnest($2::text[])::regprocedure::oid))
        AND (SELECT bool_and(has_function_privilege(current_user,v::regprocedure::oid,'EXECUTE')) FROM unnest($2::text[])v) AS safe FROM pg_roles r WHERE r.rolname=current_user`,
          [expected, allowed],
        );
        if (r.rows[0]?.safe !== true) throw new Error('RISK_CONTROL_ROLE_UNSAFE');
      },
    );
  } catch {
    closed = true;
    await pool.end();
    throw new Error('RISK_CONTROL_ROLE_UNSAFE');
  }
  return Object.freeze({
    async update(raw: ControlUpdate, context: ControlIo) {
      const request = controlUpdateSchema.parse(raw),
        global = request.scope.kind === 'GLOBAL';
      if (global !== (options.authority === 'GLOBAL')) throw new Error('RISK_CONTROL_AUTHORITY');
      const tenantId = request.scope.kind === 'GLOBAL' ? null : request.scope.tenantId;
      return tx(tenantId, context, async (p) => {
        const r = await p.query<{ result: unknown }>(
          global
            ? 'SELECT ctp_risk.update_global($1::jsonb) AS result'
            : 'SELECT ctp_risk.update_tenant($1::jsonb) AS result',
          [JSON.stringify(request)],
        );
        return Object.freeze(resultSchema.parse(r.rows[0]?.result));
      });
    },
    async read(tenantId: string | null, context: ControlIo) {
      if (options.authority === 'GLOBAL' ? tenantId !== null : tenantId === null)
        throw new Error('RISK_CONTROL_AUTHORITY');
      if (tenantId !== null) z.uuid().parse(tenantId);
      return tx(tenantId, context, async (p) => {
        const r = await p.query<{ result: unknown }>('SELECT ctp_risk.read_global() AS result');
        const globals = z
          .array(headFieldsSchema.omit({ scope: true }))
          .max(10000)
          .parse(r.rows[0]?.result)
          .map((h) => headSchema.parse({ ...h, scope: { kind: 'GLOBAL' as const } }));
        const heads: ControlHead[] = [...globals];
        if (tenantId !== null) {
          const tenants = await p.query<{ result: unknown }>(
            'SELECT ctp_risk.read_tenant($1::uuid) AS result',
            [tenantId],
          );
          heads.push(...z.array(headSchema).max(10000).parse(tenants.rows[0]?.result));
        }
        return Object.freeze(
          heads.map((h) => Object.freeze({ ...h, scope: Object.freeze(h.scope) })),
        );
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      const timer = setTimeout(() => {
        for (const p of sockets) void p.end().catch(() => {});
      }, 500);
      try {
        await pool.end();
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
