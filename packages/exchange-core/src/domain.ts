import { z } from 'zod';
import {
  decimalSchema,
  positiveAmountSchema,
  nonNegativeAmountSchema,
  amountDecimalSchema,
  positiveDecimalSchema,
  nonNegativeDecimalSchema,
  decimalCompare,
} from './decimal.js';
import { accountScopeSchema, idSchema, marketScopeSchema, timestampSchema } from './scope.js';

export const assetSchema = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/);
export const orderTypeSchema = z.enum(['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT']);
export const timeInForceSchema = z.enum(['GTC', 'IOC', 'FOK', 'POST_ONLY']);
export const sideSchema = z.enum(['BUY', 'SELL']);
export const quantityUnitSchema = z.enum(['BASE', 'CONTRACTS']);
export const freshnessSchema = z.enum(['FRESH', 'STALE', 'UNAVAILABLE']);
export const timeframeSchema = z.enum(['30s', '1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d']);
export const timeframeMs = Object.freeze({
  '30s': 30_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
});

const unavailableReason = z.enum(['NOT_PROVIDED', 'NO_EXECUTIONS', 'STALE']);
function observed<S extends z.ZodType>(schema: S) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('AVAILABLE'), value: schema }),
    z.strictObject({ state: z.literal('UNAVAILABLE'), reason: unavailableReason }),
  ]);
}
export const observedPriceSchema = observed(positiveAmountSchema);
export const observedAmountSchema = observed(amountDecimalSchema);
/** Balance and PnL observations use the PHASE 2 aggregate NUMERIC envelope (30+18). */
export const observedAggregateSchema = observed(decimalSchema);
export const observedNonNegativeSchema = observed(nonNegativeDecimalSchema);

export const instrumentSchema = z
  .strictObject({
    id: idSchema,
    scope: marketScopeSchema,
    exchangeSymbol: idSchema,
    displaySymbol: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[A-Z0-9._:/-]+$/),
    baseAsset: assetSchema,
    quoteAsset: assetSchema,
    settlementAsset: assetSchema.nullable(),
    contract: z
      .strictObject({
        size: positiveAmountSchema,
        unit: z.enum(['BASE', 'QUOTE']),
        version: idSchema,
      })
      .nullable(),
    expiryAt: timestampSchema.nullable(),
    status: z.enum(['TRADING', 'HALTED', 'DELISTED']),
    metadataVersion: idSchema,
  })
  .superRefine((value, ctx) => {
    const market = value.scope.market;
    if (value.baseAsset === value.quoteAsset)
      ctx.addIssue({ code: 'custom', message: 'INVALID_ASSET_PAIR' });
    if (market === 'SPOT') {
      if (value.contract !== null || value.expiryAt !== null || value.settlementAsset !== null)
        ctx.addIssue({ code: 'custom', message: 'INVALID_SPOT_CONTRACT' });
    } else {
      if (value.contract === null || value.settlementAsset === null)
        ctx.addIssue({ code: 'custom', message: 'MISSING_CONTRACT' });
      if (
        market.startsWith('LINEAR') &&
        (value.settlementAsset !== value.quoteAsset || value.contract?.unit !== 'BASE')
      )
        ctx.addIssue({ code: 'custom', message: 'INVALID_LINEAR_UNITS' });
      if (
        market.startsWith('INVERSE') &&
        (value.settlementAsset !== value.baseAsset || value.contract?.unit !== 'QUOTE')
      )
        ctx.addIssue({ code: 'custom', message: 'INVALID_INVERSE_UNITS' });
      if (market.endsWith('_FUTURE') !== (value.expiryAt !== null))
        ctx.addIssue({ code: 'custom', message: 'INVALID_EXPIRY' });
    }
  });
export type Instrument = z.infer<typeof instrumentSchema>;

