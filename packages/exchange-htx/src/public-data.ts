import { randomUUID } from 'node:crypto';
import {
  immutable,
  instrumentSchema,
  tradingRulesSchema,
  tickerSchema,
  orderBookSchema,
  candleSchema,
  tradeTickSchema,
  timeframeMs,
  decimalCompare,
  decimalMultiply,
  positiveAmountSchema,
  type InstrumentRecord,
  type MarketScope,
} from '@ctp/exchange-core';
import { HtxProtocolError } from './client.js';
import {
  canonicalDecimal as decimal,
  wireObject as object,
  wireArray as array,
  wireInteger as integer,
  wireId as id,
} from './wire.js';
export const intervals = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '60min',
  '4h': '4hour',
  '1d': '1day',
} as const;
export function nativeInterval(tf: string): string {
  const p = Object.entries(intervals).find(([key]) => key === tf)?.[1];
  if (typeof p !== 'string') throw new HtxProtocolError('UNSUPPORTED');
  return p;
}
export interface HtxAdmission {
  readonly newRiskSupported: boolean;
  readonly unsupportedFields: readonly string[];
  readonly nativeConstraints: Readonly<Record<string, string>>;
}
const spotFields = new Set([
  'symbol',
  'bc',
  'qc',
  'state',
  'pp',
  'ap',
  'vp',
  'minoa',
  'maxoa',
  'minov',
  'lominoa',
  'lomaxoa',
  'lomaxba',
  'lomaxsa',
  'smminoa',
  'smmaxoa',
  'bmmaxov',
  'blmlt',
  'slmgt',
  'msormlt',
  'mbormlt',
  'maxov',
  'at',
  'sp',
  'tags',
  'lr',
  'smlr',
  'flr',
  'u',
  'mfr',
  'ct',
  'rt',
  'rthr',
  'in',
  'castate',
]);
const linearFields = new Set([
  'symbol',
  'contract_code',
  'contract_size',
  'price_tick',
  'delivery_date',
  'delivery_time',
  'create_date',
  'settlement_date',
  'contract_status',
  'support_margin_mode',
  'business_type',
  'pair',
  'contract_type',
]);
const invalid = (): never => {
  throw new HtxProtocolError('INVALID_RESPONSE');
};
const upper = (x: unknown) => {
  if (typeof x !== 'string' || !/^[a-zA-Z0-9]{1,32}$/.test(x)) return invalid();
  return x.toUpperCase();
};
const positive = (x: unknown) => positiveAmountSchema.parse(decimal(x));
const precision = (x: unknown) => {
  const p = integer(x);
  if (p > 18) return invalid();
  return p;
};
const step = (p: number) => decimal(p === 0 ? '1' : '0.' + '0'.repeat(p - 1) + '1');
const scale = (d: string) => (d.includes('.') ? d.length - d.indexOf('.') - 1 : 0);
const min = (...v: ReturnType<typeof decimal>[]) =>
  v.reduce((a, b) => (decimalCompare(a, b) < 0 ? a : b));
