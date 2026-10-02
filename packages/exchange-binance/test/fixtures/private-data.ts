import type { AccountScope, NewOrder } from '@ctp/exchange-core';
import { parseDecimal } from '@ctp/exchange-core';
import { normalizeExchangeInfo } from '../../src/public-data.js';
import {
  exchangeInfo,
  futuresSymbol,
  spotSymbol,
  FUTURES_SCOPE,
  SPOT_SCOPE,
  NOW,
} from './public-data.js';

// Synthetic protocol examples. No exchange account or credential is embedded here.
export const ACCOUNT: AccountScope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  externalAccountId: 'fixture-account',
};
export const INTERNAL_ORDER_ID = '33333333-3333-4333-8333-333333333333';
export const INTENT_ID = '44444444-4444-4444-8444-444444444444';
export const INTERNAL_ALGO_ID = '55555555-5555-4555-8555-555555555555';
export function privateRecord(futures = false) {
  const item = normalizeExchangeInfo(
    exchangeInfo([futures ? futuresSymbol() : spotSymbol()]),
    futures ? FUTURES_SCOPE : SPOT_SCOPE,
    NOW,
  )[0];
  if (!item) throw new Error('MISSING_FIXTURE');
  return item;
}
export function spotAccount() {
  return {
    accountType: 'SPOT',
    canTrade: true,
    permissions: ['SPOT'],
    updateTime: String(NOW - 10),
    balances: [
      { asset: 'USDT', free: '100.12000000', locked: '2.34000000' },
      { asset: 'BTC', free: '0.00000001', locked: '0.00000000' },
    ],
  };
}
export function futuresBalances() {
  return [
    {
      accountAlias: 'fixture',
      asset: 'USDT',
      balance: '100.12000000',
      crossWalletBalance: '90.12',
      crossUnPnl: '20',
      availableBalance: '110.12',
      maxWithdrawAmount: '90.12',
      marginAvailable: true,
      updateTime: String(NOW - 10),
    },
  ];
}
export function order(futures = false) {
  return {
    symbol: 'BTCUSDT',
    orderId: '9223372036854775807',
    clientOrderId: 'fixture-order-1',
    price: '100.00000000',
    origQty: '0.10000000',
    executedQty: '0.02500000',
    cummulativeQuoteQty: '2.50000000',
    status: 'PARTIALLY_FILLED',
    timeInForce: 'GTC',
    type: 'LIMIT',
    side: 'BUY',
    stopPrice: '0.00000000',
    time: String(NOW - 100),
    updateTime: String(NOW - 10),
    ...(futures
      ? {
          positionSide: 'BOTH',
          avgPrice: '100.00000000',
          cumQuote: '2.50000000',
          reduceOnly: false,
        }
      : {}),
  };
}
export function fill(futures = false) {
  return {
    symbol: 'BTCUSDT',
    id: '9007199254740993',
    orderId: '9223372036854775807',
    price: '100.00000000',
    qty: '0.02500000',
    quoteQty: '2.50000000',
    commission: '0.00001250',
    commissionAsset: 'BTC',
    time: String(NOW - 10),
    isBuyer: true,
    isMaker: false,
    isBestMatch: true,
    ...(futures
      ? { buyer: true, maker: false, positionSide: 'BOTH', side: 'BUY', realizedPnl: '0.0' }
      : {}),
  };
}
export function position() {
  return {
    symbol: 'BTCUSDT',
    positionSide: 'BOTH',
    positionAmt: '-0.02500000',
    entryPrice: '100.00000000',
    breakEvenPrice: '100.00000000',
    markPrice: '99.9',
    unRealizedProfit: '0.00250000',
    liquidationPrice: '0.00000000',
    leverage: '5',
    marginType: 'cross',
    isolatedMargin: '0',
    isolatedWallet: '0',
    updateTime: String(NOW - 10),
  };
}
export function algo() {
  return {
    algoId: '9007199254740993',
    clientAlgoId: 'fixture-algo-1',
    algoType: 'CONDITIONAL',
    orderType: 'STOP_MARKET',
    symbol: 'BTCUSDT',
    side: 'SELL',
    positionSide: 'BOTH',
    timeInForce: 'GTC',
    quantity: '0.025',
    algoStatus: 'NEW',
    actualOrderId: '',
    actualPrice: '0',
    triggerPrice: '99.00000000',
    price: '0',
    workingType: 'MARK_PRICE',
    closePosition: false,
    priceProtect: false,
    reduceOnly: true,
    createTime: String(NOW - 100),
    updateTime: String(NOW - 10),
    triggerTime: '0',
  };
}
export function newOrder(futures = false): NewOrder {
  const record = privateRecord(futures);
  return {
    instrumentId: record.instrument.id,
    ruleVersion: record.rules.version,
    clientOrderId: 'fixture-order-1',
    side: 'BUY',
    type: 'LIMIT',
    size: { kind: 'BASE_QUANTITY', value: parseDecimal('0.1'), asset: 'BTC' },
    limitPrice: parseDecimal('100'),
    trigger: null,
    timeInForce: 'GTC',
    reduceOnly: false,
  };
}
