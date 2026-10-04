import { expect, it } from 'vitest';
import { createCandleState, restoreCandleState, applyCoverage } from '../src/candles.js';
import { createPostgresMarketStore } from '../src/postgres-store.js';
import { scope } from './fixtures.js';

it('requires a server persistence DSN and rejects unsafe credentials/protocol/roles', async () => {
  for (const connectionString of [
    'https://example.com',
    'postgresql://a:b@remote/db',
    'postgresql://a:b@127.0.0.1/db?options=-c%20role%3Dctp_ingest',
  ]) {
    await expect(
      createPostgresMarketStore({ connectionString, environment: 'production' }),
    ).rejects.toThrow();
  }
});
it('rejects corrupt checkpoints before recovery can mark a feed healthy', () => {
  const s = createCandleState(scope, 'BTCUSDT', 0);
  expect(restoreCandleState(s)).toEqual(s);
  for (const raw of [
    { ...s, format: 2 },
    { ...s, acceptAfter: 1 },
    { ...s, seen: [{ identity: 'x', hash: 'bad', time: 0 }] },
    { ...s, arbitrary: 'unknown' },
  ])
    expect(() => restoreCandleState(raw)).toThrow();
});
it('rejects an impossible verified empty checkpoint with nonzero volume', () => {
  const state = createCandleState(scope, 'BTCUSDT', 0);
  applyCoverage(state, { from: 0, to: 30000, cursor: 'proof', evidence: 'RECONCILED_TRADES' });
  state.bars[0]!.baseVolume = '999';
  expect(() => restoreCandleState(state)).toThrow();
});
