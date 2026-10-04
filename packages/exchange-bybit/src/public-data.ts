import { createHash } from 'node:crypto';
import {
  candleSchema,
  decimalCompare,
  immutable,
  instrumentSchema,
  orderBookSchema,
  positiveAmountSchema,
  nonNegativeAmountSchema,
  nonNegativeDecimalSchema,
  tickerSchema,
  tradeTickSchema,
  tradingRulesSchema,
  timeframeMs,
  type Candle,
  type InstrumentRecord,
  type MarketScope,
  type OrderBook,
  type Ticker,
} from '@ctp/exchange-core';
import {
  canonicalDecimal as decimal,
  wireArray as array,
  wireId as id,
  wireInteger as integer,
  wireObject as object,
} from './wire.js';
import { BybitProtocolError } from './client.js';
import { symbolSchema } from './profiles.js';

export interface BybitAdmission {
  readonly symbol: string;
  readonly constraints: Readonly<Record<string, unknown>>;
  readonly unsupportedConstraints: readonly string[];
}
const invalid = (): never => {
  throw new BybitProtocolError('INVALID_RESPONSE');
};
const positive = (x: unknown) => positiveAmountSchema.parse(decimal(x));
const nonnegative = (x: unknown) => nonNegativeAmountSchema.parse(decimal(x));
const unavailable = { state: 'UNAVAILABLE' as const, reason: 'NOT_PROVIDED' as const };
export function observedPrice(x: unknown) {
  return x === undefined || x === '' || decimal(x) === '0'
    ? unavailable
    : { state: 'AVAILABLE' as const, value: positive(x) };
}
function observedVolume(x: unknown) {
  return x === undefined || x === ''
    ? unavailable
    : { state: 'AVAILABLE' as const, value: nonNegativeDecimalSchema.parse(decimal(x)) };
}
const identity = (record: InstrumentRecord) => ({
  scope: record.instrument.scope,
  instrumentId: record.instrument.id,
});
const stale = (exchange: number, received: number) =>
  exchange > received + 1000 || received - exchange > 60_000;
