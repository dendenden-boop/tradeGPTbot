import {
  decimalAdd,
  decimalMultiply,
  decimalCompare,
  parseDecimal,
  sameMarketScope,
} from '@ctp/exchange-core';
import { ratio } from '@ctp/portfolio';
import {
  stateSchema,
  eventSchema,
  hash,
  canonical,
  type OrderState,
  type OrderEngineEvent,
} from './domain.js';
export const terminal = (s: string) => ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(s);
export function reduceOrder(input: OrderState, raw: OrderEngineEvent): OrderState {
  const s = stateSchema.parse(input),
    e = eventSchema.parse(raw);
  if (e.type === 'APPROVE') {
    if (s.status !== 'CREATED') throw new Error('ORDER_TRANSITION');
    s.status = 'RISK_APPROVED';
  } else if (e.type === 'DISPATCH') {
    if (
      e.operation === 'PLACE'
        ? s.status !== 'RISK_APPROVED'
        : !['SUBMITTED', 'PARTIALLY_FILLED'].includes(s.status) ||
          s.reconciliation !== 'CONSISTENT' ||
          s.activeAttemptId !== null
    )
      throw new Error('ORDER_TRANSITION');
    s.status = e.operation === 'PLACE' ? 'SUBMITTING' : 'CANCEL_PENDING';
    s.reconciliation = 'REQUIRED';
    s.activeAttemptId = e.attemptId;
    s.activeOperation = e.operation;
  } else if (e.type === 'RESULT') {
    // Positive causal exchange evidence may settle an attempt before its late HTTP response.
    if (s.activeAttemptId !== e.attemptId) return s;
    if (e.outcome.kind === 'ACCEPTED') {
      if (
        s.exchangeOrderId !== null &&
        e.outcome.ack.exchangeId !== null &&
        s.exchangeOrderId !== e.outcome.ack.exchangeId
      )
        throw new Error('ORDER_SCOPE');
      s.exchangeOrderId = e.outcome.ack.exchangeId ?? s.exchangeOrderId;
      if (!terminal(s.status)) s.status = e.operation === 'PLACE' ? 'SUBMITTED' : 'CANCEL_PENDING';
    } else {
      if (!terminal(s.status))
        s.status =
          e.outcome.kind === 'UNKNOWN'
            ? 'UNKNOWN'
            : e.operation === 'PLACE'
              ? 'REJECTED'
              : 'RECONCILIATION_REQUIRED';
      if (e.outcome.kind === 'DEFINITIVELY_REJECTED') {
        s.activeAttemptId = null;
        s.activeOperation = null;
      }
    }
    s.reconciliation =
      e.operation === 'PLACE' && e.outcome.kind === 'DEFINITIVELY_REJECTED'
        ? 'CONSISTENT'
        : 'REQUIRED';
  } else if (e.type === 'NATIVE') {
    const o = e.order,
      b = s.binding;
    if (
      !sameMarketScope(o.scope, b.profile) ||
      o.account.tenantId !== b.tenantId ||
      o.account.connectionId !== b.connectionId ||
      o.account.externalAccountId !== b.externalAccountId ||
      o.clientOrderId !== s.command.clientOrderId ||
      o.instrumentId !== s.command.instrumentId ||
      o.side !== s.command.side ||
      o.type !== s.command.type ||
      o.quantityUnit !== 'BASE' ||
      o.quantity !== s.command.size.value ||
      o.exchangeOrderId === null ||
      (s.exchangeOrderId !== null && s.exchangeOrderId !== o.exchangeOrderId) ||
      o.createdAt < s.createdAt ||
      o.updatedAt < s.createdAt
    )
      throw new Error('ORDER_SCOPE');
    const fp = hash(o);
    if (s.lastExchangeAt !== null && o.updatedAt < s.lastExchangeAt) return s;
    if (o.updatedAt === s.lastExchangeAt) {
      if (fp !== s.lastObservationHash) throw new Error('ORDER_OBSERVATION_CONFLICT');
      return s;
    }
    const next = (
      {
        PENDING: 'SUBMITTED',
        OPEN: 'SUBMITTED',
        PARTIALLY_FILLED: 'PARTIALLY_FILLED',
        FILLED: 'FILLED',
        CANCELED: 'CANCELED',
        REJECTED: 'REJECTED',
        EXPIRED: 'EXPIRED',
        UNKNOWN: 'UNKNOWN',
      } as const
    )[o.status];
    if (terminal(s.status) && next !== s.status) throw new Error('ORDER_TERMINAL');
    if (
      decimalCompare(o.filledQuantity, s.filledQuantity) < 0 ||
      decimalCompare(o.filledQuantity, s.executedQuantity) < 0
    )
      throw new Error('ORDER_FILL_BOUND');
    if (o.filledQuantity !== '0' && o.averageFillPrice.state !== 'AVAILABLE')
      throw new Error('ORDER_EXECUTION_PRICE_REQUIRED');
    s.exchangeOrderId = o.exchangeOrderId;
    s.filledQuantity = o.filledQuantity;
    s.averageFillPrice = o.averageFillPrice.state === 'AVAILABLE' ? o.averageFillPrice.value : null;
    s.lastExchangeAt = o.updatedAt;
    s.lastObservationHash = fp;
    s.lastNativeStatus = next;
    s.status = next;
    if ((s.activeOperation === 'PLACE' && o.status !== 'UNKNOWN') || terminal(next)) {
      s.activeAttemptId = null;
      s.activeOperation = null;
    } else if (s.activeOperation === 'CANCEL') s.status = 'CANCEL_PENDING';
    s.reconciliation =
      o.status !== 'UNKNOWN' &&
      s.activeOperation !== 'CANCEL' &&
      s.filledQuantity === s.executedQuantity &&
      (s.executedQuantity === '0' ||
        s.averageFillPrice === parseDecimal(ratio(s.executionNotional, '1', s.executedQuantity)))
        ? 'CONSISTENT'
        : 'REQUIRED';
  } else if (e.type === 'EXECUTION') {
    const qty = decimalAdd(s.executedQuantity, e.quantity);
    if (
      decimalCompare(qty, s.command.size.value) > 0 ||
      (terminal(s.status) && decimalCompare(qty, s.filledQuantity) > 0)
    )
      throw new Error('ORDER_FILL_BOUND');
    s.executedQuantity = qty;
    s.executionNotional = decimalAdd(s.executionNotional, decimalMultiply(e.quantity, e.price));
    if (decimalCompare(qty, s.filledQuantity) > 0) s.filledQuantity = qty;
    if (!terminal(s.status) && s.activeOperation !== 'CANCEL' && s.lastNativeStatus !== 'UNKNOWN')
      s.status = qty === s.command.size.value ? 'FILLED' : 'PARTIALLY_FILLED';
    if (
      s.lastExchangeAt === null ||
      s.averageFillPrice === null ||
      decimalCompare(qty, input.filledQuantity) > 0
    )
      s.averageFillPrice = parseDecimal(ratio(s.executionNotional, '1', qty));
    s.reconciliation =
      s.lastExchangeAt !== null &&
      s.lastNativeStatus !== 'UNKNOWN' &&
      s.filledQuantity === qty &&
      s.activeOperation === null &&
      s.averageFillPrice === parseDecimal(ratio(s.executionNotional, '1', qty))
        ? 'CONSISTENT'
        : 'REQUIRED';
  } else if (e.type === 'COMPLETE') {
    if (
      s.lastNativeStatus === null ||
      s.lastNativeStatus === 'UNKNOWN' ||
      s.activeAttemptId !== null ||
      s.filledQuantity !== s.executedQuantity ||
      (s.executedQuantity !== '0' &&
        s.averageFillPrice !== parseDecimal(ratio(s.executionNotional, '1', s.executedQuantity)))
    )
      throw new Error('ORDER_HISTORY_REQUIRED');
    if (!terminal(s.status)) s.status = s.lastNativeStatus;
    s.reconciliation = 'CONSISTENT';
  } else {
    s.reconciliation = 'REQUIRED';
    if (!terminal(s.status) && s.status !== 'CREATED') s.status = 'RECONCILIATION_REQUIRED';
  }
  if (canonical(s) === canonical(input)) return s;
  s.version++;
  return stateSchema.parse(s);
}
