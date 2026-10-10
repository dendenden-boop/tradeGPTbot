import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { newOrderSchema } from '@ctp/exchange-core';
import { calculatePaperRiskEnvelope, evaluatePaperOrder, preparePaperFrame } from '../src/index.js';
import { fixture, NOW } from './fixtures.js';

const D = Decimal.clone({ precision: 120 });
function input() {
  const { execution, ...market } = fixture();
  return { ...market, order: execution.order };
}
function command(side: 'BUY' | 'SELL', type: 'LIMIT' | 'MARKET' | 'STOP_LIMIT' | 'STOP_MARKET') {
  return newOrderSchema.parse({
    ...input().order,
    side,
    type,
    limitPrice: type.endsWith('LIMIT') ? (side === 'BUY' ? '10.5' : '9.5') : null,
    timeInForce: type.endsWith('LIMIT') ? 'GTC' : null,
    trigger: type.startsWith('STOP_') ? { source: 'LAST', price: '10' } : null,
  });
}
describe('conservative Paper Risk calculation prerequisite, never authorization', () => {
  it('has a public pure calculation entrypoint', () => {
    expect(calculatePaperRiskEnvelope).toBeTypeOf('function');
  });
  it('covers BUY principal and quote fees using the order lifetime price ceiling', () => {
    expect(calculatePaperRiskEnvelope(input())).toMatchObject({
      kind: 'PAPER_RISK_ENVELOPE_CALCULATION',
      version: 'spot-l2-taker-reserve-v1',
      executionPrice: { minimum: '0.05', maximum: '10.5' },
      quantity: '0.5',
      maxFillCount: '10',
      quoteNotionalBound: '5.25',
      quoteFeeBound: '0.00525',
      debits: [{ asset: 'USDT', amount: '5.25525' }],
    });
  });
  it('keeps SELL base principal and quote fee separate without crediting proceeds', () => {
    expect(
      calculatePaperRiskEnvelope({ ...input(), order: command('SELL', 'LIMIT') }),
    ).toMatchObject({
      executionPrice: { minimum: '9.5', maximum: '1000' },
      quoteNotionalBound: '500',
      quoteFeeBound: '0.5',
      debits: [
        { asset: 'BTC', amount: '0.5' },
        { asset: 'USDT', amount: '0.5' },
      ],
    });
  });
  it('covers per-fill fee rounding which exceeds aggregate commission rounding', () => {
    const f = input();
    const bound = calculatePaperRiskEnvelope({
      ...f,
      model: { ...f.model, takerFeeRate: '0.000000000000000001' },
    });
    expect(bound.quoteFeeBound).toBe('0.00000000000000001');
    expect(
      new D(bound.quoteFeeBound).gt(
        new D('5.25').mul('0.000000000000000001').toDecimalPlaces(18, Decimal.ROUND_CEIL),
      ),
    ).toBe(true);
  });
  const scenarios = (['BUY', 'SELL'] as const).flatMap((side) =>
    (['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT'] as const).flatMap((type) =>
      ['0', '0.001', '0.000000000000000001', '0.1'].map((fee) => ({ side, type, fee })),
    ),
  );
  it.each(scenarios)(
    'dominates actual fragmented calculator debits: $side $type fee=$fee',
    ({ side, type, fee }) => {
      const f = input(),
        order = command(side, type);
      const market = {
        ...f,
        model: { ...f.model, takerFeeRate: fee, participationRate: '1' },
        book: {
          ...f.book,
          asks: Array.from({ length: 10 }, (_, i) => ({
            price: new D('10.05').add(new D('0.05').mul(i)).toFixed(),
            quantity: '0.05',
          })),
          bids: Array.from({ length: 10 }, (_, i) => ({
            price: new D('9.95').sub(new D('0.05').mul(i)).toFixed(),
            quantity: '0.05',
          })),
        },
        trade: { ...f.trade, quantity: '0.5' },
      };
      const bound = calculatePaperRiskEnvelope({ ...market, order });
      const { order: ignored, ...frameInput } = market;
      void ignored;
      const result = evaluatePaperOrder({
        ...fixture().execution,
        order,
        frame: preparePaperFrame(frameInput),
      });
      expect(result.status).toBe('FILLED');
      expect(result.fills).toHaveLength(10);
      const actualFees = result.fills.reduce((sum, fill) => sum.add(fill.quoteFee), new D(0));
      const actualNotional = result.fills.reduce(
        (sum, fill) => sum.add(fill.quoteNotional),
        new D(0),
      );
      expect(actualFees.lte(bound.quoteFeeBound)).toBe(true);
      expect(actualNotional.lte(bound.quoteNotionalBound)).toBe(true);
      for (const fill of result.fills) {
        expect(new D(fill.price).gte(bound.executionPrice.minimum)).toBe(true);
        expect(new D(fill.price).lte(bound.executionPrice.maximum)).toBe(true);
      }
      if (side === 'BUY')
        expect(actualNotional.add(actualFees).lte(bound.debits[0]!.amount)).toBe(true);
      else expect(bound.debits[0]).toEqual({ asset: 'BTC', amount: '0.5' });
    },
  );
  it('covers later GTC fills after the initial best ask rises and actual slippage/tick rounding', () => {
    const f = input(),
      model = { ...f.model, maxSlippageRate: '0.1', seed: '-9223372036854775808' };
    const bound = calculatePaperRiskEnvelope({ ...f, model });
    const later = {
      now: NOW + 400,
      model,
      record: f.record,
      book: {
        ...f.book,
        bids: [{ price: '9.5', quantity: '1' }],
        asks: [{ price: '9.55', quantity: '1' }],
        receivedAt: NOW + 400,
        exchangeTime: NOW + 400,
      },
      trade: { ...f.trade, price: '9.55', receivedAt: NOW + 400, exchangeTime: NOW + 400 },
    };
    const result = evaluatePaperOrder({
      ...fixture().execution,
      now: later.now,
      frame: preparePaperFrame(later),
    });
    expect(result.fills.length).toBeGreaterThan(0);
    expect(new D(result.fills[0]!.price).lte(bound.executionPrice.maximum)).toBe(true);
    const referenceOnly = new D(f.book.asks[0]!.price).mul('0.5').mul('1.001');
    // A later executable price can exceed the initial reference; lifetime ceiling is required.
    const higher = {
      ...later,
      model: { ...model, maxSlippageRate: '0' },
      book: { ...later.book, asks: [{ price: '10.5', quantity: '1' }] },
    };
    const fill = evaluatePaperOrder({
      ...fixture().execution,
      now: higher.now,
      frame: preparePaperFrame(higher),
    }).fills[0]!;
    expect(new D(fill.quoteDelta).abs().gt(referenceOnly)).toBe(true);
    expect(new D(fill.quoteDelta).abs().lte(bound.debits[0]!.amount)).toBe(true);
  });
  it('keeps a 34-digit maximum fill count exact without allocating or iterating fills', () => {
    const f = input(),
      quantum = '0.000000000000000001';
    const record = {
      ...f.record,
      rules: {
        ...f.record.rules,
        tickSize: quantum,
        stepSize: quantum,
        pricePrecision: 18,
        quantityPrecision: 18,
        minPrice: quantum,
        maxPrice: '0.000000000000000002',
        minQuantity: quantum,
        marketMinQuantity: quantum,
        maxQuantity: '10000000000000000',
        marketMaxQuantity: '10000000000000000',
        minNotional: '0',
        maxNotional: null,
      },
    };
    const order = {
      ...command('BUY', 'MARKET'),
      size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '9007199254740993' },
    };
    const bound = calculatePaperRiskEnvelope({
      ...f,
      record,
      order,
      model: { ...f.model, takerFeeRate: '0' },
    });
    expect(bound.maxFillCount).toBe('9007199254740993000000000000000000');
    expect(bound.quoteNotionalBound).toBe('0.018014398509481986');
  });
  it('covers adverse slippage and tick rounding across signed seeds and both sides', () => {
    const f = input();
    for (const side of ['BUY', 'SELL'] as const) {
      for (let seed = -32; seed < 32; seed++) {
        const order = command(side, 'MARKET');
        const market = {
          ...f,
          model: { ...f.model, seed: seed.toString(), maxSlippageRate: '0.1' },
          record: { ...f.record, rules: { ...f.record.rules, maxPrice: '11' } },
          book: {
            ...f.book,
            bids: [{ price: '9.5', quantity: '1' }],
            asks: [{ price: '9.55', quantity: '1' }],
          },
        };
        const bound = calculatePaperRiskEnvelope({ ...market, order });
        const { order: ignored, ...frameInput } = market;
        void ignored;
        const fills = evaluatePaperOrder({
          ...fixture().execution,
          order,
          frame: preparePaperFrame(frameInput),
        }).fills;
        expect(fills).toHaveLength(1);
        for (const fill of fills) {
          expect(new D(fill.price).mod('0.05').isZero()).toBe(true);
          expect(new D(fill.price).lte(bound.executionPrice.maximum)).toBe(true);
          expect(new D(fill.quoteNotional).lte(bound.quoteNotionalBound)).toBe(true);
          expect(new D(fill.quoteFee).lte(bound.quoteFeeBound)).toBe(true);
          if (side === 'BUY')
            expect(new D(fill.quoteDelta).abs().lte(bound.debits[0]!.amount)).toBe(true);
        }
      }
    }
  });
  it('uses the earliest exclusive evidence or metadata deadline', () => {
    const f = input();
    expect(
      calculatePaperRiskEnvelope({
        ...f,
        book: { ...f.book, exchangeTime: NOW - 100 },
      }).validUntil,
    ).toBe(NOW + 4901);
    expect(
      calculatePaperRiskEnvelope({
        ...f,
        record: { ...f.record, rules: { ...f.record.rules, expiresAt: NOW + 201 } },
      }).validUntil,
    ).toBe(NOW + 201);
  });
  it.each(['MARKET', 'STOP_MARKET', 'SELL_LIMIT'])(
    'rejects a missing finite upper execution price (%s)',
    (kind) => {
      const f = input();
      expect(() =>
        calculatePaperRiskEnvelope({
          ...f,
          record: { ...f.record, rules: { ...f.record.rules, maxPrice: null } },
          order:
            kind === 'SELL_LIMIT'
              ? command('SELL', 'LIMIT')
              : command('BUY', kind === 'MARKET' ? 'MARKET' : 'STOP_MARKET'),
        }),
      ).toThrow('PAPER_ENVELOPE_UNBOUNDED');
    },
  );
  it('still bounds BUY LIMIT when venue has no maxPrice', () => {
    const f = input();
    expect(
      calculatePaperRiskEnvelope({
        ...f,
        record: { ...f.record, rules: { ...f.record.rules, maxPrice: null } },
      }).executionPrice.maximum,
    ).toBe('10.5');
  });
  it('rounds venue price bands inward to actual executable ticks', () => {
    const f = input();
    expect(
      calculatePaperRiskEnvelope({
        ...f,
        order: command('BUY', 'MARKET'),
        record: {
          ...f.record,
          rules: { ...f.record.rules, minPrice: '0.051', maxPrice: '10.049' },
        },
      }).executionPrice,
    ).toEqual({ minimum: '0.1', maximum: '10' });
  });
  it('denies a price band with no positive executable tick', () => {
    const f = input();
    expect(() =>
      calculatePaperRiskEnvelope({
        ...f,
        order: command('BUY', 'MARKET'),
        record: { ...f.record, rules: { ...f.record.rules, minPrice: '0.01', maxPrice: '0.02' } },
      }),
    ).toThrow('PAPER_ENVELOPE_UNBOUNDED');
  });
  it('fails closed rather than truncating an amount overflow', () => {
    const f = input();
    expect(() =>
      calculatePaperRiskEnvelope({
        ...f,
        order: {
          ...command('BUY', 'MARKET'),
          size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '99999999999999999999' },
        },
        record: {
          ...f.record,
          rules: {
            ...f.record.rules,
            maxQuantity: '99999999999999999999',
            marketMaxQuantity: '99999999999999999999',
            maxNotional: null,
          },
        },
      }),
    ).toThrow('PAPER_ENVELOPE_RANGE');
  });
  it.each(['stale-book', 'future-trade', 'stale-rules', 'scope', 'identity', 'future-rules'])(
    'rejects evidence (%s)',
    (kind) => {
      const f = input();
      const bad =
        kind === 'stale-book'
          ? { ...f, book: { ...f.book, receivedAt: NOW - 6000 } }
          : kind === 'future-trade'
            ? { ...f, trade: { ...f.trade, exchangeTime: NOW + 201 } }
            : kind === 'stale-rules'
              ? { ...f, record: { ...f.record, rules: { ...f.record.rules, expiresAt: NOW } } }
              : kind === 'future-rules'
                ? {
                    ...f,
                    record: { ...f.record, rules: { ...f.record.rules, effectiveAt: NOW + 201 } },
                  }
                : kind === 'scope'
                  ? { ...f, trade: { ...f.trade, scope: { ...f.trade.scope, exchange: 'OKX' } } }
                  : { ...f, book: { ...f.book, instrumentId: 'other' } };
      expect(() => calculatePaperRiskEnvelope(bad)).toThrow('PAPER_ENVELOPE_EVIDENCE');
    },
  );
  it.each([
    'stale-command',
    'wrong-asset',
    'fractional-lot',
    'POST_ONLY',
    'MARK-trigger',
    'reduce-only',
    'quote-budget',
  ])('rejects an invalid/unsupported command (%s)', (kind) => {
    const f = input();
    const order =
      kind === 'stale-command'
        ? { ...f.order, ruleVersion: 'old-rules' }
        : kind === 'wrong-asset'
          ? { ...f.order, size: { ...f.order.size, asset: 'ETH' } }
          : kind === 'fractional-lot'
            ? { ...f.order, size: { ...f.order.size, value: '0.51' } }
            : kind === 'POST_ONLY'
              ? { ...f.order, timeInForce: 'POST_ONLY' }
              : kind === 'MARK-trigger'
                ? { ...command('BUY', 'STOP_LIMIT'), trigger: { source: 'MARK', price: '10' } }
                : kind === 'reduce-only'
                  ? { ...f.order, reduceOnly: true }
                  : {
                      ...command('BUY', 'MARKET'),
                      size: { kind: 'QUOTE_BUDGET', asset: 'USDT', value: '5' },
                    };
    expect(() => calculatePaperRiskEnvelope({ ...f, order })).toThrow(
      /PAPER_ENVELOPE_(?:ORDER_RULES|UNSUPPORTED)/u,
    );
  });
  it('binds the full current rules/model/command and preserves deterministic restart calculation', () => {
    const f = input(),
      first = calculatePaperRiskEnvelope(f);
    expect(calculatePaperRiskEnvelope(JSON.parse(JSON.stringify(f)))).toEqual(first);
    expect(first.record).toEqual(f.record);
    expect(first.model).toEqual(f.model);
    expect(first.order).toEqual(f.order);
    expect(first.computedAt).toBe(f.now);
    expect(first.validUntil).toBe(NOW + 5201);
    expect(Object.isFrozen(first.debits[0])).toBe(true);
    expect(Object.isFrozen(first.record.rules)).toBe(true);
    expect(first).not.toHaveProperty('grant');
    expect(first).not.toHaveProperty('reservationId');
  });
  it.each(['seed', 'fee', 'rules', 'metadata', 'order'])(
    'does not silently treat a changed %s as the same calculation',
    (kind) => {
      const f = input(),
        before = calculatePaperRiskEnvelope(f);
      const changed =
        kind === 'seed'
          ? { ...f, model: { ...f.model, seed: '4' } }
          : kind === 'fee'
            ? { ...f, model: { ...f.model, takerFeeRate: '0.002' } }
            : kind === 'rules'
              ? {
                  ...f,
                  record: { ...f.record, rules: { ...f.record.rules, version: 'rules-v2' } },
                  order: { ...f.order, ruleVersion: 'rules-v2' },
                }
              : kind === 'metadata'
                ? {
                    ...f,
                    record: {
                      ...f.record,
                      instrument: { ...f.record.instrument, metadataVersion: 'metadata-v2' },
                    },
                  }
                : { ...f, order: { ...f.order, clientOrderId: 'other' } };
      expect(calculatePaperRiskEnvelope(changed)).not.toEqual(before);
    },
  );
  it.each(['grant', 'tenantId', 'credentials', 'endpointUrl', 'executedQuantity'])(
    'rejects additional untrusted %s without disclosing it',
    (key) => {
      expect(() => calculatePaperRiskEnvelope({ ...input(), [key]: 'private-material' })).toThrow(
        'PAPER_ENVELOPE_INPUT',
      );
    },
  );
});
