import {
  accountInfoSchema,
  accountSnapshotSchema,
  algoOrderSchema,
  balanceSchema,
  candleSchema,
  fillSchema,
  instrumentSchema,
  newOrderSchema,
  orderBookSchema,
  orderSchema,
  positionSchema,
  tickerSchema,
  tradeTickSchema,
  tradingRulesSchema,
} from '../../src/domain.js';
import {
  authorizationSchema,
  operations,
  type Operation,
  type OperationInput,
  type OperationOutput,
} from '../../src/operations.js';
import {
  accountScopeSchema,
  adapterProfileSchema,
  capabilityRecordSchema,
  featureSchema,
  marketScopeSchema,
} from '../../src/scope.js';

export const NOW = Date.parse('2026-09-01T12:00:00.000Z');
export const profile = adapterProfileSchema.parse({
  exchange: 'BINANCE',
  region: 'global',
  market: 'SPOT',
  environment: 'TESTNET',
  accountMode: 'SPOT',
  profileVersion: 'v1',
  endpointProfileId: 'test-reference',
});
export const scope = marketScopeSchema.parse({
  exchange: profile.exchange,
  region: profile.region,
  market: profile.market,
  environment: profile.environment,
});
export const account = accountScopeSchema.parse({
  tenantId: '10000000-0000-4000-8000-000000000001',
  connectionId: '20000000-0000-4000-8000-000000000001',
  externalAccountId: 'test-account-1',
});
export const instrument = instrumentSchema.parse({
  id: 'BTCUSDT',
  scope,
  exchangeSymbol: 'BTCUSDT',
  displaySymbol: 'BTC/USDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  settlementAsset: null,
  contract: null,
  expiryAt: null,
  status: 'TRADING',
  metadataVersion: 'v1',
});
export const rules = tradingRulesSchema.parse({
  instrumentId: instrument.id,
  scope,
  version: 'v1',
  effectiveAt: NOW - 1000,
  expiresAt: NOW + 60_000,
  tickSize: '0.05',
  stepSize: '0.001',
  minQuantity: '0.001',
  maxQuantity: '100',
  marketMinQuantity: '0.001',
  marketMaxQuantity: '50',
  minNotional: '5',
  maxNotional: '100000000',
  minPrice: '0.05',
  maxPrice: '1000000',
  quantityUnit: 'BASE',
  pricePrecision: 2,
  quantityPrecision: 3,
  orderTypes: ['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT'],
  timeInForce: ['GTC', 'IOC', 'FOK', 'POST_ONLY'],
  leverageTiers: [],
});
export const capabilities = featureSchema.options.map((feature) =>
  capabilityRecordSchema.parse({
    profile,
    feature,
    support: 'SUPPORTED',
    implementation: 'NATIVE',
    constraints: {},
    evidenceUrl: 'https://example.test/contract',
    checkedAt: NOW - 1000,
    expiresAt: NOW + 60_000,
    adapterVersion: 'v1',
  }),
);

