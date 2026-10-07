import { createPostgresConnections } from '@ctp/exchange-core';
import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { feedKey, restoreCandleState, type CandleState } from './candles.js';
import type { IoContext, MarketEvent, MarketStore, StoredPartition } from './ports.js';

export async function createPostgresMarketStore(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
}): Promise<MarketStore> {
  const url = new URL(options.connectionString);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    !url.pathname.slice(1) ||
    [...url.searchParams.keys()].some((k) => !['sslmode'].includes(k)) ||
    (options.environment === 'production' && url.searchParams.get('sslmode') !== 'verify-full') ||
    (options.environment === 'test' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('MARKET_DATABASE_URL_INVALID');
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
  let closed = false;
  const connections = new Set<PoolClient>();
  pool.on('connect', (c) => {
    connections.add(c);
    c.once('end', () => connections.delete(c));
  });
  async function transaction<T>(
    context: IoContext,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (
      closed ||
      context.signal.aborted ||
      !Number.isSafeInteger(context.deadline) ||
      context.deadline <= Date.now()
    )
      throw new Error('MARKET_STORE_ABORTED');
    let client: PoolClient | undefined,
      destroyed = false;
    const abort = () => {
      if (destroyed) return;
      destroyed = true;
      client?.release(true);
    };
    context.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(context.deadline - Date.now(), 3000));
    try {
      client = await physical.connect(pool, context);
      if (destroyed || context.signal.aborted) {
        client.release(true);
        client = undefined;
        throw new Error('MARKET_STORE_ABORTED');
      }
      await client.query('BEGIN');
      const result = await work(client);
      if (destroyed || context.signal.aborted || Date.now() >= context.deadline)
        throw new Error('MARKET_STORE_ABORTED');
      await client.query('COMMIT');
      if (destroyed || context.signal.aborted || Date.now() >= context.deadline)
        throw new Error('MARKET_STORE_ABORTED');
      return result;
    } catch {
      if (client && !destroyed) await client.query('ROLLBACK').catch(() => {});
      throw new Error('MARKET_STORE_FAILED');
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      if (client && !destroyed) client.release();
    }
  }
  const context = () => ({ signal: new AbortController().signal, deadline: Date.now() + 3000 });
  try {
    await transaction(context(), async (c) => {
      const result = await c.query<{
        safe: boolean;
      }>(`SELECT NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND current_user=session_user AND pg_has_role(current_user,'ctp_ingest','MEMBER')
        AND NOT pg_has_role(current_user,'ctp_api','MEMBER') AND NOT pg_has_role(current_user,'ctp_auth','MEMBER')
        AND NOT pg_has_role(current_user,'ctp_auth_owner','MEMBER') AND NOT pg_has_role(current_user,'ctp_signer','MEMBER')
        AND NOT has_schema_privilege(current_user,'public','CREATE') AND NOT has_schema_privilege(current_user,'ctp_market','CREATE')
        AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
        AND NOT EXISTS (SELECT 1 FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace WHERE n.nspname IN ('public','ctp_auth','ctp_market') AND pg_has_role(current_user,x.relowner,'MEMBER'))
        AND NOT has_any_column_privilege(current_user,'public.encrypted_credential','SELECT,INSERT,UPDATE')
        AND NOT has_any_column_privilege(current_user,'public.order_intent','SELECT,INSERT,UPDATE')
        AND NOT EXISTS(SELECT 1 FROM pg_roles inherited WHERE (inherited.rolsuper OR inherited.rolbypassrls OR inherited.rolcreaterole OR inherited.rolcreatedb OR inherited.rolreplication OR left(inherited.rolname,3)='pg_') AND pg_has_role(current_user,inherited.oid,'MEMBER'))
        AND NOT EXISTS(SELECT 1 FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace WHERE n.nspname='public' AND x.relkind IN ('r','p') AND x.relname NOT IN ('instrument','instrument_rule_version','capability_snapshot','candle','market_gap','market_checkpoint','subscription_assignment') AND (has_any_column_privilege(current_user,x.oid,'SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege(current_user,x.oid,'DELETE,TRUNCATE,TRIGGER')))
        AS safe FROM pg_roles r WHERE r.rolname=current_user`);
      if (result.rows.length !== 1 || result.rows[0]?.safe !== true) throw new Error('ROLE_UNSAFE');
      await c.query('SELECT key,epoch,version,state,state_hash FROM ctp_market.partition LIMIT 0');
    });
  } catch {
    closed = true;
    await physical.close();
    await pool.end();
    throw new Error('MARKET_DATABASE_ROLE_UNSAFE');
  }
  const validateKey = (key: string) => {
    if (typeof key !== 'string' || Buffer.byteLength(key) > 512 || key.length === 0)
      throw new Error('INVALID_FEED_KEY');
  };
  const ownerId = (owner: string) => z.uuid().parse(owner);
  const decode = (row: {
    epoch: string;
    version: string;
    state: string;
    state_hash: Buffer;
  }): StoredPartition => {
    if (
      !/^[1-9]\d{0,18}$/.test(row.epoch) ||
      !Number.isSafeInteger(Number(row.version)) ||
      !createHash('sha256').update(row.state).digest().equals(row.state_hash)
    )
      throw new Error('CORRUPT_CHECKPOINT');
    return {
      epoch: row.epoch,
      version: Number(row.version),
      state: restoreCandleState(JSON.parse(row.state) as unknown),
    };
  };
  return Object.freeze({
    acquire(key: string, owner: string, initial: CandleState, context: IoContext) {
      validateKey(key);
      ownerId(owner);
      restoreCandleState(initial);
      if (key !== feedKey(initial.scope, initial.instrumentId))
        throw new Error('FEED_KEY_MISMATCH');
      return transaction(context, async (c) => {
        const encoded = JSON.stringify(initial),
          hash = createHash('sha256').update(encoded).digest();
        await c.query(
          `INSERT INTO ctp_market.partition(key,owner,epoch,lease_until,state,state_hash) VALUES($1,$2,1,clock_timestamp()+interval '10 seconds',$3,$4) ON CONFLICT DO NOTHING`,
          [key, owner, encoded, hash],
        );
        const locked = await c.query<{ owner: string; live: boolean }>(
          'SELECT owner,lease_until>clock_timestamp() AS live FROM ctp_market.partition WHERE key=$1 FOR UPDATE',
          [key],
        );
        const r = locked.rows[0];
        if (!r || (r.live && r.owner !== owner)) throw new Error('OWNER_BUSY');
        const rows = await c.query<{
          epoch: string;
          version: string;
          state: string;
          state_hash: Buffer;
        }>(
          `UPDATE ctp_market.partition SET owner=$2,epoch=epoch+CASE WHEN lease_until<=clock_timestamp() THEN 1 ELSE 0 END,lease_until=clock_timestamp()+interval '10 seconds' WHERE key=$1 RETURNING epoch::text,version::text,state,state_hash`,
          [key, owner],
        );
        return decode(rows.rows[0]!);
      });
    },
    commit(
      key: string,
      owner: string,
      previous: StoredPartition,
      state: CandleState,
      events: readonly MarketEvent[],
      context: IoContext,
    ) {
      validateKey(key);
      ownerId(owner);
      restoreCandleState(state);
      if (
        feedKey(state.scope, state.instrumentId) !== key ||
        events.length > 256 ||
        events.some((e) => e.key !== key)
      )
        throw new Error('INVALID_COMMIT');
      return transaction(context, async (c) => {
        const encoded = JSON.stringify(state),
          hash = createHash('sha256').update(encoded).digest();
        const result = await c.query<{
          epoch: string;
          version: string;
          state: string;
          state_hash: Buffer;
        }>(
          `UPDATE ctp_market.partition SET state=$5,state_hash=$6,version=version+1,lease_until=clock_timestamp()+interval '10 seconds' WHERE key=$1 AND owner=$2 AND epoch=$3::bigint AND version=$4::bigint AND lease_until>clock_timestamp() RETURNING epoch::text,version::text,state,state_hash`,
          [key, owner, previous.epoch, previous.version, encoded, hash],
        );
        if (result.rows.length !== 1) throw new Error('OWNER_FENCED');
        const backlog = await c.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM ctp_market.event WHERE key=$1',
          [key],
        );
        if (Number(backlog.rows[0]?.n) + events.length > 10000) throw new Error('OUTBOX_CAPACITY');
        for (const e of events) {
          z.uuid().parse(e.id);
          if (e.bar) {
            const archived = await c.query(
              `INSERT INTO ctp_market.bar(key,timeframe,open_time,revision,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(key,timeframe,open_time) DO UPDATE SET revision=EXCLUDED.revision,payload=EXCLUDED.payload WHERE ctp_market.bar.revision<EXCLUDED.revision OR (ctp_market.bar.revision=EXCLUDED.revision AND ctp_market.bar.payload=EXCLUDED.payload) RETURNING revision`,
              [key, e.bar.timeframeMs, e.bar.openTime, e.bar.revision, JSON.stringify(e.bar)],
            );
            if (archived.rowCount !== 1) throw new Error('CANDLE_REVISION_CONFLICT');
          }
          await c.query('INSERT INTO ctp_market.event(id,key,payload) VALUES($1,$2,$3)', [
            e.id,
            key,
            JSON.stringify(e),
          ]);
        }
        return decode(result.rows[0]!);
      });
    },
    events(key: string, limit: number, context: IoContext) {
      validateKey(key);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        throw new Error('INVALID_LIMIT');
      return transaction(context, async (c) => {
        const rows = await c.query<{ payload: string }>(
          'SELECT payload FROM ctp_market.event WHERE key=$1 ORDER BY sequence LIMIT $2',
          [key, limit],
        );
        return rows.rows.map((r) => JSON.parse(r.payload) as MarketEvent);
      });
    },
    acknowledge(key: string, ids: readonly string[], context: IoContext) {
      validateKey(key);
      if (ids.length > 200) throw new Error('INVALID_LIMIT');
      ids.forEach((x) => z.uuid().parse(x));
      return transaction(context, async (c) => {
        await c.query('DELETE FROM ctp_market.event WHERE key=$1 AND id=ANY($2::uuid[])', [
          key,
          ids,
        ]);
      });
    },
    release(key: string, owner: string, epoch: string, context: IoContext) {
      validateKey(key);
      ownerId(owner);
      return transaction(context, async (c) => {
        await c.query(
          'UPDATE ctp_market.partition SET lease_until=clock_timestamp() WHERE key=$1 AND owner=$2 AND epoch=$3::bigint',
          [key, owner, epoch],
        );
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      const timer = setTimeout(() => {
        for (const c of connections) void c.end().catch(() => {});
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
