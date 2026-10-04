import { describe, expect, it } from 'vitest';
import { createMarketDataEngine } from '../src/engine.js';
import { scope, tick, registry, storeFixture } from './fixtures.js';
const trade = (
  id = '1',
  time = 1000,
  instrumentId = 'BTCUSDT',
  metadataVersion = 'metadata-0',
) => ({
  kind: 'TRADE' as const,
  tick: tick(id, time, instrumentId),
  metadataVersion,
  executionCount: 1,
});
describe('shared engine, storage and admission contracts', () => {
  it('restored history remains stale after a fresh trade until explicit reconciliation', async () => {
    const f = storeFixture(),
      r = registry(1),
      first = createMarketDataEngine({ registry: r, store: f.store, now: () => 1000 });
    const key = await first.retain(scope, 'BTCUSDT', 0);
    first.enqueue(key, trade());
    await first.flush();
    await first.close();
    const restarted = createMarketDataEngine({ registry: r, store: f.store, now: () => 1001 });
    await restarted.retain(scope, 'BTCUSDT', 0);
    restarted.enqueue(key, trade('2', 1001));
    await restarted.flush();
    expect(restarted.health(key).freshness).toBe('STALE');
    await restarted.close();
  });
  it('requires registry and durable store; refcounts one shared public identity', async () => {
    expect(() => createMarketDataEngine({} as never)).toThrow();
    const f = storeFixture(),
      engine = createMarketDataEngine({ registry: registry(1), store: f.store, now: () => 1000 });
    const a = await engine.retain(scope, 'BTCUSDT', 0),
      b = await engine.retain(scope, 'BTCUSDT', 0);
    expect(a).toBe(b);
    expect(engine.metrics().instruments).toBe(1);
    await engine.release(a);
    expect(engine.metrics().instruments).toBe(1);
    await engine.release(b);
    expect(engine.metrics().instruments).toBe(0);
    await engine.close();
  });
  it('commits checkpoint, dedup and seven timeframes atomically across restart', async () => {
    const f = storeFixture(),
      r = registry(1),
      engine = createMarketDataEngine({ registry: r, store: f.store, now: () => 31000 });
    const key = await engine.retain(scope, 'BTCUSDT', 0);
    engine.enqueue(key, trade());
    engine.enqueue(key, {
      kind: 'COVERAGE',
      proof: { from: 0, to: 30000, cursor: 'checkpoint', evidence: 'RECONCILED_TRADES' },
      repaired: false,
    });
    await engine.flush();
    expect(f.state(key).bars).toHaveLength(7);
    expect(f.outbox.get(key)?.filter((e) => e.type === 'CANDLE_CLOSED')).toHaveLength(1);
    await engine.close();
    const second = createMarketDataEngine({ registry: r, store: f.store, now: () => 31000 });
    await second.retain(scope, 'BTCUSDT', 0);
    expect(second.health(key).freshness).toBe('STALE');
    second.enqueue(key, trade());
    await second.flush();
    expect(f.state(key).bars[0]?.baseVolume).toBe('0.1');
    expect(f.outbox.get(key)).toHaveLength(1);
    await second.close();
  });
  it('storage failure blocks only affected feed; never publishes uncommitted data', async () => {
    const f = storeFixture(),
      engine = createMarketDataEngine({ registry: registry(2), store: f.store, now: () => 1000 });
    const a = await engine.retain(scope, 'BTCUSDT', 0);
    engine.enqueue(a, trade());
    f.setFailure(true);
    await engine.flush();
    expect(engine.health(a).freshness).toBe('STALE');
    expect(engine.health(a).reason).toBe('STORE_FAILED');
    expect(f.state(a).seen).toHaveLength(0);
    f.setFailure(false);
    const b = await engine.retain(scope, 'COIN1USDT', 0);
    engine.enqueue(b, trade('1', 1000, 'COIN1USDT', 'metadata-1'));
    await engine.flush();
    expect(f.state(b).seen).toHaveLength(1);
    expect(engine.enqueue(a, trade('2'))).toBe(false);
    await engine.close();
  });
  it('bounds the global queue and records overflow instead of silently dropping trades', async () => {
    const f = storeFixture(),
      engine = createMarketDataEngine({
        registry: registry(1),
        store: f.store,
        now: () => 1000,
        maxQueue: 1,
      });
    const key = await engine.retain(scope, 'BTCUSDT', 0);
    expect(engine.enqueue(key, trade())).toBe(true);
    expect(engine.enqueue(key, trade('2'))).toBe(false);
    await engine.flush();
    expect(engine.metrics().queued).toBe(0);
    expect(f.outbox.get(key)?.some((e) => e.reason === 'OVERFLOW')).toBe(true);
    expect(engine.health(key).freshness).toBe('STALE');
    await engine.close();
  });
  it('rejects foreign metadata and future clocks and preserves stale state after heartbeat/time alone', async () => {
    const f = storeFixture();
    let now = 1000;
    const engine = createMarketDataEngine({
      registry: registry(1),
      store: f.store,
      now: () => now,
      staleAfterMs: 1000,
    });
    const key = await engine.retain(scope, 'BTCUSDT', 0);
    engine.enqueue(key, trade());
    await engine.flush();
    expect(engine.health(key).freshness).toBe('FRESH');
    now = 3000;
    expect(engine.health(key).freshness).toBe('STALE');
    engine.enqueue(key, trade('2', 3000, 'BTCUSDT', 'unknown'));
    await engine.flush();
    expect(engine.health(key).freshness).toBe('STALE');
    await engine.close();
  });
  it('300 instruments share bounded process queues; one gap does not block the others', async () => {
    const f = storeFixture(),
      engine = createMarketDataEngine({ registry: registry(300), store: f.store, now: () => 1000 });
    const keys = [];
    for (let i = 0; i < 300; i++) {
      const id = i === 0 ? 'BTCUSDT' : `COIN${i}USDT`;
      const key = await engine.retain(scope, id, 0);
      keys.push(key);
      engine.enqueue(key, trade('1', 1000, id, `metadata-${i}`));
    }
    engine.enqueue(keys[0]!, { kind: 'GAP', from: 0, to: 2000, reason: 'SOURCE_GAP' });
    await engine.flush();
    expect(engine.metrics()).toMatchObject({ instruments: 300, queued: 0 });
    expect(engine.health(keys[0]!).freshness).toBe('STALE');
    expect(engine.health(keys[299]!).freshness).toBe('FRESH');
    expect(keys.every((key) => f.state(key).bars.length === 7)).toBe(true);
    await engine.close();
  });
});
