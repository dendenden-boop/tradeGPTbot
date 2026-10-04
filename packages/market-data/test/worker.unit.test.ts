import { expect, it } from 'vitest';
import { createMarketDataWorker } from '../src/worker.js';
import type { FeedInput, PublicFeedPort } from '../src/ports.js';
import { registry, scope, storeFixture, tick } from './fixtures.js';
it('worker renews leases, performs bounded recovery and closes actual sources', async () => {
  const f = storeFixture(),
    r = registry(1);
  let gap: (reason: string) => void = () => {},
    input: (key: string, event: FeedInput) => void = () => {},
    closed = 0,
    now = 31000;
  const port: PublicFeedPort = {
    maxTopics: 100,
    maxConnections: 3,
    open(_intents, _ctx, onInput, onGap) {
      input = onInput;
      gap = onGap;
      return Promise.resolve({
        close() {
          closed++;
          return Promise.resolve();
        },
      });
    },
  };
  const worker = createMarketDataWorker({
    registry: r,
    store: f.store,
    feed: port,
    metadata: { refresh: () => Promise.resolve() },
    recovery: {
      recover: () =>
        Promise.resolve({
          trades: [
            {
              kind: 'TRADE',
              tick: tick('1', 1000),
              metadataVersion: 'metadata-0',
              executionCount: 1,
            },
          ],
          proof: { from: 0, to: 30000, cursor: 'repaired', evidence: 'RECONCILED_TRADES' },
        }),
    },
    now: () => now,
  });
  const key = await worker.retain(
    { scope, instrumentId: 'BTCUSDT', profileId: 'binance-spot-testnet-v1' },
    0,
  );
  await worker.cycle();
  await worker.settled();
  gap('SOURCE_GAP');
  await worker.cycle();
  await worker.settled();
  await worker.cycle();
  expect(worker.snapshot(key).bars[0]).toMatchObject({ complete: true, quality: 'VERIFIED' });
  now = 32000;
  await worker.cycle();
  await worker.settled();
  input(key, {
    kind: 'TRADE',
    tick: tick('2', 32000),
    metadataVersion: 'metadata-0',
    executionCount: 1,
  });
  await worker.cycle();
  expect(worker.health(key).freshness).toBe('FRESH');
  await worker.close();
  expect(closed).toBeGreaterThan(0);
  expect(worker.metrics().engine.instruments).toBe(0);
});
it('no runtime worker starts with a reference/default registry or an absent recovery policy', () => {
  expect(() =>
    createMarketDataWorker({ registry: registry(1), store: storeFixture().store } as never),
  ).toThrow();
});
