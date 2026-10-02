import type { MarketScope } from '@ctp/exchange-core';

// Synthetic protocol fixtures based on the official Binance schema; not live market observations.
export const NOW = 1_800_000_000_000;
export const SPOT_SCOPE: MarketScope = {
  exchange: 'BINANCE',
  region: 'global',
  market: 'SPOT',
  environment: 'TESTNET',
};
export const FUTURES_SCOPE: MarketScope = { ...SPOT_SCOPE, market: 'LINEAR_PERPETUAL' };
export function spotSymbol() {
  return {
    symbol: 'BTCUSDT',
    status: 'TRADING',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    baseAssetPrecision: 8,
    quoteAssetPrecision: 8,
    isSpotTradingAllowed: true,
    isMarginTradingAllowed: true,
    icebergAllowed: true,
    quoteOrderQtyMarketAllowed: true,
    orderTypes: [
      'LIMIT',
      'LIMIT_MAKER',
      'MARKET',
      'STOP_LOSS',
      'STOP_LOSS_LIMIT',
      'TAKE_PROFIT',
      'TAKE_PROFIT_LIMIT',
    ],
    filters: [
      {
        filterType: 'PRICE_FILTER',
        minPrice: '0.01000000',
        maxPrice: '1000000.00000000',
        tickSize: '0.01000000',
      },
      {
        filterType: 'LOT_SIZE',
        minQty: '0.00001000',
        maxQty: '9000.00000000',
        stepSize: '0.00001000',
      },
      {
        filterType: 'MARKET_LOT_SIZE',
        minQty: '0.00000000',
        maxQty: '100.00000000',
        stepSize: '0.00000000',
      },
      {
        filterType: 'NOTIONAL',
        minNotional: '5.00000000',
        maxNotional: '1000000.00000000',
        applyMinToMarket: true,
        applyMaxToMarket: false,
        avgPriceMins: 5,
      },
      {
        filterType: 'PERCENT_PRICE_BY_SIDE',
        bidMultiplierUp: '5',
        bidMultiplierDown: '0.2',
        askMultiplierUp: '5',
        askMultiplierDown: '0.2',
        avgPriceMins: 5,
      },
      { filterType: 'MAX_NUM_ORDERS', maxNumOrders: 200 },
    ],
  };
}
export function futuresSymbol() {
  return {
    ...spotSymbol(),
    contractType: 'PERPETUAL',
    pair: 'BTCUSDT',
    marginAsset: 'USDT',
    deliveryDate: '4133404800000',
    onboardDate: '1598252400000',
    pricePrecision: 2,
    quantityPrecision: 3,
    orderTypes: [
      'LIMIT',
      'MARKET',
      'STOP',
      'STOP_MARKET',
      'TAKE_PROFIT',
      'TAKE_PROFIT_MARKET',
      'TRAILING_STOP_MARKET',
    ],
    timeInForce: ['GTC', 'IOC', 'FOK', 'GTX', 'GTD'],
    filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.10', maxPrice: '1000000', tickSize: '0.10' },
      { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '0.002', maxQty: '100', stepSize: '0.002' },
      { filterType: 'MIN_NOTIONAL', notional: '5.0' },
      {
        filterType: 'PERCENT_PRICE',
        multiplierUp: '1.0500',
        multiplierDown: '0.9500',
        multiplierDecimal: '4',
      },
      { filterType: 'MAX_NUM_ORDERS', limit: '200' },
      { filterType: 'MAX_NUM_ALGO_ORDERS', limit: '10' },
    ],
  };
}
export function exchangeInfo(symbols: unknown[] = [spotSymbol()]) {
  return { timezone: 'UTC', serverTime: NOW, rateLimits: [], exchangeFilters: [], symbols };
}
export function ticker() {
  return {
    symbol: 'BTCUSDT',
    lastPrice: '100.12000000',
    bidPrice: '100.11000000',
    askPrice: '100.13000000',
    volume: '12.34000000',
    quoteVolume: '1234.56000000',
    priceChange: '-0.01000000',
    closeTime: String(NOW - 1),
  };
}
export function book() {
  return {
    lastUpdateId: '9223372036854775807',
    bids: [
      ['100.00000000', '0.25000000'],
      ['99.90000000', '2.00000000'],
    ],
    asks: [
      ['100.10000000', '0.12500000'],
      ['100.20000000', '3.00000000'],
    ],
  };
}
export function candle(openTime = NOW - 60_000) {
  return [
    String(openTime),
    '100.00000000',
    '102.00000000',
    '99.00000000',
    '101.00000000',
    '2.30000000',
    String(openTime + 59_999),
    '231.00000000',
    '12',
    '1.20000000',
    '120.00000000',
    '0',
  ];
}
export function trade() {
  return {
    e: 'trade',
    E: String(NOW),
    s: 'BTCUSDT',
    t: '9223372036854775807',
    p: '100.12000000',
    q: '0.00001000',
    T: String(NOW - 1),
    m: true,
    M: true,
  };
}
export function kline() {
  return {
    e: 'kline',
    E: String(NOW),
    s: 'BTCUSDT',
    k: {
      t: String(NOW - 60_000),
      T: String(NOW - 1),
      s: 'BTCUSDT',
      i: '1m',
      f: '9007199254740993',
      L: '9007199254740994',
      o: '100.00000000',
      c: '101.00000000',
      h: '102.00000000',
      l: '99.00000000',
      v: '2.30000000',
      n: '12',
      x: true,
      q: '231.00000000',
      V: '1.20000000',
      Q: '120.00000000',
      B: '0',
    },
  };
}
