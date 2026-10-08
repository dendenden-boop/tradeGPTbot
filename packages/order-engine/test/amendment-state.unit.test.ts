import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseDecimal } from '@ctp/exchange-core';
import { reduceOrder } from '../src/state.js';
import type { OrderEngineEvent, OrderState } from '../src/domain.js';
import { state, native } from './fixtures.js';

function open() {
  const s = state();
  s.command = { ...s.command, type: 'LIMIT', limitPrice: parseDecimal('100'), timeInForce: 'GTC' };
  const e = native(s);
  if (e.type !== 'NATIVE') throw new Error('INVALID_FIXTURE');
  e.order.type = 'LIMIT';
  e.order.price = { state: 'AVAILABLE', value: parseDecimal('100') };
  return reduceOrder(s, e);
}
// Calculation/state contract only: the durable dispatch guard stays disabled.
const amend = (s: OrderState, type: 'DISPATCH' | 'RESULT', outcome?: unknown) =>
  reduceOrder(s, {
    type,
    operation: 'AMEND',
    attemptId: s.activeAttemptId ?? randomUUID(),
    ...(outcome === undefined ? {} : { outcome }),
  } as OrderEngineEvent);

it('records an AMEND pending state without changing immutable PLACE semantics', () => {
  const s = open();
  const pending = amend(s, 'DISPATCH');
  expect(pending.command).toEqual(s.command);
  expect(pending.intentId).toBe(s.intentId);
  // An owned pending control does not imply an uncertain exchange outcome.
  expect(pending.status).toBe('SUBMITTED');
  expect(pending.activeOperation).toBe('AMEND');
  expect(pending.reconciliation).toBe('REQUIRED');
});
it('AMEND acknowledgement cannot establish a final applied result or clear its attempt', () => {
  const pending = amend(open(), 'DISPATCH');
  const ack = amend(pending, 'RESULT', {
    kind: 'ACCEPTED',
    ack: {
      commandId: randomUUID(),
      status: 'ACKNOWLEDGED',
      exchangeId: pending.exchangeOrderId,
      receivedAt: 600,
    },
  });
  expect(ack.activeAttemptId).toBe(pending.activeAttemptId);
  expect(ack.activeOperation).toBe('AMEND');
  expect(ack.reconciliation).toBe('REQUIRED');
  expect(() => reduceOrder(ack, { type: 'COMPLETE' })).toThrow('ORDER_HISTORY_REQUIRED');
});
it('UNKNOWN AMEND remains bound and cannot be dispatched again', () => {
  const pending = amend(open(), 'DISPATCH');
  const unknown = amend(pending, 'RESULT', { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } });
  expect(unknown.status).toBe('UNKNOWN');
  expect(unknown.activeAttemptId).toBe(pending.activeAttemptId);
  expect(() => amend(unknown, 'DISPATCH')).toThrow('ORDER_TRANSITION');
  const lateAck = amend(unknown, 'RESULT', {
    kind: 'ACCEPTED',
    ack: {
      commandId: randomUUID(),
      status: 'ACKNOWLEDGED',
      exchangeId: unknown.exchangeOrderId,
      receivedAt: 600,
    },
  });
  expect(lateAck.status).toBe('UNKNOWN');
  expect(lateAck.activeAttemptId).toBe(unknown.activeAttemptId);
});
it.each(['OPEN', 'FILLED'] as const)(
  'ordinary %s native evidence cannot resolve the causal AMEND outcome',
  (status) => {
    const pending = amend(open(), 'DISPATCH');
    const event = native(pending, status === 'FILLED' ? '10' : '0', status, 700);
    if (event.type !== 'NATIVE') throw new Error('INVALID_FIXTURE');
    event.order.type = 'LIMIT';
    event.order.price = { state: 'AVAILABLE', value: parseDecimal('100') };
    const observed = reduceOrder(pending, event);
    expect(observed.activeAttemptId).toBe(pending.activeAttemptId);
    expect(observed.activeOperation).toBe('AMEND');
    expect(observed.reconciliation).toBe('REQUIRED');
    expect(() => reduceOrder(observed, { type: 'COMPLETE' })).toThrow('ORDER_HISTORY_REQUIRED');
  },
);
