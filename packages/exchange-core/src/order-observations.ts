import { decimalCompare } from './decimal.js';
import type { Order } from './domain.js';

const terminal = (order: Order) =>
  ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(order.status);
interface Evidence {
  readonly time: number;
  readonly fingerprint: string;
}
interface Entry extends Evidence {
  readonly order: Order;
}

/**
 * Stream continuity evidence, not durable order authority. Active orders are never
 * evicted. Retired terminal times form a conservative watermark: an identity no
 * longer proved by this bounded window must be newer than every retired event.
 * A late/equal unprovable event requires reconciliation instead of silent adoption.
 */
export function createOrderObservationWindow(capacity = 64) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024)
    throw new Error('INVALID_OBSERVATION_CAPACITY');
  const active = new Map<string, Entry>(),
    history = new Map<string, Entry>();
  let retiredThrough = -1;
  function check(id: string, evidence: Evidence): boolean {
    if (!Number.isSafeInteger(evidence.time) || evidence.time < 0 || !id)
      throw new Error('INVALID_ORDER_OBSERVATION');
    const previous = active.get(id) ?? history.get(id);
    if (!previous) {
      if (evidence.time <= retiredThrough) throw new Error('UNPROVABLE_ORDER_REPLAY');
      return true;
    }
    if (evidence.time < previous.time) throw new Error('REGRESSED_ORDER_OBSERVATION');
    if (evidence.time === previous.time) {
      if (evidence.fingerprint !== previous.fingerprint)
        throw new Error('CONFLICTING_ORDER_OBSERVATION');
      return false;
    }
    return true;
  }
  return Object.freeze({
    check,
    observe(
      order: Order,
      evidence: Evidence = {
        time: order.updatedAt,
        fingerprint: JSON.stringify(order),
      },
    ): boolean {
      const id = order.exchangeOrderId;
      if (id === null) throw new Error('MISSING_NATIVE_ORDER_ID');
      if (!check(id, evidence)) return false;
      const previous = active.get(id) ?? history.get(id);
      if (
        previous &&
        (order.updatedAt < previous.order.updatedAt ||
          decimalCompare(order.filledQuantity, previous.order.filledQuantity) < 0 ||
          order.internalOrderId !== previous.order.internalOrderId ||
          order.intentId !== previous.order.intentId ||
          order.createdAt !== previous.order.createdAt ||
          (terminal(previous.order) && order.status !== previous.order.status))
      )
        throw new Error('REGRESSED_ORDER_STATE');
      if (!terminal(order)) {
        if (!active.has(id) && active.size >= capacity) throw new Error('ACTIVE_ORDER_CAPACITY');
        active.set(id, { ...evidence, order });
        history.delete(id);
      } else {
        active.delete(id);
        history.set(id, { ...evidence, order });
        if (history.size > capacity) {
          let oldestId = '',
            oldestTime = Infinity;
          for (const [key, entry] of history) {
            if (entry.time < oldestTime) {
              oldestId = key;
              oldestTime = entry.time;
            }
          }
          retiredThrough = Math.max(retiredThrough, oldestTime);
          history.delete(oldestId);
        }
      }
      return true;
    },
    retained() {
      return Object.freeze({ active: active.size, terminal: history.size, retiredThrough });
    },
  });
}
