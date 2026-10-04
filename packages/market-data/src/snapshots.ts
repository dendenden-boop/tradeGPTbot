import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  marketScopeSchema,
  idSchema,
  orderBookSchema,
  tickerSchema,
  type InstrumentRegistry,
  type MarketScope,
  type OrderBook,
  type Ticker,
} from '@ctp/exchange-core';
import { feedKey } from './candles.js';
export function createMarketSnapshotCache(options: {
  registry: InstrumentRegistry;
  now?: () => number;
  maxInstruments: number;
  maxBytes?: number;
}) {
  if (
    !options.registry ||
    typeof options.registry.get !== 'function' ||
    !Number.isSafeInteger(options.maxInstruments) ||
    options.maxInstruments < 1 ||
    options.maxInstruments > 10000
  )
    throw new Error('SNAPSHOT_RUNTIME_PORT_REQUIRED');
  const now = options.now ?? Date.now,
    maxBytes = options.maxBytes ?? 33554432;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 134217728)
    throw new Error('SNAPSHOT_CAPACITY');
  const values = new Map<
    string,
    { ticker: Ticker | null; book: OrderBook | null; metadata: string; bytes: number }
  >();
  let bytes = 0;
  const hash = (value: Ticker | OrderBook) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          ...value,
          receivedAt: 0,
          ...('snapshotVersion' in value ? { snapshotVersion: '' } : {}),
        }),
      )
      .digest('hex');
  function invalidate(key: string) {
    const entry = values.get(key);
    if (entry) {
      bytes -= entry.bytes;
      values.set(key, { ticker: null, book: null, metadata: '', bytes: 0 });
    }
  }
  function malformed(raw: unknown) {
    const identity = z.object({ scope: marketScopeSchema, instrumentId: idSchema }).safeParse(raw);
    if (identity.success) invalidate(feedKey(identity.data.scope, identity.data.instrumentId));
    return 'RESYNC_REQUIRED' as const;
  }
  function put(
    value: Ticker | OrderBook,
    metadata: string,
    book: boolean,
  ): 'APPLIED' | 'DUPLICATE' | 'RESYNC_REQUIRED' {
    const key = feedKey(value.scope, value.instrumentId),
      record = options.registry.get(value.scope, value.instrumentId, now()),
      previous = values.get(key);
    if (
      !record.ok ||
      record.value.instrument.metadataVersion !== metadata ||
      now() - value.receivedAt > 15000 ||
      value.receivedAt > now() + 5000 ||
      (value.exchangeTime !== null && value.exchangeTime > now() + 5000) ||
      ('stale' in value && value.stale) ||
      ('kind' in value && value.kind !== 'SNAPSHOT')
    ) {
      invalidate(key);
      return 'RESYNC_REQUIRED';
    }
    const old = book ? previous?.book : previous?.ticker;
    if (previous?.metadata && previous.metadata !== metadata) {
      invalidate(key);
      return 'RESYNC_REQUIRED';
    }
    if (old) {
      let order: number;
      if (
        'sourceSequence' in value &&
        'sourceSequence' in old &&
        value.sourceSequence !== null &&
        old.sourceSequence !== null
      ) {
        if (
          !/^(?:0|[1-9]\d{0,127})$/.test(value.sourceSequence) ||
          !/^(?:0|[1-9]\d{0,127})$/.test(old.sourceSequence)
        ) {
          invalidate(key);
          return 'RESYNC_REQUIRED';
        }
        const a = BigInt(value.sourceSequence),
          b = BigInt(old.sourceSequence);
        order = a < b ? -1 : a > b ? 1 : 0;
      } else if (value.exchangeTime !== null && old.exchangeTime !== null)
        order =
          value.exchangeTime < old.exchangeTime
            ? -1
            : value.exchangeTime > old.exchangeTime
              ? 1
              : 0;
      else {
        invalidate(key);
        return 'RESYNC_REQUIRED';
      }
      if (order < 0 || (order === 0 && hash(value) !== hash(old))) {
        invalidate(key);
        return 'RESYNC_REQUIRED';
      }
      if (order === 0) return 'DUPLICATE';
    }
    if (!previous && values.size >= options.maxInstruments) return 'RESYNC_REQUIRED';
    const next = {
      ticker: book ? (previous?.ticker ?? null) : (value as Ticker),
      book: book ? (value as OrderBook) : (previous?.book ?? null),
      metadata,
      bytes: 0,
    };
    next.bytes = Buffer.byteLength(JSON.stringify(next));
    if (bytes - (previous?.bytes ?? 0) + next.bytes > maxBytes) {
      invalidate(key);
      return 'RESYNC_REQUIRED';
    }
    bytes += next.bytes - (previous?.bytes ?? 0);
    values.set(key, structuredClone(next));
    return 'APPLIED';
  }
  return Object.freeze({
    putBook(raw: unknown, metadataVersion: string) {
      const parsed = orderBookSchema.safeParse(raw);
      if (!parsed.success) return malformed(raw);
      return put(parsed.data, metadataVersion, true);
    },
    putTicker(raw: unknown, metadataVersion: string) {
      const parsed = tickerSchema.safeParse(raw);
      if (!parsed.success) return malformed(raw);
      return put(parsed.data, metadataVersion, false);
    },
    gap(scope: MarketScope, instrumentId: string) {
      invalidate(feedKey(scope, instrumentId));
    },
    get(scope: MarketScope, instrumentId: string) {
      const key = feedKey(scope, instrumentId),
        v = values.get(key),
        record = options.registry.get(scope, instrumentId, now());
      if (
        v &&
        (!record.ok ||
          record.value.instrument.metadataVersion !== v.metadata ||
          (v.book !== null && now() - v.book.receivedAt > 15000) ||
          (v.ticker !== null && now() - v.ticker.receivedAt > 15000))
      )
        invalidate(key);
      const current = values.get(key);
      return structuredClone({ ticker: current?.ticker ?? null, book: current?.book ?? null });
    },
    release(scope: MarketScope, instrumentId: string) {
      const key = feedKey(scope, instrumentId),
        v = values.get(key);
      if (v) {
        bytes -= v.bytes;
        values.delete(key);
      }
    },
    metrics() {
      return { instruments: values.size, bytes, maxBytes };
    },
  });
}
