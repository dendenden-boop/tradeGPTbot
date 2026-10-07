import { createPostgresConnections } from '@ctp/exchange-core';
import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { riskEvidenceScopeSchema } from './evidence.js';
import {
  lossBatchSchema,
  lossCheckpointSchema,
  type LossBatch,
  type LossJournal,
} from './loss-journal.js';
import type { SnapshotIo } from './coordinator.js';

/** Isolated server collector credentials; not an HTTP publisher or Risk authority. */
export async function createPostgresLossJournal(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
}): Promise<LossJournal> {
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
    throw new Error('RISK_LOSS_JOURNAL_DATABASE_URL');
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
    io: SnapshotIo,
    work: (p: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error('RISK_LOSS_JOURNAL_CLOSED');
    if (io.signal.aborted || !Number.isSafeInteger(io.deadline) || io.deadline <= Date.now())
      throw new Error('RISK_LOSS_JOURNAL_ABORTED');
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
        throw new Error('RISK_LOSS_JOURNAL_ABORTED');
      }
      await p.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (tenantId) await p.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const value = await work(p);
      if (destroyed || io.signal.aborted) throw new Error('RISK_LOSS_JOURNAL_ABORTED');
      await p.query('COMMIT');
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('RISK_LOSS_JOURNAL_ABORTED');
      return value;
    } catch (error) {
      if (p && !destroyed) await p.query('ROLLBACK').catch(() => {});
      const message =
        error instanceof Error && /^RISK_LOSS_JOURNAL_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'RISK_LOSS_JOURNAL_STORE_FAILED';
      throw new Error(destroyed || io.signal.aborted ? 'RISK_LOSS_JOURNAL_ABORTED' : message, {
        // eslint-disable-next-line preserve-caught-error -- Do not disclose SQL payloads or credentials.
        cause: new Error('RISK_LOSS_JOURNAL_TRANSACTION_FAILED'),
      });
    } finally {
      clearTimeout(timer);
      io.signal.removeEventListener('abort', abort);
      if (p && !destroyed) p.release();
    }
  }
  try {
    await tx(
      null,
      { signal: new AbortController().signal, deadline: Date.now() + 3000 },
      async (p) => {
        const r = await p.query<{
          safe: boolean;
        }>(`SELECT current_user=session_user AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND pg_has_role(current_user,'ctp_risk_evidence_collector','MEMBER')
        AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE x.rolname<>current_user AND x.rolname<>'ctp_risk_evidence_collector' AND pg_has_role(current_user,x.oid,'MEMBER'))
        AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND (has_schema_privilege(current_user,n.oid,'CREATE') OR pg_has_role(current_user,n.nspowner,'MEMBER')))
        AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND t.relkind IN('r','p','v','m','f') AND (pg_has_role(current_user,t.relowner,'MEMBER') OR has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='ctp_risk' AND has_function_privilege(current_user,f.oid,'EXECUTE') AND f.oid NOT IN('ctp_risk.append_loss_batch(jsonb)'::regprocedure::oid,'ctp_risk.read_loss_checkpoint(uuid,text,text,bigint)'::regprocedure::oid))
        AND has_function_privilege(current_user,'ctp_risk.append_loss_batch(jsonb)','EXECUTE') AND has_function_privilege(current_user,'ctp_risk.read_loss_checkpoint(uuid,text,text,bigint)','EXECUTE') AS safe FROM pg_roles r WHERE r.rolname=current_user`);
        if (r.rows[0]?.safe !== true) throw new Error('RISK_LOSS_JOURNAL_ROLE_UNSAFE');
      },
    );
  } catch {
    closed = true;
    await physical.close();
    await pool.end();
    throw new Error('RISK_LOSS_JOURNAL_ROLE_UNSAFE');
  }
  function decode(raw: unknown) {
    const r = z
      .strictObject({
        checkpointText: z.string().max(8192),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(raw);
    if (createHash('sha256').update(r.checkpointText).digest('hex') !== r.hash)
      throw new Error('RISK_LOSS_JOURNAL_CORRUPT');
    return immutable(
      lossCheckpointSchema.parse({
        ...z.record(z.string(), z.unknown()).parse(JSON.parse(r.checkpointText)),
        hash: r.hash,
      }),
    );
  }
  return Object.freeze({
    async append(raw: LossBatch, io: SnapshotIo) {
      let p: LossBatch;
      try {
        p = lossBatchSchema.parse(raw);
      } catch {
        throw new Error('RISK_LOSS_JOURNAL_INPUT');
      }
      return tx(p.scope.tenantId, io, async (c) => {
        const r = await c.query<{ result: unknown }>(
          'SELECT ctp_risk.append_loss_batch($1::jsonb) AS result',
          [JSON.stringify(p)],
        );
        const out = decode(r.rows[0]?.result);
        if (
          out.scope.tenantId !== p.scope.tenantId ||
          out.scope.mode !== p.scope.mode ||
          out.scope.valuationAsset !== p.scope.valuationAsset ||
          out.dayStart !== p.dayStart ||
          out.batchId !== p.id
        )
          throw new Error('RISK_LOSS_JOURNAL_CORRUPT');
        return out;
      });
    },
    async read(rawScope: LossBatch['scope'], day: number, io: SnapshotIo) {
      const scope = riskEvidenceScopeSchema.parse(rawScope);
      timestampSchema.parse(day);
      if (day % 86400000 !== 0) throw new Error('RISK_LOSS_JOURNAL_INPUT');
      return tx(scope.tenantId, io, async (c) => {
        const r = await c.query<{ result: unknown }>(
          'SELECT ctp_risk.read_loss_checkpoint($1::uuid,$2::text,$3::text,$4::bigint) AS result',
          [scope.tenantId, scope.mode, scope.valuationAsset, day],
        );
        const out = decode(r.rows[0]?.result);
        if (
          out.scope.tenantId !== scope.tenantId ||
          out.scope.mode !== scope.mode ||
          out.scope.valuationAsset !== scope.valuationAsset ||
          out.dayStart !== day
        )
          throw new Error('RISK_LOSS_JOURNAL_CORRUPT');
        return out;
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
