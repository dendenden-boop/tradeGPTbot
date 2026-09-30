import { describe, expect, it } from 'vitest';
import {
  accountInfoSchema,
  accountSnapshotSchema,
  algoOrderSchema,
  assetSchema,
  balanceSchema,
  candleSchema,
  feeSchema,
  fillSchema,
  fundingSchema,
  instrumentSchema,
  newOrderSchema,
  observedAmountSchema,
  observedNonNegativeSchema,
  observedPriceSchema,
  orderBookSchema,
  orderSchema,
  orderSizeSchema,
  pageRequestSchema,
  pageSchema,
  positionSchema,
  tickerSchema,
  tradeTickSchema,
  tradingRulesSchema,
  triggerSchema,
  timeframeMs,
} from '../src/domain.js';
import {
  instrumentFixture,
  normalizedFixtures,
  NOW,
  PRICE,
  UNAVAILABLE,
} from './fixtures/domain.js';

const fixture = normalizedFixtures();
const cases = [
  ['instrument', instrumentSchema, fixture.instrument],
  ['rules', tradingRulesSchema, fixture.rules],
  ['ticker', tickerSchema, fixture.ticker],
  ['trade tick', tradeTickSchema, fixture.tradeTick],
  ['candle', candleSchema, fixture.candle],
  ['book', orderBookSchema, fixture.book],
  ['balance', balanceSchema, fixture.balance],
  ['account info', accountInfoSchema, fixture.accountInfo],
  ['account snapshot', accountSnapshotSchema, fixture.accountSnapshot],
  ['position', positionSchema, fixture.position],
  ['fee', feeSchema, fixture.fee],
  ['order', orderSchema, fixture.order],
  ['fill', fillSchema, fixture.fill],
  ['funding', fundingSchema, fixture.funding],
  ['trigger', triggerSchema, fixture.trigger],
  ['algo order', algoOrderSchema, fixture.algoOrder],
  ['new order', newOrderSchema, fixture.newOrder],
  ['page request', pageRequestSchema, fixture.pageRequest],
] as const;

