import type { Binding, PortfolioEvent, SnapshotEvent, FillEvent } from '../src/domain.js';
export const context = { now: () => 1000 };
export function binding(market: 'SPOT' | 'LINEAR_PERPETUAL' = 'SPOT'): Binding {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    connectionId: '33333333-3333-4333-8333-333333333333',
    externalAccountId: 'native-account',
    mode: 'DEMO',
    walletId: 'primary',
    scope: { exchange: 'BINANCE', region: 'global', market, environment: 'TESTNET' },
  };
}
export function fill(overrides: Partial<FillEvent> = {}): FillEvent {
  return {
    type: 'FILL',
    id: 'f1',
    timestamp: 1000,
    internalOrderId: '44444444-4444-4444-8444-444444444444',
    native: {
      fillId: overrides.id ?? 'f1',
      identityScope: 'native-trades',
      exchangeOrderId: 'native-order',
    },
    instrumentId: 'BTCUSDT',
    metadataVersion: 'metadata1',
    ruleVersion: 'rules1',
    base: 'BTC',
    quote: 'USDT',
    positionSide: 'NET',
    bucket: 'CROSS',
    side: 'BUY',
    quantity: '1',
    price: '100',
    fees: [],
    ...overrides,
  };
}
export function snapshot(overrides: Partial<SnapshotEvent> = {}): SnapshotEvent {
  return {
    type: 'SNAPSHOT',
    id: 'snap1',
    timestamp: 999,
    covered: [],
    proof: 'RECONCILED_HISTORY',
    balances: [
      { asset: 'USDT', total: '1000', free: '1000', locked: '0', available: '1000' },
      { asset: 'BNB', total: '1', free: '1', locked: '0', available: '1' },
      { asset: 'BTC', total: '0', free: '0', locked: '0', available: '0' },
    ],
    positions: [],
    ...overrides,
  };
}
export const isEconomic = (e: PortfolioEvent) => e.type === 'FILL' || e.type === 'FUNDING';