const publicIdentity = { scope, instrumentId: instrument.id };
const privateIdentity = { account, ...publicIdentity };
const clocks = { exchangeTime: NOW - 10, receivedAt: NOW };
const unavailable = { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' } as const;
const available = (value: string) => ({ state: 'AVAILABLE' as const, value });

export const ticker = tickerSchema.parse({
  ...publicIdentity,
  ...clocks,
  last: available('30000.05'),
  bid: available('30000'),
  ask: available('30000.1'),
  baseVolume: available('10'),
  quoteVolume: available('300000'),
  change: available('-10.05'),
  freshness: 'FRESH',
});
export const trade = tradeTickSchema.parse({
  ...publicIdentity,
  ...clocks,
  tradeId: 'trade-1',
  identityScope: 'BTCUSDT-trades',
  price: '30000.05',
  quantity: '0.01',
  quantityUnit: 'BASE',
  side: 'BUY',
  sourceSequence: '101',
});
export const candle = candleSchema.parse({
  ...publicIdentity,
  timeframe: '1m',
  openTime: NOW - 60_000,
  closeTime: NOW,
  open: '30000',
  high: '30010',
  low: '29990',
  close: '30000.05',
  baseVolume: '1',
  quoteVolume: available('30000'),
  numberOfTrades: 10,
  complete: true,
  quality: 'COMPLETE',
  revision: 0,
  provenance: 'EXCHANGE',
});
export const book = orderBookSchema.parse({
  ...publicIdentity,
  ...clocks,
  kind: 'SNAPSHOT',
  bids: [{ price: '30000', quantity: '1' }],
  asks: [{ price: '30000.1', quantity: '2' }],
  sourceSequence: '100',
  previousSequence: null,
  checksum: null,
  snapshotVersion: 'snapshot-1',
  stale: false,
});
export const balance = balanceSchema.parse({
  asset: 'USDT',
  free: '10000',
  locked: '10',
  total: '10010',
  availableToTrade: available('10000'),
});
export const balances = accountSnapshotSchema.parse({
  account,
  scope,
  balances: [balance],
  sourceVersion: 'balances-1',
  asOf: NOW - 10,
  receivedAt: NOW,
  freshness: 'FRESH',
});
export const accountInfo = accountInfoSchema.parse({
  account,
  scope,
  accountMode: profile.accountMode,
  permissions: ['READ', 'TRADE'],
  positionMode: 'NOT_APPLICABLE',
  checkedAt: NOW,
});
export const position = positionSchema.parse({
  ...privateIdentity,
  side: 'NET',
  quantity: '0.01',
  quantityUnit: 'BASE',
  entryPrice: available('30000'),
  marginMode: 'CROSS',
  leverage: '1',
  liquidationPrice: unavailable,
  realizedPnl: available('0'),
  unrealizedPnl: available('0.0005'),
  version: 'position-1',
  updatedAt: NOW,
});
export const order = orderSchema.parse({
  ...privateIdentity,
  internalOrderId: '50000000-0000-4000-8000-000000000001',
  intentId: '60000000-0000-4000-8000-000000000001',
  clientOrderId: 'client-order-1',
  exchangeOrderId: 'exchange-order-1',
  side: 'BUY',
  type: 'LIMIT',
  status: 'PARTIALLY_FILLED',
  price: available('30000.05'),
  stopPrice: unavailable,
  quantity: '0.01',
  quantityUnit: 'BASE',
  filledQuantity: '0.005',
  averageFillPrice: available('30000.05'),
  fees: [{ amount: '0.000001', asset: 'BTC', kind: 'TRADING' }],
  createdAt: NOW - 1000,
  updatedAt: NOW,
});
export const fill = fillSchema.parse({
  ...privateIdentity,
  ...clocks,
  fillId: 'fill-1',
  identityScope: 'test-account-1-BTCUSDT-fills',
  internalOrderId: order.internalOrderId,
  exchangeOrderId: order.exchangeOrderId,
  price: '30000.05',
  quantity: '0.005',
  quantityUnit: 'BASE',
  fees: order.fees,
});
export const algo = algoOrderSchema.parse({
  ...privateIdentity,
  internalAlgoId: '70000000-0000-4000-8000-000000000001',
  clientAlgoId: 'client-algo-1',
  exchangeAlgoId: 'exchange-algo-1',
  childOrderIds: [],
  trigger: { source: 'LAST', price: '30010' },
  state: 'ACTIVE',
  updatedAt: NOW,
});
export const newOrder = newOrderSchema.parse({
  instrumentId: instrument.id,
  ruleVersion: rules.version,
  clientOrderId: order.clientOrderId,
  side: 'BUY',
  type: 'LIMIT',
  size: { kind: 'BASE_QUANTITY', value: '0.01', asset: 'BTC' },
  limitPrice: '30000.05',
  trigger: null,
  timeInForce: 'GTC',
  reduceOnly: false,
});

function authorization(index: number) {
  const suffix = String(index).padStart(12, '0');
  return authorizationSchema.parse({
    commandId: `30000000-0000-4000-8000-${suffix}`,
    dispatchAttemptId: `40000000-0000-4000-8000-${suffix}`,
    commandHash: '0'.repeat(64),
    profile,
    account,
    issuedAt: NOW - 1000,
    expiresAt: NOW + 10_000,
  });
}
export const permit = authorization(1);
const cancelPermit = authorization(2);
const batchPermits = [authorization(3), authorization(4)] as const;
const amendPermit = authorization(5);
const leveragePermit = authorization(6);
const modePermit = authorization(7);
const createAlgoPermit = authorization(8);
const cancelAlgoPermit = authorization(9);

function accepted(commandId: string, exchangeId: string | null) {
  return {
    kind: 'ACCEPTED',
    ack: { commandId, status: 'ACKNOWLEDGED', exchangeId, receivedAt: NOW },
  };
}
const instrumentQuery = { instrumentId: instrument.id };
const pageQuery = { limit: 100, cursor: null, queryId: 'query-1' };
const instrumentPageQuery = { ...pageQuery, ...instrumentQuery };
const historyQuery = { ...instrumentPageQuery, from: NOW - 60_000, to: NOW };
const bookQuery = { ...instrumentQuery, depth: 10 };
const locatorQuery = {
  ...instrumentQuery,
  locator: { kind: 'EXCHANGE_ID', id: order.exchangeOrderId },
};
const secondLocator = {
  ...instrumentQuery,
  locator: { kind: 'EXCHANGE_ID', id: 'exchange-order-2' },
};
const algoQuery = { ...instrumentQuery, clientAlgoId: algo.clientAlgoId };
const page = (items: readonly unknown[]) => ({
  items,
  nextCursor: null,
  queryId: pageQuery.queryId,
});

function fixture<K extends Operation>(operation: K, input: unknown, output: unknown) {
  return {
    input: operations[operation].input.parse(input) as OperationInput<K>,
    output: operations[operation].output.parse(output) as OperationOutput<K>,
  };
}

/** Every input and output is parsed through its operation's actual boundary schema. */
export const operationFixtures: {
  [K in Operation]: { input: OperationInput<K>; output: OperationOutput<K> };
} = {
  connect: fixture('connect', {}, { state: 'CONNECTED', checkedAt: NOW }),
  testConnection: fixture(
    'testConnection',
    {},
    {
      authenticated: true,
      canRead: true,
      canTrade: true,
      checkedAt: NOW,
    },
  ),
  getServerTime: fixture('getServerTime', {}, clocks),
  getAccountInfo: fixture('getAccountInfo', {}, accountInfo),
  getBalances: fixture('getBalances', {}, balances),
  getPositions: fixture('getPositions', instrumentPageQuery, page([position])),
  getOpenOrders: fixture('getOpenOrders', instrumentPageQuery, page([order])),
  getOrder: fixture('getOrder', locatorQuery, { kind: 'FOUND', order }),
  getOrderHistory: fixture('getOrderHistory', historyQuery, page([order])),
  getTrades: fixture('getTrades', historyQuery, page([fill])),
  getSymbols: fixture('getSymbols', pageQuery, page([instrument])),
  getSymbolInfo: fixture('getSymbolInfo', instrumentQuery, instrument),
  getTicker: fixture('getTicker', instrumentQuery, ticker),
  getOrderBook: fixture('getOrderBook', bookQuery, book),
  getHistoricalCandles: fixture(
    'getHistoricalCandles',
    { ...historyQuery, timeframe: '1m' },
    page([candle]),
  ),
  subscribeTicker: fixture('subscribeTicker', instrumentQuery, ticker),
  subscribeTrades: fixture('subscribeTrades', instrumentQuery, trade),
  subscribeOrderBook: fixture('subscribeOrderBook', bookQuery, book),
  subscribeCandles: fixture('subscribeCandles', { ...instrumentQuery, timeframe: '1m' }, candle),
  subscribePrivateOrders: fixture('subscribePrivateOrders', instrumentQuery, order),
  subscribePositions: fixture('subscribePositions', instrumentQuery, position),
  subscribeBalances: fixture('subscribeBalances', {}, balances),
  createOrder: fixture(
    'createOrder',
    { authorization: permit, command: newOrder },
    accepted(permit.commandId, order.exchangeOrderId),
  ),
  cancelOrder: fixture(
    'cancelOrder',
    { authorization: cancelPermit, command: locatorQuery },
    accepted(cancelPermit.commandId, order.exchangeOrderId),
  ),
  cancelAllOrders: fixture(
    'cancelAllOrders',
    {
      commands: [
        { authorization: batchPermits[0], command: locatorQuery },
        { authorization: batchPermits[1], command: secondLocator },
      ],
    },
    {
      kind: 'RESULTS',
      outcomes: [
        {
          commandId: batchPermits[0].commandId,
          outcome: accepted(batchPermits[0].commandId, order.exchangeOrderId),
        },
        {
          commandId: batchPermits[1].commandId,
          outcome: accepted(batchPermits[1].commandId, 'exchange-order-2'),
        },
      ],
    },
  ),
  amendOrder: fixture(
    'amendOrder',
    {
      authorization: amendPermit,
      command: {
        semantics: 'IN_PLACE',
        identity: { exchangeOrderId: 'PRESERVED', clientOrderId: 'REPLACED' },
        locator: locatorQuery,
        target: {
          internalOrderId: order.internalOrderId,
          placeIntentId: order.intentId,
          revision: '1',
          observedAt: NOW,
          nativeUpdatedAt: order.updatedAt,
          current: newOrder,
          filledQuantity: order.filledQuantity,
        },
        replacement: { ...newOrder, clientOrderId: 'client-amend-1' },
      },
    },
    accepted(amendPermit.commandId, order.exchangeOrderId),
  ),
  setLeverage: fixture(
    'setLeverage',
    {
      authorization: leveragePermit,
      command: { ...instrumentQuery, leverage: '1' },
    },
    accepted(leveragePermit.commandId, null),
  ),
  changePositionMode: fixture(
    'changePositionMode',
    {
      authorization: modePermit,
      command: { mode: 'ONE_WAY' },
    },
    accepted(modePermit.commandId, null),
  ),
  createAlgoOrder: fixture(
    'createAlgoOrder',
    {
      authorization: createAlgoPermit,
      command: { order: newOrder, clientAlgoId: algo.clientAlgoId, trigger: algo.trigger },
    },
    accepted(createAlgoPermit.commandId, algo.exchangeAlgoId),
  ),
  getAlgoOrder: fixture('getAlgoOrder', algoQuery, algo),
  cancelAlgoOrder: fixture(
    'cancelAlgoOrder',
    {
      authorization: cancelAlgoPermit,
      command: algoQuery,
    },
    accepted(cancelAlgoPermit.commandId, algo.exchangeAlgoId),
  ),
  getAlgoHistory: fixture('getAlgoHistory', { ...historyQuery, to: NOW + 1 }, page([algo])),
  subscribeAlgoOrders: fixture('subscribeAlgoOrders', instrumentQuery, algo),
};
