import {
  decimalCompare,
  immutable,
  inPlaceAmendmentSchema,
  type InPlaceAmendment,
} from '@ctp/exchange-core';
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
    before = state.command,
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
