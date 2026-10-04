import { createHash } from 'node:crypto';
import {
  candleSchema,
  decimalCompare,
  decimalMultiply,
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
  type InstrumentRecord,
  type MarketScope,
  type OrderBook,
} from '@ctp/exchange-core';
import {
  canonicalDecimal as decimal,
  wireArray as array,
  wireId as id,
  wireInteger as integer,
  wireObject as object,
} from './wire.js';
import { OkxProtocolError } from './client.js';
import { symbolSchema } from './profiles.js';

export interface OkxAdmission {
  readonly symbol: string;
  readonly constraints: Readonly<Record<string, unknown>>;
  readonly unsupportedConstraints: readonly string[];
}
const invalid = (): never => {
  throw new OkxProtocolError('INVALID_RESPONSE');
};
const positive = (x: unknown) => positiveAmountSchema.parse(decimal(x));
const nonnegative = (x: unknown) => nonNegativeAmountSchema.parse(decimal(x));
const unavailable = { state: 'UNAVAILABLE' as const, reason: 'NOT_PROVIDED' as const };
export function observedPrice(x: unknown) {
  return x === undefined || x === '' || decimal(x) === '0'
    ? unavailable
    : { state: 'AVAILABLE' as const, value: positive(x) };
}
const observedVolume = (x: unknown) =>
  x === undefined || x === ''
    ? unavailable
    : { state: 'AVAILABLE' as const, value: nonNegativeDecimalSchema.parse(decimal(x)) };
const identity = (r: InstrumentRecord) => ({
  scope: r.instrument.scope,
  instrumentId: r.instrument.id,
});
const stale = (exchange: number, received: number) =>
  exchange > received + 1000 || received - exchange > 60_000;
