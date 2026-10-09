import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { operations } from '@ctp/exchange-core';
import * as policy from '../src/policy.js';
import { fixture } from './fixtures.js';
function input() {
  const evaluation = fixture();
  evaluation.capabilities.push({ ...evaluation.capabilities[0]!, feature: 'CANCEL_ORDER' });
  Object.assign(evaluation.snapshot, {
    instrumentExposure: '5',
    assetExposure: '5',
    accountExposure: '5',
    userExposure: '5',
    concurrentPositions: 0,
    openOrders: 1,
    instrumentHasPendingEntry: true,
    availableAmount: '1',
  });
  for (const limits of [evaluation.platform, evaluation.user])
    Object.assign(limits, {
      maxInstrumentExposure: '5',
      maxAssetExposure: '5',
      maxAccountExposure: '5',
      maxUserExposure: '5',
      maxOpenOrders: 1,
    });
  const retention = {
    orderId: randomUUID(),
    placeIntentId: randomUUID(),
    reservationId: randomUUID(),
    accountId: evaluation.binding.accountId,
    mode: evaluation.binding.mode,
    asset: 'USDT',
    amount: '5.05',
    status: 'ACTIVE',
    orderRevision: '7',
    command: evaluation.order,
    filledQuantity: '0',
    exchangeOrderId: 'native-cancel-target',
    nativeUpdatedAt: evaluation.now - 100,
    nativeHash: 'a'.repeat(64),
  };
  const command = operations.cancelOrder.input.shape.command.parse({
    instrumentId: evaluation.order.instrumentId,
    locator: { kind: 'EXCHANGE_ID', id: retention.exchangeOrderId },
    target: {
      internalOrderId: retention.orderId,
      placeIntentId: retention.placeIntentId,
      revision: retention.orderRevision,
      observedAt: evaluation.now,
      nativeUpdatedAt: retention.nativeUpdatedAt,
      current: retention.command,
      filledQuantity: retention.filledQuantity,
    },
  });
  return { evaluation, retention, command };
}
function evaluate(raw: unknown): unknown {
  const fn = Reflect.get(policy, 'evaluateRiskCancelPolicy') as
    ((input: unknown) => unknown) | undefined;
  expect(fn).toBeTypeOf('function');
  if (!fn) throw new Error('CERTIFIED_CANCEL_POLICY_MISSING');
  return fn(raw);
}
it('CANCEL evaluates only its zero control delta and retains already-counted primary exposure at exact account limits', () => {
  expect(evaluate(input())).toEqual({
    kind: 'EVALUATED',
    effect: 'RETAIN',
    notional: '0',
    proposal: { asset: 'USDT', amount: '0' },
  });
});
it.each([
  'ACCOUNT',
  'MODE',
  'LOCATOR',
  'INSTRUMENT',
  'RELEASED',
  'STALE_OBSERVATION',
  'MISSING_TARGET',
  'CHANGED_QUANTITY',
  'MISSING_CAPABILITY',
  'UNKNOWN',
  'PAUSED',
] as const)('CANCEL rejects %s target/evidence without a new-risk or permission bypass', (kind) => {
  const f = input();
  if (kind === 'ACCOUNT') f.retention.accountId = randomUUID();
  else if (kind === 'MODE') f.retention.mode = 'DEMO';
  else if (kind === 'LOCATOR')
    f.command.locator = { kind: 'EXCHANGE_ID', id: 'different-native-order' };
  else if (kind === 'INSTRUMENT') f.command.instrumentId = 'different-instrument';
  else if (kind === 'RELEASED') f.retention.status = 'RELEASED';
  else if (kind === 'STALE_OBSERVATION') f.command.target!.observedAt = f.evaluation.now - 6000;
  else if (kind === 'MISSING_TARGET') delete f.command.target;
  else if (kind === 'CHANGED_QUANTITY')
    f.evaluation.order = {
      ...f.evaluation.order,
      size: { ...f.evaluation.order.size, value: '0.4' as typeof f.evaluation.order.size.value },
    };
  else if (kind === 'MISSING_CAPABILITY')
    f.evaluation.capabilities = f.evaluation.capabilities.filter(
      (c) => c.feature !== 'CANCEL_ORDER',
    );
  else if (kind === 'UNKNOWN') f.evaluation.snapshot.unknownExposure = true;
  else f.evaluation.snapshot.pauses.user = true;
  expect(evaluate(f)).toMatchObject({ kind: 'REJECTED' });
});
it('a fresh receipt certifies an unchanged old native CANCEL target without renewing its source clock', () => {
  const f = input();
  f.retention.nativeUpdatedAt = f.evaluation.now - 86_400_000;
  f.command.target!.nativeUpdatedAt = f.retention.nativeUpdatedAt;
  expect(evaluate(f)).toMatchObject({ kind: 'EVALUATED', effect: 'RETAIN' });
});
