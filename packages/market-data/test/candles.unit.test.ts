import { describe, expect, it } from 'vitest';
import { candleSchema, tradeTickSchema } from '@ctp/exchange-core';
import {
  createCandleState,
  applyTrade,
  applyCoverage,
  applyGap,
  timeframes,
} from '../src/candles.js';

export const scope = {
  exchange: 'BINANCE',
  market: 'SPOT',
  environment: 'TESTNET',
  region: 'global',
} as const;
export const tick = (id = '1', time = 1, price = '10', quantity = '0.1') =>
  tradeTickSchema.parse({
    scope,
    instrumentId: 'BTCUSDT',
    exchangeTime: time,
    receivedAt: time,
    tradeId: id,
    identityScope: 'BINANCE:TRADES',
    price,
    quantity,
    quantityUnit: 'BASE',
    side: 'BUY',
    sourceSequence: id,
  });
const proof = (from: number, to: number) => ({
  from,
  to,
  cursor: `proof-${to}`,
  evidence: 'RECONCILED_TRADES' as const,
});

describe('event-time candle contracts', () => {
  it.each(timeframes)('uses UTC half-open %ims windows and exact arithmetic', (tf) => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    applyTrade(s, tick('2', tf - 1, '10.2', '0.2'));
    applyTrade(s, tick('1', 0, '10.1', '0.1'));
    applyTrade(s, tick('3', tf, '11', '0.3'));
    applyCoverage(s, proof(0, tf));
    const bar = s.bars.find((b) => b.timeframeMs === tf && b.openTime === 0)!;
    expect(bar).toMatchObject({
      open: '10.1',
      close: '10.2',
      high: '10.2',
      low: '10.1',
      baseVolume: '0.3',
      quoteVolume: '3.05',
      tradeCount: 2,
      quality: 'VERIFIED',
      complete: true,
    });
    expect(s.bars.find((b) => b.timeframeMs === tf && b.openTime === tf)?.baseVolume).toBe('0.3');
    expect(candleSchema.parse(bar.candle).complete).toBe(true);
  });
  it('deduplicates replay and detects conflicting identity without changing volume', () => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    expect(applyTrade(s, tick())).toBe('APPLIED');
    expect(applyTrade(s, tick())).toBe('DUPLICATE');
    expect(() => applyTrade(s, tick('1', 1, '11'))).toThrow('IDENTITY_CONFLICT');
    expect(s.bars[0]?.baseVolume).toBe('0.1');
  });
  it('conflicting execution multiplicity is part of the identity contract', () => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    applyTrade(s, tick(), 1);
    expect(() => applyTrade(s, tick(), 2)).toThrow('IDENTITY_CONFLICT');
  });
  it('uses deterministic lossless ID ties, independent of arrival order', () => {
    const a = createCandleState(scope, 'BTCUSDT', 0),
      b = createCandleState(scope, 'BTCUSDT', 0);
    const x = tick('9007199254740992', 1000, '10'),
      y = tick('9007199254740993', 1000, '11');
    applyTrade(a, y);
    applyTrade(a, x);
    applyTrade(b, x);
    applyTrade(b, y);
    expect(a.bars).toEqual(b.bars);
    expect(a.bars[0]).toMatchObject({ open: '10', close: '11' });
  });
  it('distinguishes verified empty bars, unverified data and outage', () => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    applyCoverage(s, proof(0, 30000));
    expect(s.bars[0]).toMatchObject({
      quality: 'EMPTY_VERIFIED',
      open: null,
      candle: null,
      complete: true,
    });
    applyGap(s, 30000, 60000, 'SOURCE_GAP');
    applyTrade(s, tick('2', 35000));
    applyCoverage(s, proof(60000, 90000));
    expect(s.bars.find((b) => b.timeframeMs === 30000 && b.openTime === 30000)).toMatchObject({
      quality: 'GAP',
      complete: false,
    });
  });
  it('late finalized data creates a correction revision, never a second close', () => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    applyTrade(s, tick('2', 20000, '11'));
    applyCoverage(s, proof(0, 30000));
    const previous = s.bars[0]!.revision;
    applyTrade(s, tick('1', 1000, '10'));
    expect(s.bars[0]).toMatchObject({
      quality: 'LATE_CORRECTION',
      revision: previous + 1,
      open: '10',
      complete: false,
    });
  });
  it('bounded deduplication rejects expired replay instead of reusing an ID', () => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    applyTrade(s, tick());
    applyCoverage(s, proof(0, 120000));
    expect(() => applyTrade(s, tick())).toThrow('OUTSIDE_RETENTION');
    expect(s.seen.length).toBe(0);
  });
  it('JSON restart preserves deduplication, event order and revisions', () => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    applyTrade(s, tick());
    const restored = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(applyTrade(restored, tick())).toBe('DUPLICATE');
    applyTrade(restored, tick('2', 2));
    expect(restored.bars[0]?.baseVolume).toBe('0.2');
  });
  it('repair of a published partial candle increments its immutable revision', () => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    applyTrade(s, tick());
    s.watermark = 30000;
    const revision = s.bars[0]!.revision;
    applyCoverage(s, proof(0, 30000), true);
    expect(s.bars[0]!.revision).toBe(revision + 1);
  });
  it('a source gap revises an already published partial candle', () => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    applyTrade(s, tick());
    s.watermark = 30000;
    const revision = s.bars[0]!.revision;
    applyGap(s, 0, 30000, 'SOURCE_GAP');
    expect(s.bars[0]!.revision).toBe(revision + 1);
  });
  it('replayed coverage cannot recreate expired populated history as an empty candle', () => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    applyTrade(s, tick());
    applyCoverage(s, proof(0, 30000));
    applyCoverage(s, proof(30000, 120000));
    applyCoverage(s, proof(0, 120000), true);
    expect(s.bars.find((b) => b.timeframeMs === 30000 && b.openTime === 0)).toBeUndefined();
  });
  it('late reconciliation improves coverage without regressing the watermark', () => {
    const s = createCandleState(scope, 'BTCUSDT', 0);
    applyTrade(s, tick());
    s.watermark = 31000;
    expect(() => applyCoverage(s, proof(0, 30000), true)).not.toThrow();
    expect(s.watermark).toBe(31000);
    expect(s.bars[0]?.complete).toBe(true);
  });
  it('foreign scope, contract quantity, future time and decimal overflow fail without partial bars', () => {
    for (const changed of [
      { instrumentId: 'ETHUSDT' },
      { scope: { ...scope, environment: 'LIVE' } },
      { quantityUnit: 'CONTRACTS' },
      { price: '99999999999999999999', quantity: '99999999999999999999' },
    ]) {
      const s = createCandleState(scope, 'BTCUSDT', 0);
      expect(() => applyTrade(s, { ...tick(), ...changed })).toThrow();
      expect(s.bars).toHaveLength(0);
    }
  });
});
