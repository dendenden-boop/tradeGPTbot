import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { Client } from 'pg';
import { z } from 'zod';
import { immutable, postgresRoleBoundary } from '@ctp/exchange-core';
import {
  marketTradeKeySchema,
  marketTradePublicationSchema,
  marketTradeReceiptSchema,
  marketTradeHeadSchema,
  type DurableMarketTrades,
} from './durable-trades.js';
import type { IoContext } from './ports.js';

/** Server-controlled isolated public evidence role. No credential or financial
 * table access, caller URL/profile overrides, in-memory journal or retries. */
export async function createPostgresMarketTrades(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
  io?: IoContext;
}): Promise<DurableMarketTrades> {
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
    throw new Error('MARKET_TRADE_DATABASE_URL');
  }
  const sockets = new Set<Socket>();
  let closed = false;
  async function tx<T>(io: IoContext, work: (p: Client) => Promise<T>): Promise<T> {
    if (closed) throw new Error('MARKET_TRADE_CLOSED');
    if (
      !io ||
      !(io.signal instanceof AbortSignal) ||
      io.signal.aborted ||
      !Number.isSafeInteger(io.deadline) ||
      io.deadline <= Date.now()
    )
      throw new Error('MARKET_TRADE_ABORTED');
    if (sockets.size >= 4) throw new Error('MARKET_TRADE_BUSY');
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
        socket.destroy(new Error('MARKET_TRADE_ABORTED'));
      }
    };
    io.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(3000, io.deadline - Date.now()));
    try {
      await p.connect();
      if (destroyed || io.signal.aborted) throw new Error('MARKET_TRADE_ABORTED');
      await p.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const value = await work(p);
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('MARKET_TRADE_ABORTED');
      committing = true;
      await p.query('COMMIT');
      if (destroyed || io.signal.aborted || Date.now() >= io.deadline)
        throw new Error('MARKET_TRADE_UNCERTAIN');
      return value;
    } catch (error) {
      if (!destroyed) await p.query('ROLLBACK').catch(() => {});
      const known = [
        'MARKET_TRADE_INPUT',
        'MARKET_TRADE_CONFLICT',
        'MARKET_TRADE_STALE',
        'MARKET_TRADE_METADATA',
        'MARKET_TRADE_MISSING',
        'MARKET_TRADE_RESYNC_REQUIRED',
        'MARKET_TRADE_CORRUPT',
        'MARKET_TRADE_ROLE_UNSAFE',
      ];
      const code = committing
        ? 'MARKET_TRADE_UNCERTAIN'
        : destroyed || io.signal.aborted
          ? 'MARKET_TRADE_ABORTED'
          : error instanceof Error && known.includes(error.message)
            ? error.message
            : 'MARKET_TRADE_STORE_FAILED';
      throw new Error(code, {
        // eslint-disable-next-line preserve-caught-error -- Native payloads, SQL and connection material must not cross the server port.
        cause: new Error('MARKET_TRADE_TRANSACTION_FAILED'),
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
    const ending = [...sockets].map(
      (s) => new Promise<void>((yes) => s.once('close', () => yes())),
    );
    for (const s of sockets) s.destroy(new Error('MARKET_TRADE_CLOSED'));
    await Promise.all(ending);
  }
  const functions = [
    'ctp_market.publish_trade(text,text)',
    'ctp_market.read_trade(jsonb,integer)',
    'ctp_market.trade_head_state(jsonb)',
  ];
  try {
    await tx(
      options.io ?? { signal: new AbortController().signal, deadline: Date.now() + 3000 },
      async (p) => {
        const result = await p.query<{ safe: boolean }>(`SELECT current_user=session_user
        AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND pg_has_role(current_user,'ctp_market_trade','MEMBER')
        AND (${postgresRoleBoundary('ctp_market_trade', functions)})
        AND has_function_privilege(current_user,'ctp_market.publish_trade(text,text)','EXECUTE')
        AND has_function_privilege(current_user,'ctp_market.read_trade(jsonb,integer)','EXECUTE')
        AND has_function_privilege(current_user,'ctp_market.trade_head_state(jsonb)','EXECUTE') AS safe FROM pg_roles r WHERE r.rolname=current_user`);
        if (result.rows[0]?.safe !== true) throw new Error('MARKET_TRADE_ROLE_UNSAFE');
      },
    );
  } catch {
    await close();
    throw new Error('MARKET_TRADE_ROLE_UNSAFE');
  }
  return Object.freeze({
    async publish(raw: unknown, io: IoContext) {
      const checked = marketTradePublicationSchema.safeParse(raw);
      if (!checked.success) throw new Error('MARKET_TRADE_INPUT');
      const publication = checked.data,
        text = JSON.stringify(publication),
        hash = createHash('sha256').update(text).digest('hex');
      return tx(io, async (p) => {
        const row = await p.query<{ result: unknown }>(
          'SELECT ctp_market.publish_trade($1::text,$2::text) AS result',
          [text, hash],
        );
        const receipt = marketTradeReceiptSchema.parse(row.rows[0]?.result);
        if (receipt.id !== publication.id) throw new Error('MARKET_TRADE_CORRUPT');
        return immutable(receipt);
      });
    },
    async head(raw: unknown, io: IoContext) {
      const checked = marketTradeKeySchema.safeParse(raw);
      if (!checked.success) throw new Error('MARKET_TRADE_INPUT');
      return tx(io, async (p) => {
        const row = await p.query<{ result: unknown }>(
          'SELECT ctp_market.trade_head_state($1::jsonb) AS result',
          [JSON.stringify(checked.data)],
        );
        return immutable(marketTradeHeadSchema.parse(row.rows[0]?.result));
      });
    },
    async read(raw: unknown, io: IoContext, maxAgeMs = 5000) {
      const checked = marketTradeKeySchema.safeParse(raw);
      if (!checked.success || !Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 5000)
        throw new Error('MARKET_TRADE_INPUT');
      const result = await tx(io, async (p) => {
        const row = await p.query<{ result: unknown }>(
          'SELECT ctp_market.read_trade($1::jsonb,$2::integer) AS result',
          [JSON.stringify(checked.data), maxAgeMs],
        );
        const wire = z
          .strictObject({
            id: z.uuid(),
            revision: marketTradeReceiptSchema.shape.revision,
            text: z.string().max(1048576),
            hash: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .parse(row.rows[0]?.result);
        if (createHash('sha256').update(wire.text).digest('hex') !== wire.hash)
          throw new Error('MARKET_TRADE_CORRUPT');
        const publication = marketTradePublicationSchema.parse(JSON.parse(wire.text));
        if (
          publication.kind !== 'TRADE' ||
          publication.id !== wire.id ||
          JSON.stringify(publication.key) !== JSON.stringify(checked.data)
        )
          throw new Error('MARKET_TRADE_CORRUPT');
        return immutable({ id: wire.id, revision: wire.revision, hash: wire.hash, publication });
      });
      const now = Date.now(),
        p = result.publication;
      if (
        [p.timestamp, p.trade.receivedAt, p.trade.exchangeTime].some(
          (t) => t > now || now - t > maxAgeMs,
        )
      )
        throw new Error('MARKET_TRADE_STALE');
      if (
        p.record.rules.effectiveAt > now ||
        p.record.rules.expiresAt <= now ||
        (p.record.instrument.expiryAt !== null && p.record.instrument.expiryAt <= now)
      )
        throw new Error('MARKET_TRADE_METADATA');
      return result;
    },
    close,
  });
}
