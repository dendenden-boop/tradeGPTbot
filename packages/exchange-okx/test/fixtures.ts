import type { AccountScope, MarketScope } from '@ctp/exchange-core';
export const now = 1791100000000;
export const account: AccountScope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  externalAccountId: '90071992547409931234',
};
export const scope: MarketScope = {
  exchange: 'OKX',
  region: 'global',
  environment: 'DEMO',
  market: 'SPOT',
};
export const identity = {
  internalOrderId: '33333333-3333-4333-8333-333333333333',
  intentId: '44444444-4444-4444-8444-444444444444',
};
export function nativeInstrument(swap = false): Record<string, unknown> {
  return {
    instId: swap ? 'BTC-USDT-SWAP' : 'BTC-USDT',
    instType: swap ? 'SWAP' : 'SPOT',
    baseCcy: swap ? '' : 'BTC',
    quoteCcy: swap ? '' : 'USDT',
    settleCcy: swap ? 'USDT' : '',
    ctType: swap ? 'linear' : '',
    ctVal: swap ? '0.01' : '',
    ctMult: swap ? '1' : '',
    ctValCcy: swap ? 'BTC' : '',
    tickSz: '0.1',
    lotSz: swap ? '1' : '0.000001',
    minSz: swap ? '1' : '0.00001',
    maxLmtSz: '1000',
    maxMktSz: swap ? '100' : '1000000',
    maxLmtAmt: '10000000',
    maxMktAmt: '1000000',
    state: 'live',
    ruleType: 'normal',
    lever: swap ? '100' : '',
    expTime: '',
    instCategory: '1',
    tradeQuoteCcyList: swap ? [] : ['USDT'],
    initPxLmtPct: '0.05',
    floatPxLmtPct: '0.03',
    maxPxLmtPct: '0.15',
    upcChg: [],
  };
}
export function nativeOrder(swap = false): Record<string, unknown> {
  return {
    instId: swap ? 'BTC-USDT-SWAP' : 'BTC-USDT',
    instType: swap ? 'SWAP' : 'SPOT',
    tdMode: swap ? 'cross' : 'cash',
    posSide: swap ? 'net' : '',
    ordId: '900719925474099312345',
    clOrdId: 'Client1',
    algoId: '',
    algoClOrdId: '',
    side: 'buy',
    ordType: 'market',
    tgtCcy: swap ? '' : 'base_ccy',
    sz: swap ? '2' : '0.01',
    accFillSz: swap ? '2' : '0.01',
    avgPx: '50000',
    px: '',
    state: 'filled',
    cTime: String(now - 100),
    uTime: String(now),
    tradeQuoteCcy: swap ? '' : 'USDT',
    attachAlgoOrds: [],
  };
}
