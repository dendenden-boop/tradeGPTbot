import { describe, expect, it } from 'vitest';
import { parseDecimal } from '@ctp/exchange-core';
import * as candidate from '../src/index.js';
import { fixture, marketFixture, NOW } from './fixtures.js';

function item(index = 1, sequence = String(index)) {
  const { now, ...execution } = fixture().execution;
  void now;
  return {
    ...execution,
    admissionSequence: sequence,
    orderId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    order: { ...execution.order, clientOrderId: `client-${index}` },
  };
}
function input() {
  return {
    now: fixture().now,
    frame: candidate.preparePaperFrame(marketFixture()),
    orders: [item(1), item(2)],
  };
}
function calculate(raw: unknown) {
  if (typeof candidate.calculatePaperCompetition !== 'function')
    throw new Error('PAPER_COMPETITION_MISSING');
  return candidate.calculatePaperCompetition(raw);
}

describe('Pure bounded Paper competition contract', () => {
  it('shares one volume cap in lossless admission order independent of caller ordering', () => {
    const f = input();
    const result = calculate({ ...f, orders: [...f.orders].reverse() });
    expect(result.version).toBe('spot-l2-admission-fifo-v1');
    expect(result.executions.map((r) => [r.orderId, r.quantity])).toEqual([
      [item(1).orderId, '0.5'],
      [item(2).orderId, '0'],
    ]);
    expect(result.frame.volumeUsed).toBe('0.5');
    expect(result).toEqual(calculate(f));
  });

  it('compares sequences above the JavaScript safe integer range without rounding', () => {
    const f = input();
    const result = calculate({
      ...f,
      orders: [item(2, '9007199254740993'), item(1, '9007199254740992')],
    });
    expect(result.executions.map((r) => r.admissionSequence)).toEqual([
      '9007199254740992',
      '9007199254740993',
    ]);
    expect(result.executions[0]?.quantity).toBe('0.5');
  });

  it('uses admission sequence for priority and submitted time only for latency', () => {
    const f = input();
    const first = { ...item(1), submittedAt: NOW + 50 };
    const result = calculate({ ...f, orders: [item(2), first] });
    expect(result.executions[0]).toMatchObject({ orderId: first.orderId, quantity: '0.5' });
  });

  it('shares the total cap across opposite sides', () => {
    const f = input(),
      second = item(2);
    second.order = { ...second.order, side: 'SELL', limitPrice: parseDecimal('9.5') };
    const result = calculate({ ...f, orders: [second, item(1)] });
    expect(result.executions.map((r) => r.quantity)).toEqual(['0.5', '0']);
    expect(result.frame).toMatchObject({ asksUsed: ['0.5', '0'], bidsUsed: ['0', '0'] });
  });

  it('shares individual depth caps even when native volume remains', () => {
    const f = input();
    f.frame = candidate.preparePaperFrame({
      ...marketFixture(),
      trade: { ...fixture().trade, quantity: '4' },
    });
    const orders = [1, 2, 3, 4].map((n) => item(n));
    const result = calculate({ ...f, orders });
    expect(result.executions.map((r) => r.quantity)).toEqual(['0.5', '0.5', '0.5', '0']);
    expect(result.frame).toMatchObject({ volumeUsed: '1.5', asksUsed: ['0.5', '1'] });
  });

  it('retains previously consumed liquidity from the calculation checkpoint', () => {
    const f = input();
    const first = candidate.evaluatePaperOrder({ ...fixture().execution, frame: f.frame });
    const result = calculate({ ...f, frame: first.frame });
    expect(result.executions.every((r) => r.quantity === '0')).toBe(true);
    expect(result.frame).toEqual(first.frame);
  });

  it('failed FOK does not take liquidity from a subsequent eligible order', () => {
    const f = input(),
      first = item(1);
    first.order = {
      ...first.order,
      timeInForce: 'FOK',
      size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: parseDecimal('1') },
    };
    const result = calculate({ ...f, orders: [first, item(2)] });
    expect(result.executions[0]).toMatchObject({ status: 'EXPIRED', reason: 'FOK', quantity: '0' });
    expect(result.executions[1]?.quantity).toBe('0.5');
    expect(result.frame.volumeUsed).toBe('0.5');
  });

  it('successful FOK spends its complete quantity once in the batch', () => {
    const f = input(),
      first = item(1);
    first.order = { ...first.order, timeInForce: 'FOK' };
    const result = calculate({ ...f, orders: [first, item(2)] });
    expect(result.executions[0]).toMatchObject({ status: 'FILLED', quantity: '0.5' });
    expect(result.executions[1]?.quantity).toBe('0');
  });

  it('an earlier order awaiting latency does not consume or block eligible volume', () => {
    const f = input(),
      first = { ...item(1), submittedAt: f.now };
    const result = calculate({ ...f, orders: [first, item(2)] });
    expect(result.executions[0]).toMatchObject({
      status: 'WAITING',
      reason: 'LATENCY',
      quantity: '0',
    });
    expect(result.executions[1]?.quantity).toBe('0.5');
  });

  it('an untriggered STOP leaves liquidity available to the next order', () => {
    const f = input(),
      first = item(1);
    first.order = {
      ...first.order,
      type: 'STOP_LIMIT',
      trigger: { source: 'LAST', price: parseDecimal('11') },
    };
    const result = calculate({ ...f, orders: [first, item(2)] });
    expect(result.executions[0]).toMatchObject({
      reason: 'TRIGGER',
      quantity: '0',
      triggeredAt: null,
    });
    expect(result.executions[1]?.quantity).toBe('0.5');
  });

  it('retains triggered STOP state and adverse seeded fill identities across input permutations', () => {
    const f = input(),
      first = item(1);
    first.order = {
      ...first.order,
      type: 'STOP_LIMIT',
      trigger: { source: 'LAST', price: parseDecimal('10') },
    };
    f.frame = candidate.preparePaperFrame({
      ...marketFixture(),
      model: { ...fixture().model, maxSlippageRate: '0.01' },
    });
    const a = calculate({ ...f, orders: [first, item(2)] });
    const b = calculate({ ...f, orders: [item(2), first] });
    expect(a).toEqual(b);
    expect(a.executions[0]).toMatchObject({ triggeredAt: f.now, quantity: '0.5' });
    expect(a.executions[0]?.fills[0]?.id).toMatch(/^paper-[a-f0-9]{64}$/u);
  });

  it('a completed order consumes no new volume', () => {
    const f = input();
    const result = calculate({ ...f, orders: [{ ...item(1), executedQuantity: '0.5' }, item(2)] });
    expect(result.executions[0]).toMatchObject({ reason: 'COMPLETE', fills: [], quantity: '0' });
    expect(result.executions[1]?.quantity).toBe('0.5');
  });

  it('IOC expires its remainder without changing later admission priority', () => {
    const f = input(),
      first = item(1);
    first.order = {
      ...first.order,
      timeInForce: 'IOC',
      size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: parseDecimal('1') },
    };
    const result = calculate({ ...f, orders: [first, item(2)] });
    expect(result.executions[0]).toMatchObject({ status: 'EXPIRED', quantity: '0.5' });
    expect(result.executions[1]?.quantity).toBe('0');
  });

  it.each(['orderId', 'admissionSequence', 'clientOrderId'])(
    'rejects duplicate immutable identity %s',
    (field) => {
      const f = input(),
        a = item(1),
        b = item(2);
      if (field === 'clientOrderId') b.order = { ...b.order, clientOrderId: a.order.clientOrderId };
      else if (field === 'orderId') {
        a.orderId = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
        b.orderId = a.orderId.toUpperCase();
      } else b.admissionSequence = a.admissionSequence;
      expect(() => calculate({ ...f, orders: [a, b] })).toThrow('PAPER_COMPETITION_IDENTITY');
      expect(f.frame.volumeUsed).toBe('0');
    },
  );

  it.each(['0', '-1', '01', '1.0', '1e2', ' 1', '9223372036854775808', 1, null])(
    'rejects noncanonical or out-of-range sequence %s',
    (admissionSequence) => {
      expect(() => calculate({ ...input(), orders: [{ ...item(1), admissionSequence }] })).toThrow(
        'PAPER_COMPETITION_INPUT',
      );
    },
  );

  it('accepts the maximum signed 64-bit sequence without converting to Number', () => {
    const result = calculate({ ...input(), orders: [item(1, '9223372036854775807')] });
    expect(result.executions[0]?.admissionSequence).toBe('9223372036854775807');
  });

  it('rejects empty batches', () => {
    expect(() => calculate({ ...input(), orders: [] })).toThrow('PAPER_COMPETITION_INPUT');
  });

  it('rejects more than 300 contenders before inspecting their order fields', () => {
    const poison = {
      get order() {
        throw new Error('UNBOUNDED_VALIDATION');
      },
    };
    expect(() =>
      calculate({ ...input(), orders: Array.from({ length: 301 }, () => poison) }),
    ).toThrow('PAPER_COMPETITION_INPUT');
  });

  it('handles 300 competing orders with exactly one shared native volume allowance', () => {
    const f = input(),
      orders = Array.from({ length: 300 }, (_, n) => item(n + 1));
    const result = calculate({ ...f, orders: orders.reverse() });
    expect(result.executions).toHaveLength(300);
    expect(result.executions.filter((r) => r.fills.length > 0)).toHaveLength(1);
    expect(result.frame.volumeUsed).toBe('0.5');
    expect(result.executions.at(-1)?.admissionSequence).toBe('300');
  });

  it.each(['asks', 'bids'])('bounds %s before inspecting more than 1000 depth levels', (side) => {
    const f = input();
    const poison = {
      get price() {
        throw new Error('UNBOUNDED_VALIDATION');
      },
    };
    expect(() =>
      calculate({
        ...f,
        frame: {
          ...f.frame,
          book: { ...f.frame.book, [side]: Array.from({ length: 1001 }, () => poison) },
        },
      }),
    ).toThrow('PAPER_COMPETITION_INPUT');
  });

  it('leaves caller input unchanged and returns only one deeply immutable final frame', () => {
    const f = input(),
      original = structuredClone(f),
      result = calculate(f);
    expect(f).toEqual(original);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.frame.book.asks)).toBe(true);
    expect(Object.isFrozen(result.executions[0]?.fills)).toBe(true);
    expect(result.executions.every((r) => !('frame' in r))).toBe(true);
  });

  it('reconstructs exactly from serialized pure inputs, without claiming durable authorization', () => {
    const f = input();
    expect(calculate(JSON.parse(JSON.stringify(f)))).toEqual(calculate(f));
  });

  it.each(['rule', 'future', 'unsupported', 'executed'])(
    'rejects the whole calculation if a later contender has invalid %s',
    (kind) => {
      const f = input(),
        b = item(2),
        original = structuredClone(f);
      if (kind === 'rule') b.order = { ...b.order, ruleVersion: 'replaced-rules' };
      if (kind === 'future') b.submittedAt = f.now + 1;
      if (kind === 'unsupported') b.order = { ...b.order, timeInForce: 'POST_ONLY' };
      if (kind === 'executed') b.executedQuantity = '1';
      const error =
        kind === 'rule'
          ? 'PAPER_ORDER_RULES'
          : kind === 'unsupported'
            ? 'PAPER_ORDER_UNSUPPORTED'
            : 'PAPER_INPUT';
      expect(() => calculate({ ...f, orders: [item(1), b] })).toThrow(error);
      expect(f).toEqual(original);
    },
  );

  it('rejects stale evidence even when all orders were already completed', () => {
    const f = input();
    expect(() =>
      calculate({ ...f, now: f.now + 6000, orders: [{ ...item(1), executedQuantity: '0.5' }] }),
    ).toThrow('PAPER_EVIDENCE');
  });

  it.each(['tenantId', 'grant', 'credential', 'url'])(
    'does not accept caller authority field %s',
    (field) => {
      const f = input();
      expect(() => calculate({ ...f, [field]: 'untrusted' })).toThrow('PAPER_COMPETITION_INPUT');
      expect(() => calculate({ ...f, orders: [{ ...item(1), [field]: 'untrusted' }] })).toThrow(
        'PAPER_COMPETITION_INPUT',
      );
    },
  );
});
