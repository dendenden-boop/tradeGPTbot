import { createHash } from 'node:crypto';
import {
  assetSchema,
  candleSchema,
  decimalCompare,
  idSchema,
  immutable,
  instrumentSchema,
  marketScopeSchema,
  orderBookSchema,
  parseDecimal,
  tickerSchema,
  timestampSchema,
  tradingRulesSchema,
  tradeTickSchema,
  timeframeSchema,
  type Candle,
  type InstrumentRecord,
  type MarketScope,
  type OrderBook,
  type Ticker,
  type TradeTick,
} from '@ctp/exchange-core';
import { canonicalDecimal, wireId, wireInteger } from './wire.js';

/**
 * Protocol sources (reviewed 2026-10-01):
 * https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md
 * https://github.com/binance/binance-spot-api-docs/blob/master/filters.md
 * https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md
 * https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
 * Prices and quantities are converted only by exact decimal-string canonicalization.
 */
const INVALID = 'INVALID_BINANCE_RESPONSE';
type ObjectValue = Record<string, unknown>;
export interface BinanceAdmission {
  readonly symbol: string;
  readonly filters: readonly Readonly<Record<string, string | number | boolean>>[];
  readonly unsupportedFilters: readonly string[];
  readonly quoteOrderQtyMarketAllowed: boolean;
  readonly icebergAllowed: boolean;
  readonly rawOrderTypes: readonly string[];
  readonly rawTimeInForce: readonly string[];
}
// Documented field contracts, not a global list of primitive names. Unknown
// fields (even false/zero or fields known on another filter) deny new risk.
// Reviewed against Spot filters.md and USD-M exchangeInfo on 2026-10-03.
const FILTER_FIELDS = new Map<string, readonly string[]>([
  ['PRICE_FILTER', ['minPrice', 'maxPrice', 'tickSize']],
  ['LOT_SIZE', ['minQty', 'maxQty', 'stepSize']],
  ['MARKET_LOT_SIZE', ['minQty', 'maxQty', 'stepSize']],
  ['MIN_NOTIONAL', ['minNotional', 'applyToMarket', 'avgPriceMins']],
  [
    'NOTIONAL',
    ['minNotional', 'maxNotional', 'applyMinToMarket', 'applyMaxToMarket', 'avgPriceMins'],
  ],
  ['PERCENT_PRICE', ['multiplierUp', 'multiplierDown', 'avgPriceMins']],
  [
    'PERCENT_PRICE_BY_SIDE',
    [
      'bidMultiplierUp',
      'bidMultiplierDown',
      'askMultiplierUp',
      'askMultiplierDown',
      'avgPriceMins',
    ],
  ],
  ['ICEBERG_PARTS', ['limit']],
  ['MAX_NUM_ORDERS', ['maxNumOrders']],
  ['MAX_NUM_ALGO_ORDERS', ['maxNumAlgoOrders']],
  ['MAX_NUM_ICEBERG_ORDERS', ['maxNumIcebergOrders']],
  ['MAX_POSITION', ['maxPosition']],
  [
    'TRAILING_DELTA',
    [
      'minTrailingAboveDelta',
      'maxTrailingAboveDelta',
      'minTrailingBelowDelta',
      'maxTrailingBelowDelta',
    ],
  ],
  ['MAX_NUM_ORDER_LISTS', ['maxNumOrderLists']],
  ['MAX_NUM_ORDER_AMENDS', ['maxNumOrderAmends']],
]);
const PERPETUAL_FILTER_FIELDS = new Map<string, readonly string[]>([
  ['MIN_NOTIONAL', ['notional']],
  ['PERCENT_PRICE', ['multiplierUp', 'multiplierDown', 'multiplierDecimal']],
  ['MAX_NUM_ORDERS', ['limit']],
  ['MAX_NUM_ALGO_ORDERS', ['limit']],
]);
const DECIMAL_FILTER_FIELDS = new Set([
  'minPrice',
  'maxPrice',
  'tickSize',
  'minQty',
  'maxQty',
  'stepSize',
  'minNotional',
  'maxNotional',
  'notional',
  'multiplierUp',
  'multiplierDown',
  'bidMultiplierUp',
  'bidMultiplierDown',
  'askMultiplierUp',
  'askMultiplierDown',
  'maxPosition',
]);
const INTEGER_FILTER_FIELDS = new Set([
  'avgPriceMins',
  'limit',
  'maxNumOrders',
  'maxNumAlgoOrders',
  'maxNumIcebergOrders',
  'minTrailingAboveDelta',
  'maxTrailingAboveDelta',
  'minTrailingBelowDelta',
  'maxTrailingBelowDelta',
  'maxNumOrderLists',
  'maxNumOrderAmends',
  'multiplierDecimal',
  'priceExponent',
  'qtyExponent',
]);
const BOOLEAN_FILTER_FIELDS = new Set(['applyToMarket', 'applyMinToMarket', 'applyMaxToMarket']);
const ZERO = parseDecimal('0');
function invalid(): never {
  throw new Error(INVALID);
}
function guarded<T>(action: () => T): T {
  try {
    return action();
  } catch {
    return invalid();
  }
}
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as ObjectValue;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value as unknown[];
}
function strings(value: unknown, max = 64): string[] {
  const values = array(value, max).map((item) => idSchema.parse(item));
  if (new Set(values).size !== values.length) return invalid();
  return values;
}
function symbol(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9_]{1,31}$/u.test(value)) return invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid();
  return value;
}
function time(value: unknown): number {
  return timestampSchema.parse(wireInteger(value));
}
function numericId(value: unknown): string {
  const parsed = wireId(value);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(parsed)) return invalid();
  return parsed;
}
function clock(now: number): void {
  timestampSchema.parse(now);
}
function decimal(value: unknown) {
  // Binance monetary fields are JSON strings. Never accept a rounded JSON number.
  if (typeof value !== 'string') return invalid();
  return canonicalDecimal(value);
}
function nonnegative(value: unknown) {
  const parsed = decimal(value);
  if (decimalCompare(parsed, ZERO) < 0) return invalid();
  return parsed;
}
function positive(value: unknown) {
  const parsed = nonnegative(value);
  if (parsed === '0') return invalid();
  return parsed;
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function identity(record: InstrumentRecord) {
  const instrument = instrumentSchema.parse(record.instrument);
  if (
    instrument.scope.exchange !== 'BINANCE' ||
    !['SPOT', 'LINEAR_PERPETUAL'].includes(instrument.scope.market)
  )
    return invalid();
  return { scope: instrument.scope, instrumentId: instrument.id };
}
function checkSymbol(raw: ObjectValue, record: InstrumentRecord, required: boolean): void {
  const source = raw.s ?? raw.symbol;
  if ((required || source !== undefined) && source !== record.instrument.exchangeSymbol) invalid();
}
function timeframe(value: unknown) {
  const parsed = timeframeSchema.parse(value);
  if (parsed === '30s') return invalid();
  return parsed;
}
function requireFields(filter: ObjectValue, fields: readonly string[]): void {
  for (const field of fields) if (filter[field] === undefined) invalid();
}
function admission(raw: ObjectValue): BinanceAdmission {
  const seen = new Set<string>();
  const unsupported = new Set<string>();
  const filters = array(raw.filters, 64).map((item) => {
    const f = object(item);
    const type = idSchema.parse(f.filterType);
    if (seen.has(type)) return invalid();
    seen.add(type);
    const result: Record<string, string | number | boolean> = { filterType: type };
    const fields = Object.entries(f);
    if (fields.length > 32) return invalid();
    const supportedFields =
      raw.contractType === 'PERPETUAL'
        ? (PERPETUAL_FILTER_FIELDS.get(type) ?? FILTER_FIELDS.get(type))
        : FILTER_FIELDS.get(type);
    if (
      supportedFields === undefined ||
      fields.some(([field]) => field !== 'filterType' && !supportedFields.includes(field))
    )
      unsupported.add(type);
    for (const [field, value] of fields) {
      if (field === 'filterType') continue;
      if (DECIMAL_FILTER_FIELDS.has(field)) result[field] = nonnegative(value);
      else if (INTEGER_FILTER_FIELDS.has(field)) result[field] = wireInteger(value);
      else if (BOOLEAN_FILTER_FIELDS.has(field)) result[field] = bool(value);
      else if (typeof value === 'string' && value.length <= 256) result[field] = value;
      else if (typeof value === 'boolean') result[field] = value;
      else if (typeof value === 'number' && Number.isSafeInteger(value)) result[field] = value;
      else return invalid();
    }
    if (supportedFields !== undefined) requireFields(result, supportedFields);
    return result;
  });
  return immutable({
    symbol: symbol(raw.symbol),
    filters,
    unsupportedFilters: [...unsupported],
    quoteOrderQtyMarketAllowed:
      raw.quoteOrderQtyMarketAllowed === undefined ? false : bool(raw.quoteOrderQtyMarketAllowed),
    icebergAllowed: raw.icebergAllowed === undefined ? false : bool(raw.icebergAllowed),
    rawOrderTypes: strings(raw.orderTypes),
    rawTimeInForce: raw.timeInForce === undefined ? [] : strings(raw.timeInForce),
  });
}

/** Extra Binance rules remain explicit; they are not silently treated as core validation. */
export function normalizeBinanceAdmission(rawSymbol: unknown): BinanceAdmission {
  return guarded(() => admission(object(rawSymbol)));
}

export function normalizeExchangeInfo(
  raw: unknown,
  scope: MarketScope,
  now: number,
  observationId?: string,
): readonly InstrumentRecord[] {
  return guarded(() => {
    const parsedScope = marketScopeSchema.parse(scope);
    clock(now);
    if (observationId !== undefined) idSchema.parse(observationId);
    timestampSchema.parse(now + 60_000);
    if (
      parsedScope.exchange !== 'BINANCE' ||
      !['SPOT', 'LINEAR_PERPETUAL'].includes(parsedScope.market)
    )
      return invalid();
    const envelope = object(raw);
    if (envelope.timezone !== undefined && envelope.timezone !== 'UTC') return invalid();
    const symbols = array(envelope.symbols, 10_000);
    const result: InstrumentRecord[] = [];
    const seen = new Set<string>();
    for (const entry of symbols) {
      const s = object(entry);
      const name = symbol(s.symbol);
      if (seen.has(name)) return invalid();
      seen.add(name);
      if (typeof s.status !== 'string') return invalid();
      if (s.status !== 'TRADING') continue;
      if (parsedScope.market === 'SPOT') {
        if (!bool(s.isSpotTradingAllowed)) continue;
      } else if (
        s.contractType !== 'PERPETUAL' ||
        s.quoteAsset !== 'USDT' ||
        s.marginAsset !== 'USDT'
      )
        continue;
      const a = admission(s);
      const map = new Map(a.filters.map((f) => [f.filterType, f]));
      const price = map.get('PRICE_FILTER');
      const lot = map.get('LOT_SIZE');
      if (!price || !lot) return invalid();
      const market = map.get('MARKET_LOT_SIZE');
      const tickSize = positive(price.tickSize),
        stepSize = positive(lot.stepSize);
      const minQuantity = positive(lot.minQty),
        maxQuantity = positive(lot.maxQty);
      const marketMin = market ? nonnegative(market.minQty) : ZERO;
      const marketMax = market ? nonnegative(market.maxQty) : ZERO;
      const marketMinQuantity =
        marketMin === '0' || decimalCompare(minQuantity, marketMin) > 0 ? minQuantity : marketMin;
      const marketMaxQuantity =
        marketMax === '0' || decimalCompare(maxQuantity, marketMax) < 0 ? maxQuantity : marketMax;
      const minimum = map.get('MIN_NOTIONAL'),
        notional = map.get('NOTIONAL');
      const firstMin = minimum ? nonnegative(minimum.minNotional ?? minimum.notional) : ZERO;
      const nextMin = notional ? nonnegative(notional.minNotional) : ZERO;
      const minNotional = decimalCompare(firstMin, nextMin) >= 0 ? firstMin : nextMin;
      const maxNotional = notional ? positive(notional.maxNotional) : null;
      const baseAsset = assetSchema.parse(s.baseAsset),
        quoteAsset = assetSchema.parse(s.quoteAsset);
      const semantic = {
        scope: parsedScope,
        symbol: name,
        baseAsset,
        quoteAsset,
        marginAsset: s.marginAsset ?? null,
        contractType: s.contractType ?? null,
        admission: a,
      };
      // A fresh observation has its own immutable version, including A -> B -> A.
      const metadataVersion = `binance-${hash([semantic, now, observationId ?? null])}`;
      const orderTypes = new Set<'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT'>();
      for (const type of a.rawOrderTypes) {
        if (type === 'MARKET') orderTypes.add('MARKET');
        if (type === 'LIMIT' || type === 'LIMIT_MAKER') orderTypes.add('LIMIT');
        if (type === 'STOP_LOSS' || type === 'STOP_MARKET') orderTypes.add('STOP_MARKET');
        if (type === 'STOP_LOSS_LIMIT' || type === 'STOP') orderTypes.add('STOP_LIMIT');
      }
      const timeInForce =
        parsedScope.market === 'SPOT'
          ? ([
              'GTC',
              'IOC',
              'FOK',
              ...(a.rawOrderTypes.includes('LIMIT_MAKER') ? ['POST_ONLY'] : []),
            ] as const)
          : a.rawTimeInForce
              .filter((v) => ['GTC', 'IOC', 'FOK', 'GTX'].includes(v))
              .map((v) => (v === 'GTX' ? 'POST_ONLY' : v));
      const instrument = instrumentSchema.parse({
        id: name,
        scope: parsedScope,
        exchangeSymbol: name,
        displaySymbol: `${baseAsset}/${quoteAsset}`,
        baseAsset,
        quoteAsset,
        settlementAsset: parsedScope.market === 'SPOT' ? null : quoteAsset,
        // USD-M API quantity is a base-asset amount. This is a dimensional unit, not a lot conversion.
        contract:
          parsedScope.market === 'SPOT'
            ? null
            : { size: '1', unit: 'BASE', version: `base-${hash([name, baseAsset, quoteAsset])}` },
        expiryAt: null,
        status: 'TRADING',
        metadataVersion,
      });
      const rules = tradingRulesSchema.parse({
        instrumentId: name,
        scope: parsedScope,
        version: `rules-${hash([semantic, now, observationId ?? null])}`,
        effectiveAt: now,
        expiresAt: now + 60_000,
        tickSize,
        stepSize,
        minQuantity,
        maxQuantity,
        marketMinQuantity,
        marketMaxQuantity,
        minNotional,
        maxNotional,
        minPrice: price.minPrice === '0' ? null : positive(price.minPrice),
        maxPrice: price.maxPrice === '0' ? null : positive(price.maxPrice),
        quantityUnit: 'BASE',
        pricePrecision: tickSize.split('.')[1]?.length ?? 0,
        quantityPrecision: stepSize.split('.')[1]?.length ?? 0,
        orderTypes: [...orderTypes],
        timeInForce,
        leverageTiers: [],
      });
      result.push({ instrument, rules });
    }
    return immutable(result);
  });
}

const unavailable = { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' } as const;
function observedPrice(raw: unknown, optional = false) {
  if (raw === undefined && optional) return unavailable;
  const value = nonnegative(raw);
  return value === '0' ? unavailable : { state: 'AVAILABLE' as const, value };
}
export function normalizeTicker(raw: unknown, record: InstrumentRecord, now: number): Ticker {
  return guarded(() => {
    clock(now);
    const value = object(raw);
    checkSymbol(value, record, true);
    const stream = value.e !== undefined;
    if (stream && value.e !== '24hrTicker') return invalid();
    const bid = observedPrice(stream ? value.b : value.bidPrice, true);
    const ask = observedPrice(stream ? value.a : value.askPrice, true);
    if (
      bid.state === 'AVAILABLE' &&
      ask.state === 'AVAILABLE' &&
      decimalCompare(bid.value, ask.value) > 0
    )
      return invalid();
    const exchangeTime = time(stream ? value.E : value.closeTime);
    return immutable(
      tickerSchema.parse({
        ...identity(record),
        exchangeTime,
        receivedAt: now,
        last: observedPrice(stream ? value.c : value.lastPrice),
        bid,
        ask,
        baseVolume: { state: 'AVAILABLE', value: nonnegative(stream ? value.v : value.volume) },
        quoteVolume: {
          state: 'AVAILABLE',
          value: nonnegative(stream ? value.q : value.quoteVolume),
        },
        change: { state: 'AVAILABLE', value: decimal(stream ? value.p : value.priceChange) },
        freshness: exchangeTime <= now + 1000 && now - exchangeTime <= 60_000 ? 'FRESH' : 'STALE',
      }),
    );
  });
}

export function normalizeBook(
  raw: unknown,
  record: InstrumentRecord,
  now: number,
  depth: number,
): OrderBook {
  return guarded(() => {
    clock(now);
    if (!Number.isInteger(depth) || depth < 1 || depth > 1000) return invalid();
    const value = object(raw);
    checkSymbol(value, record, false);
    if (value.e !== undefined) return invalid(); // Diff updates require a separate sequence-aware assembler.
    const sequence = numericId(value.lastUpdateId);
    const levels = (input: unknown, descending: boolean) =>
      array(input, 1000)
        .map((item) => {
          const tuple = array(item, 2);
          if (tuple.length !== 2) return invalid();
          return { price: positive(tuple[0]), quantity: positive(tuple[1]) };
        })
        .sort((a, b) => decimalCompare(a.price, b.price) * (descending ? -1 : 1));
    const parsed = orderBookSchema.parse({
      ...identity(record),
      exchangeTime: record.instrument.scope.market === 'SPOT' ? null : time(value.T),
      receivedAt: now,
      kind: 'SNAPSHOT',
      bids: levels(value.bids, true),
      asks: levels(value.asks, false),
      sourceSequence: sequence,
      previousSequence: null,
      checksum: null,
      snapshotVersion: `book-${sequence}`,
      stale:
        record.instrument.scope.market !== 'SPOT' &&
        (time(value.T) > now + 1000 || now - time(value.T) > 60_000),
    });
    return immutable({
      ...parsed,
      bids: parsed.bids.slice(0, depth),
      asks: parsed.asks.slice(0, depth),
    });
  });
}

export function normalizeTrade(raw: unknown, record: InstrumentRecord, now: number): TradeTick {
  return guarded(() => {
    clock(now);
    const value = object(raw);
    const stream = value.e !== undefined;
    if (stream && value.e !== 'trade' && value.e !== 'aggTrade') return invalid();
    checkSymbol(value, record, stream);
    const aggregate = value.e === 'aggTrade';
    const tradeId = numericId(stream ? (aggregate ? value.a : value.t) : value.id);
    return immutable(
      tradeTickSchema.parse({
        ...identity(record),
        exchangeTime: time(stream ? value.T : value.time),
        receivedAt: now,
        tradeId,
        identityScope: aggregate ? 'BINANCE:AGGREGATE_TRADES' : 'BINANCE:TRADES',
        price: positive(stream ? value.p : value.price),
        quantity: positive(stream ? value.q : value.qty),
        quantityUnit: 'BASE',
        side: bool(stream ? value.m : value.isBuyerMaker) ? 'SELL' : 'BUY',
        sourceSequence: tradeId,
      }),
    );
  });
}

export function normalizeCandles(
  raw: unknown,
  record: InstrumentRecord,
  requestedTimeframe: string,
  now: number,
): Candle[] {
  return guarded(() => {
    clock(now);
    const interval = timeframe(requestedTimeframe);
    let previous = -1;
    return immutable(
      array(raw, 1500).map((entry) => {
        const row = array(entry, 12);
        if (row.length !== 12) return invalid();
        const openTime = time(row[0]),
          closeTime = time(row[6]) + 1;
        if (openTime <= previous || openTime > now) return invalid();
        previous = openTime;
        const complete = closeTime <= now;
        return candleSchema.parse({
          ...identity(record),
          timeframe: interval,
          openTime,
          closeTime,
          open: positive(row[1]),
          high: positive(row[2]),
          low: positive(row[3]),
          close: positive(row[4]),
          baseVolume: nonnegative(row[5]),
          quoteVolume: { state: 'AVAILABLE', value: nonnegative(row[7]) },
          numberOfTrades: wireInteger(row[8]),
          complete,
          quality: complete ? 'COMPLETE' : 'PARTIAL',
          revision: 0,
          provenance: 'EXCHANGE',
        });
      }),
    );
  });
}

export function normalizeKlineEvent(
  raw: unknown,
  record: InstrumentRecord,
  requestedTimeframe: string,
  now: number,
): Candle {
  return guarded(() => {
    clock(now);
    const interval = timeframe(requestedTimeframe);
    const event = object(raw);
    if (event.e !== 'kline') return invalid();
    checkSymbol(event, record, true);
    const k = object(event.k);
    checkSymbol(k, record, true);
    if (k.i !== interval) return invalid();
    const openTime = time(k.t),
      closeTime = time(k.T) + 1,
      complete = bool(k.x);
    if (openTime > now || (complete && closeTime > now)) return invalid();
    return immutable(
      candleSchema.parse({
        ...identity(record),
        timeframe: interval,
        openTime,
        closeTime,
        open: positive(k.o),
        high: positive(k.h),
        low: positive(k.l),
        close: positive(k.c),
        baseVolume: nonnegative(k.v),
        quoteVolume: { state: 'AVAILABLE', value: nonnegative(k.q) },
        numberOfTrades: wireInteger(k.n),
        complete,
        quality: complete ? 'COMPLETE' : 'PARTIAL',
        revision: time(event.E),
        provenance: 'EXCHANGE',
      }),
    );
  });
}
