import { createPostgresConnections } from '@ctp/exchange-core';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { immutable } from '@ctp/exchange-core';
import {
  policyHeadSchema,
  policyModeSchema,
  policyUpdateSchema,
  policyFingerprint,
  policyLimitsText,
  type PolicyHead,
  type PolicyUpdate,
} from './policies.js';
export interface PolicyIo {
  signal: AbortSignal;
  deadline: number;
}
export interface PostgresPolicies {
  update(
    request: PolicyUpdate,
    context: PolicyIo,
  ): Promise<Readonly<{ version: string; eventId: string; replayed: boolean }>>;
  read(
    tenantId: string | null,
    mode: PolicyUpdate['mode'],
    context: PolicyIo,
  ): Promise<readonly PolicyHead[]>;
  close(): Promise<void>;
}
const resultSchema = z.strictObject({
  version: policyHeadSchema.shape.version,
  eventId: z.uuid(),
  replayed: z.boolean(),
});
/** Server-only factory. Credentials and scope authorization belong to server composition. */
export async function createPostgresPolicies(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
  authority: 'PLATFORM' | 'USER';
}): Promise<PostgresPolicies> {
  try {
    z.strictObject({
      connectionString: z.string().max(4096),
      environment: z.enum(['test', 'development', 'staging', 'production']),
      authority: z.enum(['PLATFORM', 'USER']),
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
    throw new Error('RISK_POLICY_DATABASE_URL');
  }
  const physical = createPostgresConnections();
  const pool = new Pool({
    stream: physical.stream,
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
    context: PolicyIo,
    work: (p: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error('RISK_POLICY_CLOSED');
    if (
      context.signal.aborted ||
      !Number.isSafeInteger(context.deadline) ||
      context.deadline <= Date.now()
    )
      throw new Error('RISK_POLICY_ABORTED');
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
      p = await physical.connect(pool, context);
      if (destroyed || context.signal.aborted) {
        p.release(true);
        p = undefined;
        throw new Error('RISK_POLICY_ABORTED');
      }
      await p.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (tenantId) await p.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const value = await work(p);
      if (destroyed || context.signal.aborted) throw new Error('RISK_POLICY_ABORTED');
      await p.query('COMMIT');
      if (destroyed || context.signal.aborted) throw new Error('RISK_POLICY_ABORTED');
      return value;
    } catch (error) {
      if (p && !destroyed) await p.query('ROLLBACK').catch(() => {});
      const message =
        error instanceof Error && /^RISK_POLICY_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'RISK_POLICY_STORE_FAILED';
      throw new Error(destroyed || context.signal.aborted ? 'RISK_POLICY_ABORTED' : message, {
        // eslint-disable-next-line preserve-caught-error -- PostgreSQL errors can include secrets and tenant data.
        cause: new Error('RISK_POLICY_TRANSACTION_FAILED'),
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
        const expected =
          options.authority === 'PLATFORM'
            ? 'ctp_risk_policy_operator'
            : 'ctp_risk_policy_controller';
        const allowed =
          options.authority === 'PLATFORM'
            ? ['ctp_risk.update_platform_policy(jsonb)', 'ctp_risk.read_platform_policy(text)']
            : ['ctp_risk.update_user_policy(jsonb)', 'ctp_risk.read_current_policy(uuid,text)'];
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
        if (r.rows[0]?.safe !== true) throw new Error('RISK_POLICY_ROLE_UNSAFE');
      },
    );
  } catch {
    closed = true;
    await physical.close();
    await pool.end();
    throw new Error('RISK_POLICY_ROLE_UNSAFE');
  }
  return Object.freeze({
    async update(raw: PolicyUpdate, context: PolicyIo) {
      let request: PolicyUpdate;
      try {
        request = policyUpdateSchema.parse(raw);
      } catch {
        throw new Error('RISK_POLICY_INPUT');
      }
      const platform = request.scope.kind === 'PLATFORM';
      if (platform !== (options.authority === 'PLATFORM')) throw new Error('RISK_POLICY_AUTHORITY');
      const tenantId = request.scope.kind === 'USER' ? request.scope.tenantId : null;
      const { limits, ...identity } = request;
      const payload = {
        ...identity,
        limitsText: policyLimitsText(limits),
        limitsHash: policyFingerprint(limits),
      };
      return tx(tenantId, context, async (p) => {
        const r = await p.query<{ result: unknown }>(
          platform
            ? 'SELECT ctp_risk.update_platform_policy($1::jsonb) AS result'
            : 'SELECT ctp_risk.update_user_policy($1::jsonb) AS result',
          [JSON.stringify(payload)],
        );
        return immutable(resultSchema.parse(r.rows[0]?.result));
      });
    },
    async read(tenantId: string | null, rawMode: PolicyUpdate['mode'], context: PolicyIo) {
      if (options.authority === 'PLATFORM' ? tenantId !== null : tenantId === null)
        throw new Error('RISK_POLICY_AUTHORITY');
      if (tenantId !== null) z.uuid().parse(tenantId);
      const mode = policyModeSchema.parse(rawMode);
      return tx(tenantId, context, async (p) => {
        const r = await p.query<{ result: unknown }>(
          tenantId === null
            ? 'SELECT ctp_risk.read_platform_policy($1::text) AS result'
            : 'SELECT ctp_risk.read_current_policy($1::uuid,$2::text) AS result',
          tenantId === null ? [mode] : [tenantId, mode],
        );
        const heads =
          tenantId === null
            ? [policyHeadSchema.parse(r.rows[0]?.result)]
            : z.array(policyHeadSchema).length(2).parse(r.rows[0]?.result);
        if (
          heads[0]?.scope.kind !== 'PLATFORM' ||
          heads.some((h) => h.mode !== mode) ||
          (tenantId !== null &&
            (heads[1]?.scope.kind !== 'USER' || heads[1].scope.tenantId !== tenantId))
        )
          throw new Error('RISK_POLICY_SCOPE');
        return immutable(heads);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      const timer = setTimeout(() => {
        for (const p of sockets) void p.end().catch(() => {});
      }, 500);
      try {
        await physical.close();
        await pool.end();
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