const knownTop = new Set(
  'instType seriesId instId uly groupId instFamily category baseCcy quoteCcy settleCcy ctVal ctMult ctValCcy optType stk listTime auctionEndTime contTdSwTime preMktSwTime openType expTime lever tickSz lotSz minSz ctType alias state ruleType maxLmtSz maxMktSz maxLmtAmt maxMktAmt maxTwapSz maxIcebergSz maxTriggerSz maxStopSz futureSettlement tradeQuoteCcyList instIdCode instCategory initPxLmtPct floatPxLmtPct maxPxLmtPct rpiMinLevel rpiMinPxBand upcChg'.split(
    ' ',
  ),
);
export function normalizeInstrument(
  raw: unknown,
  scope: MarketScope,
  now: number,
  observation: string,
): { readonly record: InstrumentRecord; readonly admission: OkxAdmission } {
  const x = object(raw),
    swap = scope.market === 'LINEAR_PERPETUAL';
  if (scope.exchange !== 'OKX' || (!swap && scope.market !== 'SPOT')) return invalid();
  const symbol = symbolSchema.parse(x.instId);
  if (x.instType !== (swap ? 'SWAP' : 'SPOT') || symbol.endsWith('-SWAP') !== swap)
    return invalid();
  const base = swap ? x.ctValCcy : x.baseCcy;
  if (
    symbol !== `${String(base)}-USDT${swap ? '-SWAP' : ''}` ||
    x.ruleType !== 'normal' ||
    x.instCategory !== '1' ||
    (x.expTime !== undefined && x.expTime !== '')
  )
    throw new OkxProtocolError('UNSUPPORTED');
  if (swap && (x.ctType !== 'linear' || x.settleCcy !== 'USDT' || decimal(x.ctMult) !== '1'))
    throw new OkxProtocolError('UNSUPPORTED');
  if (!swap && (x.quoteCcy !== 'USDT' || !array(x.tradeQuoteCcyList, 8).includes('USDT')))
    throw new OkxProtocolError('UNSUPPORTED');
  if (Object.keys(x).length > 64) return invalid();
  const unsupported = Object.keys(x).filter((k) => !knownTop.has(k));
  for (const [key, value] of Object.entries(x)) {
    if (!knownTop.has(key) || key === 'upcChg') continue;
    if (key === 'tradeQuoteCcyList') {
      if (
        array(value, 8).some((item) => typeof item !== 'string' || !/^[A-Z0-9]{1,32}$/.test(item))
      )
        unsupported.push(key);
    } else if (key === 'futureSettlement') {
      if (value !== false) unsupported.push(key);
    } else if (typeof value !== 'string') unsupported.push(key);
  }
  let expiresAt = now + 60_000;
  for (const entry of array(x.upcChg ?? [], 32)) {
    const change = object(entry);
    if (
      Object.keys(change).some((k) => !['param', 'newValue', 'effTime'].includes(k)) ||
      !['tickSz', 'lotSz', 'minSz', 'maxLmtSz', 'maxMktSz', 'maxLmtAmt', 'maxMktAmt'].includes(
        String(change.param),
      )
    )
      unsupported.push('upcChg');
    positive(change.newValue);
    const effective = integer(change.effTime);
    if (effective <= now) throw new OkxProtocolError('STALE_METADATA');
    expiresAt = Math.min(expiresAt, effective);
  }
  for (const field of [
    'maxLmtAmt',
    'maxMktAmt',
    'maxTwapSz',
    'maxIcebergSz',
    'maxTriggerSz',
    'maxStopSz',
    'initPxLmtPct',
    'floatPxLmtPct',
    'maxPxLmtPct',
    'rpiMinLevel',
    'rpiMinPxBand',
  ])
    if (x[field] !== undefined && x[field] !== '') nonnegative(x[field]);
  if (!swap && (x.maxMktSz === undefined || x.maxMktSz === '')) unsupported.push('maxMktSz');
  else positive(x.maxMktSz);
  const tick = positive(x.tickSz),
    step = positive(x.lotSz),
    min = positive(x.minSz),
    max = positive(x.maxLmtSz);
  const version = `okx-${createHash('sha256')
    .update(JSON.stringify({ scope, raw: x, observation }))
    .digest('hex')
    .slice(0, 40)}`;
  const instrument = instrumentSchema.parse({
    id: symbol,
    scope,
    exchangeSymbol: symbol,
    displaySymbol: `${String(base)}/USDT`,
    baseAsset: base,
    quoteAsset: 'USDT',
    settlementAsset: swap ? 'USDT' : null,
    contract: swap ? { size: positive(x.ctVal), unit: 'BASE', version } : null,
    expiryAt: null,
    status:
      x.state === 'live'
        ? 'TRADING'
        : ['suspend', 'rebase', 'post_only', 'preopen', 'test', 'settling'].includes(
              String(x.state),
            )
          ? 'HALTED'
          : invalid(),
    metadataVersion: version,
  });
  const rules = tradingRulesSchema.parse({
    instrumentId: symbol,
    scope,
    version,
    effectiveAt: now,
    expiresAt,
    tickSize: tick,
    stepSize: step,
    minQuantity: min,
    maxQuantity: max,
    marketMinQuantity: min,
    // Spot maxMktSz is USDT. The local BASE cap is additional; native notional admission remains mandatory.
    marketMaxQuantity: swap ? positive(x.maxMktSz) : max,
    minNotional: '0',
    maxNotional: null,
    minPrice: null,
    maxPrice: null,
    quantityUnit: swap ? 'CONTRACTS' : 'BASE',
    pricePrecision: tick.split('.')[1]?.length ?? 0,
    quantityPrecision: step.split('.')[1]?.length ?? 0,
    orderTypes: ['MARKET', 'LIMIT'],
    timeInForce: ['GTC', 'IOC', 'FOK', 'POST_ONLY'],
    leverageTiers: [],
  });
  return immutable({
    record: { instrument, rules },
    admission: { symbol, constraints: x, unsupportedConstraints: [...new Set(unsupported)] },
  });
}
function matchSymbol(x: unknown, record: InstrumentRecord) {
  if (x !== record.instrument.exchangeSymbol) return invalid();
}
export function normalizeTicker(raw: unknown, record: InstrumentRecord, receivedAt: number) {
  const x = object(raw);
  matchSymbol(x.instId, record);
  if (x.instType !== (record.instrument.scope.market === 'SPOT' ? 'SPOT' : 'SWAP'))
    return invalid();
  const exchangeTime = integer(x.ts);
  // Derivatives volCcy24h is BASE, whereas Spot volCcy24h is quote currency.
  const swap = record.instrument.scope.market === 'LINEAR_PERPETUAL';
  return immutable(
    tickerSchema.parse({
      ...identity(record),
      exchangeTime,
      receivedAt,
      last: observedPrice(x.last),
      bid: observedPrice(x.bidPx),
      ask: observedPrice(x.askPx),
      baseVolume: observedVolume(swap ? x.volCcy24h : x.vol24h),
      quoteVolume: swap ? unavailable : observedVolume(x.volCcy24h),
      change: unavailable,
      freshness: stale(exchangeTime, receivedAt) ? 'STALE' : 'FRESH',
    }),
  );
}
export const intervals = Object.freeze({
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1Dutc',
});
export function nativeInterval(timeframe: string): string {
  if (!Object.hasOwn(intervals, timeframe)) throw new OkxProtocolError('UNSUPPORTED');
  return intervals[timeframe as keyof typeof intervals];
}
export function normalizeCandles(
  raw: unknown,
  record: InstrumentRecord,
  timeframe: string,
  now: number,
) {
  nativeInterval(timeframe);
  const tf = timeframe as keyof typeof intervals,
    seen = new Set<number>();
  return immutable(
    array(raw, 100)
      .map((entry) => {
        const row = array(entry, 9);
        if (row.length !== 9 || !['0', '1'].includes(String(row[8]))) return invalid();
        const openTime = integer(row[0]),
          closeTime = openTime + timeframeMs[tf],
          complete = row[8] === '1';
        if (seen.has(openTime) || openTime > now || (complete && closeTime > now)) return invalid();
        seen.add(openTime);
        return candleSchema.parse({
          ...identity(record),
          timeframe: tf,
          openTime,
          closeTime,
          open: positive(row[1]),
          high: positive(row[2]),
          low: positive(row[3]),
          close: positive(row[4]),
          baseVolume: nonNegativeDecimalSchema.parse(
            decimal(record.instrument.scope.market === 'SPOT' ? row[5] : row[6]),
          ),
          quoteVolume: observedVolume(row[7]),
          numberOfTrades: null,
          complete,
          quality: complete ? 'COMPLETE' : 'PARTIAL',
          revision: 0,
          provenance: 'EXCHANGE',
        });
      })
      .sort((a, b) => a.openTime - b.openTime),
  );
}
export function normalizeTrade(raw: unknown, record: InstrumentRecord, now: number) {
  const x = object(raw);
  matchSymbol(x.instId, record);
  if (x.side !== 'buy' && x.side !== 'sell') return invalid();
  return immutable(
    tradeTickSchema.parse({
      ...identity(record),
      exchangeTime: integer(x.ts),
      receivedAt: now,
      tradeId: id(x.tradeId),
      identityScope: `OKX:${record.instrument.scope.market}:TRADES`,
      price: positive(x.px),
      quantity: positive(x.sz),
      quantityUnit: record.rules.quantityUnit,
      side: x.side === 'buy' ? 'BUY' : 'SELL',
      sourceSequence: x.seqId === undefined ? null : id(x.seqId),
    }),
  );
}
function seq(x: unknown, negative = false): string {
  const s = typeof x === 'number' && Number.isSafeInteger(x) ? String(x) : x;
  if (typeof s !== 'string' || !(/^(?:0|[1-9]\d{0,29})$/.test(s) || (negative && s === '-1')))
    return invalid();
  return s;
}
export function createBookAssembler(record: InstrumentRecord, depth: number) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 400)
    throw new OkxProtocolError('UNSUPPORTED');
  let ready = false,
    lastSequence: string | null = null,
    lastFrame = '',
    lastTime = 0;
  let bids = new Map<string, string>(),
    asks = new Map<string, string>();
  return Object.freeze({
    update(raw: unknown, now: number): OrderBook | null {
      const event = object(raw),
        rows = array(event.data, 1);
      if (rows.length !== 1) return invalid();
      const x = object(rows[0]),
        snapshot = event.action === 'snapshot';
      if (!snapshot && event.action !== 'update') return invalid();
      const nextSeq = seq(x.seqId),
        prev = seq(x.prevSeqId, true),
        time = integer(x.ts);
      if (snapshot ? prev !== '-1' : !ready || prev !== lastSequence || time < lastTime)
        return invalid();
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ bids: x.bids, asks: x.asks }))
        .digest('hex');
      if (!snapshot && nextSeq === lastSequence) {
        if (array(x.bids, 400).length === 0 && array(x.asks, 400).length === 0) return null;
        if (fingerprint !== lastFrame) return invalid();
        return null;
      }
      const nextB = snapshot ? new Map<string, string>() : new Map(bids),
        nextA = snapshot ? new Map<string, string>() : new Map(asks);
      const apply = (raw: unknown, map: Map<string, string>) => {
        const seen = new Set<string>();
        for (const level of array(raw, 400)) {
          const tuple = array(level, 4);
          if (tuple.length !== 4) return invalid();
          const p = positive(tuple[0]),
            nativeQty = nonnegative(tuple[1]);
          if (seen.has(p) || (snapshot && nativeQty === '0')) return invalid();
          seen.add(p);
          if (nativeQty === '0') map.delete(p);
          else
            map.set(
              p,
              record.instrument.contract === null
                ? nativeQty
                : positive(decimalMultiply(nativeQty, record.instrument.contract.size)),
            );
        }
        if (map.size > 400) return invalid();
      };
      apply(x.bids, nextB);
      apply(x.asks, nextA);
      const sorted = (map: Map<string, string>, desc: boolean) =>
        [...map]
          .map(([price, quantity]) => ({ price: positive(price), quantity: nonnegative(quantity) }))
          .sort((a, b) => decimalCompare(a.price, b.price) * (desc ? -1 : 1))
          .slice(0, depth);
      const result = orderBookSchema.parse({
        ...identity(record),
        exchangeTime: time,
        receivedAt: now,
        kind: 'SNAPSHOT',
        bids: sorted(nextB, true),
        asks: sorted(nextA, false),
        sourceSequence: nextSeq,
        previousSequence: null,
        checksum: null,
        snapshotVersion: `okx-book-${nextSeq}`,
        stale: stale(time, now),
      });
      bids = nextB;
      asks = nextA;
      ready = true;
      lastSequence = nextSeq;
      lastFrame = fingerprint;
      lastTime = time;
      return immutable(result);
    },
  });
}
