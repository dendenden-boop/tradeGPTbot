import {
  amendmentEvidenceSchema,
  orderSchema,
  timestampSchema,
  decimalCompare,
  immutable,
  inPlaceAmendmentSchema,
  type InPlaceAmendment,
} from '@ctp/exchange-core';
import { z } from 'zod';
import {
  amendDraftSchema,
  nativeAmendTargetSchema,
  stateSchema,
  hash,
  type AmendDraft,
  type NativeAmendTarget,
  type OrderState,
} from './domain.js';
import { reduceOrder } from './state.js';

/** Server-only construction; this does not issue Risk or a mutation permit. */
export function prepareOrderAmendment(
  rawState: OrderState,
  rawRequest: AmendDraft,
  rawEvidence: NativeAmendTarget,
  clientOrderId: string,
  now: number,
): InPlaceAmendment {
  const state = stateSchema.parse(rawState),
    request = amendDraftSchema.parse(rawRequest),
    evidence = nativeAmendTargetSchema.parse(rawEvidence),
    before = state.effectiveCommand ?? state.command,
    after = request.replacement;
  if (
    !Number.isSafeInteger(now) ||
    state.binding.mode === 'LIVE' ||
    state.binding.mode === 'PAPER' ||
    state.binding.profile.market !== 'SPOT' ||
    state.reconciliation !== 'CONSISTENT' ||
    !['SUBMITTED', 'PARTIALLY_FILLED'].includes(state.status) ||
    state.activeAttemptId !== null ||
    state.activeOperation !== null ||
    state.exchangeOrderId === null ||
    state.lastExchangeAt === null ||
    request.expectedVersion !== String(state.version) ||
    evidence.receivedAt > now ||
    now - evidence.receivedAt > 5000 ||
    evidence.order.updatedAt > evidence.receivedAt ||
    hash(evidence.order) !== state.lastObservationHash
  )
    throw new Error('ORDER_AMEND_TARGET');
  // Complete exact native scope and immutable price/quantity checks remain shared
  // with reconciliation; an application receipt cannot renew a changed target.
  reduceOrder(state, { type: 'NATIVE', order: evidence.order });
  if (
    before.type !== 'LIMIT' ||
    before.timeInForce !== 'GTC' ||
    before.reduceOnly ||
    before.size.kind !== 'BASE_QUANTITY' ||
    after.size.kind !== 'BASE_QUANTITY' ||
    before.limitPrice !== after.limitPrice ||
    decimalCompare(after.size.value, before.size.value) >= 0
  )
    throw new Error('ORDER_AMEND_UNSUPPORTED');
  const parsed = inPlaceAmendmentSchema.safeParse({
    semantics: 'IN_PLACE',
    identity: { exchangeOrderId: 'PRESERVED', clientOrderId: 'REPLACED' },
    locator: {
      instrumentId: before.instrumentId,
      locator: { kind: 'EXCHANGE_ID', id: state.exchangeOrderId },
    },
    target: {
      internalOrderId: state.id,
      placeIntentId: state.intentId,
      revision: request.expectedVersion,
      observedAt: evidence.receivedAt,
      nativeUpdatedAt: state.lastExchangeAt,
      current: before,
      filledQuantity: state.filledQuantity,
    },
    replacement: { ...after, clientOrderId },
  });
  if (!parsed.success) throw new Error('ORDER_AMEND_UNSUPPORTED');
  return immutable(parsed.data);
}

const applicationSchema = z.strictObject({
  attemptId: z.uuid(),
  command: inPlaceAmendmentSchema,
  evidence: amendmentEvidenceSchema,
  order: orderSchema,
  nativeReceivedAt: timestampSchema,
});
/** Pure state calculation. The durable store must independently prove source and attempt authority. */
export function applyOrderAmendment(
  rawState: OrderState,
  rawProof: unknown,
  now: number,
): OrderState {
  try {
    const state = stateSchema.parse(rawState),
      proof = applicationSchema.parse(rawProof);
    const before = state.effectiveCommand ?? state.command;
    const { command, evidence, order } = proof;
    if (
      !Number.isSafeInteger(now) ||
      state.binding.mode !== 'TESTNET' ||
      state.binding.profile.exchange !== 'BINANCE' ||
      state.binding.profile.market !== 'SPOT' ||
      state.activeOperation !== 'AMEND' ||
      state.activeAttemptId !== proof.attemptId ||
      command.target.internalOrderId !== state.id ||
      command.target.placeIntentId !== state.intentId ||
      hash(command.target.current) !== hash(before) ||
      command.locator.locator.id !== state.exchangeOrderId ||
      before.type !== 'LIMIT' ||
      before.timeInForce !== 'GTC' ||
      before.reduceOnly ||
      command.replacement.limitPrice !== before.limitPrice ||
      decimalCompare(command.replacement.size.value, before.size.value) >= 0 ||
      decimalCompare(state.filledQuantity, command.replacement.size.value) > 0 ||
      decimalCompare(state.executedQuantity, command.replacement.size.value) > 0 ||
      evidence.kind !== 'APPLIED_EVIDENCE' ||
      hash(evidence.account) !== hash(order.account) ||
      hash(evidence.scope) !== hash(order.scope) ||
      evidence.instrumentId !== before.instrumentId ||
      evidence.receivedAt > now ||
      now - evidence.receivedAt > 5000 ||
      proof.nativeReceivedAt > now ||
      now - proof.nativeReceivedAt > 5000 ||
      order.updatedAt > proof.nativeReceivedAt ||
      evidence.evidence.time < command.target.observedAt ||
      evidence.evidence.time > evidence.receivedAt ||
      evidence.evidence.time > order.updatedAt ||
      evidence.evidence.exchangeOrderId !== command.locator.locator.id ||
      evidence.evidence.oldClientOrderId !== before.clientOrderId ||
      evidence.evidence.newClientOrderId !== command.replacement.clientOrderId ||
      evidence.evidence.originalQuantity !== before.size.value ||
      evidence.evidence.newQuantity !== command.replacement.size.value ||
      (state.lastExchangeAt !== null && order.updatedAt <= state.lastExchangeAt)
    )
      throw new Error();
    return reduceOrder(
      {
        ...state,
        effectiveCommand: command.replacement,
        activeAttemptId: null,
        activeOperation: null,
      },
      { type: 'NATIVE', order },
    );
  } catch {
    // Native/private evidence errors must not expose account data.
    throw new Error('ORDER_AMEND_APPLICATION_UNPROVED');
  }
}
