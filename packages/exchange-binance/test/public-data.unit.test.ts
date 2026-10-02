import { describe, expect, it } from 'vitest';
import { createInstrumentRegistry } from '@ctp/exchange-core';
import {
  normalizeExchangeInfo,
  normalizeBinanceAdmission,
  normalizeTicker,
  normalizeBook,
  normalizeCandles,
  normalizeTrade,
  normalizeKlineEvent,
} from '../src/public-data.js';
import {
  NOW,
  SPOT_SCOPE,
  FUTURES_SCOPE,
  spotSymbol,
  futuresSymbol,
  exchangeInfo,
  ticker,
  book,
  candle,
  trade,
  kline,
} from './fixtures/public-data.js';

function record(futures = false) {
  const result = normalizeExchangeInfo(
    exchangeInfo([futures ? futuresSymbol() : spotSymbol()]),
    futures ? FUTURES_SCOPE : SPOT_SCOPE,
    NOW,
  );
  if (!result[0]) throw new Error('MISSING_FIXTURE');
  return result[0];
}
function rejects(fn: () => unknown) {
  expect(fn).toThrow('INVALID_BINANCE_RESPONSE');
}

describe('Binance exchangeInfo protocol contract', () => {
  it('maps exact Spot dynamic filters and a scoped immutable instrument', () => {
    const r = record();
    expect(r.instrument).toMatchObject({
      id: 'BTCUSDT',
      scope: SPOT_SCOPE,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      contract: null,
      expiryAt: null,
    });
    expect(r.rules).toMatchObject({
      tickSize: '0.01',
      stepSize: '0.00001',
      minQuantity: '0.00001',
      marketMinQuantity: '0.00001',
      maxQuantity: '9000',
      marketMaxQuantity: '100',
      minNotional: '5',
      maxNotional: '1000000',
      quantityUnit: 'BASE',
      pricePrecision: 2,
      quantityPrecision: 5,
      effectiveAt: NOW,
      expiresAt: NOW + 60_000,
    });
    expect(Object.isFrozen(r.rules.orderTypes)).toBe(true);
    expect(Object.isFrozen(r)).toBe(true);
  });
  it('uses USD-M filter increments instead of precision fields and base quantities', () => {
    const r = record(true);
    expect(r.rules).toMatchObject({
      tickSize: '0.1',
      stepSize: '0.001',
      pricePrecision: 1,
      quantityPrecision: 3,
      marketMinQuantity: '0.002',
      quantityUnit: 'BASE',
    });
    expect(r.instrument.contract).toMatchObject({ size: '1', unit: 'BASE' });
    expect(r.instrument.settlementAsset).toBe('USDT');
    expect(r.rules.timeInForce).toContain('POST_ONLY');
  });
  it('versions fresh metadata observations and rule leases without trusting server clock', () => {
    const a = record();
    const raw = exchangeInfo();
    raw.serverTime += 123;
    const b = normalizeExchangeInfo(raw, SPOT_SCOPE, NOW + 1)[0]!;
    expect(b.instrument.metadataVersion).not.toBe(a.instrument.metadataVersion);
    expect({ ...b.instrument, metadataVersion: a.instrument.metadataVersion }).toEqual(
      a.instrument,
    );
    expect(b.rules.version).not.toBe(a.rules.version);
    const registry = createInstrumentRegistry({ capacity: 2 });
    expect(registry.put(a, NOW).ok).toBe(true);
    expect(registry.put(b, NOW + 1).ok).toBe(true);
  });
  it('changes metadata and rule version when filter content changes', () => {
    const s = spotSymbol();
    s.filters[0]!.tickSize = '0.02000000';
    const b = normalizeExchangeInfo(exchangeInfo([s]), SPOT_SCOPE, NOW)[0]!;
    expect(b.instrument.metadataVersion).not.toBe(record().instrument.metadataVersion);
    expect(b.rules.version).not.toBe(record().rules.version);
  });
  it('skips explicitly ineligible symbols without inventing contracts', () => {
    expect(
      normalizeExchangeInfo(
        exchangeInfo([
          { ...spotSymbol(), status: 'BREAK' },
          { ...spotSymbol(), symbol: 'ETHUSDT', isSpotTradingAllowed: false },
        ]),
        SPOT_SCOPE,
        NOW,
      ),
    ).toEqual([]);
    expect(
      normalizeExchangeInfo(
        exchangeInfo([
          { ...futuresSymbol(), contractType: 'CURRENT_QUARTER' },
          { ...futuresSymbol(), symbol: 'ETHUSDT', marginAsset: 'USDC' },
          { ...futuresSymbol(), symbol: 'BTCUSDC', quoteAsset: 'USDC' },
        ]),
        FUTURES_SCOPE,
        NOW,
      ),
    ).toEqual([]);
  });
  it.each(['BYBIT', 'OKX', 'HTX'])('rejects another exchange %s', (exchange) => {
    rejects(() => normalizeExchangeInfo(exchangeInfo(), { ...SPOT_SCOPE, exchange } as never, NOW));
  });
  it.each(['INVERSE_PERPETUAL', 'LINEAR_FUTURE', 'INVERSE_FUTURE'])(
    'rejects unsupported market %s',
    (market) => {
      rejects(() => normalizeExchangeInfo(exchangeInfo(), { ...SPOT_SCOPE, market } as never, NOW));
    },
  );
  it.each(['PRICE_FILTER', 'LOT_SIZE'])('rejects missing mandatory filter %s', (filter) => {
    const s = spotSymbol();
    s.filters = s.filters.filter((f) => f.filterType !== filter);
    rejects(() => normalizeExchangeInfo(exchangeInfo([s]), SPOT_SCOPE, NOW));
  });
  it.each(['tickSize', 'minPrice', 'maxPrice'])('rejects malformed PRICE_FILTER.%s', (field) => {
    const s = spotSymbol();
    Object.assign(s.filters[0]!, { [field]: 'NaN' });
    rejects(() => normalizeExchangeInfo(exchangeInfo([s]), SPOT_SCOPE, NOW));
  });
  it('does not silently permit a disabled tick size', () => {
    const s = spotSymbol();
    s.filters[0]!.tickSize = '0';
    rejects(() => normalizeExchangeInfo(exchangeInfo([s]), SPOT_SCOPE, NOW));
  });
  it('does not silently permit crossed quantity filters', () => {
    const s = spotSymbol();
    s.filters[1]!.minQty = '9001';
    rejects(() => normalizeExchangeInfo(exchangeInfo([s]), SPOT_SCOPE, NOW));
  });
  it('rejects duplicated symbols and filters', () => {
    rejects(() =>
      normalizeExchangeInfo(exchangeInfo([spotSymbol(), spotSymbol()]), SPOT_SCOPE, NOW),
    );
    const s = spotSymbol();
    s.filters.push(s.filters[0]!);
    rejects(() => normalizeExchangeInfo(exchangeInfo([s]), SPOT_SCOPE, NOW));
  });
  it('rejects malformed eligible symbol instead of silently dropping it', () => {
    rejects(() =>
      normalizeExchangeInfo(exchangeInfo([{ ...spotSymbol(), baseAsset: null }]), SPOT_SCOPE, NOW),
    );
    rejects(() =>
      normalizeExchangeInfo(exchangeInfo([{ ...spotSymbol(), orderTypes: [] }]), SPOT_SCOPE, NOW),
    );
  });
  it('preserves distinct market step and unsupported admission filters explicitly', () => {
    const s = futuresSymbol();
    const a = normalizeBinanceAdmission(s);
    expect(a.filters.find((f) => f.filterType === 'MARKET_LOT_SIZE')?.stepSize).toBe('0.002');
    expect(a.unsupportedFilters).toEqual([]);
    expect(Object.isFrozen(a.filters)).toBe(true);
    const extra = {
      ...s,
      filters: [...s.filters, { filterType: 'FUTURE_NEW_FILTER', value: '1' }],
    };
    expect(normalizeBinanceAdmission(extra).unsupportedFilters).toEqual(['FUTURE_NEW_FILTER']);
  });
  it('retains notional application flags and weighted average windows', () => {
    const a = normalizeBinanceAdmission(spotSymbol());
    expect(a.filters.find((f) => f.filterType === 'NOTIONAL')).toMatchObject({
      applyMinToMarket: true,
      applyMaxToMarket: false,
      avgPriceMins: 5,
    });
  });
  it('keeps undocumented filter semantics unsupported even when a name is recognized', () => {
    const s = spotSymbol();
    expect(
      normalizeBinanceAdmission({
        ...s,
        filters: [...s.filters, { filterType: 'T_PLUS_SELL', sellWindow: 1 }],
      }).unsupportedFilters,
    ).toContain('T_PLUS_SELL');
  });
  it.each([null, [], {}, { symbols: null }, { symbols: [null] }])(
    'rejects malformed envelope %j',
    (raw) => rejects(() => normalizeExchangeInfo(raw, SPOT_SCOPE, NOW)),
  );
  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects invalid metadata clock %s',
    (now) => rejects(() => normalizeExchangeInfo(exchangeInfo(), SPOT_SCOPE, now)),
  );
  it('contains hostile property accessor messages', () => {
    rejects(() =>
      normalizeExchangeInfo(
        {
          get symbols() {
            throw new Error('SECRET');
          },
        },
        SPOT_SCOPE,
        NOW,
      ),
    );
  });
});

