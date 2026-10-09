import { describe, expect, it } from 'vitest';
import { decimalAdd, parseDecimal } from '@ctp/exchange-core';
import { evaluatePaperOrder, paperModelSchema, preparePaperFrame } from '../src/index.js';
import { fixture, marketFixture, NOW } from './fixtures.js';

describe('Paper model precision and boundaries', () => {
  it.each(['9007199254740993', '-9223372036854775808', '9223372036854775807'])(
    'preserves lossless signed 64-bit seed %s',
    (seed) => {
      const market = marketFixture();
      const frame = preparePaperFrame({ ...market, model: { ...market.model, seed } });
      expect(frame.model.seed).toBe(seed);
    },
  );

  it.each([
    '9223372036854775808',
    '-9223372036854775809',
    '-0',
    '01',
    '1e3',
    1,
    '1\n',
    '1\r\n',
    '9223372036854775807\n',
    '1 ',
  ])('rejects invalid seed %s', (seed) => {
    const f = fixture();
    expect(paperModelSchema.safeParse({ ...f.model, seed }).success).toBe(false);
  });

  it.each(['not-a-rate', 'secret-do-not-echo', '-1', '1e-3', '0.100000000000000001'])(
    'rejects unsupported rates without throwing from schema validation (%s)',
    (takerFeeRate) => {
      const f = fixture();
      expect(paperModelSchema.safeParse({ ...f.model, takerFeeRate }).success).toBe(false);
      expect(() =>
        preparePaperFrame({ ...marketFixture(), model: { ...f.model, takerFeeRate } }),
      ).toThrow('PAPER_EVIDENCE');
    },
  );

  it('supports 300 independent instruments without assigning a shared mutable global PRNG', () => {
    const f = fixture();
    const outcomes = [];
    for (let i = 0; i < 300; i++) {
      const id = `instrument-${i}`;
      const market = {
        ...marketFixture(),
        record: {
          instrument: { ...f.record.instrument, id },
          rules: { ...f.record.rules, instrumentId: id },
        },
        book: { ...f.book, instrumentId: id },
        trade: { ...f.trade, instrumentId: id },
      };
      const input = {
        ...f.execution,
        order: { ...f.execution.order, instrumentId: id },
        frame: preparePaperFrame(market),
      };
      const result = evaluatePaperOrder(input);
      expect(evaluatePaperOrder(JSON.parse(JSON.stringify(input)) as unknown)).toEqual(result);
      outcomes.push(result.fills[0]?.id);
    }
    expect(new Set(outcomes).size).toBe(300);
  });

  it.each(['BINANCE', 'BYBIT', 'OKX', 'HTX'] as const)(
    'uses the common public-data contract for %s without private credentials',
    (exchange) => {
      const f = fixture(),
        scope = { ...f.book.scope, exchange, environment: 'LIVE' as const };
      const market = {
        ...marketFixture(),
        record: {
          instrument: { ...f.record.instrument, scope },
          rules: { ...f.record.rules, scope },
        },
        book: { ...f.book, scope },
        trade: { ...f.trade, scope },
      };
      expect(
        evaluatePaperOrder({ ...f.execution, frame: preparePaperFrame(market) }),
      ).toMatchObject({ status: 'FILLED', quantity: '0.5' });
    },
  );

  it('keeps adjacent native sequences above 2^53 lossless', () => {
    const f = fixture();
    const a = evaluatePaperOrder({ ...f.execution, frame: preparePaperFrame(marketFixture()) });
    const b = evaluatePaperOrder({
      ...f.execution,
      frame: preparePaperFrame({
        ...marketFixture(),
        trade: { ...f.trade, tradeId: '9223372036854775808', sourceSequence: '9007199254740994' },
      }),
    });
    expect(a.fills[0]?.id).not.toBe(b.fills[0]?.id);
    expect(b.frame.trade.sourceSequence).toBe('9007199254740994');
  });

  it('balances each asset delta against execution and quote fee counterentries', () => {
    const f = fixture();
    for (const side of ['BUY', 'SELL'] as const) {
      const result = evaluatePaperOrder({
        ...f.execution,
        order: { ...f.execution.order, side, limitPrice: side === 'BUY' ? '10.5' : '9.5' },
        frame: preparePaperFrame(marketFixture()),
      });
      const fill = result.fills[0]!;
      const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
      expect(add(fill.baseDelta, side === 'BUY' ? '-' + fill.quantity : fill.quantity)).toBe('0');
      expect(
        add(
          add(fill.quoteDelta, side === 'BUY' ? fill.quoteNotional : '-' + fill.quoteNotional),
          fill.quoteFee,
        ),
      ).toBe('0');
    }
  });

  it('rounds sub-quantum fee upward, never silently to zero', () => {
    const f = fixture();
    const result = evaluatePaperOrder({
      ...f.execution,
      frame: preparePaperFrame({
        ...marketFixture(),
        model: { ...f.model, takerFeeRate: '0.000000000000000001' },
      }),
    });
    expect(result.fills[0]?.quoteFee).toBe('0.000000000000000006');
  });

  it('cannot reuse evidence before the trigger watermark after restoring a partial STOP', () => {
    const f = fixture();
    expect(
      evaluatePaperOrder({
        ...f.execution,
        now: NOW + 201,
        triggeredAt: NOW + 201,
        order: {
          ...f.execution.order,
          type: 'STOP_LIMIT',
          trigger: { source: 'LAST', price: '10' },
        },
        frame: preparePaperFrame(marketFixture()),
      }),
    ).toMatchObject({ status: 'WAITING', reason: 'LATENCY', fills: [] });
  });

  it('requires a sticky trigger watermark for a partially executed STOP', () => {
    const f = fixture();
    expect(() =>
      evaluatePaperOrder({
        ...f.execution,
        executedQuantity: '0.1',
        order: {
          ...f.execution.order,
          type: 'STOP_LIMIT',
          trigger: { source: 'LAST', price: '10' },
        },
        frame: preparePaperFrame(marketFixture()),
      }),
    ).toThrow('PAPER_INPUT');
  });

  it('rejects partial FOK state and non-step cumulative execution', () => {
    const f = fixture(),
      frame = preparePaperFrame(marketFixture());
    expect(() =>
      evaluatePaperOrder({
        ...f.execution,
        executedQuantity: '0.1',
        order: { ...f.execution.order, timeInForce: 'FOK' },
        frame,
      }),
    ).toThrow('PAPER_INPUT');
    expect(() => evaluatePaperOrder({ ...f.execution, executedQuantity: '0.01', frame })).toThrow(
      'PAPER_INPUT',
    );
  });

  it('rejects timestamp overflow rather than changing eligibility', () => {
    const f = fixture();
    expect(() =>
      evaluatePaperOrder({
        ...f.execution,
        submittedAt: 8640000000000000,
        frame: preparePaperFrame(marketFixture()),
      }),
    ).toThrow('PAPER_INPUT');
  });

  it('does not silently accept raw credential or caller endpoint fields', () => {
    expect(() =>
      preparePaperFrame({ ...marketFixture(), credentials: { secret: 'not-a-real-secret' } }),
    ).toThrow('PAPER_EVIDENCE');
    expect(() => preparePaperFrame({ ...marketFixture(), url: 'https://example.invalid' })).toThrow(
      'PAPER_EVIDENCE',
    );
  });
});
