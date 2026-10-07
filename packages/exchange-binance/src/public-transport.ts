import { randomUUID } from 'node:crypto';
import {
  immutable,
  timestampSchema,
  type AccountScope,
  type InstrumentRecord,
  type ReadOperation,
  type MutationOperation,
  type RequestContext,
} from '@ctp/exchange-core';
import { BinanceProtocolError, createRestClient, readResponse } from './client.js';
import type { NetworkIo } from './io.js';
import type { BinanceEndpointProfile } from './profiles.js';
import type { BinanceRateLimitPort, WritableInstrumentRegistry } from './ports.js';
import {
  normalizeBook,
  normalizeCandles,
  normalizeExchangeInfo,
  normalizeTicker,
  normalizeBinanceAdmission,
  type BinanceAdmission,
} from './public-data.js';
import { wireObject, wireInteger, wireArray } from './wire.js';

function invalid(): never {
  throw new BinanceProtocolError('INVALID_RESPONSE');
}
function cursorInteger(raw: unknown): number {
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d{0,15})$/.test(raw)) return invalid();
  return wireInteger(raw);
}

/** Internal server assembly: callers cannot supply destinations through the adapter API. */
export function createPublicTransport(
  endpoint: BinanceEndpointProfile,
  symbols: readonly string[],
  registry: WritableInstrumentRegistry,
  io: NetworkIo,
  limiter: BinanceRateLimitPort,
  account: AccountScope | null,
  now: () => number,
) {
  const client = createRestClient(endpoint, io, limiter, account, now);
  const prefix = endpoint.scope.market === 'SPOT' ? '/api/v3/' : '/fapi/v1/';
  const allowed = new Set(symbols);
  let records: readonly InstrumentRecord[] = [];
  let admissions: ReadonlyMap<string, BinanceAdmission> = new Map();
  let lease = 0;
  let leaseId: string | null = null;
  const record = (instrumentId: unknown): InstrumentRecord => {
    if (typeof instrumentId !== 'string' || !allowed.has(instrumentId))
      throw new BinanceProtocolError('INVALID_REQUEST');
    const result = registry.get(endpoint.scope, instrumentId, now());
    if (!result.ok)
      throw new BinanceProtocolError(
        result.error.code === 'NOT_FOUND'
          ? 'STALE_METADATA'
          : result.error.code === 'STALE_METADATA'
            ? 'STALE_METADATA'
            : 'INVALID_RESPONSE',
      );
    const cached = records.find((value) => value.instrument.id === instrumentId);
    if (
      !cached ||
      cached.rules.version !== result.value.rules.version ||
      cached.instrument.metadataVersion !== result.value.instrument.metadataVersion
    )
      throw new BinanceProtocolError('STALE_METADATA');
    return result.value;
  };
  async function refresh(context: RequestContext): Promise<void> {
    const response = await client.call(
      {
        path: `${prefix}exchangeInfo`,
        weight: endpoint.scope.market === 'SPOT' ? 20 : 1,
        ...(endpoint.scope.market === 'SPOT'
          ? { params: { symbols: JSON.stringify(symbols), showPermissionSets: 'false' } }
          : {}),
      },
      context,
    );
    const raw = wireObject(readResponse(response));
    const observationId = randomUUID();
    const selected = wireArray(raw.symbols, 10_000).filter((item) =>
      allowed.has(String(wireObject(item).symbol)),
    );
    const nextRecords = [
      ...normalizeExchangeInfo(
        { ...raw, symbols: selected },
        endpoint.scope,
        response.receivedAt,
        observationId,
      ),
    ].sort((a, b) =>
      a.instrument.id < b.instrument.id ? -1 : a.instrument.id > b.instrument.id ? 1 : 0,
    );
    const eligible = new Set(nextRecords.map((value) => value.instrument.id));
    const nextAdmissions = new Map(
      selected
        .filter((item) => eligible.has(String(wireObject(item).symbol)))
        .map((item) => {
          const result = normalizeBinanceAdmission(item);
          return [result.symbol, result] as const;
        }),
    );
    if (registry.putBatch) {
      const inserted = await registry.putBatch(nextRecords, response.receivedAt, context);
      if (!inserted.ok)
        throw Object.assign(new Error(inserted.error.code), { code: inserted.error.code });
    } else
      for (const value of nextRecords) {
        const inserted = await registry.put(value, response.receivedAt, context);
        if (!inserted.ok)
          throw Object.assign(new Error(inserted.error.code), { code: inserted.error.code });
      }
    records = immutable(nextRecords);
    admissions = nextAdmissions;
    lease = response.receivedAt;
    leaseId = observationId;
  }
  return Object.freeze({
    client,
    record,
    admission(instrumentId: string): BinanceAdmission {
      record(instrumentId);
      const value = admissions.get(instrumentId);
      if (!value) throw new BinanceProtocolError('STALE_METADATA');
      return value;
    },
    async request(
      operation: ReadOperation | MutationOperation,
      request: unknown,
      context: RequestContext,
    ): Promise<unknown> {
      const input = wireObject(request);
      if (operation === 'connect' || operation === 'testConnection') {
        readResponse(await client.call({ path: `${prefix}ping`, weight: 1 }, context));
        return operation === 'connect'
          ? { state: 'CONNECTED', checkedAt: now() }
          : { authenticated: false, canRead: true, canTrade: false, checkedAt: now() };
      }
      if (operation === 'getServerTime') {
        const response = await client.call({ path: `${prefix}time`, weight: 1 }, context);
        return {
          exchangeTime: timestampSchema.parse(
            wireInteger(wireObject(readResponse(response)).serverTime),
          ),
          receivedAt: response.receivedAt,
        };
      }
      if (operation === 'getSymbols') {
        if (
          !Number.isInteger(input.limit) ||
          typeof input.limit !== 'number' ||
          input.limit < 1 ||
          input.limit > 200
        )
          return invalid();
        let index = 0;
        if (input.cursor === null) {
          if (leaseId === null || now() >= lease + 60_000) await refresh(context);
        } else {
          if (typeof input.cursor !== 'string' || !/^[a-f0-9-]{36}\.\d{1,3}$/.test(input.cursor))
            return invalid();
          const [version, offset] = input.cursor.split('.');
          if (version !== leaseId || now() >= lease + 60_000)
            throw new BinanceProtocolError('STALE_METADATA');
          index = cursorInteger(offset);
          if (index < 1 || index >= records.length) return invalid();
        }
        return {
          items: records.slice(index, index + input.limit).map((value) => value.instrument),
          nextCursor:
            index + input.limit < records.length ? `${leaseId}.${index + input.limit}` : null,
          queryId: input.queryId,
        };
      }
      if (
        !['getSymbolInfo', 'getTicker', 'getOrderBook', 'getHistoricalCandles'].includes(operation)
      )
        throw new BinanceProtocolError('UNSUPPORTED');
      const metadata = record(input.instrumentId),
        symbol = metadata.instrument.exchangeSymbol;
      if (operation === 'getSymbolInfo') return metadata.instrument;
      if (operation === 'getTicker') {
        const response = await client.call(
          {
            path: `${prefix}ticker/24hr`,
            params: { symbol },
            symbol,
            weight: endpoint.scope.market === 'SPOT' ? 2 : 1,
          },
          context,
        );
        return normalizeTicker(readResponse(response), metadata, response.receivedAt);
      }
      if (operation === 'getOrderBook') {
        if (
          typeof input.depth !== 'number' ||
          !Number.isInteger(input.depth) ||
          input.depth < 1 ||
          input.depth > 1000
        )
          return invalid();
        const limit =
          [5, 10, 20, 50, 100, 500, 1000].find((value) => value >= (input.depth as number)) ?? 1000;
        const weight =
          endpoint.scope.market === 'SPOT'
            ? limit <= 100
              ? 5
              : limit <= 500
                ? 25
                : 50
            : limit <= 50
              ? 2
              : limit <= 100
                ? 5
                : limit <= 500
                  ? 10
                  : 20;
        const response = await client.call(
          { path: `${prefix}depth`, params: { symbol, limit: String(limit) }, symbol, weight },
          context,
        );
        return normalizeBook(readResponse(response), metadata, response.receivedAt, input.depth);
      }
      if (input.timeframe === '30s') throw new BinanceProtocolError('UNSUPPORTED');
      if (
        typeof input.timeframe !== 'string' ||
        typeof input.from !== 'number' ||
        typeof input.to !== 'number' ||
        typeof input.limit !== 'number'
      )
        return invalid();
      const from = timestampSchema.parse(input.from),
        to = timestampSchema.parse(input.to);
      if (from === to) return { items: [], nextCursor: null, queryId: input.queryId };
      const start = input.cursor === null ? from : cursorInteger(input.cursor);
      if (start < from || start >= to || input.limit < 1 || input.limit > 200) return invalid();
      const limit = input.limit + 1;
      const weight = endpoint.scope.market === 'SPOT' ? 2 : limit < 100 ? 1 : 2;
      const response = await client.call(
        {
          path: `${prefix}klines`,
          params: {
            symbol,
            interval: input.timeframe,
            startTime: String(start),
            endTime: String(to - 1),
            limit: String(limit),
          },
          symbol,
          weight,
        },
        context,
      );
      const items = normalizeCandles(
        readResponse(response),
        metadata,
        input.timeframe,
        response.receivedAt,
      );
      if (
        items.length > limit ||
        items.some((value) => value.openTime < start || value.openTime >= to)
      )
        return invalid();
      return {
        items: items.slice(0, input.limit),
        nextCursor: items.length > input.limit ? String(items[input.limit]?.openTime) : null,
        queryId: input.queryId,
      };
    },
  });
}