describe('Binance ticker and depth protocol contract', () => {
  it('normalizes decimals exactly and priceChange as an absolute quote amount', () => {
    expect(normalizeTicker(ticker(), record(), NOW)).toMatchObject({
      last: { value: '100.12' },
      bid: { value: '100.11' },
      ask: { value: '100.13' },
      change: { value: '-0.01' },
      baseVolume: { value: '12.34' },
      quoteVolume: { value: '1234.56' },
      exchangeTime: NOW - 1,
      receivedAt: NOW,
    });
  });
  it('maps ticker WS fields and unavailable USD-M quotes', () => {
    expect(
      normalizeTicker(
        {
          e: '24hrTicker',
          E: String(NOW),
          s: 'BTCUSDT',
          c: '100.12',
          v: '12.34',
          q: '1234.56',
          p: '-0.01',
        },
        record(true),
        NOW,
      ),
    ).toMatchObject({
      bid: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      ask: { state: 'UNAVAILABLE' },
      exchangeTime: NOW,
    });
  });
  it('represents exchange zero bid/ask as unavailable, never an executable zero', () => {
    expect(
      normalizeTicker({ ...ticker(), bidPrice: '0', askPrice: '0' }, record(), NOW),
    ).toMatchObject({ bid: { state: 'UNAVAILABLE' }, ask: { state: 'UNAVAILABLE' } });
  });
  it.each(['lastPrice', 'volume', 'quoteVolume', 'priceChange'])(
    'rejects invalid %s decimal',
    (field) => rejects(() => normalizeTicker({ ...ticker(), [field]: '1e-8' }, record(), NOW)),
  );
  it('rejects mismatching symbols and crossed available quotes', () => {
    rejects(() => normalizeTicker({ ...ticker(), symbol: 'ETHUSDT' }, record(), NOW));
    rejects(() => normalizeTicker({ ...ticker(), bidPrice: '102' }, record(), NOW));
  });
  it('preserves 64 bit book sequence and canonical sorted levels', () => {
    const raw = book();
    raw.bids.reverse();
    raw.asks.reverse();
    const b = normalizeBook(raw, record(), NOW, 1);
    expect(b.sourceSequence).toBe('9223372036854775807');
    expect(b.bids).toEqual([{ price: '100', quantity: '0.25' }]);
    expect(b.asks).toEqual([{ price: '100.1', quantity: '0.125' }]);
  });
  it('uses actual USD-M transaction time', () => {
    expect(
      normalizeBook({ ...book(), E: NOW, T: String(NOW - 1) }, record(true), NOW, 20).exchangeTime,
    ).toBe(NOW - 1);
  });
  it('leaves unavailable Spot exchange time explicit instead of inventing a clock', () => {
    expect(normalizeBook(book(), record(), NOW, 20)).toMatchObject({
      exchangeTime: null,
      receivedAt: NOW,
      stale: false,
    });
  });
  it.each([0, 1001, 1.5, NaN])('rejects invalid depth %s', (depth) =>
    rejects(() => normalizeBook(book(), record(), NOW, depth)),
  );
  it('rejects zero snapshot quantity and duplicates, including levels beyond requested depth', () => {
    const a = book();
    a.bids[1]![1] = '0';
    rejects(() => normalizeBook(a, record(), NOW, 1));
    const b = book();
    b.bids.push(['100.000', '1']);
    rejects(() => normalizeBook(b, record(), NOW, 1));
  });
  it('rejects crossed books, malformed levels, oversized payloads and unsafe sequences', () => {
    const a = book();
    a.asks[0]![0] = '99';
    rejects(() => normalizeBook(a, record(), NOW, 20));
    rejects(() => normalizeBook({ ...book(), bids: [['1']] }, record(), NOW, 20));
    rejects(() =>
      normalizeBook(
        { ...book(), bids: Array.from({ length: 1001 }, () => ['1', '1']) },
        record(),
        NOW,
        20,
      ),
    );
    rejects(() => normalizeBook({ ...book(), lastUpdateId: 9007199254740992 }, record(), NOW, 20));
  });
  it('does not confuse a depth delta with a complete snapshot', () => {
    rejects(() =>
      normalizeBook(
        {
          e: 'depthUpdate',
          s: 'BTCUSDT',
          E: NOW,
          U: '1',
          u: '2',
          b: [['100', '1']],
          a: [['101', '1']],
        },
        record(),
        NOW,
        20,
      ),
    );
  });
  it.each(['sequence-1', '-1', '01', '1e3'])(
    'rejects a noninteger Binance sequence %s',
    (lastUpdateId) => {
      rejects(() => normalizeBook({ ...book(), lastUpdateId }, record(), NOW, 20));
    },
  );
});

