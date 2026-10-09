import { describe, expect, it } from 'vitest';
import { evaluatePaperOrder, preparePaperFrame } from '../src/model.js';
import { fixture, marketFixture, NOW } from './fixtures.js';

describe('Paper Spot L2 taker execution contract', () => {
  it('caps a fill by both observed depth and actual native volume and charges quote fee', () => {
    const f = fixture();
    const frame = preparePaperFrame(marketFixture());
    const result = evaluatePaperOrder({ ...f.execution, frame });
    expect(result).toMatchObject({
      status: 'FILLED',
      quantity: '0.5',
      triggeredAt: null,
      fills: [
        {
          quantity: '0.5',
          price: '10.05',
          quoteNotional: '5.025',
          quoteFee: '0.005025',
          baseDelta: '0.5',
          quoteDelta: '-5.030025',
        },
      ],
      frame: { volumeUsed: '0.5', asksUsed: ['0.5', '0'], bidsUsed: ['0', '0'] },
    });
  });

  it('shares consumed volume across BUY and SELL orders without replenishing it', () => {
    const f = fixture();
    const first = evaluatePaperOrder({ ...f.execution, frame: preparePaperFrame(marketFixture()) });
    const second = evaluatePaperOrder({
      ...f.execution,
      orderId: '44444444-4444-4444-8444-444444444444',
      order: { ...f.execution.order, side: 'SELL', limitPrice: '9.5' },
      frame: first.frame,
    });
    expect(second).toMatchObject({
      status: 'WAITING',
      quantity: '0',
      fills: [],
      frame: { volumeUsed: '0.5' },
    });
    expect(first.frame.volumeUsed).toBe('0.5');
  });

  it('walks depth conservatively and keeps a GTC partial remainder', () => {
    const f = fixture();
    const frame = preparePaperFrame({ ...marketFixture(), trade: { ...f.trade, quantity: '4' } });
    const result = evaluatePaperOrder({
      ...f.execution,
      order: { ...f.execution.order, size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '2' } },
      frame,
    });
    expect(result).toMatchObject({
      status: 'PARTIALLY_FILLED',
      quantity: '1.5',
      fills: [
        { quantity: '0.5', price: '10.05' },
        { quantity: '1', price: '10.1' },
      ],
    });
  });

  it('never crosses a BUY limit after adverse slippage and tick rounding', () => {
    const f = fixture();
    const frame = preparePaperFrame({
      ...marketFixture(),
      model: { ...f.model, maxSlippageRate: '0.1' },
    });
    const result = evaluatePaperOrder({
      ...f.execution,
      order: { ...f.execution.order, limitPrice: '10.05' },
      frame,
    });
    expect(result).toMatchObject({
      status: 'WAITING',
      fills: [],
      quantity: '0',
      frame: { volumeUsed: '0' },
    });
  });

  it('does not use market evidence from before the modeled latency boundary', () => {
    const f = fixture();
    const frame = preparePaperFrame({
      ...marketFixture(),
      book: { ...f.book, receivedAt: NOW + 99, exchangeTime: NOW + 99 },
    });
    expect(evaluatePaperOrder({ ...f.execution, frame })).toMatchObject({
      status: 'WAITING',
      reason: 'LATENCY',
      fills: [],
    });
  });

  it('FOK has no partial execution or liquidity side effect', () => {
    const f = fixture();
    const frame = preparePaperFrame(marketFixture());
    const result = evaluatePaperOrder({
      ...f.execution,
      order: {
        ...f.execution.order,
        size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '1' },
        timeInForce: 'FOK',
      },
      frame,
    });
    expect(result).toMatchObject({ status: 'EXPIRED', reason: 'FOK', quantity: '0', fills: [] });
    expect(result.frame).toEqual(frame);
  });

  it.each(['IOC', null])('IOC and MARKET expire unfilled remainder (%s)', (timeInForce) => {
    const f = fixture();
    const order = {
      ...f.execution.order,
      size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '1' },
      timeInForce,
      ...(timeInForce === null ? { type: 'MARKET', limitPrice: null } : {}),
    };
    expect(
      evaluatePaperOrder({ ...f.execution, order, frame: preparePaperFrame(marketFixture()) }),
    ).toMatchObject({ status: 'EXPIRED', quantity: '0.5' });
  });

  it('SELL fills debit base and credit quote net of the fee', () => {
    const f = fixture();
    expect(
      evaluatePaperOrder({
        ...f.execution,
        order: { ...f.execution.order, side: 'SELL', limitPrice: '9.5' },
        frame: preparePaperFrame(marketFixture()),
      }),
    ).toMatchObject({
      fills: [{ price: '9.95', baseDelta: '-0.5', quoteDelta: '4.970025', quoteFee: '0.004975' }],
    });
  });

  it('STOP uses a real LAST trade and preserves a triggered watermark across partials', () => {
    const f = fixture();
    const order = {
      ...f.execution.order,
      type: 'STOP_LIMIT',
      trigger: { source: 'LAST', price: '10' },
      size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '1' },
    };
    const first = evaluatePaperOrder({
      ...f.execution,
      order,
      frame: preparePaperFrame(marketFixture()),
    });
    expect(first).toMatchObject({
      triggeredAt: NOW + 200,
      status: 'PARTIALLY_FILLED',
      quantity: '0.5',
    });
    const second = evaluatePaperOrder({
      ...f.execution,
      order,
      executedQuantity: first.quantity,
      triggeredAt: first.triggeredAt,
      frame: first.frame,
    });
    expect(second).toMatchObject({ triggeredAt: NOW + 200, fills: [] });
  });

  it('keeps an untriggered STOP pending without consuming volume', () => {
    const f = fixture();
    expect(
      evaluatePaperOrder({
        ...f.execution,
        order: {
          ...f.execution.order,
          type: 'STOP_LIMIT',
          trigger: { source: 'LAST', price: '11' },
        },
        frame: preparePaperFrame(marketFixture()),
      }),
    ).toMatchObject({
      status: 'WAITING',
      reason: 'TRIGGER',
      quantity: '0',
      frame: { volumeUsed: '0' },
    });
  });

  it('seed, model and evidence replay are deterministic across serialization/restart', () => {
    const f = fixture();
    const market = {
      ...marketFixture(),
      model: { ...f.model, latencyJitterMs: 50, maxSlippageRate: '0.02' },
    };
    const frame = preparePaperFrame(market);
    const input = { ...f.execution, frame };
    const a = evaluatePaperOrder(input);
    const b = evaluatePaperOrder(JSON.parse(JSON.stringify(input)) as unknown);
    expect(a).toEqual(b);
    expect(a.fills.length).toBeGreaterThan(0);
    expect(a.eligibleAfter).toBeGreaterThanOrEqual(NOW + 100);
    expect(a.eligibleAfter).toBeLessThanOrEqual(NOW + 150);
    expect(a.fills[0]?.id).toMatch(/^paper-[a-f0-9]{64}$/);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.frame)).toBe(true);
  });

  it('does not mutate the caller frame or order', () => {
    const f = fixture();
    const frame = preparePaperFrame(marketFixture());
    const input = { ...f.execution, frame };
    const before = JSON.stringify(input);
    evaluatePaperOrder(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('lot-rounded native volume too small for one step cannot invent a fill', () => {
    const f = fixture();
    const frame = preparePaperFrame({
      ...marketFixture(),
      trade: { ...f.trade, quantity: '0.01' },
    });
    expect(evaluatePaperOrder({ ...f.execution, frame })).toMatchObject({
      status: 'WAITING',
      fills: [],
      quantity: '0',
    });
  });

  it.each(['POST_ONLY', 'MARK', 'QUOTE_BUDGET', 'reduceOnly'])(
    'rejects unmodeled semantics (%s)',
    (kind) => {
      const f = fixture();
      let order: unknown = { ...f.execution.order, timeInForce: 'POST_ONLY' };
      if (kind === 'MARK')
        order = {
          ...f.execution.order,
          type: 'STOP_LIMIT',
          trigger: { source: 'MARK', price: '10' },
        };
      if (kind === 'QUOTE_BUDGET')
        order = {
          ...f.execution.order,
          type: 'MARKET',
          limitPrice: null,
          timeInForce: null,
          size: { kind: 'QUOTE_BUDGET', asset: 'USDT', value: '5' },
        };
      if (kind === 'reduceOnly') order = { ...f.execution.order, reduceOnly: true };
      expect(() =>
        evaluatePaperOrder({ ...f.execution, order, frame: preparePaperFrame(marketFixture()) }),
      ).toThrow('PAPER_ORDER_UNSUPPORTED');
    },
  );

  it.each(['stale', 'future', 'scope', 'delta', 'empty', 'missing-sequence', 'stale-rules'])(
    'fails closed on unusable market evidence (%s)',
    (kind) => {
      const f = fixture();
      const market = marketFixture();
      const bad =
        kind === 'stale'
          ? { ...market, book: { ...f.book, receivedAt: NOW - 6000 } }
          : kind === 'future'
            ? { ...market, trade: { ...f.trade, exchangeTime: NOW + 201 } }
            : kind === 'scope'
              ? { ...market, trade: { ...f.trade, scope: { ...f.trade.scope, exchange: 'OKX' } } }
              : kind === 'delta'
                ? { ...market, book: { ...f.book, kind: 'DELTA', previousSequence: '1' } }
                : kind === 'empty'
                  ? { ...market, book: { ...f.book, asks: [] } }
                  : kind === 'missing-sequence'
                    ? { ...market, book: { ...f.book, sourceSequence: null, exchangeTime: null } }
                    : {
                        ...market,
                        record: { ...f.record, rules: { ...f.record.rules, expiresAt: NOW } },
                      };
      expect(() => preparePaperFrame(bad)).toThrow('PAPER_EVIDENCE');
    },
  );

  it('rejects a frame whose consumption exceeds native volume or depth', () => {
    const f = fixture();
    const frame = preparePaperFrame(marketFixture());
    expect(() =>
      evaluatePaperOrder({ ...f.execution, frame: { ...frame, volumeUsed: '1' } }),
    ).toThrow('PAPER_FRAME');
    expect(() =>
      evaluatePaperOrder({ ...f.execution, frame: { ...frame, asksUsed: ['1', '0'] } }),
    ).toThrow('PAPER_FRAME');
  });

  it('requires current rules even after restoring an older frame', () => {
    const f = fixture();
    expect(() =>
      evaluatePaperOrder({
        ...f.execution,
        now: NOW + 60001,
        frame: preparePaperFrame(marketFixture()),
      }),
    ).toThrow('PAPER_EVIDENCE');
  });
});
