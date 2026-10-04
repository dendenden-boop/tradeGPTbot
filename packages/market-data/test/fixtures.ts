import {
  createInstrumentRegistry,
  tradeTickSchema,
  type Result,
  type InstrumentRecord,
} from '@ctp/exchange-core';
import { recordFixture } from '../../exchange-core/test/fixtures/domain.js';
import type { CandleState } from '../src/candles.js';
import type { MarketStore, StoredPartition, MarketEvent } from '../src/ports.js';
export const scope = {
  exchange: 'BINANCE',
  market: 'SPOT',
  environment: 'TESTNET',
  region: 'global',
} as const;
export const tick = (id = '1', time = 1, instrumentId = 'BTCUSDT') =>
  tradeTickSchema.parse({
    scope,
    instrumentId,
    exchangeTime: time,
    receivedAt: time,
    tradeId: id,
    identityScope: 'BINANCE:TRADES',
    price: '10',
    quantity: '0.1',
    quantityUnit: 'BASE',
    side: 'BUY',
    sourceSequence: id,
  });
export function registry(count = 300) {
  const registry = createInstrumentRegistry({ capacity: count + 1 });
  for (let i = 0; i < count; i++) {
    const record = recordFixture(scope),
      id = i === 0 ? 'BTCUSDT' : `COIN${i}USDT`;
    const result: Result<InstrumentRecord> = registry.put(
      {
        instrument: {
          ...record.instrument,
          id,
          exchangeSymbol: id,
          metadataVersion: `metadata-${i}`,
        },
        rules: {
          ...record.rules,
          instrumentId: id,
          version: `rules-${i}`,
          effectiveAt: 0,
          expiresAt: 8640000000000,
        },
      },
      0,
    );
    if (!result.ok) throw new Error(result.error.code);
  }
  return registry;
}
/** Test-only durable model across handle recreation; never a production export/default. */
export function storeFixture() {
  const rows = new Map<string, StoredPartition & { owner: string }>(),
    outbox = new Map<string, MarketEvent[]>();
  let fail = false;
  const store: MarketStore = {
    async acquire(key, owner, initial) {
      await Promise.resolve();
      const previous = rows.get(key);
      const row = {
        owner,
        epoch:
          previous?.owner === owner ? previous.epoch : String(BigInt(previous?.epoch ?? '0') + 1n),
        version: previous?.version ?? 0,
        state: structuredClone(previous?.state ?? initial),
      };
      rows.set(key, row);
      return structuredClone(row);
    },
    async commit(key, owner, previous, state, events) {
      await Promise.resolve();
      if (fail) throw new Error('STORE_FAILED');
      const current = rows.get(key);
      if (
        !current ||
        current.owner !== owner ||
        current.epoch !== previous.epoch ||
        current.version !== previous.version
      )
        throw new Error('FENCED');
      const row = {
        owner,
        epoch: previous.epoch,
        version: previous.version + 1,
        state: structuredClone(state),
      };
      rows.set(key, row);
      outbox.set(key, [...(outbox.get(key) ?? []), ...structuredClone(events)]);
      return structuredClone(row);
    },
    async events(key, limit) {
      await Promise.resolve();
      return structuredClone((outbox.get(key) ?? []).slice(0, limit));
    },
    async acknowledge(key, ids) {
      await Promise.resolve();
      outbox.set(
        key,
        (outbox.get(key) ?? []).filter((e) => !ids.includes(e.id)),
      );
    },
    async release() {},
    async close() {},
  };
  return {
    store,
    rows,
    outbox,
    setFailure: (v: boolean) => {
      fail = v;
    },
    state: (key: string): CandleState => structuredClone(rows.get(key)!.state),
  };
}