describe('Binance trades and candles protocol contract', () => {
  it('preserves large trade IDs, maker flag direction and BASE units', () => {
    expect(normalizeTrade(trade(), record(), NOW)).toMatchObject({
      tradeId: '9223372036854775807',
      price: '100.12',
      quantity: '0.00001',
      side: 'SELL',
      quantityUnit: 'BASE',
      exchangeTime: NOW - 1,
    });
    expect(normalizeTrade({ ...trade(), m: false }, record(true), NOW).side).toBe('BUY');
  });
  it('keeps aggregate trade and individual trade identity namespaces separate', () => {
    const a = normalizeTrade(trade(), record(), NOW);
    const b = normalizeTrade(
      { ...trade(), e: 'aggTrade', a: '9223372036854775807' },
      record(),
      NOW,
    );
    expect(b.identityScope).not.toBe(a.identityScope);
  });
  it('accepts REST trade fields without fabricating another identity', () => {
    const a = normalizeTrade(
      { id: '123', price: '100.12', qty: '0.1', time: String(NOW), isBuyerMaker: false },
      record(),
      NOW,
    );
    expect(a.tradeId).toBe('123');
    expect(a.side).toBe('BUY');
    expect(a.identityScope).toBe(normalizeTrade(trade(), record(), NOW).identityScope);
  });
  it.each([
    { m: 'false' },
    { s: 'ETHUSDT' },
    { p: '0' },
    { q: '0' },
    { t: 9007199254740992 },
    { T: '9007199254740993' },
  ])('rejects malformed trade %j', (patch) =>
    rejects(() => normalizeTrade({ ...trade(), ...patch }, record(), NOW)),
  );
  it.each(['opaque', '-1', '01', '1e3'])('rejects a noninteger Binance trade id %s', (t) => {
    rejects(() => normalizeTrade({ ...trade(), t }, record(), NOW));
  });
  it('normalizes REST candle inclusive close to exclusive UTC boundary', () => {
    expect(normalizeCandles([candle()], record(), '1m', NOW)[0]).toMatchObject({
      openTime: NOW - 60_000,
      closeTime: NOW,
      open: '100',
      high: '102',
      low: '99',
      close: '101',
      baseVolume: '2.3',
      quoteVolume: { value: '231' },
      numberOfTrades: 12,
      complete: true,
      quality: 'COMPLETE',
      provenance: 'EXCHANGE',
    });
  });
  it('keeps current candles explicitly partial', () => {
    expect(normalizeCandles([candle(NOW)], record(), '1m', NOW)[0]).toMatchObject({
      complete: false,
      quality: 'PARTIAL',
    });
  });
  it('normalizes closed and open WS klines without synthetic OHLC', () => {
    expect(normalizeKlineEvent(kline(), record(), '1m', NOW)).toMatchObject({
      complete: true,
      quality: 'COMPLETE',
      closeTime: NOW,
      close: '101',
    });
    const k = kline();
    k.k.x = false;
    expect(normalizeKlineEvent(k, record(), '1m', NOW)).toMatchObject({
      complete: false,
      quality: 'PARTIAL',
    });
  });
  it('rejects unsupported 30-second klines before fabricating aggregation', () => {
    rejects(() => normalizeCandles([], record(), '30s', NOW));
  });
  it.each([1, 2, 3, 4, 5, 7])('rejects nondecimal candle field %s', (index) => {
    const c = candle();
    c[index] = 'NaN';
    rejects(() => normalizeCandles([c], record(), '1m', NOW));
  });
  it('rejects UTC misalignment, invalid OHLC and duplicate/out-of-order bars', () => {
    rejects(() => normalizeCandles([candle(NOW - 59_999)], record(), '1m', NOW));
    const c = candle();
    c[2] = '100';
    rejects(() => normalizeCandles([c], record(), '1m', NOW));
    rejects(() => normalizeCandles([candle(), candle()], record(), '1m', NOW));
    rejects(() => normalizeCandles([candle(), candle(NOW - 120_000)], record(), '1m', NOW));
  });
  it('rejects invalid kline event identity, timeframe and finalization', () => {
    const a = kline();
    a.k.s = 'ETHUSDT';
    rejects(() => normalizeKlineEvent(a, record(), '1m', NOW));
    const b = kline();
    b.k.i = '5m';
    rejects(() => normalizeKlineEvent(b, record(), '1m', NOW));
    const c = kline();
    c.k.t = String(NOW);
    c.k.T = String(NOW + 59_999);
    rejects(() => normalizeKlineEvent(c, record(), '1m', NOW));
  });
});