const leverageTierSchema = z.strictObject({
  notionalCap: positiveDecimalSchema,
  maxLeverage: positiveAmountSchema,
});
export const tradingRulesSchema = z
  .strictObject({
    instrumentId: idSchema,
    scope: marketScopeSchema,
    version: idSchema,
    effectiveAt: timestampSchema,
    expiresAt: timestampSchema,
    tickSize: positiveAmountSchema,
    stepSize: positiveAmountSchema,
    minQuantity: positiveAmountSchema,
    maxQuantity: positiveAmountSchema,
    marketMinQuantity: positiveAmountSchema,
    marketMaxQuantity: positiveAmountSchema,
    minNotional: nonNegativeAmountSchema,
    maxNotional: positiveDecimalSchema.nullable(),
    minPrice: positiveAmountSchema.nullable(),
    maxPrice: positiveAmountSchema.nullable(),
    quantityUnit: quantityUnitSchema,
    pricePrecision: z.number().int().min(0).max(18),
    quantityPrecision: z.number().int().min(0).max(18),
    orderTypes: z.array(orderTypeSchema).min(1).max(4),
    timeInForce: z.array(timeInForceSchema).min(1).max(4),
    leverageTiers: z.array(leverageTierSchema).max(64),
  })
  .superRefine((v, ctx) => {
    if (
      v.expiresAt <= v.effectiveAt ||
      decimalCompare(v.minQuantity, v.maxQuantity) > 0 ||
      decimalCompare(v.marketMinQuantity, v.marketMaxQuantity) > 0 ||
      (v.maxNotional !== null && decimalCompare(v.minNotional, v.maxNotional) > 0) ||
      (v.minPrice !== null && v.maxPrice !== null && decimalCompare(v.minPrice, v.maxPrice) > 0) ||
      new Set(v.orderTypes).size !== v.orderTypes.length ||
      new Set(v.timeInForce).size !== v.timeInForce.length
    )
      ctx.addIssue({ code: 'custom', message: 'INVALID_RULES' });
    if (
      (v.tickSize.split('.')[1]?.length ?? 0) > v.pricePrecision ||
      (v.stepSize.split('.')[1]?.length ?? 0) > v.quantityPrecision
    )
      ctx.addIssue({ code: 'custom', message: 'INVALID_RULE_PRECISION' });
    let previous = '0';
    for (const tier of v.leverageTiers) {
      if (decimalCompare(tier.notionalCap, decimalSchema.parse(previous)) <= 0)
        ctx.addIssue({ code: 'custom', message: 'INVALID_LEVERAGE_TIERS' });
      previous = tier.notionalCap;
    }
  });
export type TradingRules = z.infer<typeof tradingRulesSchema>;

const publicIdentity = { scope: marketScopeSchema, instrumentId: idSchema };
const clocks = { exchangeTime: timestampSchema, receivedAt: timestampSchema };
export const tickerSchema = z.strictObject({
  ...publicIdentity,
  ...clocks,
  last: observedPriceSchema,
  bid: observedPriceSchema,
  ask: observedPriceSchema,
  baseVolume: observedNonNegativeSchema,
  quoteVolume: observedNonNegativeSchema,
  change: observedAmountSchema,
  freshness: freshnessSchema,
});
export const tradeTickSchema = z
  .strictObject({
    ...publicIdentity,
    ...clocks,
    tradeId: idSchema,
    identityScope: idSchema,
    price: positiveAmountSchema,
    quantity: positiveAmountSchema,
    quantityUnit: quantityUnitSchema,
    side: sideSchema,
    sourceSequence: idSchema.nullable(),
  })
  .refine((v) => v.scope.market !== 'SPOT' || v.quantityUnit === 'BASE', {
    message: 'INVALID_QUANTITY_UNIT',
  });
export const candleSchema = z
  .strictObject({
    ...publicIdentity,
    timeframe: timeframeSchema,
    openTime: timestampSchema,
    closeTime: timestampSchema,
    open: positiveAmountSchema,
    high: positiveAmountSchema,
    low: positiveAmountSchema,
    close: positiveAmountSchema,
    baseVolume: nonNegativeDecimalSchema,
    quoteVolume: observedNonNegativeSchema,
    numberOfTrades: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    complete: z.boolean(),
    quality: z.enum(['COMPLETE', 'PARTIAL', 'GAP']),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    provenance: z.enum(['EXCHANGE', 'AGGREGATED_TRADES']),
  })
  .superRefine((v, ctx) => {
    if (
      v.openTime % timeframeMs[v.timeframe] !== 0 ||
      v.closeTime !== v.openTime + timeframeMs[v.timeframe] ||
      decimalCompare(v.low, v.high) > 0 ||
      decimalCompare(v.low, v.open) > 0 ||
      decimalCompare(v.low, v.close) > 0 ||
      decimalCompare(v.high, v.open) < 0 ||
      decimalCompare(v.high, v.close) < 0 ||
      (v.complete && v.quality !== 'COMPLETE')
    )
      ctx.addIssue({ code: 'custom', message: 'INVALID_CANDLE' });
  });
