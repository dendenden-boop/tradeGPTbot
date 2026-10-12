import type { OrderBinding, OrderDraft } from './domain.js';

/** Draft admission only; this confers no reservation, fill or dispatch authority. */
export function assertPaperDraft(binding: OrderBinding, draft: OrderDraft): void {
  if (binding.mode !== 'PAPER') return;
  const p = binding.profile;
  if (
    binding.connectionId !== null ||
    p.market !== 'SPOT' ||
    p.accountMode !== 'SIMULATED' ||
    p.endpointProfileId !== 'paper-spot-v1' ||
    p.profileVersion !== 'spot-l2-taker-v1' ||
    p.credentialRef !== undefined
  )
    throw new Error('ORDER_PAPER_CONFIGURATION');
  if (
    draft.order.size.kind !== 'BASE_QUANTITY' ||
    draft.order.reduceOnly ||
    draft.order.timeInForce === 'POST_ONLY' ||
    (draft.order.trigger !== null && draft.order.trigger.source !== 'LAST')
  )
    throw new Error('ORDER_PAPER_ORDER_UNSUPPORTED');
}
