import { createPostgresConnections, postgresRoleBoundary } from '@ctp/exchange-core';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import {
  riskPortfolioScopeSchema,
  decodeRiskPortfolioSource,
  type RiskPortfolioScope,
  type RiskPortfolioSource,
} from './portfolio-source.js';
import type { SnapshotIo } from './coordinator.js';

/** Server-only read authority. No API/client sources, certificate or financial write authority. */
export async function createPostgresRiskPortfolioReader(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
}) {
  try {
    z.strictObject({
      connectionString: z.string().max(4096),
      environment: z.enum(['test', 'development', 'staging', 'production']),
    }).parse(options);
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
  } catch {
    throw new Error('RISK_PORTFOLIO_DATABASE_URL');
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
  async function transaction<T>(
    scope: RiskPortfolioScope | null,
    io: SnapshotIo,
    work: (p: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error('RISK_PORTFOLIO_CLOSED');
    if (io.signal.aborted || !Number.isSafeInteger(io.deadline) || io.deadline <= Date.now())
      throw new Error('RISK_PORTFOLIO_ABORTED');
    let p: PoolClient | undefined,
      destroyed = false;
    const abort = () => {
      if (!destroyed) {
        destroyed = true;
        p?.release(true);
      }
    };
    io.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, io.deadline - Date.now()));
    try {
      p = await physical.connect(pool, io);
      if (destroyed || io.signal.aborted) {
        p.release(true);
        p = undefined;
        throw new Error('RISK_PORTFOLIO_ABORTED');
      }
      await p.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (scope) await p.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
      const result = await work(p);
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('RISK_PORTFOLIO_ABORTED');
      await p.query('COMMIT');
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('RISK_PORTFOLIO_ABORTED');
      return result;
    } catch (error) {
      if (p && !destroyed) await p.query('ROLLBACK').catch(() => {});
      const code =
        error instanceof Error && /^RISK_PORTFOLIO_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'RISK_PORTFOLIO_STORE_FAILED';
      throw new Error(destroyed || io.signal.aborted ? 'RISK_PORTFOLIO_ABORTED' : code, {
        // eslint-disable-next-line preserve-caught-error -- SQL payloads, private account facts and credentials must not enter caller errors.
        cause: new Error('RISK_PORTFOLIO_TRANSACTION_FAILED'),
      });
    } finally {
      clearTimeout(timer);
      io.signal.removeEventListener('abort', abort);
      if (p && !destroyed) p.release();
    }
  }
  try {
    await transaction(
      null,
      { signal: new AbortController().signal, deadline: Date.now() + 3000 },
      async (p) => {
        const r = await p.query<{
          safe: boolean;
        }>(`SELECT current_user=session_user AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND pg_has_role(current_user,'ctp_risk_snapshot_reader','MEMBER')
        AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE x.rolname<>current_user AND x.rolname<>'ctp_risk_snapshot_reader' AND pg_has_role(current_user,x.oid,'MEMBER'))
        AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND (has_schema_privilege(current_user,n.oid,'CREATE') OR pg_has_role(current_user,n.nspowner,'MEMBER')))
        AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND t.relkind IN('r','p','v','m','f') AND (pg_has_role(current_user,t.relowner,'MEMBER') OR has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='ctp_risk' AND has_function_privilege(current_user,f.oid,'EXECUTE') AND f.oid<>'ctp_risk.capture_portfolio(jsonb)'::regprocedure::oid)
        AND has_function_privilege(current_user,'ctp_risk.capture_portfolio(jsonb)','EXECUTE') AND (${postgresRoleBoundary('ctp_risk_snapshot_reader', ['ctp_risk.capture_portfolio(jsonb)'])}) AS safe FROM pg_roles r WHERE r.rolname=current_user`);
        if (r.rows[0]?.safe !== true) throw new Error('RISK_PORTFOLIO_ROLE_UNSAFE');
      },
    );
  } catch {
    closed = true;
    await physical.close();
    await pool.end();
    throw new Error('RISK_PORTFOLIO_ROLE_UNSAFE');
  }
  return Object.freeze({
    async read(raw: RiskPortfolioScope, io: SnapshotIo): Promise<RiskPortfolioSource> {
      const scope = riskPortfolioScopeSchema.parse(raw);
      const source = await transaction(scope, io, async (p) => {
        const r = await p.query<{ result: unknown }>(
          'SELECT ctp_risk.capture_portfolio($1::jsonb) AS result',
          [JSON.stringify(scope)],
        );
        return decodeRiskPortfolioSource(r.rows[0]?.result, scope, Date.now());
      });
      const now = Date.now();
      if (source.asOf > now || now - source.asOf > scope.maxEvidenceAgeMs)
        throw new Error('RISK_PORTFOLIO_INCOMPLETE');
      return source;
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
export type RiskPortfolioReader = Awaited<ReturnType<typeof createPostgresRiskPortfolioReader>>;
