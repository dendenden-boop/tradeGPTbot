import { describe, expect, it, vi } from 'vitest';
import { parseDecimal } from '@ctp/exchange-core';
import type { NewAlgoOrder } from '@ctp/exchange-core';
import {
  normalizeSpotAccount,
  normalizeFuturesBalances,
  normalizeSpotAccountInfo,
  normalizeFuturesAccountInfo,
  normalizeOrder,
  normalizeFill,
  normalizePositionV2,
  normalizeAlgoOrder,
  serializeOrder,
  serializeAlgoOrder,
  serializeOrderLocator,
} from '../src/private-data.js';
import {
  ACCOUNT,
  INTERNAL_ORDER_ID,
  INTENT_ID,
  INTERNAL_ALGO_ID,
  privateRecord,
  spotAccount,
  futuresBalances,
  order,
  fill,
  position,
  algo,
  newOrder,
} from './fixtures/private-data.js';
import { NOW, SPOT_SCOPE, FUTURES_SCOPE } from './fixtures/public-data.js';

const identities = {
  order: vi.fn(() => ({ internalOrderId: INTERNAL_ORDER_ID, intentId: INTENT_ID })),
  algo: vi.fn(() => ({ internalAlgoId: INTERNAL_ALGO_ID })),
  fill: vi.fn(() => ({ internalOrderId: INTERNAL_ORDER_ID })),
};
const invalid = (fn: () => unknown) => expect(fn).toThrow('INVALID_BINANCE_RESPONSE');
function newAlgo(): NewAlgoOrder {
  const child = newOrder(true);
  return {
    order: { ...child, type: 'LIMIT', trigger: null },
    clientAlgoId: 'fixture-algo-1',
    trigger: { source: 'MARK', price: parseDecimal('101') },
  };
}

