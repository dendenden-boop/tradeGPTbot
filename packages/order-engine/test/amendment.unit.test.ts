import { expect, it } from 'vitest';
import { parseDecimal } from '@ctp/exchange-core';
import { prepareOrderAmendment } from '../src/amendment.js';
import { amendDraftSchema, hash, nativeAmendTargetSchema } from '../src/domain.js';
import { state, native } from './fixtures.js';
const now = 1_000_000;
function fixture() {
  const target = structuredClone(state());
  target.command = {
    ...target.command,
    type: 'LIMIT',
    limitPrice: parseDecimal('100'),
    timeInForce: 'GTC',
  };
  const { clientOrderId, ...replacement } = target.command;
  void clientOrderId;
  target.draft = { ...target.draft, order: replacement };
  target.status = 'SUBMITTED';
  target.reconciliation = 'CONSISTENT';
  target.version = 4;
  target.exchangeOrderId = 'native-1';
  target.lastExchangeAt = now - 100_000;
  target.lastNativeStatus = 'SUBMITTED';
  const event = native(target, '0', 'OPEN', target.lastExchangeAt);
  if (event.type !== 'NATIVE') throw new Error('Invalid fixture');
  const order = {
    ...event.order,
    price: { state: 'AVAILABLE' as const, value: parseDecimal('100') },
  };
  target.lastObservationHash = hash(order);
  const request = amendDraftSchema.parse({
    key: 'amend',
    expectedVersion: '4',
    dbRuleId: target.draft.dbRuleId,
    replacement: { ...replacement, size: { ...replacement.size, value: '5' } },
  });
  const evidence = nativeAmendTargetSchema.parse({ order, receivedAt: now });
  return { target, request, evidence };
}
it('constructs exact cumulative quantity reduction with fresh receipt of an unchanged idle native order', () => {
  const f = fixture(),
    original = structuredClone(f.target.command);
  const command = prepareOrderAmendment(f.target, f.request, f.evidence, '9007199254740993', now);
  expect(command.target).toMatchObject({
    internalOrderId: f.target.id,
    placeIntentId: f.target.intentId,
    revision: '4',
    nativeUpdatedAt: now - 100_000,
    observedAt: now,
    current: original,
  });
  expect(command.replacement.clientOrderId).toBe('9007199254740993');
  expect(f.target.command).toEqual(original);
  expect(Object.isFrozen(command)).toBe(true);
});
it.each([
  'version',
  'stale',
  'future',
  'changed-native',
  'unknown',
  'pending',
  'live',
  'paper',
] as const)('rejects %s target evidence without constructing dispatch authority', (kind) => {
  const f = fixture();
  if (kind === 'version') f.request.expectedVersion = '3';
  if (kind === 'stale') f.evidence.receivedAt = now - 5001;
  if (kind === 'future') f.evidence.receivedAt = now + 1;
  if (kind === 'changed-native') f.evidence.order.updatedAt++;
  if (kind === 'unknown') f.target.status = 'UNKNOWN';
  if (kind === 'pending') f.target.activeAttemptId = f.target.intentId;
  if (kind === 'live') {
    f.target.binding.mode = 'LIVE';
    f.target.binding.profile = { ...f.target.binding.profile, environment: 'LIVE' };
  }
  if (kind === 'paper') {
    f.target.binding.mode = 'PAPER';
    f.target.binding.connectionId = null;
  }
  expect(() => prepareOrderAmendment(f.target, f.request, f.evidence, '2', now)).toThrow(
    'ORDER_AMEND_TARGET',
  );
});
it.each(['price', 'side', 'increase', 'same', 'below-fill', 'type', 'trigger', 'asset'] as const)(
  'does not emulate unsupported %s semantic changes',
  (kind) => {
    const f = fixture();
    if (kind === 'price') f.request.replacement.limitPrice = parseDecimal('101');
    if (kind === 'side') f.request.replacement.side = 'SELL';
    if (kind === 'increase') f.request.replacement.size.value = parseDecimal('11');
    if (kind === 'same') f.request.replacement.size.value = parseDecimal('10');
    if (kind === 'below-fill') {
      f.target.filledQuantity = parseDecimal('5');
      f.target.executedQuantity = parseDecimal('5');
    }
    if (kind === 'type') {
      f.request.replacement.type = 'MARKET';
      f.request.replacement.limitPrice = null;
      f.request.replacement.timeInForce = null;
    }
    if (kind === 'trigger') {
      f.request.replacement.type = 'STOP_LIMIT';
      f.request.replacement.trigger = {
        price: parseDecimal('99'),
        source: 'LAST',
      };
    }
    if (kind === 'asset' && f.request.replacement.size.kind === 'BASE_QUANTITY')
      f.request.replacement.size.asset = 'ETH';
    expect(() => prepareOrderAmendment(f.target, f.request, f.evidence, '2', now)).toThrow();
  },
);
