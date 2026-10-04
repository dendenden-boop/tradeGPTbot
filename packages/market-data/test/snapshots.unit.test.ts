import { expect, it } from 'vitest';
import { orderBookSchema } from '@ctp/exchange-core';
import { createMarketSnapshotCache } from '../src/snapshots.js';
import { registry, scope } from './fixtures.js';
const book = (version: string | null, time = 1000, quantity = '1') =>
  orderBookSchema.parse({
    scope,
    instrumentId: 'BTCUSDT',
    receivedAt: 1000,
    exchangeTime: time,
    kind: 'SNAPSHOT',
    bids: [{ price: '10', quantity }],
    asks: [{ price: '11', quantity: '1' }],
    sourceSequence: version,
    previousSequence: null,
    checksum: null,
    snapshotVersion: version ?? 'snapshot',
    stale: false,
  });
it.each([
  ['9007199254740993', '9007199254740992', 1001, '1', 'RESYNC_REQUIRED'],
  ['9007199254740993', '9007199254740993', 1000, '1', 'DUPLICATE'],
  ['9007199254740993', '9007199254740993', 1000, '2', 'RESYNC_REQUIRED'],
  ['9007199254740993', '9007199254740994', 1001, '1', 'APPLIED'],
  [null, null, 999, '1', 'RESYNC_REQUIRED'],
  [null, null, 1000, '1', 'DUPLICATE'],
  [null, null, 1000, '2', 'RESYNC_REQUIRED'],
  [null, null, 1001, '1', 'APPLIED'],
] as const)(
  'book cache preserves native sequence/time ordering %#',
  (a, b, time, quantity, result) => {
    const cache = createMarketSnapshotCache({
      registry: registry(1),
      now: () => 1000,
      maxInstruments: 1,
    });
    cache.putBook(book(a), 'metadata-0');
    expect(cache.putBook(book(b, time, quantity), 'metadata-0')).toBe(result);
    if (result === 'RESYNC_REQUIRED') expect(cache.get(scope, 'BTCUSDT').book).toBeNull();
  },
);
it('rejects deltas, foreign metadata and stale input and requests a native resnapshot', () => {
  const cache = createMarketSnapshotCache({
    registry: registry(1),
    now: () => 1000,
    maxInstruments: 1,
  });
  cache.putBook(book('1'), 'metadata-0');
  expect(cache.putBook(book('2'), 'wrong')).toBe('RESYNC_REQUIRED');
  expect(cache.get(scope, 'BTCUSDT').book).toBeNull();
  expect(cache.putBook({ ...book('2'), kind: 'DELTA', previousSequence: '1' }, 'metadata-0')).toBe(
    'RESYNC_REQUIRED',
  );
  expect(cache.putBook({ ...book('3'), stale: true }, 'metadata-0')).toBe('RESYNC_REQUIRED');
});
it('malformed input with a known identity invalidates its previous snapshot', () => {
  const cache = createMarketSnapshotCache({
    registry: registry(1),
    now: () => 1000,
    maxInstruments: 1,
  });
  cache.putBook(book('1'), 'metadata-0');
  expect(
    cache.putBook({ ...book('2'), bids: [{ price: 'NaN', quantity: '1' }] }, 'metadata-0'),
  ).toBe('RESYNC_REQUIRED');
  expect(cache.get(scope, 'BTCUSDT').book).toBeNull();
});
