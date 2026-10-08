import { createPostgresConnections, postgresRoleBoundary } from '@ctp/exchange-core';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import type { SnapshotIo } from './coordinator.js';
export interface CertificationDatabaseOptions {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
}
/** Internal fixed-authority connection boundary; never exported through the package index. */
export async function openCertificationDatabase(
  options: CertificationDatabaseOptions,
  authority: 'CERTIFIER' | 'OBSERVER',
) {
  const group = authority === 'CERTIFIER' ? 'ctp_risk_certifier' : 'ctp_risk_observer';
  const functions =
    authority === 'CERTIFIER'
      ? [
          'ctp_certification.capture_sources(jsonb)',
          'ctp_certification.next_identity(jsonb)',
          'ctp_certification.insert_certificate(jsonb,text)',
          'ctp_certification.read_certificate(jsonb)',
        ]
      : ['ctp_certification.publish_observation(text)'];
  try {
    z.strictObject({
      connectionString: z.string().max(4096),
      environment: z.enum(['test', 'development', 'staging', 'production']),
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
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error();
  } catch {
    throw new Error('RISK_SNAPSHOT_DATABASE_URL');
  }
  const physical = createPostgresConnections();
  const pool = new Pool({
    connectionString: options.connectionString,
    stream: physical.stream,
    max: 4,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 10000,
    statement_timeout: 2000,
    query_timeout: 2500,
    options: '-c idle_in_transaction_session_timeout=3000',
  });
  pool.on('error', () => {});
  let closed = false;
  const check = (io: SnapshotIo) => {
    if (closed) throw new Error('RISK_SNAPSHOT_CLOSED');
    if (io.signal.aborted || !Number.isSafeInteger(io.deadline) || io.deadline <= Date.now())
      throw new Error('RISK_SNAPSHOT_ABORTED');
  };
  async function transaction<T>(
    key: { binding: { tenantId: string } } | null,
    io: SnapshotIo,
    work: (p: PoolClient) => Promise<T>,
  ): Promise<T> {
    check(io);
    let p: PoolClient | undefined,
      destroyed = false;
    const abort = () => {
      if (destroyed) return;
      destroyed = true;
      p?.release(true);
    };
    io.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, io.deadline - Date.now()));
    try {
      p = await physical.connect(pool, io);
      if (destroyed || io.signal.aborted) {
        p.release(true);
        p = undefined;
        throw new Error('RISK_SNAPSHOT_ABORTED');
      }
      await p.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (key) {
        await p.query("SELECT set_config('app.tenant_id',$1,true)", [key.binding.tenantId]);
        await p.query('SELECT pg_advisory_xact_lock_shared(1129599058,12)');
        await p.query("SELECT pg_advisory_xact_lock(hashtextextended('ctp:risk:'||$1::text,0))", [
          key.binding.tenantId,
        ]);
      }
      const result = await work(p);
      check(io);
      if (destroyed) throw new Error('RISK_SNAPSHOT_ABORTED');
      await p.query('COMMIT');
      check(io);
      if (destroyed) throw new Error('RISK_SNAPSHOT_ABORTED');
      return result;
    } catch (error) {
      if (p && !destroyed) await p.query('ROLLBACK').catch(() => {});
      const code =
        error instanceof Error && /^RISK_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'RISK_SNAPSHOT_STORE_FAILED';
      throw new Error(destroyed || io.signal.aborted ? 'RISK_SNAPSHOT_ABORTED' : code, {
        // eslint-disable-next-line preserve-caught-error -- No private rows, SQL text or connection material in caller errors.
        cause: new Error('RISK_SNAPSHOT_TRANSACTION_FAILED'),
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
        const r = await p.query<{ safe: boolean }>(`SELECT current_user=session_user
        AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND pg_has_role(current_user,'${group}','MEMBER')
        AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
        AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
          WHERE n.nspname='public' AND t.relkind IN('r','p','v','m','f')
          AND (has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
            OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        AND (${postgresRoleBoundary(group, functions)})
        AND ${functions.map((f) => `has_function_privilege(current_user,'${f}','EXECUTE')`).join(' AND ')}
        AS safe FROM pg_roles r WHERE r.rolname=current_user`);
        if (r.rows[0]?.safe !== true) throw new Error('RISK_SNAPSHOT_ROLE_UNSAFE');
      },
    );
  } catch {
    closed = true;
    await physical.close();
    await pool.end();
    throw new Error('RISK_SNAPSHOT_ROLE_UNSAFE');
  }
  return Object.freeze({
    transaction,
    check,
    async close() {
      if (closed) return;
      closed = true;
      await physical.close();
      await pool.end();
    },
  });
}
