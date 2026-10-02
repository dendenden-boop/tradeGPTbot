import { z } from 'zod';
import { positiveAmountSchema } from './decimal.js';
import {
  accountInfoSchema,
  accountSnapshotSchema,
  algoOrderSchema,
  candleSchema,
  fillSchema,
  instrumentSchema,
  newAlgoOrderSchema,
  newOrderSchema,
  orderBookSchema,
  orderSchema,
  pageSchema,
  positionSchema,
  tickerSchema,
  tradeTickSchema,
  timeframeSchema,
} from './domain.js';
import { accountScopeSchema, adapterProfileSchema, idSchema, timestampSchema } from './scope.js';
import { exchangeErrorSchema } from './errors.js';
import type { Feature } from './scope.js';

export const cursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_.-]+$/);
const empty = z.strictObject({});
const instrumentQuery = z.strictObject({ instrumentId: idSchema });
const pageFields = {
  limit: z.number().int().min(1).max(200),
  cursor: cursorSchema.nullable(),
  queryId: idSchema,
};
const pageQuery = z.strictObject(pageFields);
const instrumentPageQuery = z.strictObject({ ...pageFields, instrumentId: idSchema });
const historyQuery = z
  .strictObject({
    ...pageFields,
    instrumentId: idSchema,
    from: timestampSchema,
    to: timestampSchema,
  })
  .refine((v) => v.from <= v.to, { message: 'INVALID_TIME_WINDOW' });
const orderLocator = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('EXCHANGE_ID'), id: idSchema }),
  z.strictObject({ kind: z.literal('CLIENT_ID'), id: idSchema }),
]);
const locatorQuery = z.strictObject({ instrumentId: idSchema, locator: orderLocator });
const algoLocatorQuery = z.strictObject({ instrumentId: idSchema, clientAlgoId: idSchema });
export const authorizationSchema = z
  .strictObject({
    commandId: z.uuid(),
    commandHash: z.string().regex(/^[a-f0-9]{64}$/),
    dispatchAttemptId: z.uuid(),
    profile: adapterProfileSchema,
    account: accountScopeSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .refine((v) => v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 30_000, {
    message: 'INVALID_AUTHORIZATION_WINDOW',
  });
export type Authorization = z.infer<typeof authorizationSchema>;
const ackSchema = z.strictObject({
  commandId: z.uuid(),
  status: z.literal('ACKNOWLEDGED'),
  exchangeId: idSchema.nullable(),
  receivedAt: timestampSchema,
});
export const mutationOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ACCEPTED'), ack: ackSchema }),
  z.strictObject({ kind: z.literal('DEFINITIVELY_REJECTED'), error: exchangeErrorSchema }),
  z.strictObject({ kind: z.literal('UNKNOWN'), error: exchangeErrorSchema }),
]);
export type MutationOutcome = z.infer<typeof mutationOutcomeSchema>;
export const batchOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('RESULTS'),
    outcomes: z
      .array(z.strictObject({ commandId: z.uuid(), outcome: mutationOutcomeSchema }))
      .min(1)
      .max(100),
  }),
  z.strictObject({ kind: z.literal('NOT_SENT'), error: exchangeErrorSchema }),
]);
export type BatchOutcome = z.infer<typeof batchOutcomeSchema>;
const authorized = <S extends z.ZodType>(command: S) =>
  z.strictObject({ authorization: authorizationSchema, command });
const connectionHealth = z.strictObject({
  state: z.literal('CONNECTED'),
  checkedAt: timestampSchema,
});
const connectionReport = z.strictObject({
  authenticated: z.boolean(),
  canRead: z.boolean(),
  canTrade: z.boolean(),
  checkedAt: timestampSchema,
});
const bookQuery = z.strictObject({
  instrumentId: idSchema,
  depth: z.number().int().min(1).max(1000),
});
const candlesQuery = z
  .strictObject({
    ...pageFields,
    instrumentId: idSchema,
    timeframe: timeframeSchema,
    from: timestampSchema,
    to: timestampSchema,
  })
  .refine((v) => v.from <= v.to, { message: 'INVALID_TIME_WINDOW' });
export const orderLookupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('FOUND'), order: orderSchema }),
  z
    .strictObject({
      kind: z.literal('NOT_FOUND_WITH_SCOPE'),
      from: timestampSchema,
      to: timestampSchema,
      queriedIds: z.array(idSchema).min(1).max(2),
    })
    .refine((v) => v.from <= v.to, { message: 'INVALID_LOOKUP_WINDOW' }),
  z.strictObject({
    kind: z.literal('INDETERMINATE'),
    reason: z.enum(['WINDOW_EXPIRED', 'SOURCE_UNAVAILABLE', 'NOT_AUTHORITATIVE']),
  }),
]);