const bookLevelSchema = z.strictObject({
  price: positiveAmountSchema,
  quantity: nonNegativeAmountSchema,
});
export const orderBookSchema = z
  .strictObject({
    ...publicIdentity,
    ...clocks,
    kind: z.enum(['SNAPSHOT', 'DELTA']),
    bids: z.array(bookLevelSchema).max(1000),
    asks: z.array(bookLevelSchema).max(1000),
    sourceSequence: idSchema.nullable(),
    previousSequence: idSchema.nullable(),
    checksum: idSchema.nullable(),
    snapshotVersion: idSchema,
    stale: z.boolean(),
  })
  .superRefine((v, ctx) => {
    for (const [side, descending] of [
      [v.bids, true],
      [v.asks, false],
    ] as const) {
      for (let i = 0; i < side.length; i++) {
        const current = side[i];
        const previous = side[i - 1];
        if (
          current &&
          ((v.kind === 'SNAPSHOT' && current.quantity === '0') ||
            (previous &&
              (descending
                ? decimalCompare(previous.price, current.price) <= 0
                : decimalCompare(previous.price, current.price) >= 0)))
        )
          ctx.addIssue({ code: 'custom', message: 'INVALID_BOOK_LEVELS' });
      }
    }
    if (
      v.kind === 'SNAPSHOT' &&
      v.bids[0] &&
      v.asks[0] &&
      decimalCompare(v.bids[0].price, v.asks[0].price) >= 0
    )
      ctx.addIssue({ code: 'custom', message: 'CROSSED_BOOK' });
    if (v.kind === 'DELTA' && (v.sourceSequence === null || v.previousSequence === null))
      ctx.addIssue({ code: 'custom', message: 'MISSING_DELTA_SEQUENCE' });
  });

export const balanceSchema = z.strictObject({
  asset: assetSchema,
  free: decimalSchema,
  locked: nonNegativeDecimalSchema,
  total: decimalSchema,
  availableToTrade: observedAggregateSchema,
});
const privateIdentity = { account: accountScopeSchema, scope: marketScopeSchema };
export const accountInfoSchema = z.strictObject({
  ...privateIdentity,
  accountMode: idSchema,
  permissions: z.array(z.enum(['READ', 'TRADE'])).max(2),
  positionMode: z.enum(['ONE_WAY', 'HEDGE', 'NOT_APPLICABLE']),
  checkedAt: timestampSchema,
});
export const accountSnapshotSchema = z
  .strictObject({
    ...privateIdentity,
    balances: z.array(balanceSchema).max(1000),
    sourceVersion: idSchema,
    asOf: timestampSchema,
    receivedAt: timestampSchema,
    freshness: freshnessSchema,
  })
  .refine((v) => new Set(v.balances.map((b) => b.asset)).size === v.balances.length, {
    message: 'DUPLICATE_BALANCE',
  });
export const positionSchema = z
  .strictObject({
    ...privateIdentity,
    instrumentId: idSchema,
    side: z.enum(['LONG', 'SHORT', 'NET']),
    quantity: amountDecimalSchema,
    quantityUnit: quantityUnitSchema,
    entryPrice: observedPriceSchema,
    marginMode: z.enum(['CROSS', 'ISOLATED']),
    leverage: positiveAmountSchema,
    liquidationPrice: observedPriceSchema,
    realizedPnl: observedAggregateSchema,
    unrealizedPnl: observedAggregateSchema,
    version: idSchema,
    updatedAt: timestampSchema,
  })
  .refine((v) => v.side === 'NET' || decimalCompare(v.quantity, decimalSchema.parse('0')) >= 0, {
    message: 'INVALID_POSITION_SIGN',
  })
  .refine((v) => v.scope.market !== 'SPOT' || v.quantityUnit === 'BASE', {
    message: 'INVALID_QUANTITY_UNIT',
  });
