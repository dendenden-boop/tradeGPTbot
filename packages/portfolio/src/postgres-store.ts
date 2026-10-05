import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import {
  bindingSchema,
  eventSchema,
  canonical,
  type Binding,
  type IoContext,
  type Checkpoint,
  type PortfolioStore,
  type PortfolioEvent,
} from './domain.js';
import { createState, reducePortfolio, restorePortfolio } from './accounting.js';
const digest = (value: string) => createHash('sha256').update(value).digest();
const safeErrors = new Set([
  'PORTFOLIO_ABORTED',
  'PORTFOLIO_CLOSED',
  'PORTFOLIO_BINDING_DENIED',
  'EVIDENCE_CONFLICT',
  'REVISION_CONFLICT',
  'PORTFOLIO_OUTBOX_FULL',
  'CORRUPT_CHECKPOINT',
  'INCOMPLETE_COVERAGE',
  'RECONCILIATION_REPAIR_CONFLICT',
  'OUT_OF_ORDER_ECONOMIC',
  'UNKNOWN_COMMITMENT',
  'POSITION_DIRECTION',
  'BALANCE_COMPONENTS',
  'NEEDS_SNAPSHOT',
  'UNPROVEN_FEE_CONVERSION',
  'POSITION_UNITS',
  'FUNDING_UNITS',
  'SPOT_FUNDING_UNSUPPORTED',
  'PORTFOLIO_CAPACITY',
]);
export async function createPostgresPortfolioStore(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
}): Promise<PortfolioStore> {
  let url: URL;
  try {
    z.strictObject({
      connectionString: z.string().max(4096),
      environment: z.enum(['test', 'development', 'staging', 'production']),
    }).parse(options);
    url = new URL(options.connectionString);
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
    throw new Error('PORTFOLIO_DATABASE_URL_INVALID');
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
  let closed = false;
  const connections = new Set<PoolClient>();
  pool.on('connect', (c) => {
    connections.add(c);
    c.once('end', () => connections.delete(c));
  });
  const ctx = () => ({ signal: new AbortController().signal, deadline: Date.now() + 3000 });
  async function transaction<T>(
    context: IoContext,
    binding: Binding | null,
    work: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error('PORTFOLIO_CLOSED');
    if (
      context.signal.aborted ||
      !Number.isSafeInteger(context.deadline) ||
      context.deadline <= Date.now()
    )
      throw new Error('PORTFOLIO_ABORTED');
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
      client = await pool.connect();
      if (destroyed || context.signal.aborted) {
        client.release(true);
        client = undefined;
        throw new Error('PORTFOLIO_ABORTED');
      }
      await client.query('BEGIN');
      if (binding)
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [binding.tenantId]);
      const value = await work(client);
      if (destroyed || context.signal.aborted) throw new Error('PORTFOLIO_ABORTED');
      await client.query('COMMIT');
      return value;
    } catch (error) {
      if (client && !destroyed) await client.query('ROLLBACK').catch(() => {});
      const code =
        error instanceof Error && safeErrors.has(error.message)
          ? error.message
          : 'PORTFOLIO_STORE_FAILED';
      throw new Error(destroyed || context.signal.aborted ? 'PORTFOLIO_ABORTED' : code, {
        // eslint-disable-next-line preserve-caught-error -- Raw PostgreSQL errors can contain private account data or connection secrets.
        cause: new Error('PORTFOLIO_TRANSACTION_FAILED'),
      });
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      if (client && !destroyed) client.release();
    }
  }
  try {
    await transaction(ctx(), null, async (c) => {
      const r = await c.query<{
        safe: boolean;
      }>(`SELECT NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
      AND current_user=session_user AND pg_has_role(current_user,'ctp_portfolio','MEMBER')
      AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE (x.rolsuper OR x.rolbypassrls OR x.rolcreatedb OR x.rolcreaterole OR x.rolreplication OR left(x.rolname,3)='pg_' OR x.rolname IN ('ctp_api','ctp_auth','ctp_auth_owner','ctp_ingest','ctp_signer')) AND pg_has_role(current_user,x.oid,'MEMBER'))
      AND NOT has_schema_privilege(current_user,'public','CREATE') AND NOT has_schema_privilege(current_user,'ctp_portfolio','CREATE') AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
      AND NOT EXISTS(SELECT 1 FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace WHERE n.nspname IN ('public','ctp_auth','ctp_market','ctp_portfolio') AND pg_has_role(current_user,x.relowner,'MEMBER'))
      AND NOT EXISTS(SELECT 1 FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace WHERE n.nspname='public' AND x.relkind IN ('r','p') AND x.relname NOT IN ('exchange_account','exchange_connection','ledger_transaction','ledger_entry') AND (has_any_column_privilege(current_user,x.oid,'SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege(current_user,x.oid,'DELETE,TRUNCATE,TRIGGER')))
      AND NOT has_table_privilege(current_user,'public.exchange_account','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AND NOT has_table_privilege(current_user,'public.exchange_connection','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
      AND NOT has_table_privilege(current_user,'public.ledger_transaction','UPDATE,DELETE,TRUNCATE,TRIGGER') AND NOT has_table_privilege(current_user,'public.ledger_entry','UPDATE,DELETE,TRUNCATE,TRIGGER')
      AS safe FROM pg_roles r WHERE r.rolname=current_user`);
      if (r.rows[0]?.safe !== true) throw new Error('ROLE_UNSAFE');
      await c.query('SELECT id FROM ctp_portfolio.book LIMIT 0');
    });
  } catch {
    closed = true;
    await pool.end();
    throw new Error('PORTFOLIO_DATABASE_ROLE_UNSAFE');
  }
  type Row = { id: string; revision: string; state: string; state_hash: Buffer };
  const decode = (r: Row): Checkpoint => {
    if (
      !Number.isSafeInteger(Number(r.revision)) ||
      Number(r.revision) < 0 ||
      !digest(r.state).equals(r.state_hash)
    )
      throw new Error('CORRUPT_CHECKPOINT');
    try {
      return {
        revision: Number(r.revision),
        state: restorePortfolio(JSON.parse(r.state) as unknown),
      };
    } catch {
      throw new Error('CORRUPT_CHECKPOINT');
    }
  };
  async function ensure(c: PoolClient, b: Binding, lock: boolean): Promise<Row> {
    const ownership = await c.query<{ exchange: string; region: string; external: string }>(
      `SELECT a.exchange,a.region,a."externalAccountId" AS external FROM public.exchange_account a JOIN public.exchange_connection x ON x."tenantId"=a."tenantId" AND x."accountId"=a.id AND x.mode=a.mode WHERE a."tenantId"=$1 AND a.id=$2 AND a.mode=$3 AND x.id=$4`,
      [b.tenantId, b.accountId, b.mode, b.connectionId],
    );
    const a = ownership.rows[0];
    if (
      !a ||
      a.exchange !== b.scope.exchange ||
      a.region !== b.scope.region ||
      a.external !== b.externalAccountId
    )
      throw new Error('PORTFOLIO_BINDING_DENIED');
    const initial = canonical(createState(b));
    await c.query(
      'INSERT INTO ctp_portfolio.book("tenantId","accountId",mode,wallet,state,state_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT ("tenantId","accountId",mode,wallet) DO NOTHING',
      [b.tenantId, b.accountId, b.mode, b.walletId, initial, digest(initial)],
    );
    const r = await c.query<Row>(
      `SELECT id,revision,state,state_hash FROM ctp_portfolio.book WHERE "tenantId"=$1 AND "accountId"=$2 AND mode=$3 AND wallet=$4${lock ? ' FOR UPDATE' : ''}`,
      [b.tenantId, b.accountId, b.mode, b.walletId],
    );
    const row = r.rows[0];
    if (!row || canonical(decode(row).state.binding) !== canonical(b))
      throw new Error('PORTFOLIO_BINDING_DENIED');
    return row;
  }
  const parseBinding = (b: Binding) => bindingSchema.parse(b);
  return Object.freeze({
    evidence(binding: Binding, ids: readonly string[], context: IoContext) {
      const b = parseBinding(binding);
      z.array(z.string().min(1).max(128)).max(200).parse(ids);
      return transaction(context, b, async (c) => {
        const row = await ensure(c, b, false);
        const r = await c.query<{
          id: string;
          payload: string;
          fingerprint: Buffer;
          ledger: string | null;
        }>(
          'SELECT id,payload,fingerprint,ledger FROM ctp_portfolio.evidence WHERE "tenantId"=$1 AND book=$2 AND id=ANY($3::text[])',
          [b.tenantId, row.id, ids],
        );
        const byId = new Map(
          r.rows.map((x) => {
            if (!digest(x.payload).equals(x.fingerprint)) throw new Error('CORRUPT_CHECKPOINT');
            const event = eventSchema.parse(JSON.parse(x.payload) as unknown);
            if (event.id !== x.id) throw new Error('CORRUPT_CHECKPOINT');
            return [x.id, { event, ledgerId: x.ledger }] as const;
          }),
        );
        return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      });
    },
    read(binding: Binding, context: IoContext) {
      const b = parseBinding(binding);
      return transaction(context, b, async (c) => decode(await ensure(c, b, false)));
    },
    apply(binding: Binding, raw: PortfolioEvent, expectedRevision: number, context: IoContext) {
      const b = parseBinding(binding),
        event = eventSchema.parse(raw),
        payload = canonical(event),
        fingerprint = digest(payload);
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        Buffer.byteLength(payload) > 1048576
      )
        throw new Error('INVALID_EVENT');
      return transaction(context, b, async (c) => {
        const row = await ensure(c, b, true),
          previous = decode(row);
        const seen = await c.query<{ fingerprint: Buffer }>(
          'SELECT fingerprint FROM ctp_portfolio.evidence WHERE "tenantId"=$1 AND book=$2 AND id=$3',
          [b.tenantId, row.id, event.id],
        );
        if (seen.rows[0]) {
          if (!seen.rows[0].fingerprint.equals(fingerprint)) throw new Error('EVIDENCE_CONFLICT');
          return { checkpoint: previous, duplicate: true };
        }
        if (previous.revision !== expectedRevision || previous.revision >= Number.MAX_SAFE_INTEGER)
          throw new Error('REVISION_CONFLICT');
        const count = await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM ctp_portfolio.outbox WHERE "tenantId"=$1 AND book=$2',
          [b.tenantId, row.id],
        );
        if ((count.rows[0]?.n ?? 10000) >= 10000) throw new Error('PORTFOLIO_OUTBOX_FULL');
        const reduced = reducePortfolio(previous.state, event, { now: () => Date.now() });
        const ledger = reduced.postings.length ? randomUUID() : null;
        if (ledger) {
          await c.query(
            `INSERT INTO public.ledger_transaction(id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode") VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7::double precision/1000),'portfolio-event')`,
            [
              ledger,
              b.tenantId,
              b.accountId,
              b.mode,
              event.type === 'FILL' ? 'FILL' : event.type === 'FUNDING' ? 'FUNDING' : 'ADJUSTMENT',
              `portfolio:${row.id}:${event.id}`,
              event.timestamp,
            ],
          );
          for (const [index, p] of reduced.postings.entries())
            await c.query(
              'INSERT INTO public.ledger_entry("tenantId","transactionId","accountId",mode,"entryIndex",asset,bucket,amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8::numeric)',
              [b.tenantId, ledger, b.accountId, b.mode, index, p.asset, p.bucket, p.amount],
            );
        }
        await c.query(
          'INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [b.tenantId, row.id, b.accountId, b.mode, event.id, fingerprint, payload, ledger],
        );
        const revision = previous.revision + 1,
          state = canonical(reduced.state);
        await c.query(
          'UPDATE ctp_portfolio.book SET state=$1,state_hash=$2,revision=$3 WHERE "tenantId"=$4 AND id=$5',
          [state, digest(state), revision, b.tenantId, row.id],
        );
        await c.query(
          'INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId") VALUES($1,$2,$3,$4,$5,$6,$7)',
          [b.tenantId, row.id, b.accountId, b.mode, revision, event.type, event.id],
        );
        return { checkpoint: { revision, state: reduced.state }, duplicate: false };
      });
    },
    events(binding: Binding, limit: number, context: IoContext) {
      const b = parseBinding(binding);
      z.number().int().min(1).max(200).parse(limit);
      return transaction(context, b, async (c) => {
        const row = await ensure(c, b, false);
        const r = await c.query<{
          id: string;
          eventId: string;
          revision: string;
          type: PortfolioEvent['type'];
        }>(
          'SELECT id,"eventId",revision,type FROM ctp_portfolio.outbox WHERE "tenantId"=$1 AND book=$2 ORDER BY revision LIMIT $3',
          [b.tenantId, row.id, limit],
        );
        return r.rows.map((r) => ({ ...r, revision: Number(r.revision) }));
      });
    },
    acknowledge(binding: Binding, ids: readonly string[], context: IoContext) {
      const b = parseBinding(binding);
      z.array(z.uuid()).max(200).parse(ids);
      return transaction(context, b, async (c) => {
        const row = await ensure(c, b, false);
        await c.query(
          'DELETE FROM ctp_portfolio.outbox WHERE "tenantId"=$1 AND book=$2 AND id=ANY($3::uuid[])',
          [b.tenantId, row.id, ids],
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
        await pool.end();
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
