import type { MarketScope } from '@ctp/exchange-core';

export const now = 1_792_000_020_000;
export const scope: MarketScope = {
  exchange: 'BYBIT',
  region: 'global',
  market: 'SPOT',
  environment: 'TESTNET',
};
export function nativeInstrument(linear = false): Record<string, unknown> {
  return {
    symbol: 'BTCUSDT',
    baseCoin: 'BTC',
    quoteCoin: 'USDT',
    status: 'Trading',
    priceFilter: linear
      ? { tickSize: '0.10', minPrice: '0.10', maxPrice: '1000000' }
      : { tickSize: '0.10' },
    lotSizeFilter: linear
      ? {
          qtyStep: '0.001',
          minOrderQty: '0.001',
          maxOrderQty: '100',
          maxMktOrderQty: '10',
          minNotionalValue: '5',
        }
      : {
          basePrecision: '0.000001',
          quotePrecision: '0.000001',
          minOrderAmt: '5',
          maxLimitOrderQty: '100',
          maxMarketOrderQty: '10',
          minOrderQty: '0.00000001',
          maxOrderQty: '999',
          maxOrderAmt: '999999',
          postOnlyMaxLimitOrderSize: '100',
        },
    riskParameters: { priceLimitRatioX: '0.01', priceLimitRatioY: '0.02' },
    ...(linear
      ? {
          contractType: 'LinearPerpetual',
          settleCoin: 'USDT',
          deliveryTime: '0',
          unifiedMarginTrade: true,
          isPreListing: false,
          leverageFilter: { minLeverage: '1', maxLeverage: '100', leverageStep: '0.01' },
        }
      : { marginTrading: 'none', stTag: '0' }),
  };
}
export const account = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  externalAccountId: '90071992547409931234',
};
export function nativeOrder(linear = false): Record<string, unknown> {
  return {
    category: linear ? 'linear' : 'spot',
    symbol: 'BTCUSDT',
    orderId: 'native-order-1',
    orderLinkId: 'client-1',
    side: 'Buy',
    orderType: 'Market',
    orderStatus: 'Filled',
    qty: '0.01',
    cumExecQty: '0.01',
    avgPrice: '50000',
    price: '0',
    triggerPrice: '0',
    positionIdx: 0,
    marketUnit: 'baseCoin',
    isLeverage: '0',
    timeInForce: 'IOC',
    createdTime: String(now - 1000),
    updatedTime: String(now),
    reduceOnly: false,
  };
}
