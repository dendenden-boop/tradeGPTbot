import {
  instrumentSchema,
  newOrderSchema,
  tradingRulesSchema,
  type Instrument,
  type NewOrder,
  type TradingRules,
} from '../../src/domain.js';
import { marketScopeSchema, type MarketScope } from '../../src/scope.js';
import type { InstrumentRecord } from '../../src/registry.js';

export const NOW = 1_800_000_000_000;
export const ACCOUNT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  externalAccountId: '9223372036854775807',
};
export const INTERNAL_ID = '33333333-3333-4333-8333-333333333333';
export const UNAVAILABLE = { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' } as const;
export const PRICE = { state: 'AVAILABLE', value: '10' } as const;

export function instrumentFixture(
  scopeOverrides: Partial<MarketScope> = {},
  overrides: Partial<Instrument> = {},
): Instrument {
  const scope = marketScopeSchema.parse({
    exchange: 'BINANCE',
    region: 'global',
    market: 'SPOT',
    environment: 'TESTNET',
    ...scopeOverrides,
  });
  const derivative = scope.market !== 'SPOT';
  const inverse = scope.market.startsWith('INVERSE');
  return instrumentSchema.parse({
    id: 'btc-usdt',
    scope,
    exchangeSymbol: 'BTCUSDT',
    displaySymbol: 'BTC/USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    settlementAsset: derivative ? (inverse ? 'BTC' : 'USDT') : null,
    contract: derivative
      ? { size: inverse ? '100' : '0.01', unit: inverse ? 'QUOTE' : 'BASE', version: 'contract-v1' }
      : null,
    expiryAt: scope.market.endsWith('_FUTURE') ? NOW + 86_400_000 : null,
    status: 'TRADING',
    metadataVersion: 'metadata-v1',
    ...overrides,
  });
}

export function rulesFixture(
  instrument: Instrument = instrumentFixture(),
  overrides: Partial<TradingRules> = {},
): TradingRules {
  return tradingRulesSchema.parse({
    instrumentId: instrument.id,
    scope: instrument.scope,
    version: 'rules-v1',
    effectiveAt: NOW - 60_000,
    expiresAt: NOW + 60_000,
    tickSize: '0.05',
    stepSize: '0.05',
    minQuantity: '0.1',
    maxQuantity: '10',
    marketMinQuantity: '0.2',
    marketMaxQuantity: '5',
    minNotional: '1',
    maxNotional: '1000',
    minPrice: '0.05',
    maxPrice: '1000',
    quantityUnit: instrument.scope.market === 'SPOT' ? 'BASE' : 'CONTRACTS',
    pricePrecision: 2,
    quantityPrecision: 2,
    orderTypes: ['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT'],
    timeInForce: ['GTC', 'IOC', 'FOK', 'POST_ONLY'],
    leverageTiers: [],
    ...overrides,
  });
}

export function recordFixture(scope: Partial<MarketScope> = {}): InstrumentRecord {
  const instrument = instrumentFixture(scope);
  return { instrument, rules: rulesFixture(instrument) };
}

export function newOrderFixture(
  record: InstrumentRecord = recordFixture(),
  overrides: Partial<NewOrder> = {},
): NewOrder {
  return newOrderSchema.parse({
    instrumentId: record.instrument.id,
    ruleVersion: record.rules.version,
    clientOrderId: 'client-1',
    side: 'BUY',
    type: 'LIMIT',
    size:
      record.rules.quantityUnit === 'BASE'
        ? { kind: 'BASE_QUANTITY', value: '0.5', asset: record.instrument.baseAsset }
        : {
            kind: 'CONTRACTS',
            value: '10',
            contractSpecVersion: record.instrument.contract?.version,
          },
    limitPrice: '10',
    trigger: null,
    timeInForce: 'GTC',
    reduceOnly: false,
    ...overrides,
  });
}

export function normalizedFixtures() {
  const instrument = instrumentFixture();
  const publicIdentity = { scope: instrument.scope, instrumentId: instrument.id };
  const privateIdentity = { ...publicIdentity, account: ACCOUNT };
  const clocks = { exchangeTime: NOW, receivedAt: NOW + 1 };
  const balance = {
    asset: 'BTC',
    free: '1',
    locked: '0.25',
    total: '1.25',
    availableToTrade: { state: 'AVAILABLE', value: '1' },
  };
  const trigger = { source: 'MARK', price: '9' };
  const fee = { amount: '-0.0001', asset: 'BTC', kind: 'REBATE' };
  return {
    instrument,
    rules: rulesFixture(instrument),
    ticker: {
      ...publicIdentity,
      ...clocks,
      last: PRICE,
      bid: { state: 'AVAILABLE', value: '9.95' },
      ask: { state: 'AVAILABLE', value: '10.05' },
      baseVolume: { state: 'AVAILABLE', value: '12' },
      quoteVolume: UNAVAILABLE,
      change: { state: 'AVAILABLE', value: '-0.1' },
      freshness: 'FRESH',
    },
    tradeTick: {
      ...publicIdentity,
      ...clocks,
      tradeId: '9223372036854775807',
      identityScope: 'instrument-day-2027-01-15',
      price: '10',
      quantity: '0.5',
      quantityUnit: 'BASE',
      side: 'SELL',
      sourceSequence: '9007199254740993',
    },
    candle: {
      ...publicIdentity,
      timeframe: '1m',
      openTime: NOW,
      closeTime: NOW + 60_000,
      open: '10',
      high: '11',
      low: '9',
      close: '10.5',
      baseVolume: '0',
      quoteVolume: UNAVAILABLE,
      numberOfTrades: null,
      complete: true,
      quality: 'COMPLETE',
      revision: 0,
      provenance: 'EXCHANGE',
    },
    book: {
      ...publicIdentity,
      ...clocks,
      kind: 'SNAPSHOT',
      bids: [
        { price: '9.95', quantity: '1' },
        { price: '9.9', quantity: '2' },
      ],
      asks: [
        { price: '10.05', quantity: '1' },
        { price: '10.1', quantity: '2' },
      ],
      sourceSequence: '9007199254740993',
      previousSequence: null,
      checksum: null,
      snapshotVersion: 'book-v1',
      stale: false,
    },
    balance,
    accountInfo: {
      account: ACCOUNT,
      scope: instrument.scope,
      accountMode: 'CASH',
      permissions: ['READ'],
      positionMode: 'NOT_APPLICABLE',
      checkedAt: NOW,
    },
    accountSnapshot: {
      account: ACCOUNT,
      scope: instrument.scope,
      balances: [balance],
      sourceVersion: 'account-v1',
      asOf: NOW,
      receivedAt: NOW + 1,
      freshness: 'FRESH',
    },
    position: {
      ...privateIdentity,
      side: 'NET',
      quantity: '-0.5',
      quantityUnit: 'BASE',
      entryPrice: PRICE,
      marginMode: 'CROSS',
      leverage: '1',
      liquidationPrice: UNAVAILABLE,
      realizedPnl: { state: 'AVAILABLE', value: '-0.2' },
      unrealizedPnl: UNAVAILABLE,
      version: 'position-v1',
      updatedAt: NOW,
    },
    fee,
    order: {
      ...privateIdentity,
      internalOrderId: INTERNAL_ID,
      intentId: '44444444-4444-4444-8444-444444444444',
      clientOrderId: 'client-1',
      exchangeOrderId: '9223372036854775807',
      side: 'BUY',
      type: 'LIMIT',
      status: 'OPEN',
      price: PRICE,
      stopPrice: UNAVAILABLE,
      quantity: '1',
      quantityUnit: 'BASE',
      filledQuantity: '0',
      averageFillPrice: { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' },
      fees: [fee],
      createdAt: NOW,
      updatedAt: NOW,
    },
    fill: {
      ...privateIdentity,
      ...clocks,
      fillId: '9223372036854775807',
      identityScope: 'account-instrument',
      internalOrderId: INTERNAL_ID,
      exchangeOrderId: '9223372036854775807',
      price: '10',
      quantity: '0.5',
      quantityUnit: 'BASE',
      fees: [fee],
    },
    funding: {
      ...privateIdentity,
      instrumentId: instrument.id,
      fundingId: 'funding-1',
      identityScope: 'account-instrument',
      amount: '-0.005',
      asset: 'BTC',
      timestamp: NOW,
    },
    trigger,
    algoOrder: {
      ...privateIdentity,
      internalAlgoId: INTERNAL_ID,
      clientAlgoId: 'algo-1',
      exchangeAlgoId: null,
      childOrderIds: [],
      trigger,
      state: 'PENDING',
      updatedAt: NOW,
    },
    newOrder: newOrderFixture(),
    pageRequest: { limit: 100, cursor: null, queryId: 'query-1' },
  };
}