function read<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  feature: Feature | null,
  privateOperation = false,
) {
  return { kind: 'READ' as const, input, output, feature, privateOperation };
}
function stream<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  privateOperation = false,
) {
  return {
    kind: 'STREAM' as const,
    input,
    output,
    feature: (privateOperation ? 'PRIVATE_STREAM' : 'PUBLIC_STREAM') as Feature,
    privateOperation,
  };
}
function mutation<I extends z.ZodType>(input: I, feature: Feature) {
  return {
    kind: 'MUTATION' as const,
    input,
    output: mutationOutcomeSchema,
    feature,
    privateOperation: true,
  };
}
/** Complete PHASE 4 contract catalogue; no implementation of a real exchange protocol. */
export const operations = Object.freeze({
  connect: read(empty, connectionHealth, null),
  testConnection: read(empty, connectionReport, null),
  getServerTime: read(
    empty,
    z.strictObject({ exchangeTime: timestampSchema, receivedAt: timestampSchema }),
    null,
  ),
  getAccountInfo: read(empty, accountInfoSchema, 'ACCOUNT_READ', true),
  getBalances: read(empty, accountSnapshotSchema, 'ACCOUNT_READ', true),
  getPositions: read(instrumentPageQuery, pageSchema(positionSchema), 'ACCOUNT_READ', true),
  getOpenOrders: read(instrumentPageQuery, pageSchema(orderSchema), 'ORDER_READ', true),
  getOrder: read(locatorQuery, orderLookupSchema, 'ORDER_READ', true),
  getOrderHistory: read(historyQuery, pageSchema(orderSchema), 'ORDER_READ', true),
  getTrades: read(historyQuery, pageSchema(fillSchema), 'ORDER_READ', true),
  getSymbols: read(pageQuery, pageSchema(instrumentSchema), 'PUBLIC_READ'),
  getSymbolInfo: read(instrumentQuery, instrumentSchema, 'PUBLIC_READ'),
  getTicker: read(instrumentQuery, tickerSchema, 'PUBLIC_READ'),
  getOrderBook: read(bookQuery, orderBookSchema, 'PUBLIC_READ'),
  getHistoricalCandles: read(candlesQuery, pageSchema(candleSchema), 'HISTORICAL_CANDLES'),
  subscribeTicker: stream(instrumentQuery, tickerSchema),
  subscribeTrades: stream(instrumentQuery, tradeTickSchema),
  subscribeOrderBook: stream(bookQuery, orderBookSchema),
  subscribeCandles: stream(
    z.strictObject({ instrumentId: idSchema, timeframe: timeframeSchema }),
    candleSchema,
  ),
  subscribePrivateOrders: stream(instrumentQuery, orderSchema, true),
  subscribePositions: stream(instrumentQuery, positionSchema, true),
  subscribeBalances: stream(empty, accountSnapshotSchema, true),
  createOrder: mutation(authorized(newOrderSchema), 'MARKET_ORDER'),
  cancelOrder: mutation(authorized(locatorQuery), 'CANCEL_ORDER'),
  cancelAllOrders: {
    kind: 'BATCH' as const,
    input: z.strictObject({ commands: z.array(authorized(locatorQuery)).min(1).max(100) }),
    output: batchOutcomeSchema,
    feature: 'CANCEL_ALL_ORDERS' as const,
    privateOperation: true,
  },
  amendOrder: mutation(
    authorized(z.strictObject({ locator: locatorQuery, replacement: newOrderSchema })),
    'AMEND_ORDER',
  ),
  setLeverage: mutation(
    authorized(z.strictObject({ instrumentId: idSchema, leverage: positiveAmountSchema })),
    'SET_LEVERAGE',
  ),
  changePositionMode: mutation(
    authorized(z.strictObject({ mode: z.enum(['ONE_WAY', 'HEDGE']) })),
    'CHANGE_POSITION_MODE',
  ),
  createAlgoOrder: mutation(authorized(newAlgoOrderSchema), 'ALGO_ORDERS'),
  getAlgoOrder: read(algoLocatorQuery, algoOrderSchema, 'ALGO_ORDERS', true),
  cancelAlgoOrder: mutation(authorized(algoLocatorQuery), 'ALGO_ORDERS'),
  getAlgoHistory: read(historyQuery, pageSchema(algoOrderSchema), 'ALGO_ORDERS', true),
  subscribeAlgoOrders: {
    ...stream(instrumentQuery, algoOrderSchema, true),
    feature: 'ALGO_ORDERS' as const,
  },
});
export type Operation = keyof typeof operations;
export type OperationInput<K extends Operation> = z.infer<(typeof operations)[K]['input']>;
export type OperationOutput<K extends Operation> = z.infer<(typeof operations)[K]['output']>;
export type StreamOperation = {
  [K in Operation]: (typeof operations)[K]['kind'] extends 'STREAM' ? K : never;
}[Operation];
export type MutationOperation = {
  [K in Operation]: (typeof operations)[K]['kind'] extends 'MUTATION' | 'BATCH' ? K : never;
}[Operation];
export type ReadOperation = Exclude<Operation, StreamOperation | MutationOperation>;
