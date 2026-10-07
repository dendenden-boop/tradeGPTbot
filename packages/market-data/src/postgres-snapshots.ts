import { createPostgresConnections, postgresRoleBoundary } from '@ctp/exchange-core';
import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { immutable } from '@ctp/exchange-core';
import {
  marketSnapshotKeySchema,
  marketSnapshotPublicationSchema,
  marketSnapshotReceiptSchema,
  type DurableMarketSnapshots,
  type MarketSnapshotKey,
  type MarketSnapshotPublication,
} from './durable-snapshots.js';
import type { IoContext } from './ports.js';

/** Isolated server-owned public Market Data evidence, never an accounting/snapshot authority API. */
export async function createPostgresMarketSnapshots(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
}): Promise<DurableMarketSnapshots> {
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
    throw new Error('MARKET_EVIDENCE_DATABASE_URL');
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
  let closed = false;
  pool.on('connect', (p) => {
    sockets.add(p);
    p.once('end', () => sockets.delete(p));
  });
  async function tx<T>(io: IoContext, work: (p: PoolClient) => Promise<T>): Promise<T> {
    if (closed) throw new Error('MARKET_EVIDENCE_CLOSED');
    if (io.signal.aborted || !Number.isSafeInteger(io.deadline) || io.deadline <= Date.now())
      throw new Error('MARKET_EVIDENCE_ABORTED');
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
        throw new Error('MARKET_EVIDENCE_ABORTED');
      }
      await p.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(p);
      if (destroyed || io.signal.aborted) throw new Error('MARKET_EVIDENCE_ABORTED');
      await p.query('COMMIT');
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('MARKET_EVIDENCE_ABORTED');
      return result;
    } catch (error) {
      if (p && !destroyed) await p.query('ROLLBACK').catch(() => {});
      const message =
        error instanceof Error && /^MARKET_EVIDENCE_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'MARKET_EVIDENCE_STORE_FAILED';
      throw new Error(destroyed || io.signal.aborted ? 'MARKET_EVIDENCE_ABORTED' : message, {
        // eslint-disable-next-line preserve-caught-error -- SQL errors may contain native payloads or connection secrets.
        cause: new Error('MARKET_EVIDENCE_TRANSACTION_FAILED'),
      });
    } finally {
      clearTimeout(timer);
      io.signal.removeEventListener('abort', abort);
      if (p && !destroyed) p.release();
    }
  }
  try {
    await tx({ signal: new AbortController().signal, deadline: Date.now() + 3000 }, async (p) => {
      const r = await p.query<{ safe: boolean }>(`SELECT current_user=session_user
        AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND pg_has_role(current_user,'ctp_market_snapshot','MEMBER')
        AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE x.rolname<>current_user AND x.rolname<>'ctp_market_snapshot' AND pg_has_role(current_user,x.oid,'MEMBER'))
        AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND (has_schema_privilege(current_user,n.oid,'CREATE') OR pg_has_role(current_user,n.nspowner,'MEMBER')))
        AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND t.relkind IN('r','p','v','m','f') AND (pg_has_role(current_user,t.relowner,'MEMBER') OR has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname IN('ctp_market','ctp_risk') AND has_function_privilege(current_user,f.oid,'EXECUTE') AND f.oid NOT IN('ctp_market.publish_snapshot(text,text)'::regprocedure::oid,'ctp_market.read_snapshot(jsonb,integer)'::regprocedure::oid))
        AND has_function_privilege(current_user,'ctp_market.publish_snapshot(text,text)','EXECUTE')
        AND has_function_privilege(current_user,'ctp_market.read_snapshot(jsonb,integer)','EXECUTE') AND (${postgresRoleBoundary('ctp_market_snapshot', ['ctp_market.publish_snapshot(text,text)', 'ctp_market.read_snapshot(jsonb,integer)'])}) AS safe FROM pg_roles r WHERE r.rolname=current_user`);
      if (r.rows[0]?.safe !== true) throw new Error('MARKET_EVIDENCE_ROLE_UNSAFE');
    });
  } catch {
    closed = true;
    await physical.close();
    await pool.end();
    throw new Error('MARKET_EVIDENCE_ROLE_UNSAFE');
  }
  const sameKey = (a: MarketSnapshotKey, b: MarketSnapshotKey) =>
    JSON.stringify(a) === JSON.stringify(b);
  return Object.freeze({
    async publish(raw: MarketSnapshotPublication, io: IoContext) {
      const p = marketSnapshotPublicationSchema.parse(raw),
        text = JSON.stringify(p),
        hash = createHash('sha256').update(text).digest('hex');
      return tx(io, async (c) => {
        const r = await c.query<{ result: unknown }>(
          'SELECT ctp_market.publish_snapshot($1,$2) AS result',
          [text, hash],
        );
        const receipt = marketSnapshotReceiptSchema.parse(r.rows[0]?.result);
        if (receipt.id !== p.id) throw new Error('MARKET_EVIDENCE_CORRUPT');
        return immutable(receipt);
      });
    },
    async read(raw: MarketSnapshotKey, io: IoContext, maxAgeMs = 5000) {
      const key = marketSnapshotKeySchema.parse(raw);
      z.number().int().min(1).max(5000).parse(maxAgeMs);
      return tx(io, async (c) => {
        const r = await c.query<{ result: unknown }>(
          'SELECT ctp_market.read_snapshot($1::jsonb,$2) AS result',
          [JSON.stringify(key), maxAgeMs],
        );
        const row = z
          .strictObject({
            id: z.uuid(),
            revision: marketSnapshotReceiptSchema.shape.revision,
            text: z.string().max(1048576),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(r.rows[0]?.result);
        if (createHash('sha256').update(row.text).digest('hex') !== row.hash)
          throw new Error('MARKET_EVIDENCE_CORRUPT');
        const publication = marketSnapshotPublicationSchema.parse(JSON.parse(row.text) as unknown);
        const now = Date.now();
        if (
          publication.kind !== 'SNAPSHOT' ||
          publication.id !== row.id ||
          !sameKey(key, publication.key) ||
          [
            publication.timestamp,
            publication.ticker.exchangeTime,
            publication.ticker.receivedAt,
            publication.book.receivedAt,
            ...(publication.book.exchangeTime === null ? [] : [publication.book.exchangeTime]),
          ].some((at) => at > now || now - at > maxAgeMs) ||
          publication.record.rules.effectiveAt > now ||
          publication.record.rules.expiresAt <= now
        )
          throw new Error('MARKET_EVIDENCE_STALE');
        return immutable({ id: row.id, revision: row.revision, hash: row.hash, publication });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      const destroy = () => {
        for (const p of sockets) void p.end().catch(() => {});
      };
      const timer = setTimeout(destroy, 500);
      try {
        await physical.close();
        await pool.end();
      } finally {
        clearTimeout(timer);
        destroy();
      }
    },
  });
}
