import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { reduceOrder } from '../src/state.js';
import { parseDecimal } from '@ctp/exchange-core';
import { state, native } from './fixtures.js';
it.each(['different', 'unavailable'] as const)(
  'rejects %s native limit price before reconciling an immutable PLACE',
  (kind) => {
    const s = state();
    s.command = {
      ...s.command,
      type: 'LIMIT',
      limitPrice: parseDecimal('100'),
      timeInForce: 'GTC',
    };
    const observation = native(s);
    if (observation.type !== 'NATIVE') throw new Error('INVALID_FIXTURE');
    const price =
      kind === 'different'
        ? { state: 'AVAILABLE' as const, value: parseDecimal('101') }
        : { state: 'UNAVAILABLE' as const, reason: 'NOT_PROVIDED' as const };
    const apply = () => reduceOrder(s, { ...observation, order: { ...observation.order, price } });
    // Core rejects an unavailable LIMIT price before projection. A different valid
    // price must additionally fail the immutable PLACE scope comparison.
    if (kind === 'different') expect(apply).toThrow('ORDER_SCOPE');
    else expect(apply).toThrow();
  },
);
it('persists explicit submit state before external action', () =>
  expect(
    reduceOrder(reduceOrder(state(), { type: 'APPROVE' }), {
      type: 'DISPATCH',
      operation: 'PLACE',
      attemptId: randomUUID(),
    }).status,
  ).toBe('SUBMITTING'));
it('unknown lost response cannot be submitted again', () => {
  const id = randomUUID();
  const s = reduceOrder(reduceOrder(state(), { type: 'APPROVE' }), {
    type: 'DISPATCH',
    operation: 'PLACE',
    attemptId: id,
  });
  const u = reduceOrder(s, {
    type: 'RESULT',
    operation: 'PLACE',
    attemptId: id,
    outcome: { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } },
  });
  expect(u.status).toBe('UNKNOWN');
  expect(() =>
    reduceOrder(u, { type: 'DISPATCH', operation: 'PLACE', attemptId: randomUUID() }),
  ).toThrow('ORDER_TRANSITION');
});
it('REST cumulative quantity and adopted fills are not added twice', () => {
  let s = state();
  s = reduceOrder(s, native(s, '2'));
  s = reduceOrder(s, {
    type: 'EXECUTION',
    quantity: parseDecimal('2'),
    price: parseDecimal('100'),
  });
  expect(s.filledQuantity).toBe('2');
  expect(s.executedQuantity).toBe('2');
  expect(s.reconciliation).toBe('CONSISTENT');
});
it('durable native watermark ignores old snapshots and rejects equal conflicting content', () => {
  let s = state();
  s = reduceOrder(s, native(s, '2', 'OPEN', 500));
  expect(reduceOrder(s, native(s, '0', 'OPEN', 499))).toEqual(s);
  expect(reduceOrder(s, native(s, '2', 'OPEN', 500))).toEqual(s);
  expect(() => reduceOrder(s, native(s, '3', 'OPEN', 500))).toThrow('ORDER_OBSERVATION_CONFLICT');
});
it('canceled projection retains legitimate late partial fill without reopening', () => {
  let s = state();
  s = reduceOrder(s, native(s, '2', 'CANCELED'));
  s = reduceOrder(s, {
    type: 'EXECUTION',
    quantity: parseDecimal('2'),
    price: parseDecimal('100'),
  });
  expect(s.status).toBe('CANCELED');
  expect(s.reconciliation).toBe('CONSISTENT');
  expect(() => reduceOrder(s, native(s, '2', 'OPEN', 600))).toThrow('ORDER_TERMINAL');
});
it('full fills preserve positive terminal evidence across late unknown acknowledgment', () => {
  const id = randomUUID();
  let s = reduceOrder(reduceOrder(state(), { type: 'APPROVE' }), {
    type: 'DISPATCH',
    operation: 'PLACE',
    attemptId: id,
  });
  s = reduceOrder(s, native(s, '10', 'FILLED'));
  s = reduceOrder(s, {
    type: 'EXECUTION',
    quantity: parseDecimal('10'),
    price: parseDecimal('100'),
  });
  expect(
    reduceOrder(s, {
      type: 'RESULT',
      operation: 'PLACE',
      attemptId: id,
      outcome: { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } },
    }).status,
  ).toBe('FILLED');
});
it('rejects foreign native identity and execution overflow', () => {
  const s = state();
  const n = native(s);
  if (n.type !== 'NATIVE') throw new Error();
  expect(() => reduceOrder(s, { ...n, order: { ...n.order, clientOrderId: 'foreign' } })).toThrow(
    'ORDER_SCOPE',
  );
  expect(() =>
    reduceOrder(s, { type: 'EXECUTION', quantity: parseDecimal('11'), price: parseDecimal('100') }),
  ).toThrow('ORDER_FILL_BOUND');
});
