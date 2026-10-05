import { expect, it } from 'vitest';
import { parseDecimal } from '@ctp/exchange-core';
import { reduceOrder } from '../src/state.js';
import { state, native } from './fixtures.js';
it('partial execution coverage preserves authoritative cumulative average', () => {
  let s = state();
  const n = native(s, '2', 'CANCELED');
  if (n.type !== 'NATIVE') throw new Error();
  n.order.averageFillPrice = { state: 'AVAILABLE', value: parseDecimal('150') };
  s = reduceOrder(s, n);
  s = reduceOrder(s, {
    type: 'EXECUTION',
    quantity: parseDecimal('1'),
    price: parseDecimal('100'),
  });
  expect(s.averageFillPrice).toBe('150');
  expect(s.reconciliation).toBe('REQUIRED');
});
it('native observed cumulative quantity cannot regress', () => {
  let s = state();
  s = reduceOrder(s, native(s, '2'));
  expect(() => reduceOrder(s, native(s, '1', 'OPEN', 600))).toThrow('ORDER_FILL_BOUND');
});
it('unknown native status stays blocking when its execution arrives', () => {
  let s = state();
  const n = native(s, '2');
  if (n.type !== 'NATIVE') throw new Error();
  n.order.status = 'UNKNOWN';
  s = reduceOrder(s, n);
  s = reduceOrder(s, {
    type: 'EXECUTION',
    quantity: parseDecimal('2'),
    price: parseDecimal('100'),
  });
  expect(s.reconciliation).toBe('REQUIRED');
});
it('equal fill quantity with conflicting notional never becomes reconciled', () => {
  const s = state();
  const observed = reduceOrder(reduceOrder(s, { type: 'APPROVE' }), native(s, '2'));
  const adopted = reduceOrder(observed, {
    type: 'EXECUTION',
    quantity: parseDecimal('2'),
    price: parseDecimal('200'),
  });
  expect(adopted.reconciliation).toBe('REQUIRED');
  expect(adopted.averageFillPrice).toBe('100');
});
it('definitive PLACE rejection is terminal and needs no imaginary exchange history', () => {
  let s = state();
  s = reduceOrder(s, { type: 'APPROVE' });
  s = reduceOrder(s, { type: 'DISPATCH', operation: 'PLACE', attemptId: s.intentId });
  s = reduceOrder(s, {
    type: 'RESULT',
    operation: 'PLACE',
    attemptId: s.intentId,
    outcome: { kind: 'DEFINITIVELY_REJECTED', error: { code: 'INVALID_REQUEST' } },
  });
  expect(s.status).toBe('REJECTED');
  expect(s.reconciliation).toBe('CONSISTENT');
});
it('unknown native observation cannot resolve a durable dispatch attempt', () => {
  let s = state();
  s = reduceOrder(s, { type: 'APPROVE' });
  s = reduceOrder(s, { type: 'DISPATCH', operation: 'PLACE', attemptId: s.intentId });
  const n = native(s);
  if (n.type !== 'NATIVE') throw new Error();
  n.order.status = 'UNKNOWN';
  s = reduceOrder(s, n);
  expect(s.activeAttemptId).toBe(s.intentId);
  expect(s.reconciliation).toBe('REQUIRED');
});
it('an older native order with a matching reused client ID cannot reconcile a newer intent', () => {
  const s = state(),
    n = native(s);
  if (n.type !== 'NATIVE') throw new Error();
  n.order.createdAt = s.createdAt - 1;
  expect(() => reduceOrder(s, n)).toThrow('ORDER_SCOPE');
});
