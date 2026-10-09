import { immutable, operations } from '@ctp/exchange-core';
import {
  hash,
  nativeAmendTargetSchema,
  stateSchema,
  type NativeAmendTarget,
  type OrderState,
} from './domain.js';
import { reduceOrder } from './state.js';

/** Server-only evidence construction. No reservation or transport authority. */
export function prepareOrderCancellation(
  rawState: OrderState,
  rawEvidence: NativeAmendTarget,
  now: number,
) {
  const s = stateSchema.parse(rawState),
    e = nativeAmendTargetSchema.parse(rawEvidence);
  if (
    !Number.isSafeInteger(now) ||
    s.binding.mode === 'LIVE' ||
    s.binding.mode === 'PAPER' ||
    s.reconciliation !== 'CONSISTENT' ||
    !['SUBMITTED', 'PARTIALLY_FILLED'].includes(s.status) ||
    s.activeAttemptId !== null ||
    s.activeOperation !== null ||
    s.exchangeOrderId === null ||
    s.lastExchangeAt === null ||
    e.receivedAt > now ||
    now - e.receivedAt > 5000 ||
    e.order.updatedAt > e.receivedAt ||
    hash(e.order) !== s.lastObservationHash
  )
    throw new Error('ORDER_CANCEL_TARGET');
  reduceOrder(s, { type: 'NATIVE', order: e.order });
  return immutable(
    operations.cancelOrder.input.shape.command.parse({
      instrumentId: s.command.instrumentId,
      locator: { kind: 'EXCHANGE_ID', id: s.exchangeOrderId },
      target: {
        internalOrderId: s.id,
        placeIntentId: s.intentId,
        revision: String(s.version),
        observedAt: e.receivedAt,
        nativeUpdatedAt: s.lastExchangeAt,
        current: s.effectiveCommand ?? s.command,
        filledQuantity: s.filledQuantity,
      },
    }),
  );
}
