import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { inPlaceAmendmentSchema, parseDecimal } from '@ctp/exchange-core';
import * as policy from '../src/policy.js';
import { fixture } from './fixtures.js';

function input() {
  const evaluation = fixture();
  const command = inPlaceAmendmentSchema.parse({
    semantics: 'IN_PLACE',
    identity: { exchangeOrderId: 'PRESERVED', clientOrderId: 'REPLACED' },
    locator: {
      instrumentId: evaluation.order.instrumentId,
      locator: { kind: 'EXCHANGE_ID', id: 'native-retained-order' },
    },
    target: {
      internalOrderId: randomUUID(),
      placeIntentId: randomUUID(),
      revision: '9007199254740993',
      observedAt: evaluation.now - 10,
      nativeUpdatedAt: evaluation.now - 1000,
      current: evaluation.order,
      filledQuantity: '0',
    },
    replacement: {
      ...evaluation.order,
      clientOrderId: 'new-client',
      size: { kind: 'BASE_QUANTITY', value: '0.4', asset: 'BTC' },
    },
  });
  evaluation.order = command.replacement;
  evaluation.capabilities.push({ ...evaluation.capabilities[0]!, feature: 'AMEND_ORDER' });
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
  for (const limits of [evaluation.platform, evaluation.user]) {
    Object.assign(limits, {
      maxInstrumentExposure: '5',
      maxAssetExposure: '5',
      maxAccountExposure: '5',
      maxUserExposure: '5',
      maxOpenOrders: 1,
    });
  }
  const retention = {
    orderId: command.target.internalOrderId,
    placeIntentId: command.target.placeIntentId,
    reservationId: randomUUID(),
    accountId: evaluation.binding.accountId,
    mode: evaluation.binding.mode,
    asset: 'USDT',
    amount: '5.05',
    status: 'ACTIVE',
    orderRevision: command.target.revision,
    command: command.target.current,
    filledQuantity: '0',
    exchangeOrderId: command.locator.locator.id,
    nativeUpdatedAt: command.target.nativeUpdatedAt,
    nativeHash: 'a'.repeat(64),
  };
  return { evaluation, command, retention };
}

function evaluate(raw: unknown): unknown {
  const fn = Reflect.get(policy, 'evaluateRiskAmendmentPolicy') as
    ((input: unknown) => unknown) | undefined;
  expect(fn).toBeTypeOf('function');
  if (!fn) throw new Error('RISK_RETAINED_AMENDMENT_CONTRACT_MISSING');
  return fn(raw);
}

it('re-evaluates native quantity decrease without adding another exposure, open order or cash reserve', () => {
  expect(evaluate(input())).toEqual({
    kind: 'EVALUATED',
    effect: 'RETAIN',
    notional: '0',
    proposal: { asset: 'USDT', amount: '0' },
  });
});

it.each(['orderId', 'placeIntentId', 'accountId', 'exchangeOrderId', 'orderRevision'] as const)(
  'rejects contradictory retained %s',
  (field) => {
    const f = input();
    f.retention[field] = field === 'orderRevision' ? '1' : randomUUID();
    expect(evaluate(f)).toEqual({ kind: 'REJECTED', reasons: ['RISK_AMEND_TARGET'] });
  },
);

it.each(['UNKNOWN', 'STALE', 'PAUSE', 'CAPABILITY', 'COVERAGE', 'INCREASE'] as const)(
  'fails closed on %s instead of treating an AMEND as reduceOnly authority',
  (kind) => {
    const f = input();
    if (kind === 'UNKNOWN') f.retention.status = 'UNRESOLVED';
    if (kind === 'STALE') f.command.target.observedAt = f.evaluation.now - 6000;
    if (kind === 'PAUSE') f.evaluation.snapshot.pauses.global = true;
    if (kind === 'CAPABILITY')
      f.evaluation.capabilities = f.evaluation.capabilities.filter(
        (c) => c.feature !== 'AMEND_ORDER',
      );
    if (kind === 'COVERAGE') f.retention.amount = '1';
    if (kind === 'INCREASE') f.command.replacement.size.value = parseDecimal('0.6');
    expect(evaluate(f)).toMatchObject({ kind: 'REJECTED' });
  },
);

it('cannot grant retained semantics through the ordinary PLACE evaluator', () => {
  const f = input();
  expect(policy.evaluateRiskPolicy(f.evaluation)).toMatchObject({ kind: 'REJECTED' });
  expect(policy.evaluateRiskPolicy({ ...f.evaluation, retention: f.retention })).toEqual({
    kind: 'REJECTED',
    reasons: ['RISK_INPUT'],
  });
});
