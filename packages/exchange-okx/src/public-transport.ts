import { randomUUID } from 'node:crypto';
import {
  immutable,
  timeframeMs,
  type AccountScope,
  type InstrumentRecord,
  type ReadOperation,
  type MutationOperation,
  type RequestContext,
} from '@ctp/exchange-core';
import { createRestClient, readResponse, OkxProtocolError } from './client.js';
import type { NetworkIo } from './io.js';
import type { OkxEndpointProfile } from './profiles.js';
import type { OkxRateLimitPort, WritableInstrumentRegistry } from './ports.js';
import {
  normalizeInstrument,
  normalizeTicker,
  normalizeCandles,
  nativeInterval,
  createBookAssembler,
  type OkxAdmission,
} from './public-data.js';
import { wireObject as object, wireArray as array, wireInteger as integer } from './wire.js';

export function createPublicTransport(
  endpoint: OkxEndpointProfile,
  symbols: readonly string[],
  registry: WritableInstrumentRegistry,
  io: NetworkIo,
  limiter: OkxRateLimitPort,
  account: AccountScope | null,
  now: () => number,
) {
  const client = createRestClient(endpoint, io, limiter, account, now),
    allowed = new Set(symbols);
  let records: readonly InstrumentRecord[] = [],
    admissions: ReadonlyMap<string, OkxAdmission> = new Map(),
    lease: string | null = null,
    expires = 0,
    refreshing = false;
  function record(instrumentId: unknown): InstrumentRecord {
    if (typeof instrumentId !== 'string' || !allowed.has(instrumentId))
      throw new OkxProtocolError('INVALID_REQUEST');
    const found = registry.get(endpoint.scope, instrumentId, now()),
      cached = records.find((v) => v.instrument.id === instrumentId);
    if (
      !found.ok ||
      !cached ||
      now() >= expires ||
      found.value.rules.version !== cached.rules.version ||
      found.value.instrument.metadataVersion !== cached.instrument.metadataVersion
    )
      throw new OkxProtocolError('STALE_METADATA');
    return found.value;
  }
  async function refresh(context: RequestContext) {
    if (refreshing) throw new OkxProtocolError('BUSY');
    refreshing = true;
    try {
      const response = await client.call(
          { path: '/api/v5/public/instruments', params: { instType: endpoint.instType } },
          context,
        ),
        selected: unknown[] = [],
        seen = new Set<string>();
      for (const row of array(readResponse(response), 10000)) {
        const x = object(row);
        if (typeof x.instId === 'string' && allowed.has(x.instId)) {
          if (seen.has(x.instId)) throw new OkxProtocolError('INVALID_RESPONSE');
          seen.add(x.instId);
          selected.push(row);
        }
      }
      const observation = randomUUID(),
        next = selected
          .map((raw) => normalizeInstrument(raw, endpoint.scope, response.receivedAt, observation))
          .sort((a, b) => a.record.instrument.id.localeCompare(b.record.instrument.id));
      for (const item of next) {
        const put = registry.put(item.record, response.receivedAt);
        if (!put.ok)
          throw new OkxProtocolError(put.error.code === 'BUSY' ? 'BUSY' : 'INVALID_RESPONSE');
      }
      records = immutable(next.map((x) => x.record));
      admissions = new Map(next.map((x) => [x.record.instrument.id, x.admission]));
      lease = observation;
      expires = Math.min(response.receivedAt + 60000, ...next.map((x) => x.record.rules.expiresAt));
    } finally {
      refreshing = false;
    }
  }
  return Object.freeze({
    client,
    record,
    refresh,
    admission(instrumentId: string) {
      record(instrumentId);
      const a = admissions.get(instrumentId);
      if (!a) throw new OkxProtocolError('STALE_METADATA');
      return a;
    },
    async request(
      operation: ReadOperation | MutationOperation,
      raw: unknown,
      context: RequestContext,
    ): Promise<unknown> {
      const input = object(raw);
      if (['connect', 'testConnection', 'getServerTime'].includes(operation)) {
        const r = await client.call({ path: '/api/v5/public/time' }, context),
          data = array(readResponse(r), 1);
        if (data.length !== 1) throw new OkxProtocolError('INVALID_RESPONSE');
        const exchangeTime = integer(object(data[0]).ts);
        return operation === 'getServerTime'
          ? { exchangeTime, receivedAt: r.receivedAt }
          : operation === 'connect'
            ? { state: 'CONNECTED', checkedAt: r.receivedAt }
            : { authenticated: false, canRead: true, canTrade: false, checkedAt: r.receivedAt };
      }
      if (operation === 'getSymbols') {
        let offset = 0;
        if (input.cursor === null) {
          if (lease === null || now() >= expires) await refresh(context);
        } else {
          if (typeof input.cursor !== 'string' || !/^\w[\w-]{35}\.\d{1,3}$/.test(input.cursor))
            throw new OkxProtocolError('INVALID_REQUEST');
          const [v, i] = input.cursor.split('.');
          if (v !== lease || now() >= expires) throw new OkxProtocolError('STALE_METADATA');
          offset = integer(i);
          if (offset < 1 || offset >= records.length) throw new OkxProtocolError('INVALID_REQUEST');
        }
        const end = offset + integer(input.limit);
        return {
          items: records.slice(offset, end).map((x) => x.instrument),
          nextCursor: end < records.length ? `${lease}.${end}` : null,
          queryId: input.queryId,
        };
      }
      if (lease === null || now() >= expires) await refresh(context);
      const r = record(input.instrumentId),
        symbol = r.instrument.exchangeSymbol,
        params = { instId: symbol };
      if (operation === 'getSymbolInfo') return r.instrument;
      if (operation === 'getTicker') {
        const response = await client.call(
            { path: '/api/v5/market/ticker', params, symbol },
            context,
          ),
          rows = array(readResponse(response), 1);
        if (rows.length !== 1) throw new OkxProtocolError('INVALID_RESPONSE');
        return normalizeTicker(rows[0], r, response.receivedAt);
      }
      if (operation === 'getOrderBook') {
        const depth = integer(input.depth);
        if (depth > 400) throw new OkxProtocolError('UNSUPPORTED');
        const response = await client.call(
            { path: '/api/v5/market/books', params: { ...params, sz: String(depth) }, symbol },
            context,
          ),
          rows = array(readResponse(response), 1);
        if (rows.length !== 1) throw new OkxProtocolError('INVALID_RESPONSE');
        const x = object(rows[0]);
        // REST books may omit sequence. No fabricated sequence enters a WS continuity contract.
        if (x.seqId === undefined) throw new OkxProtocolError('UNSUPPORTED');
        return createBookAssembler(r, depth).update(
          { action: 'snapshot', data: [{ ...x, prevSeqId: '-1' }] },
          response.receivedAt,
        );
      }
      if (operation === 'getHistoricalCandles') {
        const interval = nativeInterval(String(input.timeframe)),
          tf = input.timeframe as keyof typeof timeframeMs,
          limit = integer(input.limit),
          from = integer(input.from),
          to = integer(input.to);
        if (limit > 100) throw new OkxProtocolError('UNSUPPORTED');
        let start = from;
        if (input.cursor !== null) {
          start = integer(input.cursor);
          if (start <= from || start >= to) throw new OkxProtocolError('INVALID_REQUEST');
        }
        if (start >= to) return { items: [], nextCursor: null, queryId: input.queryId };
        if (start === 0) throw new OkxProtocolError('UNSUPPORTED');
        const end = Math.min(to, start + limit * timeframeMs[tf]),
          response = await client.call(
            {
              path: '/api/v5/market/history-candles',
              params: {
                ...params,
                bar: interval,
                after: String(end),
                before: String(start - 1),
                limit: String(limit),
              },
              symbol,
            },
            context,
          );
        const items = normalizeCandles(
          readResponse(response),
          r,
          String(input.timeframe),
          response.receivedAt,
        );
        if (items.some((c) => c.openTime < start || c.openTime >= end))
          throw new OkxProtocolError('INVALID_RESPONSE');
        return { items, nextCursor: end < to ? String(end) : null, queryId: input.queryId };
      }
      throw new OkxProtocolError('UNSUPPORTED');
    },
  });
}
export type PublicTransport = ReturnType<typeof createPublicTransport>;