export function normalizeInstrument(
  raw: unknown,
  scope: MarketScope,
  receivedAt: number,
  observation: string,
): { readonly record: InstrumentRecord; readonly admission: HtxAdmission } {
  const x = object(raw),
    spot = scope.market === 'SPOT';
  if (
    scope.exchange !== 'HTX' ||
    !['SPOT', 'LINEAR_PERPETUAL'].includes(scope.market) ||
    Object.keys(x).length > 64 ||
    JSON.stringify(x).length > 8192
  )
    return invalid();
  const symbol = id(spot ? x.symbol : x.contract_code),
    base = upper(spot ? x.bc : x.symbol),
    quote = spot ? upper(x.qc) : 'USDT';
  if (symbol !== (spot ? (base + quote).toLowerCase() : base + '-' + quote)) return invalid();
  if (
    !spot &&
    (x.business_type !== 'swap' ||
      x.contract_type !== 'swap' ||
      x.pair !== symbol ||
      x.delivery_time !== '' ||
      x.delivery_date !== '' ||
      !['cross', 'all'].includes(String(x.support_margin_mode)))
  )
    return invalid();
  const unknown = Object.keys(x)
    .filter((k) => !(spot ? spotFields : linearFields).has(k))
    .sort();
  for (const [key, value] of Object.entries(x)) {
    if ((spot ? spotFields : linearFields).has(key) && value !== null && typeof value === 'object')
      unknown.push(`UNSUPPORTED_SHAPE:${key}`);
  }
  if (!spot) unknown.push('MISSING_NATIVE_ORDER_LIMITS');
  const constraints: Record<string, string> = {};
  for (const k of spot
    ? ['blmlt', 'slmgt', 'msormlt', 'mbormlt', 'bmmaxov', 'maxov', 'lomaxba', 'lomaxsa']
    : []) {
    if (x[k] !== undefined) constraints[k] = positive(x[k]);
  }
  if (
    spot &&
    ((x.u !== undefined && x.u !== '') ||
      (typeof x.tags === 'string' ? x.tags : '')
        .split(',')
        .some((t) => ['etp', 'nav', 'holdinglimit'].includes(t)))
  )
    unknown.push('ETP_UNSUPPORTED');
  let status: 'TRADING' | 'HALTED' | 'DELISTED';
  if (spot) {
    if (
      ![
        'unknown',
        'not-online',
        'pre-online',
        'online',
        'suspend',
        'offline',
        'transfer-board',
        'fuse',
      ].includes(String(x.state))
    )
      return invalid();
    status =
      x.state === 'offline'
        ? 'DELISTED'
        : x.state === 'online' && x.at === 'enabled' && x.castate === undefined
          ? 'TRADING'
          : 'HALTED';
  } else {
    const state = integer(x.contract_status);
    if (state > 8) return invalid();
    status = state === 1 ? 'TRADING' : state === 0 ? 'DELISTED' : 'HALTED';
  }
  const tick = spot ? step(precision(x.pp)) : positive(x.price_tick),
    lot = spot ? step(precision(x.ap)) : decimal('1'),
    version = `htx-${observation}-${symbol}`;
  const instrument = instrumentSchema.parse({
    id: symbol,
    scope,
    exchangeSymbol: symbol,
    displaySymbol: `${base}/${quote}`,
    baseAsset: base,
    quoteAsset: quote,
    settlementAsset: spot ? null : 'USDT',
    contract: spot
      ? null
      : { size: positive(x.contract_size), unit: 'BASE', version: `c-${version}` },
    expiryAt: null,
    status,
    metadataVersion: `m-${version}`,
  });
  const rules = tradingRulesSchema.parse({
    instrumentId: symbol,
    scope,
    version: `r-${version}`,
    effectiveAt: receivedAt,
    expiresAt: receivedAt + 60000,
    tickSize: tick,
    stepSize: lot,
    minQuantity: spot ? positive(x.lominoa) : decimal('1'),
    maxQuantity: spot
      ? min(positive(x.maxoa), positive(x.lomaxoa), positive(x.lomaxba), positive(x.lomaxsa))
      : decimal('1000000000'),
    marketMinQuantity: spot ? positive(x.smminoa) : decimal('1'),
    marketMaxQuantity: spot ? positive(x.smmaxoa) : decimal('1000000000'),
    minNotional: spot ? positive(x.minov) : decimal('0'),
    maxNotional: spot && x.maxov !== undefined ? positive(x.maxov) : null,
    minPrice: null,
    maxPrice: null,
    quantityUnit: spot ? 'BASE' : 'CONTRACTS',
    pricePrecision: scale(tick),
    quantityPrecision: scale(lot),
    orderTypes: ['MARKET', 'LIMIT'],
    timeInForce: ['GTC', 'IOC', 'FOK', 'POST_ONLY'],
    leverageTiers: [],
  });
  return immutable({
    record: { instrument, rules },
    admission: {
      newRiskSupported: unknown.length === 0 && status === 'TRADING',
      unsupportedFields: unknown,
      nativeConstraints: constraints,
    },
  });
}
export function exchangeTimestamp(raw: unknown, receivedAt: number): number {
  const t = integer(raw);
  if (t > receivedAt + 1000) return invalid();
  return t;
}
const unavailable = Object.freeze({
  state: 'UNAVAILABLE' as const,
  reason: 'NOT_PROVIDED' as const,
});
const available = (raw: unknown) => ({ state: 'AVAILABLE' as const, value: decimal(raw) });
const price = (raw: unknown) =>
  raw === undefined || raw === '' || decimal(raw) === '0'
    ? unavailable
    : { state: 'AVAILABLE' as const, value: positive(raw) };