describe('normalized domain contracts', () => {
  it.each(cases)('accepts the complete %s contract without data loss', (_name, schema, input) => {
    expect(schema.parse(input)).toEqual(input);
  });

  it.each(cases)('rejects unknown fields and nonobjects in %s', (_name, schema, input) => {
    expect(
      schema.safeParse({ ...input, transportSecret: 'must not enter normalized data' }).success,
    ).toBe(false);
    for (const invalid of [null, undefined, [], 'raw-response', 1]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each(['BTC\n', 'BTC\r', 'BTC\u2028', 'BTC\u2029', ' btc', 'btc', '', 'A'.repeat(33)])(
    'rejects malformed asset text %#',
    (asset) => {
      expect(assetSchema.safeParse(asset).success).toBe(false);
      expect(balanceSchema.safeParse({ ...fixture.balance, asset }).success).toBe(false);
    },
  );

  it('rejects a trailing newline in display symbols', () => {
    expect(
      instrumentSchema.safeParse({ ...fixture.instrument, displaySymbol: 'BTC/USDT\n' }).success,
    ).toBe(false);
  });

  it.each(['tradeTick', 'fill', 'position', 'order'] as const)(
    'rejects SPOT contract quantities in %s',
    (name) => {
      const schemas = {
        tradeTick: tradeTickSchema,
        fill: fillSchema,
        position: positionSchema,
        order: orderSchema,
      };
      expect(schemas[name].safeParse({ ...fixture[name], quantityUnit: 'CONTRACTS' }).success).toBe(
        false,
      );
    },
  );

  it.each(['NOT_PROVIDED', 'STALE'] as const)(
    'retains unknown partial-fill average with reason %s',
    (reason) => {
      const value = {
        ...fixture.order,
        status: 'PARTIALLY_FILLED',
        filledQuantity: '0.5',
        averageFillPrice: { state: 'UNAVAILABLE', reason },
      };
      expect(orderSchema.parse(value).averageFillPrice).toEqual({ state: 'UNAVAILABLE', reason });
    },
  );

  it('never invents an average of zero or allows NO_EXECUTIONS after a fill', () => {
    expect(
      orderSchema.safeParse({
        ...fixture.order,
        averageFillPrice: { state: 'AVAILABLE', value: '0' },
      }).success,
    ).toBe(false);
    expect(orderSchema.safeParse({ ...fixture.order, filledQuantity: '0.5' }).success).toBe(false);
    expect(orderSchema.safeParse({ ...fixture.order, averageFillPrice: PRICE }).success).toBe(
      false,
    );
  });
});

describe('explicit observations, identifiers and monetary boundaries', () => {
  it('distinguishes unavailable observations from observed zero and signed amounts', () => {
    expect(observedPriceSchema.parse(UNAVAILABLE)).toEqual(UNAVAILABLE);
    expect(observedNonNegativeSchema.parse({ state: 'AVAILABLE', value: '0' })).toEqual({
      state: 'AVAILABLE',
      value: '0',
    });
    expect(observedAmountSchema.parse({ state: 'AVAILABLE', value: '-0.2' }).state).toBe(
      'AVAILABLE',
    );
    for (const input of [
      { state: 'AVAILABLE', value: '0' },
      { state: 'AVAILABLE', value: 10 },
      { state: 'AVAILABLE', value: '10.0' },
      { state: 'AVAILABLE', value: '1e2' },
      { ...UNAVAILABLE, value: '10' },
      { state: 'UNAVAILABLE' },
    ])
      expect(observedPriceSchema.safeParse(input).success).toBe(false);
    expect(observedNonNegativeSchema.safeParse({ state: 'AVAILABLE', value: '-1' }).success).toBe(
      false,
    );
  });

  it('rejects binary floats and noncanonical money throughout nested DTOs', () => {
    expect(
      tickerSchema.safeParse({ ...fixture.ticker, last: { state: 'AVAILABLE', value: 0.1 } })
        .success,
    ).toBe(false);
    expect(orderSchema.safeParse({ ...fixture.order, quantity: 1 }).success).toBe(false);
    expect(
      fillSchema.safeParse({ ...fixture.fill, fees: [{ ...fixture.fee, amount: -0.1 }] }).success,
    ).toBe(false);
    expect(
      accountSnapshotSchema.safeParse({
        ...fixture.accountSnapshot,
        balances: [{ ...fixture.balance, locked: '1.0' }],
      }).success,
    ).toBe(false);
    expect(positionSchema.safeParse({ ...fixture.position, quantity: '1e3' }).success).toBe(false);
    expect(fundingSchema.safeParse({ ...fixture.funding, amount: '-0' }).success).toBe(false);
    expect(
      triggerSchema.safeParse({ ...fixture.trigger, price: '100000000000000000000' }).success,
    ).toBe(false);
  });

  it.each(['1e999999999', 'NaN', '1.0', '0.0000000000000000001', '9'.repeat(31)])(
    'returns a failed parse without throwing from decimal refinements for malformed value %#',
    (value) => {
      const results = [
        tradingRulesSchema.safeParse({ ...fixture.rules, minQuantity: value }),
        candleSchema.safeParse({ ...fixture.candle, high: value }),
        orderBookSchema.safeParse({ ...fixture.book, bids: [{ price: value, quantity: '1' }] }),
        orderSchema.safeParse({ ...fixture.order, filledQuantity: value }),
        positionSchema.safeParse({ ...fixture.position, side: 'LONG', quantity: value }),
      ];
      expect(results.every((result) => !result.success)).toBe(true);
    },
  );

  it('retains opaque IDs and requires the declared identity scope', () => {
    expect(tradeTickSchema.parse(fixture.tradeTick).tradeId).toBe('9223372036854775807');
    expect(tradeTickSchema.parse(fixture.tradeTick).sourceSequence).toBe('9007199254740993');
    expect(fillSchema.parse(fixture.fill).account.externalAccountId).toBe('9223372036854775807');
    for (const identityScope of [undefined, '', 'account\n', 123]) {
      expect(tradeTickSchema.safeParse({ ...fixture.tradeTick, identityScope }).success).toBe(
        false,
      );
      expect(fillSchema.safeParse({ ...fixture.fill, identityScope }).success).toBe(false);
      expect(fundingSchema.safeParse({ ...fixture.funding, identityScope }).success).toBe(false);
    }
    expect(
      fillSchema.safeParse({ ...fixture.fill, fillId: Number('9223372036854775807') }).success,
    ).toBe(false);
    expect(fillSchema.safeParse({ ...fixture.fill, account: undefined }).success).toBe(false);
    expect(
      orderSchema.safeParse({
        ...fixture.order,
        account: { ...fixture.order.account, tenantId: 'wrong' },
      }).success,
    ).toBe(false);
    expect(
      tradeTickSchema.safeParse({
        ...fixture.tradeTick,
        scope: { ...fixture.tradeTick.scope, endpoint: 'https://example.test' },
      }).success,
    ).toBe(false);
  });

  it.each([-1, 0.5, '1800000000000', NaN, Infinity, 8_640_000_000_000_001])(
    'rejects invalid timestamp %# across normalized sources',
    (timestamp) => {
      expect(
        tradeTickSchema.safeParse({ ...fixture.tradeTick, exchangeTime: timestamp }).success,
      ).toBe(false);
      expect(
        accountInfoSchema.safeParse({ ...fixture.accountInfo, checkedAt: timestamp }).success,
      ).toBe(false);
      expect(fundingSchema.safeParse({ ...fixture.funding, timestamp }).success).toBe(false);
    },
  );

  it('rejects duplicate asset balances and invalid position signs', () => {
    expect(
      accountSnapshotSchema.safeParse({
        ...fixture.accountSnapshot,
        balances: [fixture.balance, fixture.balance],
      }).success,
    ).toBe(false);
    expect(positionSchema.parse(fixture.position).quantity).toBe('-0.5');
    for (const side of ['LONG', 'SHORT']) {
      expect(positionSchema.safeParse({ ...fixture.position, side }).success).toBe(false);
      expect(positionSchema.safeParse({ ...fixture.position, side, quantity: '0.5' }).success).toBe(
        true,
      );
    }
  });
});

describe('instrument and trading-rule consistency', () => {
  it.each(['LINEAR_PERPETUAL', 'INVERSE_PERPETUAL', 'LINEAR_FUTURE', 'INVERSE_FUTURE'] as const)(
    'retains explicit contract denomination and expiry for %s',
    (market) => {
      const instrument = instrumentFixture({ market });
      expect(instrumentSchema.parse(instrument)).toEqual(instrument);
      expect(instrument.contract?.unit).toBe(market.startsWith('INVERSE') ? 'QUOTE' : 'BASE');
      expect(instrument.expiryAt !== null).toBe(market.endsWith('_FUTURE'));
    },
  );

  it('rejects impossible spot, inverse and dated-future metadata', () => {
    const inverse = instrumentFixture({ market: 'INVERSE_PERPETUAL' });
    const future = instrumentFixture({ market: 'LINEAR_FUTURE' });
    const invalid = [
      { ...fixture.instrument, baseAsset: 'USDT' },
      { ...fixture.instrument, contract: inverse.contract },
      { ...fixture.instrument, expiryAt: NOW },
      { ...fixture.instrument, settlementAsset: 'BTC' },
      { ...inverse, settlementAsset: 'USDT' },
      { ...inverse, contract: { ...inverse.contract, unit: 'BASE' } },
      { ...inverse, contract: null },
      { ...inverse, expiryAt: NOW },
      { ...future, expiryAt: null },
      { ...future, contract: { ...future.contract, size: '0' } },
    ];
    for (const instrument of invalid)
      expect(instrumentSchema.safeParse(instrument).success).toBe(false);
  });

  it.each([
    { expiresAt: NOW - 60_000 },
    { minQuantity: '11' },
    { marketMinQuantity: '6' },
    { minNotional: '1001' },
    { minPrice: '1001' },
    { pricePrecision: 1 },
    { quantityPrecision: 1 },
    { orderTypes: ['LIMIT', 'LIMIT'] },
    { timeInForce: ['GTC', 'GTC'] },
    {
      leverageTiers: [
        { notionalCap: '100', maxLeverage: '10' },
        { notionalCap: '100', maxLeverage: '5' },
      ],
    },
    {
      leverageTiers: [
        { notionalCap: '100', maxLeverage: '10' },
        { notionalCap: '99', maxLeverage: '5' },
      ],
    },
  ])('rejects contradictory trading rules %#', (patch) => {
    expect(tradingRulesSchema.safeParse({ ...fixture.rules, ...patch }).success).toBe(false);
  });
});

describe('candles and order books', () => {
  it.each(Object.entries(timeframeMs))(
    'requires exact %s interval and open-time alignment',
    (timeframe, milliseconds) => {
      const value = {
        ...fixture.candle,
        timeframe,
        openTime: milliseconds * 2,
        closeTime: milliseconds * 3,
      };
      expect(candleSchema.safeParse(value).success).toBe(true);
      expect(candleSchema.safeParse({ ...value, openTime: value.openTime + 1 }).success).toBe(
        false,
      );
      expect(candleSchema.safeParse({ ...value, closeTime: value.closeTime - 1 }).success).toBe(
        false,
      );
    },
  );

  it.each([
    { high: '8' },
    { low: '12' },
    { open: '12' },
    { close: '8' },
    { complete: true, quality: 'PARTIAL' },
    { complete: true, quality: 'GAP' },
    { timeframe: '2m' },
    { numberOfTrades: Number.MAX_SAFE_INTEGER + 1 },
    { revision: -1 },
  ])('rejects contradictory OHLC or candle metadata %#', (patch) => {
    expect(candleSchema.safeParse({ ...fixture.candle, ...patch }).success).toBe(false);
  });

  it('preserves explicit partial and gap candles without inventing a trade count', () => {
    for (const quality of ['PARTIAL', 'GAP']) {
      expect(
        candleSchema.parse({ ...fixture.candle, complete: false, quality }).numberOfTrades,
      ).toBeNull();
    }
  });

  it('requires sorted unique positive snapshot levels and rejects crossing', () => {
    for (const patch of [
      { bids: [...fixture.book.bids].reverse() },
      { asks: [...fixture.book.asks].reverse() },
      { bids: [fixture.book.bids[0], fixture.book.bids[0]] },
      { bids: [{ price: '9', quantity: '0' }] },
      { asks: [{ price: '9.95', quantity: '1' }] },
      { asks: [{ price: '9.9', quantity: '1' }] },
      { bids: [{ price: '9', quantity: '-1' }] },
    ])
      expect(orderBookSchema.safeParse({ ...fixture.book, ...patch }).success).toBe(false);
  });

  it('permits explicit delta deletions only with a sequence chain', () => {
    const delta = {
      ...fixture.book,
      kind: 'DELTA',
      bids: [{ price: '9.95', quantity: '0' }],
      previousSequence: '9007199254740992',
    };
    expect(orderBookSchema.parse(delta).bids[0]?.quantity).toBe('0');
    expect(orderBookSchema.safeParse({ ...delta, previousSequence: null }).success).toBe(false);
    expect(orderBookSchema.safeParse({ ...delta, sourceSequence: null }).success).toBe(false);
    expect(
      orderBookSchema.safeParse({ ...delta, sourceSequence: Number('9007199254740993') }).success,
    ).toBe(false);
  });

  it('bounds a side at 1000 entries and rejects unknown level fields', () => {
    const bids = Array.from({ length: 1000 }, (_, index) => ({
      price: String(2000 - index),
      quantity: '1',
    }));
    const book = { ...fixture.book, bids, asks: [{ price: '2001', quantity: '1' }] };
    expect(orderBookSchema.safeParse(book).success).toBe(true);
    expect(
      orderBookSchema.safeParse({ ...book, bids: [...bids, { price: '1000', quantity: '1' }] })
        .success,
    ).toBe(false);
    expect(
      orderBookSchema.safeParse({ ...book, bids: [{ price: '1', quantity: '1', raw: 'extra' }] })
        .success,
    ).toBe(false);
  });
});

describe('order commands, fills and pagination', () => {
  it.each([
    { kind: 'BASE_QUANTITY', value: '0.5', asset: 'BTC' },
    { kind: 'QUOTE_BUDGET', value: '50', asset: 'USDT' },
    { kind: 'CONTRACTS', value: '2.5', contractSpecVersion: 'contract-v1' },
  ])('retains explicit order size denomination $kind', (value) => {
    expect(orderSizeSchema.parse(value)).toEqual(value);
    expect(orderSizeSchema.safeParse({ ...value, value: 0.5 }).success).toBe(false);
    expect(orderSizeSchema.safeParse({ ...value, extraUnit: 'BTC' }).success).toBe(false);
  });

  it('requires trigger and limit fields to agree with the order type', () => {
    const command = fixture.newOrder;
    const market = { ...command, type: 'MARKET', limitPrice: null, timeInForce: null };
    expect(newOrderSchema.safeParse(market).success).toBe(true);
    expect(
      newOrderSchema.safeParse({ ...market, type: 'STOP_MARKET', trigger: fixture.trigger })
        .success,
    ).toBe(true);
    expect(
      newOrderSchema.safeParse({ ...command, type: 'STOP_LIMIT', trigger: fixture.trigger })
        .success,
    ).toBe(true);
    for (const patch of [
      { type: 'MARKET' },
      { limitPrice: null },
      { timeInForce: null },
      { type: 'STOP_LIMIT' },
      { trigger: fixture.trigger },
    ])
      expect(newOrderSchema.safeParse({ ...command, ...patch }).success).toBe(false);
    const budget = { ...market, size: { kind: 'QUOTE_BUDGET', value: '5', asset: 'USDT' } };
    expect(newOrderSchema.safeParse(budget).success).toBe(true);
    expect(newOrderSchema.safeParse({ ...budget, side: 'SELL' }).success).toBe(false);
    expect(newOrderSchema.safeParse({ ...command, size: budget.size }).success).toBe(false);
  });

  it('enforces fill conservation, chronology and required price evidence', () => {
    const partial = {
      ...fixture.order,
      status: 'PARTIALLY_FILLED',
      filledQuantity: '0.5',
      averageFillPrice: PRICE,
    };
    expect(orderSchema.safeParse(partial).success).toBe(true);
    expect(orderSchema.safeParse({ ...partial, status: 'FILLED' }).success).toBe(false);
    expect(orderSchema.safeParse({ ...partial, filledQuantity: '1.05' }).success).toBe(false);
    expect(orderSchema.safeParse({ ...partial, updatedAt: NOW - 1 }).success).toBe(false);
    expect(orderSchema.safeParse({ ...partial, price: UNAVAILABLE }).success).toBe(false);
    expect(orderSchema.safeParse({ ...partial, type: 'STOP_LIMIT' }).success).toBe(false);
    expect(
      orderSchema.safeParse({ ...partial, status: 'FILLED', filledQuantity: '1' }).success,
    ).toBe(true);
  });

  it('validates every page item and keeps query/cursor identity opaque', () => {
    const schema = pageSchema(tradeTickSchema);
    const page = { items: [fixture.tradeTick], nextCursor: '9007199254740993', queryId: 'query-1' };
    expect(schema.parse(page).nextCursor).toBe('9007199254740993');
    expect(
      schema.safeParse({ ...page, items: [{ ...fixture.tradeTick, price: 10 }] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...page, items: Array.from({ length: 201 }, () => fixture.tradeTick) })
        .success,
    ).toBe(false);
    expect(schema.safeParse({ ...page, nextCursor: 123 }).success).toBe(false);
    expect(schema.safeParse({ ...page, rawCursor: 'extra' }).success).toBe(false);
    for (const limit of [0, 201, 0.5])
      expect(pageRequestSchema.safeParse({ ...fixture.pageRequest, limit }).success).toBe(false);
  });
});
