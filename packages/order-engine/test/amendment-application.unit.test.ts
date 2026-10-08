import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  inPlaceAmendmentSchema,
  amendmentEvidenceSchema,
  orderSchema,
  parseDecimal,
} from '@ctp/exchange-core';
import * as implementation from '../src/amendment.js';
import { reduceOrder } from '../src/state.js';
import { stateSchema, type OrderState } from '../src/domain.js';
import { state, native } from './fixtures.js';

function fixture() {
  const initial = state();
  initial.command = {
    ...initial.command,
    type: 'LIMIT',
    limitPrice: parseDecimal('100'),
    timeInForce: 'GTC',
  };
  const first = native(initial);
  if (first.type !== 'NATIVE') throw new Error('INVALID_FIXTURE');
  first.order.price = { state: 'AVAILABLE', value: parseDecimal('100') };
  const opened = reduceOrder(initial, first);
  const command = inPlaceAmendmentSchema.parse({
    semantics: 'IN_PLACE',
    identity: { exchangeOrderId: 'PRESERVED', clientOrderId: 'REPLACED' },
    locator: {
      instrumentId: initial.command.instrumentId,
      locator: { kind: 'EXCHANGE_ID', id: opened.exchangeOrderId },
    },
    target: {
      internalOrderId: initial.id,
      placeIntentId: initial.intentId,
      revision: String(opened.version),
      observedAt: 600,
      nativeUpdatedAt: 500,
      current: opened.command,
      filledQuantity: '0',
    },
    replacement: {
      ...opened.command,
      clientOrderId: '2',
      size: { ...opened.command.size, value: '5' },
    },
  });
  const attemptId = randomUUID();
  const pending = reduceOrder(opened, { type: 'DISPATCH', operation: 'AMEND', attemptId });
  const evidence = amendmentEvidenceSchema.parse({
    kind: 'APPLIED_EVIDENCE',
    account: first.order.account,
    scope: first.order.scope,
    instrumentId: initial.command.instrumentId,
    receivedAt: 750,
    evidence: {
      executionId: '9007199254740993',
      time: 650,
      exchangeOrderId: opened.exchangeOrderId,
      oldClientOrderId: '1',
      newClientOrderId: '2',
      originalQuantity: '10',
      newQuantity: '5',
    },
  });
  const order = orderSchema.parse({
    ...first.order,
    clientOrderId: '2',
    quantity: '5',
    updatedAt: 700,
  });
  return { pending, command, evidence, order, attemptId, now: 800 };
}
function apply(f: ReturnType<typeof fixture>): OrderState {
  const fn = (
    implementation as unknown as {
      applyOrderAmendment: (state: OrderState, proof: unknown, now: number) => OrderState;
    }
  ).applyOrderAmendment;
  return fn(
    f.pending,
    {
      attemptId: f.attemptId,
      command: f.command,
      evidence: f.evidence,
      order: f.order,
      nativeReceivedAt: 750,
    },
    f.now,
  );
}
it('causal application establishes effective semantics while preserving the original PLACE command', () => {
  const f = fixture();
  const resolved = apply(f);
  expect(resolved.command).toEqual(f.pending.command);
  expect(resolved.intentId).toBe(f.pending.intentId);
  expect((resolved as unknown as { effectiveCommand: unknown }).effectiveCommand).toEqual(
    f.command.replacement,
  );
  expect(resolved.activeAttemptId).toBeNull();
  expect(resolved.activeOperation).toBeNull();
  expect(resolved.status).toBe('SUBMITTED');
  expect(resolved.reconciliation).toBe('CONSISTENT');
  expect(stateSchema.parse(JSON.parse(JSON.stringify(resolved)))).toEqual(resolved);
});
it.each([
  'EMPTY',
  'CLIENT',
  'QUANTITY',
  'ACCOUNT',
  'ATTEMPT',
  'TIME',
  'STALE',
  'FILL_RACE',
] as const)('rejects %s application evidence without changing pending state', (kind) => {
  const f = fixture();
  const before = structuredClone(f.pending);
  if (kind === 'EMPTY')
    f.evidence = amendmentEvidenceSchema.parse({
      account: f.evidence.account,
      scope: f.evidence.scope,
      instrumentId: f.evidence.instrumentId,
      receivedAt: f.evidence.receivedAt,
      kind: 'INDETERMINATE',
      reason: 'NO_CAUSAL_EVIDENCE',
    });
  else if (kind === 'CLIENT') f.order.clientOrderId = 'foreign';
  else if (kind === 'QUANTITY') f.order.quantity = parseDecimal('6');
  else if (kind === 'ACCOUNT')
    f.order.account = { ...f.order.account, externalAccountId: 'foreign' };
  else if (kind === 'ATTEMPT') f.attemptId = randomUUID();
  else if (kind === 'TIME') f.order.updatedAt = 640;
  else if (kind === 'STALE') f.now = 5751;
  else f.pending.filledQuantity = parseDecimal('6');
  expect(() => apply(f)).toThrow('ORDER_AMEND_APPLICATION_UNPROVED');
  // The reducer never mutates the supplied state, including raced filled quantity.
  if (kind === 'FILL_RACE') before.filledQuantity = parseDecimal('6');
  expect(f.pending).toEqual(before);
});
it('effective quantity and client identity constrain subsequent native observations and executions after restart', () => {
  const f = fixture();
  const resolved = stateSchema.parse(JSON.parse(JSON.stringify(apply(f))));
  expect(() =>
    reduceOrder(resolved, {
      type: 'NATIVE',
      order: { ...f.order, clientOrderId: '1', updatedAt: 900 },
    }),
  ).toThrow('ORDER_SCOPE');
  expect(() =>
    reduceOrder(resolved, {
      type: 'EXECUTION',
      quantity: parseDecimal('6'),
      price: parseDecimal('100'),
    }),
  ).toThrow('ORDER_FILL_BOUND');
  const filled = reduceOrder(resolved, {
    type: 'EXECUTION',
    quantity: parseDecimal('5'),
    price: parseDecimal('100'),
  });
  expect(filled.command.size.value).toBe('10');
  expect(filled.status).toBe('FILLED');
});
it.each(['PRICE', 'SIDE', 'SIZE', 'CLIENT', 'INSTRUMENT', 'REDUCE_ONLY'] as const)(
  'the stored effective command codec rejects %s changes to immutable PLACE semantics',
  (kind) => {
    const f = fixture(),
      resolved = apply(f);
    const effective = { ...f.command.replacement };
    if (kind === 'PRICE') effective.limitPrice = parseDecimal('101');
    else if (kind === 'SIDE') effective.side = 'SELL';
    else if (kind === 'SIZE') effective.size = { ...effective.size, value: parseDecimal('11') };
    else if (kind === 'CLIENT') effective.clientOrderId = resolved.command.clientOrderId;
    else if (kind === 'INSTRUMENT') effective.instrumentId = 'FOREIGN';
    else effective.reduceOnly = true;
    expect(() => stateSchema.parse({ ...resolved, effectiveCommand: effective })).toThrow();
  },
);