export const feeSchema = z.strictObject({
  amount: amountDecimalSchema,
  asset: assetSchema,
  kind: z.enum(['TRADING', 'REBATE', 'FUNDING']),
});
export const orderStatusSchema = z.enum([
  'PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'UNKNOWN',
]);
export const orderSchema = z
  .strictObject({
    ...privateIdentity,
    instrumentId: idSchema,
    internalOrderId: z.uuid(),
    intentId: z.uuid(),
    clientOrderId: idSchema,
    exchangeOrderId: idSchema.nullable(),
    side: sideSchema,
    type: orderTypeSchema,
    status: orderStatusSchema,
    price: observedPriceSchema,
    stopPrice: observedPriceSchema,
    quantity: positiveAmountSchema,
    quantityUnit: quantityUnitSchema,
    filledQuantity: nonNegativeAmountSchema,
    averageFillPrice: observedPriceSchema,
    fees: z.array(feeSchema).max(100),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((v, ctx) => {
    if (
      v.updatedAt < v.createdAt ||
      decimalCompare(v.filledQuantity, v.quantity) > 0 ||
      (v.filledQuantity === '0' && v.averageFillPrice.state !== 'UNAVAILABLE') ||
      (v.filledQuantity !== '0' &&
        v.averageFillPrice.state === 'UNAVAILABLE' &&
        v.averageFillPrice.reason === 'NO_EXECUTIONS') ||
      (v.scope.market === 'SPOT' && v.quantityUnit !== 'BASE') ||
      (v.status === 'FILLED' && decimalCompare(v.filledQuantity, v.quantity) !== 0) ||
      ((v.type === 'LIMIT' || v.type === 'STOP_LIMIT') && v.price.state !== 'AVAILABLE') ||
      (v.type.startsWith('STOP_') && v.stopPrice.state !== 'AVAILABLE')
    )
      ctx.addIssue({ code: 'custom', message: 'INVALID_ORDER' });
  });
export const fillSchema = z
  .strictObject({
    ...privateIdentity,
    ...clocks,
    instrumentId: idSchema,
    fillId: idSchema,
    identityScope: idSchema,
    internalOrderId: z.uuid(),
    exchangeOrderId: idSchema,
    price: positiveAmountSchema,
    quantity: positiveAmountSchema,
    quantityUnit: quantityUnitSchema,
    fees: z.array(feeSchema).max(20),
  })
  .refine((v) => v.scope.market !== 'SPOT' || v.quantityUnit === 'BASE', {
    message: 'INVALID_QUANTITY_UNIT',
  });
export const fundingSchema = z.strictObject({
  ...privateIdentity,
  instrumentId: idSchema,
  fundingId: idSchema,
  identityScope: idSchema,
  amount: amountDecimalSchema,
  asset: assetSchema,
  timestamp: timestampSchema,
});
export const triggerSchema = z.strictObject({
  source: z.enum(['LAST', 'MARK', 'INDEX']),
  price: positiveAmountSchema,
});
export const algoOrderSchema = z.strictObject({
  ...privateIdentity,
  instrumentId: idSchema,
  internalAlgoId: z.uuid(),
  clientAlgoId: idSchema,
  exchangeAlgoId: idSchema.nullable(),
  childOrderIds: z.array(idSchema).max(100),
  trigger: triggerSchema,
  state: z.enum(['PENDING', 'ACTIVE', 'TRIGGERED', 'CANCELED', 'REJECTED', 'UNKNOWN']),
  updatedAt: timestampSchema,
});
export const orderSizeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('BASE_QUANTITY'),
    value: positiveAmountSchema,
    asset: assetSchema,
  }),
  z.strictObject({
    kind: z.literal('QUOTE_BUDGET'),
    value: positiveAmountSchema,
    asset: assetSchema,
  }),
  z.strictObject({
    kind: z.literal('CONTRACTS'),
    value: positiveAmountSchema,
    contractSpecVersion: idSchema,
  }),
]);
export type OrderSize = z.infer<typeof orderSizeSchema>;
export const newOrderSchema = z
  .strictObject({
    instrumentId: idSchema,
    ruleVersion: idSchema,
    clientOrderId: idSchema,
    side: sideSchema,
    type: orderTypeSchema,
    size: orderSizeSchema,
    limitPrice: positiveAmountSchema.nullable(),
    trigger: triggerSchema.nullable(),
    timeInForce: timeInForceSchema.nullable(),
    reduceOnly: z.boolean(),
  })
  .superRefine((v, ctx) => {
    const limit = v.type === 'LIMIT' || v.type === 'STOP_LIMIT';
    if (
      limit !== (v.limitPrice !== null) ||
      limit !== (v.timeInForce !== null) ||
      v.type.startsWith('STOP_') !== (v.trigger !== null) ||
      (v.size.kind === 'QUOTE_BUDGET' && (v.type !== 'MARKET' || v.side !== 'BUY'))
    )
      ctx.addIssue({ code: 'custom', message: 'INVALID_ORDER_COMBINATION' });
  });
export type NewOrder = z.infer<typeof newOrderSchema>;

export const pageCursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u);
export const pageRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(200),
  cursor: pageCursorSchema.nullable(),
  queryId: idSchema,
});
export function pageSchema<S extends z.ZodType>(item: S) {
  return z.strictObject({
    items: z.array(item).max(200),
    nextCursor: pageCursorSchema.nullable(),
    queryId: idSchema,
  });
}
export function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) immutable(nested);
    Object.freeze(value);
  }
  return value;
}
export type Ticker = z.infer<typeof tickerSchema>;
export type TradeTick = z.infer<typeof tradeTickSchema>;
export type Candle = z.infer<typeof candleSchema>;
export type OrderBook = z.infer<typeof orderBookSchema>;
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;
export type Position = z.infer<typeof positionSchema>;
export type Order = z.infer<typeof orderSchema>;
export type Fill = z.infer<typeof fillSchema>;
export type Funding = z.infer<typeof fundingSchema>;
export type AlgoOrder = z.infer<typeof algoOrderSchema>;
export type Balance = z.infer<typeof balanceSchema>;
export type Fee = z.infer<typeof feeSchema>;
export type AccountInfo = z.infer<typeof accountInfoSchema>;
export type ExchangeSymbol = z.infer<typeof idSchema>;
