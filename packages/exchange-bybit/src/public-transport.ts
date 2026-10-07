import { randomUUID } from 'node:crypto';
import {
  immutable,
  type AccountScope,
  type InstrumentRecord,
  type ReadOperation,
  type MutationOperation,
  type RequestContext,
} from '@ctp/exchange-core';
import { createRestClient, readResponse, BybitProtocolError } from './client.js';
import type { NetworkIo } from './io.js';
import type { BybitEndpointProfile } from './profiles.js';
import type { BybitRateLimitPort, WritableInstrumentRegistry } from './ports.js';
import {
  normalizeInstrument,
  normalizeTicker,
  normalizeBook,
  normalizeCandles,
  nativeInterval,
  type BybitAdmission,
} from './public-data.js';
import { wireObject as object, wireArray as array, wireInteger as integer } from './wire.js';
import { timeframeMs } from '@ctp/exchange-core';

export function createPublicTransport(
  endpoint: BybitEndpointProfile,
  symbols: readonly string[],
  registry: WritableInstrumentRegistry,
  io: NetworkIo,
  limiter: BybitRateLimitPort,
  account: AccountScope | null,
  now: () => number,
) {
  const client = createRestClient(endpoint, io, limiter, account, now),
    allowed = new Set(symbols);
  let records: readonly InstrumentRecord[] = [],
    admissions: ReadonlyMap<string, BybitAdmission> = new Map(),
    lease: string | null = null,
    expires = 0,
    refreshing = false;
  function record(instrumentId: unknown): InstrumentRecord {
    if (typeof instrumentId !== 'string' || !allowed.has(instrumentId))
      throw new BybitProtocolError('INVALID_REQUEST');
    const found = registry.get(endpoint.scope, instrumentId, now()),
      cached = records.find((v) => v.instrument.id === instrumentId);
    if (
      !found.ok ||
      !cached ||
      now() >= expires ||
      found.value.rules.version !== cached.rules.version ||
      found.value.instrument.metadataVersion !== cached.instrument.metadataVersion
    )
      throw new BybitProtocolError('STALE_METADATA');
    return found.value;
  }
  async function refresh(context: RequestContext) {
    if (refreshing) throw new BybitProtocolError('BUSY');
    refreshing = true;
    try {
      let cursor = '',
        pages = 0;
      const seen = new Set<string>(),
        selected: unknown[] = [];
      let receipt = now();
      do {
        if (++pages > 32) throw new BybitProtocolError('BUSY');
        const response = await client.call(
          {
            path: '/v5/market/instruments-info',
            params: {
              category: endpoint.category,
              ...(endpoint.category === 'linear'
                ? { limit: '1000', ...(cursor === '' ? {} : { cursor }) }
                : {}),
            },
          },
          context,
        );
        receipt = response.receivedAt;
        const data = readResponse(response);
        if (data.category !== endpoint.category) throw new BybitProtocolError('SCOPE_MISMATCH');
        for (const row of array(data.list, 10_000)) {
          const x = object(row);
          if (typeof x.symbol === 'string' && allowed.has(x.symbol)) {
            if (seen.has(x.symbol)) throw new BybitProtocolError('INVALID_RESPONSE');
            seen.add(x.symbol);
            selected.push(row);
          }
        }
        const next = data.nextPageCursor;
        if (next !== undefined && typeof next !== 'string')
          throw new BybitProtocolError('INVALID_RESPONSE');
        const token = next ?? '';
        if (
          token.length > 2048 ||
          (token === cursor && token !== '') ||
          (endpoint.category === 'spot' && token !== '')
        )
          throw new BybitProtocolError('INVALID_RESPONSE');
        cursor = token;
      } while (cursor !== '');
      const observation = randomUUID(),
        next = selected
          .map((raw) => normalizeInstrument(raw, endpoint.scope, receipt, observation))
          .sort((a, b) => a.record.instrument.id.localeCompare(b.record.instrument.id));
      if (registry.putBatch) {
        const put = await registry.putBatch(
          next.map((item) => item.record),
          receipt,
          context,
        );
        if (!put.ok)
          throw new BybitProtocolError(put.error.code === 'BUSY' ? 'BUSY' : 'INVALID_RESPONSE');
      } else
        for (const item of next) {
          const put = await registry.put(item.record, receipt, context);
          if (!put.ok)
            throw new BybitProtocolError(put.error.code === 'BUSY' ? 'BUSY' : 'INVALID_RESPONSE');
        }
      records = immutable(next.map((x) => x.record));
      admissions = new Map(next.map((x) => [x.record.instrument.id, x.admission]));
      lease = observation;
      expires = receipt + 60_000;
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
      if (!a) throw new BybitProtocolError('STALE_METADATA');
      return a;
    },
    async request(
      operation: ReadOperation | MutationOperation,
      raw: unknown,
      context: RequestContext,
    ): Promise<unknown> {
      const input = object(raw);
      if (['connect', 'testConnection', 'getServerTime'].includes(operation)) {
        const r = await client.call({ path: '/v5/market/time' }, context);
        readResponse(r);
        return operation === 'getServerTime'
          ? { exchangeTime: r.exchangeTime, receivedAt: r.receivedAt }
          : operation === 'connect'
            ? { state: 'CONNECTED', checkedAt: r.receivedAt }
            : { authenticated: false, canRead: true, canTrade: false, checkedAt: r.receivedAt };
      }
      if (operation === 'getSymbols') {
        let offset = 0;
        if (input.cursor === null) {
          if (lease === null || now() >= expires) await refresh(context);
        } else {
          if (typeof input.cursor !== 'string' || !/^[a-f0-9-]{36}\.\d{1,3}$/.test(input.cursor))
            throw new BybitProtocolError('INVALID_REQUEST');
          const [v, i] = input.cursor.split('.');
          if (v !== lease || now() >= expires) throw new BybitProtocolError('STALE_METADATA');
          offset = integer(i);
          if (offset < 1 || offset >= records.length)
            throw new BybitProtocolError('INVALID_REQUEST');
        }
        const limit = integer(input.limit),
          end = offset + limit;
        return {
          items: records.slice(offset, end).map((x) => x.instrument),
          nextCursor: end < records.length ? `${lease}.${end}` : null,
          queryId: input.queryId,
        };
      }
      if (lease === null || now() >= expires) await refresh(context);
      const r = record(input.instrumentId),
        symbol = r.instrument.exchangeSymbol,
        params = { category: endpoint.category, symbol };
      if (operation === 'getSymbolInfo') return r.instrument;
      if (operation === 'getTicker') {
        const response = await client.call({ path: '/v5/market/tickers', params, symbol }, context);
        const data = readResponse(response);
        if (data.category !== endpoint.category) throw new BybitProtocolError('SCOPE_MISMATCH');
        const list = array(data.list, 1);
        if (list.length !== 1) throw new BybitProtocolError('INVALID_RESPONSE');
        return normalizeTicker(list[0], r, response.exchangeTime, response.receivedAt);
      }
      if (operation === 'getOrderBook') {
        const response = await client.call(
          {
            path: '/v5/market/orderbook',
            params: { ...params, limit: String(input.depth) },
            symbol,
          },
          context,
        );
        return normalizeBook(readResponse(response), r, integer(input.depth), response.receivedAt);
      }
      if (operation === 'getHistoricalCandles') {
        const interval = nativeInterval(String(input.timeframe)),
          tf = input.timeframe as keyof typeof timeframeMs,
          limit = integer(input.limit),
          from = integer(input.from),
          to = integer(input.to);
        let start = from;
        if (input.cursor !== null) {
          start = integer(input.cursor);
          if (start <= from || start >= to) throw new BybitProtocolError('INVALID_REQUEST');
        }
        if (start >= to) return { items: [], nextCursor: null, queryId: input.queryId };
        const end = Math.min(to, start + limit * timeframeMs[tf]);
        const response = await client.call(
          {
            path: '/v5/market/kline',
            params: {
              ...params,
              interval,
              start: String(start),
              end: String(end - 1),
              limit: String(limit),
            },
            symbol,
          },
          context,
        );
        const data = readResponse(response);
        if (data.category !== endpoint.category || data.symbol !== symbol)
          throw new BybitProtocolError('SCOPE_MISMATCH');
        const items = normalizeCandles(
          data.list,
          r,
          String(input.timeframe),
          response.receivedAt,
        ).filter((c) => c.openTime >= start && c.openTime < end);
        return { items, nextCursor: end < to ? String(end) : null, queryId: input.queryId };
      }
      throw new BybitProtocolError('UNSUPPORTED');
    },
  });
}
export type PublicTransport = ReturnType<typeof createPublicTransport>;
