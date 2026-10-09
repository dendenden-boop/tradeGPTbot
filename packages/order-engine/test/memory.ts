/* eslint-disable @typescript-eslint/require-await -- Async contract fixtures deliberately resolve synchronously. */
// Reference contract fixture only; no production persistence/authorization default.
import { randomUUID } from 'node:crypto';
import {
  computeCommandHash,
  newOrderSchema,
  orderSchema,
  mutationOutcomeSchema,
} from '@ctp/exchange-core';
import {
  hash,
  type OrderStore,
  type OrderState,
  type DispatchClaim,
  type OrderBinding,
  type StoredAmendment,
} from '../src/domain.js';
import { reduceOrder } from '../src/state.js';
import { prepareOrderAmendment } from '../src/amendment.js';
import { prepareOrderCancellation } from '../src/cancellation.js';
import { state } from './fixtures.js';
export function memoryStore(currentRule = () => 'v1') {
  const orders = new Map<string, OrderState>(),
    keys = new Map<string, { id: string; fp: string }>(),
    cancel = new Map<
      string,
      {
        orderId: string;
        bindingHash: string;
        command: unknown;
        intentId: string;
        fp: string;
        ruleVersion: string;
      }
    >(),
    amendments = new Map<string, { requestHash: string; result: StoredAmendment }>(),
    claims = new Map<string, DispatchClaim>(),
    consumed = new Set<string>();
  let counter = 0n;
  const bind = (b: OrderBinding, id: string) => {
    const s = orders.get(id);
    if (!s || hash(s.binding) !== hash(b)) throw new Error('ORDER_BINDING_DENIED');
    return structuredClone(s);
  };
  const store: OrderStore = {
    async recoverUnsent(b, id) {
      const s = bind(b, id);
      const claim = [...claims.values()].find((v) => v.attemptId === s.activeAttemptId);
      if (claim && claim.expiresAt > Date.now()) return s;
      throw new Error('ORDER_DURABLE_RECOVERY_REQUIRED');
    },
    async pendingAmendment(b, id, c) {
      const state = await store.read(b, id, c);
      const claim = [...claims.values()].find(
        (v) =>
          v.state.id === id && v.operation === 'AMEND' && v.attemptId === state.activeAttemptId,
      );
      return claim ? structuredClone({ ...claim, state }) : null;
    },
    async resolveAmendment() {
      throw new Error('ORDER_AMEND_APPLICATION_UNPROVED');
    },
    async findCreate(b, d) {
      const k = keys.get(`${b.tenantId}:${d.key}`);
      if (!k) return null;
      if (k.fp !== hash({ b, d })) throw new Error('ORDER_IDEMPOTENCY_CONFLICT');
      return bind(b, k.id);
    },
    async create(b, d) {
      const fp = hash({ b, d }),
        key = `${b.tenantId}:${d.key}`,
        k = keys.get(key);
      if (k) {
        if (k.fp !== fp) throw new Error('ORDER_IDEMPOTENCY_CONFLICT');
        return bind(b, k.id);
      }
      const s = {
        ...state(),
        binding: b,
        draft: d,
        command: newOrderSchema.parse({ ...d.order, clientOrderId: (++counter).toString() }),
      };
      orders.set(s.id, s);
      keys.set(key, { id: s.id, fp });
      return structuredClone(s);
    },
    async read(b, id) {
      return bind(b, id);
    },
    async findAmend(b, id, request) {
      const previous = amendments.get(`${b.tenantId}:${request.key}`);
      if (!previous) return null;
      if (previous.requestHash !== hash({ binding: b, orderId: id, request }))
        throw new Error('ORDER_IDEMPOTENCY_CONFLICT');
      return structuredClone({ ...previous.result, state: bind(b, id) });
    },
    async amendIntent(b, id, request, evidence) {
      const requestHash = hash({ binding: b, orderId: id, request }),
        key = `${b.tenantId}:${request.key}`,
        previous = amendments.get(key),
        state = bind(b, id);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Error('ORDER_IDEMPOTENCY_CONFLICT');
        return structuredClone({ ...previous.result, state });
      }
      const clientOrderId = (counter + 1n).toString();
      const command = prepareOrderAmendment(state, request, evidence, clientOrderId, Date.now());
      if (request.replacement.ruleVersion !== currentRule()) throw new Error('ORDER_METADATA');
      const result: StoredAmendment = {
        state,
        intentId: randomUUID(),
        command,
        commandHash: computeCommandHash('amendOrder', command, {
          profile: b.profile,
          account: {
            tenantId: b.tenantId,
            connectionId: b.connectionId,
            externalAccountId: b.externalAccountId,
          },
        }),
        dispatched: false,
      };
      counter++;
      amendments.set(key, { requestHash, result });
      return structuredClone(result);
    },
    async findCancel(b, id, key) {
      const s = bind(b, id),
        old = cancel.get(`${b.tenantId}:${key}`);
      if (!old) return null;
      if (old.orderId !== id || old.bindingHash !== hash(b))
        throw new Error('ORDER_IDEMPOTENCY_CONFLICT');
      return {
        state: s,
        intentId: old.intentId,
        commandHash: old.fp,
        ruleVersion: old.ruleVersion,
        dispatched: claims.has(old.intentId),
      };
    },
    async cancelIntent(b, id, key, c, evidence) {
      const existing = await store.findCancel(b, id, key, c);
      if (existing) return existing;
      const s = bind(b, id),
        command = evidence
          ? prepareOrderCancellation(s, evidence, Date.now())
          : {
              instrumentId: s.command.instrumentId,
              locator: {
                kind: s.exchangeOrderId === null ? 'CLIENT_ID' : 'EXCHANGE_ID',
                id: s.exchangeOrderId ?? s.command.clientOrderId,
              },
            },
        fp = computeCommandHash('cancelOrder', command, {
          profile: b.profile,
          account: {
            tenantId: b.tenantId,
            connectionId: b.connectionId,
            externalAccountId: b.externalAccountId,
          },
        });
      const intentId = randomUUID();
      const ruleVersion = currentRule();
      cancel.set(`${b.tenantId}:${key}`, {
        orderId: id,
        bindingHash: hash(b),
        command,
        intentId,
        fp,
        ruleVersion,
      });
      return { state: s, intentId, commandHash: fp, ruleVersion, dispatched: claims.has(intentId) };
    },
    async begin(b, id, intentId, g) {
      if (claims.has(intentId)) return null;
      const s = bind(b, id),
        operation = intentId === s.intentId ? 'PLACE' : 'CANCEL',
        attemptId = randomUUID(),
        command =
          operation === 'PLACE'
            ? s.command
            : [...cancel.values()].find((v) => v.intentId === intentId)!.command,
        commandHash = computeCommandHash(
          operation === 'PLACE' ? 'createOrder' : 'cancelOrder',
          command,
          {
            profile: b.profile,
            account: {
              tenantId: b.tenantId,
              connectionId: b.connectionId,
              externalAccountId: b.externalAccountId,
            },
          },
        );
      const next = reduceOrder(operation === 'PLACE' ? reduceOrder(s, { type: 'APPROVE' }) : s, {
          type: 'DISPATCH',
          operation,
          attemptId,
        }),
        claim: DispatchClaim = {
          state: next,
          intentId,
          attemptId,
          operation,
          commandHash,
          command,
          expiresAt: g.expiresAt,
        };
      orders.set(id, next);
      claims.set(intentId, claim);
      return structuredClone(claim);
    },
    async result(b, c, o) {
      const next = reduceOrder(bind(b, c.state.id), {
        type: 'RESULT',
        operation: c.operation,
        attemptId: c.attemptId,
        outcome: mutationOutcomeSchema.parse(o),
      });
      orders.set(next.id, next);
      return next;
    },
    async observe(b, id, o) {
      const next = reduceOrder(bind(b, id), { type: 'NATIVE', order: orderSchema.parse(o) });
      orders.set(id, next);
      return next;
    },
    async gap(b, id) {
      const next = reduceOrder(bind(b, id), { type: 'GAP' });
      orders.set(id, next);
      return next;
    },
    async complete(b, id, raw) {
      const s = bind(b, id),
        o = orderSchema.parse(raw);
      let next = reduceOrder(s, { type: 'NATIVE', order: o });
      if (next.lastObservationHash !== hash(o)) throw new Error('ORDER_HISTORY_REQUIRED');
      next = reduceOrder(next, { type: 'COMPLETE' });
      orders.set(id, next);
      return next;
    },
    async adopt() {
      throw new Error('ORDER_FILL_PROOF');
    },
    async authorize(_op, input) {
      const a = (
        input as {
          authorization: { dispatchAttemptId: string; commandId: string; commandHash: string };
        }
      ).authorization;
      const c = claims.get(a.commandId);
      if (
        !c ||
        c.attemptId !== a.dispatchAttemptId ||
        c.commandHash !== a.commandHash ||
        consumed.has(c.attemptId)
      )
        return false;
      consumed.add(c.attemptId);
      return true;
    },
    async close() {},
  };
  return { store, orders, claims, consumed };
}
