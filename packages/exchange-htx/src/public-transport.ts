import { randomUUID } from 'node:crypto';
import {
  immutable,
  timeframeMs,
  type InstrumentRecord,
  type AccountScope,
  type RequestContext,
  type ReadOperation,
  type MutationOperation,
} from '@ctp/exchange-core';
import { createRestClient, readResponse, HtxProtocolError } from './client.js';
import type { NetworkIo } from './io.js';
import type { HtxEndpointProfile } from './profiles.js';
import type { HtxRateLimitPort, WritableInstrumentRegistry } from './ports.js';
import {
  normalizeInstrument,
  normalizeTicker,
  normalizeBook,
  normalizeCandle,
  nativeInterval,
  type HtxAdmission,
} from './public-data.js';
import { requestSpotCandles } from './streams.js';
import { wireObject as object, wireArray as array, wireInteger as integer } from './wire.js';
export function createPublicTransport(
  endpoint: HtxEndpointProfile,
  symbols: readonly string[],
  registry: WritableInstrumentRegistry,
  io: NetworkIo,
  limiter: HtxRateLimitPort,
  account: AccountScope | null,
  now: () => number,
) {
  const client = createRestClient(endpoint, io, limiter, account, now),
    allowed = new Set(symbols);
  let records: readonly InstrumentRecord[] = [],
    admissions: ReadonlyMap<string, HtxAdmission> = new Map(),
    lease: string | null = null,
    expires = 0,
    refreshing = false;
  function record(raw: unknown): InstrumentRecord {
    if (typeof raw !== 'string' || !allowed.has(raw)) throw new HtxProtocolError('INVALID_REQUEST');
    const current = registry.get(endpoint.scope, raw, now()),
      cached = records.find((r) => r.instrument.id === raw);
    if (
      !current.ok ||
      !cached ||
      now() >= expires ||
      current.value.rules.version !== cached.rules.version ||
      current.value.instrument.metadataVersion !== cached.instrument.metadataVersion
    )
      throw new HtxProtocolError('STALE_METADATA');
    return current.value;
  }
  function assertRecord(expected: InstrumentRecord) {
    const current = record(expected.instrument.id);
    if (
      current.rules.version !== expected.rules.version ||
      current.instrument.metadataVersion !== expected.instrument.metadataVersion
    )
      throw new HtxProtocolError('STALE_METADATA');
  }
  async function refresh(context: RequestContext) {
    if (refreshing) throw new HtxProtocolError('BUSY');
    refreshing = true;
    try {
      const response = await client.call(
        {
          path: endpoint.spot
            ? '/v1/settings/common/market-symbols'
            : '/linear-swap-api/v1/swap_contract_info',
          ...(endpoint.spot ? {} : { params: { business_type: 'swap' } }),
        },
        context,
      );
      if (endpoint.spot && integer(response.raw.full) !== 1)
        throw new HtxProtocolError('INVALID_RESPONSE');
      const seen = new Set<string>(),
        selected: unknown[] = [];
      for (const row of array(readResponse(response), 10000)) {
        const x = object(row),
          symbol = x[endpoint.spot ? 'symbol' : 'contract_code'];
        if (typeof symbol === 'string' && allowed.has(symbol)) {
          if (seen.has(symbol)) throw new HtxProtocolError('INVALID_RESPONSE');
          seen.add(symbol);
          selected.push(row);
        }
      }
      if (seen.size !== allowed.size) throw new HtxProtocolError('STALE_METADATA');
      const observation = randomUUID(),
        next = selected
          .map((row) => normalizeInstrument(row, endpoint.scope, response.receivedAt, observation))
          .sort((a, b) => a.record.instrument.id.localeCompare(b.record.instrument.id));
      if (registry.putBatch) {
        const put = await registry.putBatch(
          next.map((item) => item.record),
          response.receivedAt,
          context,
        );
        if (!put.ok)
          throw new HtxProtocolError(put.error.code === 'BUSY' ? 'BUSY' : 'INVALID_RESPONSE');
      } else
        for (const n of next) {
          const put = await registry.put(n.record, response.receivedAt, context);
          if (!put.ok)
            throw new HtxProtocolError(put.error.code === 'BUSY' ? 'BUSY' : 'INVALID_RESPONSE');
        }
      records = immutable(next.map((n) => n.record));
      admissions = new Map(next.map((n) => [n.record.instrument.id, n.admission]));
      lease = observation;
      expires = response.receivedAt + 60000;
    } finally {
      refreshing = false;
    }
  }
  return Object.freeze({
    client,
    record,
    assertRecord,
    refresh,
    admission(instrumentId: string) {
      record(instrumentId);
      const a = admissions.get(instrumentId);
      if (!a) throw new HtxProtocolError('STALE_METADATA');
      return a;
    },
    async request(
      operation: ReadOperation | MutationOperation,
      raw: unknown,
      context: RequestContext,
    ): Promise<unknown> {
      const input = object(raw);
      if (['connect', 'testConnection', 'getServerTime'].includes(operation)) {
        const response = await client.call(
            { path: endpoint.spot ? '/v1/common/timestamp' : '/api/v1/timestamp' },
            context,
          ),
          exchangeTime = integer(endpoint.spot ? readResponse(response) : response.raw.ts);
        return operation === 'getServerTime'
          ? { exchangeTime, receivedAt: response.receivedAt }
          : operation === 'connect'
            ? { state: 'CONNECTED', checkedAt: response.receivedAt }
            : {
                authenticated: false,
                canRead: true,
                canTrade: false,
                checkedAt: response.receivedAt,
              };
      }
      if (operation === 'getSymbols') {
        let offset = 0;
        if (input.cursor === null) {
          if (!lease || now() >= expires) await refresh(context);
        } else {
          if (typeof input.cursor !== 'string' || !/^\w[\w-]{35}\.\d{1,3}$/.test(input.cursor))
            throw new HtxProtocolError('INVALID_REQUEST');
          const [v, i] = input.cursor.split('.');
          if (v !== lease || now() >= expires) throw new HtxProtocolError('STALE_METADATA');
          offset = integer(i);
          if (offset < 1 || offset >= records.length) throw new HtxProtocolError('INVALID_REQUEST');
        }
        const end = offset + integer(input.limit);
        return {
          items: records.slice(offset, end).map((r) => r.instrument),
          nextCursor: end < records.length ? `${lease}.${end}` : null,
          queryId: input.queryId,
        };
      }
      if (!lease || now() >= expires) await refresh(context);
      const r = record(input.instrumentId),
        symbol = r.instrument.exchangeSymbol,
        params = endpoint.spot ? { symbol } : { contract_code: symbol };
      if (operation === 'getSymbolInfo') return r.instrument;
      if (operation === 'getTicker') {
        const response = await client.call(
          {
            path: endpoint.spot ? '/market/detail/merged' : '/linear-swap-ex/market/detail/merged',
            params,
            symbol,
          },
          context,
        );
        assertRecord(r);
        if (response.raw.ch !== `market.${symbol}.detail.merged`)
          throw new HtxProtocolError('SCOPE_MISMATCH');
        return normalizeTicker(response.raw.tick, r, integer(response.raw.ts), response.receivedAt);
      }
      if (operation === 'getOrderBook') {
        const depth = integer(input.depth);
        if (depth > 150) throw new HtxProtocolError('UNSUPPORTED');
        const response = await client.call(
          {
            path: endpoint.spot ? '/market/depth' : '/linear-swap-ex/market/depth',
            params: { ...params, type: 'step0' },
            symbol,
          },
          context,
        );
        assertRecord(r);
        if (response.raw.ch !== `market.${symbol}.depth.step0`)
          throw new HtxProtocolError('SCOPE_MISMATCH');
        return normalizeBook(response.raw.tick, r, depth, response.receivedAt);
      }
      if (operation === 'getHistoricalCandles') {
        const tf = input.timeframe as keyof typeof timeframeMs,
          period = nativeInterval(String(tf)),
          from = integer(input.from),
          to = integer(input.to),
          limit = integer(input.limit),
          start = input.cursor === null ? from : integer(input.cursor);
        if (
          start < from ||
          (start >= to && start !== from) ||
          start % timeframeMs[tf] !== 0 ||
          to % 1000 !== 0 ||
          to > now()
        )
          throw new HtxProtocolError('INVALID_REQUEST');
        if (start === to) return { items: [], nextCursor: null, queryId: input.queryId };
        const end = Math.min(to, start + limit * timeframeMs[tf]),
          channel = `market.${symbol}.kline.${period}`;
        let data: unknown, receivedAt: number;
        if (endpoint.spot) {
          data = await requestSpotCandles(
            endpoint,
            io,
            limiter,
            symbol,
            period,
            start,
            end,
            context,
            now,
          );
          receivedAt = now();
        } else {
          const response = await client.call(
            {
              path: '/linear-swap-ex/market/history/kline',
              params: {
                contract_code: symbol,
                period,
                from: String(start / 1000),
                to: String((end - 1000) / 1000),
              },
              symbol,
            },
            context,
          );
          if (response.raw.ch !== channel) throw new HtxProtocolError('SCOPE_MISMATCH');
          data = readResponse(response);
          receivedAt = response.receivedAt;
        }
        assertRecord(r);
        const seen = new Set<number>(),
          items = array(data, 200)
            .map((row) => normalizeCandle(row, r, String(tf), receivedAt))
            .sort((a, b) => a.openTime - b.openTime);
        for (const c of items) {
          if (c.openTime < start || c.openTime >= end || seen.has(c.openTime))
            throw new HtxProtocolError('INVALID_RESPONSE');
          seen.add(c.openTime);
        }
        return { items, nextCursor: end < to ? String(end) : null, queryId: input.queryId };
      }
      throw new HtxProtocolError('UNSUPPORTED');
    },
  });
}
export type PublicTransport = ReturnType<typeof createPublicTransport>;