function sequence(x: unknown): string {
  const value = id(x);
  if (!/^\d{1,30}$/.test(value)) return invalid();
  return value;
}
function matchSymbol(x: unknown, record: InstrumentRecord) {
  if (x !== record.instrument.exchangeSymbol) return invalid();
}
const knownTop = new Set([
  'symbol',
  'symbolId',
  'baseCoin',
  'quoteCoin',
  'status',
  'symbolType',
  'innovation',
  'marginTrading',
  'stTag',
  'xstockMultiplier',
  'priceFilter',
  'lotSizeFilter',
  'riskParameters',
  'contractType',
  'settleCoin',
  'launchTime',
  'deliveryTime',
  'deliveryFeeRate',
  'priceScale',
  'leverageFilter',
  'unifiedMarginTrade',
  'fundingInterval',
  'copyTrading',
  'upperFundingRate',
  'lowerFundingRate',
  'isPreListing',
  'preListingInfo',
  'forbidUplWithdrawal',
  'displayName',
  'skipCallAuction',
]);
export function normalizeInstrument(
  raw: unknown,
  scope: MarketScope,
  now: number,
  observation: string,
): { readonly record: InstrumentRecord; readonly admission: BybitAdmission } {
  const value = object(raw),
    linear = scope.market === 'LINEAR_PERPETUAL';
  if (scope.exchange !== 'BYBIT' || (!linear && scope.market !== 'SPOT')) return invalid();
  const symbol = symbolSchema.parse(value.symbol);
  if (
    linear &&
    (value.contractType !== 'LinearPerpetual' ||
      value.quoteCoin !== 'USDT' ||
      value.settleCoin !== 'USDT' ||
      value.unifiedMarginTrade !== true ||
      value.isPreListing === true ||
      value.symbolType === 'xstocks' ||
      (value.deliveryTime !== undefined && integer(value.deliveryTime) !== 0))
  )
    throw new BybitProtocolError('UNSUPPORTED');
  if (
    !linear &&
    (value.symbolType === 'xstocks' ||
      (value.xstockMultiplier !== undefined && decimal(value.xstockMultiplier) !== '1'))
  )
    throw new BybitProtocolError('UNSUPPORTED');
  const price = object(value.priceFilter),
    lot = object(value.lotSizeFilter),
    unsupported = new Set<string>();
  const fields: readonly [string, Readonly<Record<string, unknown>>, readonly string[]][] = [
    ['priceFilter', price, linear ? ['tickSize', 'minPrice', 'maxPrice'] : ['tickSize']],
    [
      'lotSizeFilter',
      lot,
      linear
        ? [
            'minNotionalValue',
            'maxOrderQty',
            'maxMktOrderQty',
            'minOrderQty',
            'qtyStep',
            'postOnlyMaxOrderQty',
          ]
        : [
            'basePrecision',
            'quotePrecision',
            'minOrderAmt',
            'maxLimitOrderQty',
            'maxMarketOrderQty',
            'postOnlyMaxLimitOrderSize',
            'minOrderQty',
            'maxOrderQty',
            'maxOrderAmt',
          ],
    ],
  ];
  for (const [name, constraint, allowed] of fields) {
    if (Object.keys(constraint).length > 32) return invalid();
    if (Object.keys(constraint).some((k) => !allowed.includes(k))) unsupported.add(name);
  }
  if (value.leverageFilter !== undefined) {
    const f = object(value.leverageFilter);
    if (Object.keys(f).some((k) => !['minLeverage', 'maxLeverage', 'leverageStep'].includes(k)))
      unsupported.add('leverageFilter');
    for (const k of ['minLeverage', 'maxLeverage', 'leverageStep']) positive(f[k]);
  } else if (linear) return invalid();
  if (value.riskParameters !== undefined) {
    const f = object(value.riskParameters);
    if (Object.keys(f).some((k) => !['priceLimitRatioX', 'priceLimitRatioY'].includes(k)))
      unsupported.add('riskParameters');
    for (const k of ['priceLimitRatioX', 'priceLimitRatioY']) nonnegative(f[k]);
  } else unsupported.add('riskParameters');
  if (Object.keys(value).length > 64) return invalid();
  if (Object.keys(value).some((k) => !knownTop.has(k))) unsupported.add('instrument');
  const tick = positive(price.tickSize),
    step = positive(linear ? lot.qtyStep : lot.basePrecision);
  if (!linear) positive(lot.quotePrecision);
  const version = `bybit-${createHash('sha256')
    .update(JSON.stringify({ scope, raw: value, observation }))
    .digest('hex')
    .slice(0, 40)}`;
  const instrument = instrumentSchema.parse({
    id: symbol,
    scope,
    exchangeSymbol: symbol,
    displaySymbol: `${String(value.baseCoin)}/${String(value.quoteCoin)}`,
    baseAsset: value.baseCoin,
    quoteAsset: value.quoteCoin,
    settlementAsset: linear ? 'USDT' : null,
    contract: linear ? { size: '1', unit: 'BASE', version } : null,
    expiryAt: null,
    status:
      value.status === 'Trading'
        ? 'TRADING'
        : ['PendingOpen', 'PreLaunch', 'Settling', 'Delivering'].includes(String(value.status))
          ? 'HALTED'
          : value.status === 'Closed'
            ? 'DELISTED'
            : invalid(),
    metadataVersion: version,
  });
  const rules = tradingRulesSchema.parse({
    instrumentId: symbol,
    scope,
    version,
    effectiveAt: now,
    expiresAt: now + 60_000,
    tickSize: tick,
    stepSize: step,
    minQuantity: linear ? positive(lot.minOrderQty) : step,
    maxQuantity: positive(linear ? lot.maxOrderQty : lot.maxLimitOrderQty),
    marketMinQuantity: linear ? positive(lot.minOrderQty) : step,
    marketMaxQuantity: positive(linear ? lot.maxMktOrderQty : lot.maxMarketOrderQty),
    minNotional: nonnegative(linear ? lot.minNotionalValue : lot.minOrderAmt),
    maxNotional: null,
    minPrice: linear ? positive(price.minPrice) : null,
    maxPrice: linear ? positive(price.maxPrice) : null,
    quantityUnit: 'BASE',
    pricePrecision: tick.split('.')[1]?.length ?? 0,
    quantityPrecision: step.split('.')[1]?.length ?? 0,
    orderTypes: ['MARKET', 'LIMIT'],
    timeInForce: ['GTC', 'IOC', 'FOK', 'POST_ONLY'],
    leverageTiers: [],
  });
  return immutable({
    record: { instrument, rules },
    admission: {
      symbol,
      constraints: {
        priceFilter: price,
        lotSizeFilter: lot,
        ...(value.leverageFilter === undefined ? {} : { leverageFilter: value.leverageFilter }),
        ...(value.riskParameters === undefined ? {} : { riskParameters: value.riskParameters }),
      },
      unsupportedConstraints: [...unsupported],
    },
  });
}
export function normalizeTicker(
  raw: unknown,
  record: InstrumentRecord,
  exchangeTime: number,
  receivedAt: number,
): Ticker {
  const x = object(raw);
  matchSymbol(x.symbol, record);
  return immutable(
    tickerSchema.parse({
      ...identity(record),
      exchangeTime,
      receivedAt,
      last: observedPrice(x.lastPrice),
      bid: observedPrice(x.bid1Price),
      ask: observedPrice(x.ask1Price),
      baseVolume: observedVolume(x.volume24h),
      quoteVolume: observedVolume(x.turnover24h),
      change: unavailable,
      freshness: stale(exchangeTime, receivedAt) ? 'STALE' : 'FRESH',
    }),
  );
}
export const intervals = Object.freeze({
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
});
export function nativeInterval(timeframe: string): string {
  if (!Object.hasOwn(intervals, timeframe)) throw new BybitProtocolError('UNSUPPORTED');
  return intervals[timeframe as keyof typeof intervals];
}
export function normalizeCandles(
  raw: unknown,
  record: InstrumentRecord,
  timeframe: string,
  now: number,
): readonly Candle[] {
  nativeInterval(timeframe);
  const tf = timeframe as keyof typeof intervals;
  const seen = new Set<number>();
  const result = array(raw, 1000).map((entry) => {
    const r = array(entry, 7);
    if (r.length !== 7) return invalid();
    const openTime = integer(r[0]);
    if (seen.has(openTime) || openTime > now) return invalid();
    seen.add(openTime);
    const closeTime = openTime + timeframeMs[tf];
    const complete = closeTime <= now;
    return candleSchema.parse({
      ...identity(record),
      timeframe: tf,
      openTime,
      closeTime,
      open: positive(r[1]),
      high: positive(r[2]),
      low: positive(r[3]),
      close: positive(r[4]),
      baseVolume: nonNegativeDecimalSchema.parse(decimal(r[5])),
      quoteVolume: observedVolume(r[6]),
      numberOfTrades: null,
      complete,
      quality: complete ? 'COMPLETE' : 'PARTIAL',
      revision: 0,
      provenance: 'EXCHANGE',
    });
  });
  return immutable(result.sort((a, b) => a.openTime - b.openTime));
}
export function normalizeKline(
  raw: unknown,
  record: InstrumentRecord,
  timeframe: string,
  now: number,
): Candle {
  const x = object(raw);
  if (String(x.interval) !== nativeInterval(timeframe) || typeof x.confirm !== 'boolean')
    return invalid();
  const rows = normalizeCandles(
    [[String(integer(x.start)), x.open, x.high, x.low, x.close, x.volume, x.turnover]],
    record,
    timeframe,
    now,
  );
  const candle = rows[0];
  if (!candle || integer(x.end) + 1 !== candle.closeTime || (x.confirm && candle.closeTime > now))
    return invalid();
  return immutable({ ...candle, complete: x.confirm, quality: x.confirm ? 'COMPLETE' : 'PARTIAL' });
}
export function normalizeTrade(raw: unknown, record: InstrumentRecord, now: number) {
  const x = object(raw);
  matchSymbol(x.s, record);
  if (x.S !== 'Buy' && x.S !== 'Sell') return invalid();
  return immutable(
    tradeTickSchema.parse({
      ...identity(record),
      exchangeTime: integer(x.T),
      receivedAt: now,
      tradeId: id(x.i),
      identityScope: `BYBIT:${record.instrument.scope.market}:TRADES`,
      price: positive(x.p),
      quantity: positive(x.v),
      quantityUnit: 'BASE',
      side: x.S === 'Buy' ? 'BUY' : 'SELL',
      sourceSequence: x.seq === undefined ? null : sequence(x.seq),
    }),
  );
}
export function normalizeBook(
  raw: unknown,
  record: InstrumentRecord,
  depth: number,
  now: number,
): OrderBook {
  const x = object(raw);
  return (
    createBookAssembler(record, depth).update({ type: 'snapshot', ts: x.ts, data: x }, now) ??
    invalid()
  );
}
export function createBookAssembler(record: InstrumentRecord, depth: number) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 1000) return invalid();
  let ready = false,
    lastUpdate: string | null = null,
    lastSeq: string | null = null,
    lastFrame = '';
  let bids = new Map<string, string>(),
    asks = new Map<string, string>();
  return Object.freeze({
    update(raw: unknown, now: number): OrderBook | null {
      const event = object(raw),
        x = object(event.data);
      matchSymbol(x.s, record);
      const u = sequence(x.u),
        seq = sequence(x.seq),
        snapshot = event.type === 'snapshot';
      if (!snapshot && event.type !== 'delta') return invalid();
      if (!snapshot && !ready) return invalid();
      if (
        !snapshot &&
        (u === '1' ||
          !lastUpdate ||
          !lastSeq ||
          BigInt(u) < BigInt(lastUpdate) ||
          BigInt(seq) < BigInt(lastSeq))
      )
        return invalid();
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ b: x.b, a: x.a }))
        .digest('hex');
      if (!snapshot && u === lastUpdate && seq === lastSeq) {
        if (fingerprint !== lastFrame) return invalid();
        return null;
      }
      const nextB = snapshot ? new Map<string, string>() : new Map(bids),
        nextA = snapshot ? new Map<string, string>() : new Map(asks);
      const apply = (raw: unknown, map: Map<string, string>) => {
        const seen = new Set<string>();
        for (const entry of array(raw, 1000)) {
          const tuple = array(entry, 2);
          if (tuple.length !== 2) return invalid();
          const p = positive(tuple[0]),
            q = nonnegative(tuple[1]);
          if (seen.has(p) || (snapshot && q === '0')) return invalid();
          seen.add(p);
          if (q === '0') map.delete(p);
          else map.set(p, q);
        }
        if (map.size > 1000) return invalid();
      };
      apply(x.b, nextB);
      apply(x.a, nextA);
      const sorted = (map: Map<string, string>, descending: boolean) =>
        [...map]
          .map(([price, quantity]) => ({ price, quantity }))
          .sort(
            (a, b) =>
              decimalCompare(
                a.price as ReturnType<typeof positive>,
                b.price as ReturnType<typeof positive>,
              ) * (descending ? -1 : 1),
          )
          .slice(0, depth);
      const ts = integer(event.ts);
      const result = orderBookSchema.parse({
        ...identity(record),
        exchangeTime: ts,
        receivedAt: now,
        kind: 'SNAPSHOT',
        bids: sorted(nextB, true),
        asks: sorted(nextA, false),
        sourceSequence: u,
        previousSequence: null,
        checksum: null,
        snapshotVersion: `bybit-book-${u}-${seq}`,
        stale: stale(ts, now),
      });
      bids = nextB;
      asks = nextA;
      ready = true;
      lastUpdate = u;
      lastSeq = seq;
      lastFrame = fingerprint;
      return immutable(result);
    },
  });
}