describe('Binance private account observations', () => {
  it('adds Spot wallet components exactly without floating point', () => {
    const snapshot = normalizeSpotAccount(spotAccount(), SPOT_SCOPE, ACCOUNT, NOW);
    expect(snapshot.balances[0]).toEqual({
      asset: 'USDT',
      free: '100.12',
      locked: '2.34',
      total: '102.46',
      availableToTrade: { state: 'AVAILABLE', value: '100.12' },
    });
    expect(snapshot.balances[1]?.total).toBe('0.00000001');
    expect(snapshot.asOf).toBe(NOW - 10);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
  it('does not manufacture Spot free/locked for a futures wallet', () => {
    const snapshot = normalizeFuturesBalances(futuresBalances(), FUTURES_SCOPE, ACCOUNT, NOW);
    expect(snapshot.balances[0]).toEqual({
      asset: 'USDT',
      free: null,
      locked: null,
      total: '100.12',
      availableToTrade: { state: 'AVAILABLE', value: '110.12' },
    });
    expect(snapshot.asOf).toBe(NOW - 10);
  });
  it('maps only reported trade permission', () => {
    expect(normalizeSpotAccountInfo(spotAccount(), SPOT_SCOPE, ACCOUNT, NOW).permissions).toEqual([
      'READ',
      'TRADE',
    ]);
    expect(
      normalizeSpotAccountInfo({ ...spotAccount(), canTrade: false }, SPOT_SCOPE, ACCOUNT, NOW)
        .permissions,
    ).toEqual(['READ']);
    expect(
      normalizeFuturesAccountInfo(
        { canTrade: true, multiAssetsMargin: false },
        false,
        FUTURES_SCOPE,
        ACCOUNT,
        NOW,
      ).positionMode,
    ).toBe('ONE_WAY');
  });
  it('rejects hedge and multi asset account modes', () => {
    invalid(() =>
      normalizeFuturesAccountInfo(
        { canTrade: true, multiAssetsMargin: false },
        true,
        FUTURES_SCOPE,
        ACCOUNT,
        NOW,
      ),
    );
    invalid(() =>
      normalizeFuturesAccountInfo(
        { canTrade: true, multiAssetsMargin: true },
        false,
        FUTURES_SCOPE,
        ACCOUNT,
        NOW,
      ),
    );
  });
  it('rejects duplicate assets and wrong account type', () => {
    const raw = spotAccount();
    raw.balances.push({ ...raw.balances[0]! });
    invalid(() => normalizeSpotAccount(raw, SPOT_SCOPE, ACCOUNT, NOW));
    invalid(() =>
      normalizeSpotAccount({ ...spotAccount(), accountType: 'MARGIN' }, SPOT_SCOPE, ACCOUNT, NOW),
    );
  });
  it.each([0.1, '1e3', 'NaN', '01', '-1'])(
    'rejects noncanonical or negative Spot free %s',
    (value) =>
      invalid(() =>
        normalizeSpotAccount(
          { ...spotAccount(), balances: [{ asset: 'USDT', free: value, locked: '0' }] },
          SPOT_SCOPE,
          ACCOUNT,
          NOW,
        ),
      ),
  );
  it('preserves negative futures wallet without inventing a locked amount', () => {
    const raw = futuresBalances();
    raw[0]!.balance = '-2.5';
    raw[0]!.availableBalance = '-2.5';
    expect(normalizeFuturesBalances(raw, FUTURES_SCOPE, ACCOUNT, NOW).balances[0]?.total).toBe(
      '-2.5',
    );
  });
  it('rejects futures values fed into a Spot scope', () =>
    invalid(() => normalizeFuturesBalances(futuresBalances(), SPOT_SCOPE, ACCOUNT, NOW)));
});

describe('Binance private order and fill identity', () => {
  it('preserves exact large IDs and uses only trusted durable UUID mapping', () => {
    const result = normalizeOrder(order(), privateRecord(), ACCOUNT, identities);
    expect(result).toMatchObject({
      exchangeOrderId: '9223372036854775807',
      internalOrderId: INTERNAL_ORDER_ID,
      intentId: INTENT_ID,
      status: 'PARTIALLY_FILLED',
      quantity: '0.1',
      filledQuantity: '0.025',
      averageFillPrice: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      fees: [],
    });
    expect(identities.order).toHaveBeenCalledWith(
      ACCOUNT,
      'BTCUSDT',
      '9223372036854775807',
      'fixture-order-1',
    );
  });
  it('uses reported futures average price without calculating a rounded average', () =>
    expect(
      normalizeOrder(order(true), privateRecord(true), ACCOUNT, identities).averageFillPrice,
    ).toEqual({ state: 'AVAILABLE', value: '100' }));
  it('zero executions have no execution price', () =>
    expect(
      normalizeOrder(
        { ...order(true), status: 'NEW', executedQty: '0', avgPrice: '0' },
        privateRecord(true),
        ACCOUNT,
        identities,
      ).averageFillPrice,
    ).toEqual({ state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' }));
  it.each([
    ['NEW', 'OPEN'],
    ['PENDING_NEW', 'PENDING'],
    ['FILLED', 'FILLED'],
    ['CANCELED', 'CANCELED'],
    ['REJECTED', 'REJECTED'],
    ['EXPIRED', 'EXPIRED'],
    ['EXPIRED_IN_MATCH', 'EXPIRED'],
  ])('maps exchange status %s', (raw, mapped) => {
    const input = { ...order(), status: raw, ...(raw === 'FILLED' ? { executedQty: '0.1' } : {}) };
    expect(normalizeOrder(input, privateRecord(), ACCOUNT, identities).status).toBe(mapped);
  });
  it.each(['9e3', '-1', '001', 'order-id', 9007199254740992])(
    'rejects invalid numeric exchange order id %s',
    (id) =>
      invalid(() =>
        normalizeOrder({ ...order(), orderId: id }, privateRecord(), ACCOUNT, identities),
      ),
  );
  it('rejects cross symbol, invalid identity and overfills', () => {
    invalid(() =>
      normalizeOrder({ ...order(), symbol: 'ETHUSDT' }, privateRecord(), ACCOUNT, identities),
    );
    invalid(() =>
      normalizeOrder(order(), privateRecord(), ACCOUNT, {
        ...identities,
        order: () => ({ internalOrderId: 'not-uuid', intentId: INTENT_ID }),
      }),
    );
    invalid(() =>
      normalizeOrder({ ...order(), executedQty: '0.2' }, privateRecord(), ACCOUNT, identities),
    );
  });
  it('rejects unknown target quantity in quote-budget response', () =>
    invalid(() =>
      normalizeOrder(
        { ...order(), origQty: '0', executedQty: '0', type: 'MARKET', price: '0', status: 'NEW' },
        privateRecord(),
        ACCOUNT,
        identities,
      ),
    ));
  it('maps real commissions and source time exactly', () => {
    const result = normalizeFill(
      fill(),
      privateRecord(),
      ACCOUNT,
      { internalOrderId: INTERNAL_ORDER_ID },
      NOW,
    );
    expect(result).toMatchObject({
      fillId: '9007199254740993',
      exchangeOrderId: '9223372036854775807',
      price: '100',
      quantity: '0.025',
      exchangeTime: NOW - 10,
      receivedAt: NOW,
      fees: [{ amount: '0.0000125', asset: 'BTC', kind: 'TRADING' }],
    });
  });
  it('marks a negative commission as a rebate', () =>
    expect(
      normalizeFill(
        { ...fill(), commission: '-0.00001250' },
        privateRecord(),
        ACCOUNT,
        { internalOrderId: INTERNAL_ORDER_ID },
        NOW,
      ).fees[0]?.kind,
    ).toBe('REBATE'));
  it('rejects futures hedge trade records', () =>
    invalid(() =>
      normalizeFill(
        { ...fill(true), positionSide: 'LONG' },
        privateRecord(true),
        ACCOUNT,
        { internalOrderId: INTERNAL_ORDER_ID },
        NOW,
      ),
    ));
  it.each([0.1, '1e-3', '-0.1'])('rejects invalid fill quantity %s', (qty) =>
    invalid(() =>
      normalizeFill(
        { ...fill(), qty },
        privateRecord(),
        ACCOUNT,
        { internalOrderId: INTERNAL_ORDER_ID },
        NOW,
      ),
    ),
  );
});

describe('Binance positions and native conditional observations', () => {
  it('maps signed ONE_WAY quantities and unavailable prices honestly', () => {
    expect(normalizePositionV2(position(), privateRecord(true), ACCOUNT)).toMatchObject({
      side: 'NET',
      quantity: '-0.025',
      quantityUnit: 'BASE',
      marginMode: 'CROSS',
      leverage: '5',
      entryPrice: { state: 'AVAILABLE', value: '100' },
      liquidationPrice: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      realizedPnl: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      unrealizedPnl: { state: 'AVAILABLE', value: '0.0025' },
    });
  });
  it('handles an explicitly zero position without inventing entry price', () =>
    expect(
      normalizePositionV2(
        { ...position(), positionAmt: '0', entryPrice: '0' },
        privateRecord(true),
        ACCOUNT,
      ).entryPrice.state,
    ).toBe('UNAVAILABLE'));
  it.each([
    { positionSide: 'LONG' },
    { marginType: 'unknown' },
    { leverage: '0' },
    { leverage: 2 },
    { symbol: 'ETHUSDT' },
  ])('rejects incomplete or foreign position %j', (patch) =>
    invalid(() => normalizePositionV2({ ...position(), ...patch }, privateRecord(true), ACCOUNT)),
  );
  it('does not invent missing V3 leverage/margin fields', () => {
    const raw: Record<string, unknown> = position();
    delete raw.leverage;
    delete raw.marginType;
    invalid(() => normalizePositionV2(raw, privateRecord(true), ACCOUNT));
  });
  it('maps native algo IDs and one shared stop trigger', () =>
    expect(normalizeAlgoOrder(algo(), privateRecord(true), ACCOUNT, identities)).toMatchObject({
      exchangeAlgoId: '9007199254740993',
      internalAlgoId: INTERNAL_ALGO_ID,
      state: 'ACTIVE',
      trigger: { source: 'MARK', price: '99' },
      childOrderIds: [],
    }));
  it('retains actual child exchange ID after trigger', () =>
    expect(
      normalizeAlgoOrder(
        {
          ...algo(),
          algoStatus: 'TRIGGERED',
          actualOrderId: '9223372036854775807',
          triggerTime: String(NOW - 20),
        },
        privateRecord(true),
        ACCOUNT,
        identities,
      ).childOrderIds,
    ).toEqual(['9223372036854775807']));
  it.each([
    { orderType: 'TAKE_PROFIT_MARKET' },
    { workingType: 'INDEX_PRICE' },
    { positionSide: 'LONG' },
    { algoStatus: 'SURPRISE' },
    { symbol: 'ETHUSDT' },
  ])('rejects algo semantics outside shared stop contract %j', (patch) =>
    invalid(() =>
      normalizeAlgoOrder({ ...algo(), ...patch }, privateRecord(true), ACCOUNT, identities),
    ),
  );
});

describe('Binance mutation parameter serialization', () => {
  it('serializes exact Spot LIMIT parameters with caller client ID', () =>
    expect(serializeOrder(newOrder(), privateRecord())).toEqual({
      path: '/api/v3/order',
      weight: 1,
      orders: 1,
      params: {
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        newClientOrderId: 'fixture-order-1',
        quantity: '0.1',
        price: '100',
        timeInForce: 'GTC',
        newOrderRespType: 'ACK',
      },
    }));
  it('uses Spot LIMIT_MAKER for post-only', () => {
    const spec = serializeOrder({ ...newOrder(), timeInForce: 'POST_ONLY' }, privateRecord());
    expect(spec.params.type).toBe('LIMIT_MAKER');
    expect(spec.params.timeInForce).toBeUndefined();
  });
  it('serializes ONE_WAY reduce-only and GTX', () =>
    expect(
      serializeOrder(
        { ...newOrder(true), reduceOnly: true, timeInForce: 'POST_ONLY' },
        privateRecord(true),
      ).params,
    ).toMatchObject({ positionSide: 'BOTH', reduceOnly: 'true', timeInForce: 'GTX' }));
  it('serializes market quantities without adding limit parameters', () => {
    const spec = serializeOrder(
      { ...newOrder(), type: 'MARKET', limitPrice: null, timeInForce: null },
      privateRecord(),
    );
    expect(spec.params.price).toBeUndefined();
    expect(spec.params.timeInForce).toBeUndefined();
    expect(spec.params.quantity).toBe('0.1');
  });
  it('does not serialize quote budget when positive target quantity cannot be reconciled', () =>
    expect(() =>
      serializeOrder(
        {
          ...newOrder(),
          type: 'MARKET',
          limitPrice: null,
          timeInForce: null,
          size: { kind: 'QUOTE_BUDGET', value: parseDecimal('10'), asset: 'USDT' },
        },
        privateRecord(),
      ),
    ).toThrow('UNSUPPORTED'));
  it('keeps Spot standalone stops on native ordinary route', () =>
    expect(
      serializeOrder(
        {
          ...newOrder(),
          type: 'STOP_LIMIT',
          trigger: { source: 'LAST', price: parseDecimal('101') },
        },
        privateRecord(),
      ).params,
    ).toMatchObject({ type: 'STOP_LOSS_LIMIT', stopPrice: '101' }));
  it.each(['MARK', 'INDEX'] as const)('rejects unsupported Spot trigger source %s', (source) =>
    expect(() =>
      serializeOrder(
        { ...newOrder(), type: 'STOP_LIMIT', trigger: { source, price: parseDecimal('101') } },
        privateRecord(),
      ),
    ).toThrow('UNSUPPORTED'),
  );
  it('does not confuse futures conditional IDs with regular order IDs', () =>
    expect(() =>
      serializeOrder(
        {
          ...newOrder(true),
          type: 'STOP_LIMIT',
          trigger: { source: 'MARK', price: parseDecimal('101') },
        },
        privateRecord(true),
      ),
    ).toThrow('UNSUPPORTED'));
  it('rejects native algo when requested child clientOrderId cannot be honored', () =>
    expect(() => serializeAlgoOrder(newAlgo(), privateRecord(true))).toThrow('UNSUPPORTED'));
  it('does not silently omit a requested child identity', () =>
    expect(() =>
      serializeAlgoOrder(
        { ...newAlgo(), order: { ...newAlgo().order, clientOrderId: 'exact-child-identity' } },
        privateRecord(true),
      ),
    ).toThrow('UNSUPPORTED'));
  it('does not map generic algo into Spot OCO', () =>
    expect(() =>
      serializeAlgoOrder(
        { ...newAlgo(), order: { ...newAlgo().order, ruleVersion: privateRecord().rules.version } },
        privateRecord(),
      ),
    ).toThrow('UNSUPPORTED'));
  it('rejects nested triggers even when passed through unknown input', () =>
    expect(() =>
      serializeAlgoOrder(
        {
          ...newAlgo(),
          order: {
            ...newAlgo().order,
            type: 'STOP_LIMIT',
            trigger: { source: 'MARK', price: '102' },
          },
        } as unknown as NewAlgoOrder,
        privateRecord(true),
      ),
    ).toThrow('INVALID_REQUEST'));
  it('maps locator without losing large integer bytes', () =>
    expect(
      serializeOrderLocator(privateRecord(), { kind: 'EXCHANGE_ID', id: '9223372036854775807' }),
    ).toEqual({ symbol: 'BTCUSDT', orderId: '9223372036854775807' }));
  it('validates client ID syntax before dispatch', () =>
    expect(() =>
      serializeOrder({ ...newOrder(), clientOrderId: 'not allowed' }, privateRecord()),
    ).toThrow('INVALID_REQUEST'));
  it('never rounds stale-rule commands or foreign assets', () => {
    expect(() => serializeOrder({ ...newOrder(), ruleVersion: 'old' }, privateRecord())).toThrow(
      'STALE_METADATA',
    );
    expect(() =>
      serializeOrder(
        {
          ...newOrder(),
          size: { kind: 'BASE_QUANTITY', asset: 'ETH', value: parseDecimal('0.1') },
        },
        privateRecord(),
      ),
    ).toThrow('INVALID_REQUEST');
  });
});