export function normalizeTicker(
  raw: unknown,
  r: InstrumentRecord,
  exchangeTime: number,
  receivedAt: number,
) {
  const x = object(raw),
    t = exchangeTimestamp(exchangeTime, receivedAt);
  const bid = x.bid === undefined ? unavailable : price(array(x.bid, 2)[0]),
    ask = x.ask === undefined ? unavailable : price(array(x.ask, 2)[0]);
  return immutable(
    tickerSchema.parse({
      scope: r.instrument.scope,
      instrumentId: r.instrument.id,
      exchangeTime: t,
      receivedAt,
      last: price(x.close),
      bid,
      ask,
      baseVolume: x.amount === undefined ? unavailable : available(x.amount),
      quoteVolume:
        r.instrument.scope.market === 'SPOT' && x.vol !== undefined
          ? available(x.vol)
          : x.trade_turnover === undefined
            ? unavailable
            : available(x.trade_turnover),
      change: unavailable,
      freshness: receivedAt - t <= 5000 ? 'FRESH' : 'STALE',
    }),
  );
}
export function normalizeBook(
  raw: unknown,
  r: InstrumentRecord,
  depth: number,
  receivedAt: number,
) {
  if (depth < 1 || depth > 150) throw new HtxProtocolError('UNSUPPORTED');
  const x = object(raw),
    t = exchangeTimestamp(x.ts, receivedAt);
  const levels = (raw: unknown) =>
    array(raw, 150).map((row) => {
      const a = array(row, 2);
      if (a.length !== 2) return invalid();
      return {
        price: positive(a[0]),
        quantity: r.instrument.contract
          ? positive(decimalMultiply(decimal(a[1]), r.instrument.contract.size))
          : positive(a[1]),
      };
    });
  const full = orderBookSchema.parse({
    scope: r.instrument.scope,
    instrumentId: r.instrument.id,
    exchangeTime: t,
    receivedAt,
    kind: 'SNAPSHOT',
    bids: levels(x.bids),
    asks: levels(x.asks),
    sourceSequence: x.version === undefined ? null : id(x.version),
    previousSequence: null,
    checksum: null,
    snapshotVersion: randomUUID(),
    stale: receivedAt - t > 5000,
  });
  return immutable({ ...full, bids: full.bids.slice(0, depth), asks: full.asks.slice(0, depth) });
}
export function normalizeCandle(
  raw: unknown,
  r: InstrumentRecord,
  timeframe: string,
  receivedAt: number,
) {
  nativeInterval(timeframe);
  const x = object(raw),
    tf = timeframe as keyof typeof timeframeMs,
    openTime = integer(x.id) * 1000,
    closeTime = openTime + timeframeMs[tf];
  if (openTime > receivedAt + 1000) return invalid();
  const complete = closeTime <= receivedAt;
  return immutable(
    candleSchema.parse({
      scope: r.instrument.scope,
      instrumentId: r.instrument.id,
      timeframe: tf,
      openTime,
      closeTime,
      open: positive(x.open),
      high: positive(x.high),
      low: positive(x.low),
      close: positive(x.close),
      baseVolume: decimal(x.amount),
      quoteVolume:
        r.instrument.scope.market === 'SPOT'
          ? available(x.vol)
          : x.trade_turnover === undefined
            ? unavailable
            : available(x.trade_turnover),
      numberOfTrades: x.count === undefined ? null : integer(x.count),
      complete,
      quality: complete ? 'COMPLETE' : 'PARTIAL',
      revision: 0,
      provenance: 'EXCHANGE',
    }),
  );
}
export function normalizeTrade(raw: unknown, r: InstrumentRecord, receivedAt: number) {
  const x = object(raw);
  if (!['buy', 'sell'].includes(String(x.direction))) return invalid();
  return immutable(
    tradeTickSchema.parse({
      scope: r.instrument.scope,
      instrumentId: r.instrument.id,
      exchangeTime: exchangeTimestamp(x.ts, receivedAt),
      receivedAt,
      tradeId: id(x.tradeId ?? x.id),
      identityScope: r.instrument.id,
      price: positive(x.price),
      quantity: positive(x.amount),
      quantityUnit: r.instrument.contract ? 'CONTRACTS' : 'BASE',
      side: x.direction === 'buy' ? 'BUY' : 'SELL',
      sourceSequence: null,
    }),
  );
}
