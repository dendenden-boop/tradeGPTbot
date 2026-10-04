import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getBybitProfile, bybitProfileIds } from '../src/profiles.js';
import {
  normalizeInstrument,
  normalizeTicker,
  normalizeCandles,
  createBookAssembler,
} from '../src/public-data.js';
import { normalizeWallet, normalizeOrder, normalizePosition } from '../src/private-data.js';
import { signRest, signWs } from '../src/auth.js';
import { parseWireJson } from '../src/wire.js';
import { account, nativeInstrument, nativeOrder, now, scope } from './fixtures.js';

describe('Bybit V5 contracts written before implementation', () => {
  it('has six isolated server profiles and Demo public/mainnet + private/demo routing', () => {
    expect(bybitProfileIds).toHaveLength(6);
    for (const id of bybitProfileIds) {
      const p = getBybitProfile(id);
      expect(p.scope.exchange).toBe('BYBIT');
      expect(p.scope.environment).toBe(
        id.includes('testnet') ? 'TESTNET' : id.includes('demo') ? 'DEMO' : 'LIVE',
      );
    }
    const p = getBybitProfile('bybit-spot-demo-v1');
    expect(p.rest).toBe('https://api-demo.bybit.com');
    expect(p.publicWs).toBe('wss://stream.bybit.com/v5/public/spot');
    expect(p.privateWs).toBe('wss://stream-demo.bybit.com/v5/private');
    expect(() => getBybitProfile('https://user.invalid' as never)).toThrow();
  });
  it.each(['category=spot&symbol=BTCUSDT', '{"category":"spot","qty":"0.01"}'])(
    'signs exact native payload bytes %s',
    (payload) => {
      expect(signRest('test-key', 'test-secret', now, payload)).toBe(
        createHmac('sha256', 'test-secret').update(`${now}test-key5000${payload}`).digest('hex'),
      );
      expect(signWs('test-secret', now + 5000)).toBe(
        createHmac('sha256', 'test-secret')
          .update(`GET/realtime${now + 5000}`)
          .digest('hex'),
      );
    },
  );
  it('preserves oversized IDs and decimal source bytes', () => {
    expect(parseWireJson('{"id":90071992547409931234,"qty":0.000000000000000001}')).toEqual({
      id: '90071992547409931234',
      qty: '0.000000000000000001',
    });
    expect(() => parseWireJson('{"__proto__":{}}')).toThrow();
  });
  it.each([false, true])('normalizes distinct market/limit quantity rules linear=%s', (linear) => {
    const s = { ...scope, market: linear ? ('LINEAR_PERPETUAL' as const) : ('SPOT' as const) };
    const x = normalizeInstrument(nativeInstrument(linear), s, now, 'observation-a');
    expect(x.record.rules.maxQuantity).toBe('100');
    expect(x.record.rules.marketMaxQuantity).toBe('10');
    expect(x.record.rules.stepSize).toBe(linear ? '0.001' : '0.000001');
    expect(x.record.rules.minQuantity).toBe(linear ? '0.001' : '0.000001');
    expect(x.admission.unsupportedConstraints).toEqual([]);
  });
  it.each(['priceFilter', 'lotSizeFilter', 'riskParameters', 'leverageFilter'])(
    'unknown constraint fields fail closed in %s',
    (field) => {
      const raw = nativeInstrument(true);
      raw[field] = { ...(raw[field] as object), futureConstraint: false };
      const x = normalizeInstrument(
        raw,
        { ...scope, market: 'LINEAR_PERPETUAL' },
        now,
        'unknown-a',
      );
      expect(x.admission.unsupportedConstraints).toContain(field);
    },
  );
  it.each(['InversePerpetual', 'LinearFutures'])(
    'rejects unsupported contract %s',
    (contractType) => {
      expect(() =>
        normalizeInstrument(
          { ...nativeInstrument(true), contractType },
          { ...scope, market: 'LINEAR_PERPETUAL' },
          now,
          'x',
        ),
      ).toThrow();
    },
  );
  it('ticker absence stays unavailable and stale clocks are visible', () => {
    const r = normalizeInstrument(nativeInstrument(), scope, now, 'a').record;
    const t = normalizeTicker({ symbol: 'BTCUSDT', lastPrice: '50000' }, r, now - 61_000, now);
    expect(t.last).toEqual({ state: 'AVAILABLE', value: '50000' });
    expect(t.bid.state).toBe('UNAVAILABLE');
    expect(t.freshness).toBe('STALE');
  });
  it('sorts native reverse klines, preserves quote volume and exclusive closing time', () => {
    const r = normalizeInstrument(nativeInstrument(), scope, now, 'a').record;
    const start = Math.floor(now / 60_000) * 60_000 - 120_000;
    const rows = [
      [String(start + 60_000), '10', '12', '9', '11', '2', '22'],
      [String(start), '10', '12', '9', '11', '2', '22'],
    ];
    const x = normalizeCandles(rows, r, '1m', now);
    expect(x.map((v) => v.openTime)).toEqual([start, start + 60_000]);
    expect(x[0]?.closeTime).toBe(start + 60_000);
    expect(x[0]?.numberOfTrades).toBeNull();
    expect(() => normalizeCandles(rows, r, '30s', now)).toThrow();
  });
  it('book requires snapshot, accepts non-consecutive seq, deletes zero and resets with fresh snapshot', () => {
    const r = normalizeInstrument(nativeInstrument(), scope, now, 'a').record;
    const book = createBookAssembler(r, 50);
    expect(() =>
      book.update(
        { type: 'delta', ts: now, data: { s: 'BTCUSDT', u: 2, seq: 9, b: [], a: [] } },
        now,
      ),
    ).toThrow();
    expect(
      book.update(
        {
          type: 'snapshot',
          ts: now,
          data: { s: 'BTCUSDT', u: 100, seq: 200, b: [['10', '2']], a: [['11', '2']] },
        },
        now,
      )?.bids,
    ).toHaveLength(1);
    expect(
      book.update(
        {
          type: 'delta',
          ts: now,
          data: { s: 'BTCUSDT', u: 102, seq: 205, b: [['10', '0']], a: [] },
        },
        now,
      )?.bids,
    ).toHaveLength(0);
    expect(
      book.update(
        { type: 'snapshot', ts: now, data: { s: 'BTCUSDT', u: 1, seq: 1, b: [['9', '1']], a: [] } },
        now,
      )?.sourceSequence,
    ).toBe('1');
  });
  it('UNIFIED wallet subtracts spotBorrow without fabricating free/available', () => {
    const x = normalizeWallet(
      {
        list: [
          {
            accountType: 'UNIFIED',
            totalAvailableBalance: '999',
            coin: [{ coin: 'USDT', walletBalance: '10', spotBorrow: '2', locked: '1' }],
          },
        ],
      },
      account,
      scope,
      now,
      now,
    );
    expect(x.balances).toEqual([
      {
        asset: 'USDT',
        total: '8',
        free: null,
        locked: '1',
        availableToTrade: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      },
    ]);
  });
  it('Filled order uses durable server identities, never quote quantity', () => {
    const r = normalizeInstrument(nativeInstrument(), scope, now, 'a').record;
    const identity = {
      internalOrderId: '33333333-3333-4333-8333-333333333333',
      intentId: '44444444-4444-4444-8444-444444444444',
    };
    const x = normalizeOrder(nativeOrder(), r, account, identity);
    expect(x.quantity).toBe('0.01');
    expect(x.status).toBe('FILLED');
    expect(x.fees).toEqual([]);
    expect(() =>
      normalizeOrder({ ...nativeOrder(), marketUnit: 'quoteCoin' }, r, account, identity),
    ).toThrow();
    expect(() =>
      normalizeOrder({ ...nativeOrder(), positionIdx: 1 }, r, account, identity),
    ).toThrow();
  });
  it('one-way short position has signed BASE exposure and account-derived margin mode', () => {
    const r = normalizeInstrument(
      nativeInstrument(true),
      { ...scope, market: 'LINEAR_PERPETUAL' },
      now,
      'a',
    ).record;
    const p = {
      symbol: 'BTCUSDT',
      positionIdx: 0,
      side: 'Sell',
      size: '0.01',
      avgPrice: '50000',
      liqPrice: '',
      leverage: '10',
      cumRealisedPnl: '1',
      unrealisedPnl: '-2',
      updatedTime: String(now),
    };
    const x = normalizePosition(p, r, account, 'REGULAR_MARGIN');
    expect(x.quantity).toBe('-0.01');
    expect(x.side).toBe('NET');
    expect(x.liquidationPrice.state).toBe('UNAVAILABLE');
    expect(() =>
      normalizePosition({ ...p, positionIdx: 2 }, r, account, 'REGULAR_MARGIN'),
    ).toThrow();
    expect(() => normalizePosition(p, r, account, 'PORTFOLIO_MARGIN')).toThrow();
  });
});
