/* eslint-disable @typescript-eslint/require-await -- Server contract fixtures deliberately resolve synchronously. */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  createExchangeAdapter,
  createInstrumentRegistry,
  orderSchema,
  parseDecimal,
  operations,
  type AdapterTransport,
  type AmendmentEvidence,
} from '@ctp/exchange-core';
import { createOrderEngine } from '../src/service.js';
import { reduceOrder } from '../src/state.js';
import { applyOrderAmendment } from '../src/amendment.js';
import {
  hash,
  type OrderStore,
  type StoredAmendment,
  type OrderState,
  type AmendDraft,
} from '../src/domain.js';
import { memoryStore } from './memory.js';
import { state } from './fixtures.js';
import {
  instrument,
  rules,
  capabilities as baseCapabilities,
  order as nativeFixture,
} from '../../exchange-core/test/fixtures/adapter.js';

const cleaners: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleaners.splice(0)) await close();
});
type AmendmentEngine = ReturnType<typeof createOrderEngine> & {
  amend(id: string, request: AmendDraft, signal?: AbortSignal): Promise<OrderState>;
};
function fixture(unsupported = false, unknown = false) {
  const now = () => Date.now(),
    initial = state();
  initial.binding.profile = {
    ...initial.binding.profile,
    endpointProfileId: 'binance-spot-testnet-v1',
  };
  const original = {
    ...initial.command,
    clientOrderId: 'place-owned-client',
    type: 'LIMIT' as const,
    limitPrice: parseDecimal('30000.05'),
    timeInForce: 'GTC' as const,
  };
  const { clientOrderId: omitted, ...replacement } = original;
  void omitted;
  const native = orderSchema.parse({
    ...nativeFixture,
    internalOrderId: initial.id,
    intentId: initial.intentId,
    clientOrderId: original.clientOrderId,
    exchangeOrderId: 'native-owned-order',
    type: 'LIMIT',
    quantity: original.size.value,
    price: { state: 'AVAILABLE', value: original.limitPrice },
    filledQuantity: '0',
    averageFillPrice: { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' },
    createdAt: initial.createdAt,
    updatedAt: now() - 100,
    status: 'OPEN',
  });
  const target = reduceOrder(
    { ...initial, command: original, draft: { ...initial.draft, order: replacement } },
    { type: 'NATIVE', order: native },
  );
  const request: AmendDraft = {
    key: randomUUID(),
    expectedVersion: String(target.version),
    dbRuleId: target.draft.dbRuleId,
    replacement: { ...replacement, size: { ...replacement.size, value: parseDecimal('9') } },
  };
  const registry = createInstrumentRegistry({ capacity: 1 });
  registry.put(
    { instrument, rules: { ...rules, effectiveAt: now() - 1000, expiresAt: now() + 60000 } },
    now(),
  );
  const m = memoryStore(() =>
    registry.get(instrument.scope, instrument.id, now()).ok ? 'v1' : 'missing',
  );
  m.orders.set(target.id, target);
  let amendment: StoredAmendment | undefined,
    riskCalls = 0,
    lookups = 0,
    sends = 0,
    deny = false,
    histories = 0,
    applications = 0,
    noEvidence = false,
    delayedHistory = false;
  let nativeReceipt = 0,
    proofReceipt = 0;
  let nativeCurrent = native,
    application: AmendmentEvidence | undefined;
  const store: OrderStore = {
    ...m.store,
    async recoverUnsent(b, id, c) {
      return m.store.read(b, id, c);
    },
    async resolveAmendment(b, id, attemptId, proof, c) {
      proofReceipt = (proof as { nativeReceivedAt: number }).nativeReceivedAt;
      const current = await m.store.read(b, id, c);
      const claim = [...m.claims.values()].find((v) => v.attemptId === attemptId);
      if (!claim) throw new Error('ORDER_AMEND_APPLICATION_UNPROVED');
      const next = applyOrderAmendment(
        current,
        { ...(proof as object), attemptId, command: claim.command },
        now(),
      );
      applications++;
      m.orders.set(id, next);
      return next;
    },
    async findAmend(b, id, r, c) {
      const value = await m.store.findAmend(b, id, r, c);
      return value === null ? null : { ...value, dispatched: m.claims.has(value.intentId) };
    },
    async amendIntent(...args) {
      amendment = await m.store.amendIntent(...args);
      return amendment;
    },
    async begin(b, id, intent, g, c) {
      if (!amendment || amendment.intentId !== intent) return m.store.begin(b, id, intent, g, c);
      if (m.claims.has(intent)) return null;
      const state = reduceOrder(await m.store.read(b, id, c), {
        type: 'DISPATCH',
        operation: 'AMEND',
        attemptId: randomUUID(),
      });
      const claim = {
        state,
        intentId: intent,
        attemptId: state.activeAttemptId!,
        operation: 'AMEND' as const,
        command: amendment.command,
        commandHash: amendment.commandHash,
        expiresAt: g.expiresAt,
      };
      m.orders.set(id, state);
      m.claims.set(intent, claim);
      return claim;
    },
  };
  const transport: AdapterTransport = {
    async request(op, raw) {
      if (op === 'getOrder') {
        const q = operations.getOrder.input.parse(raw);
        expect(q.locator).toEqual({ kind: 'EXCHANGE_ID', id: native.exchangeOrderId });
        lookups++;
        nativeReceipt = now();
        return { kind: 'FOUND', order: nativeCurrent };
      }
      if (op === 'getAmendmentEvidence') {
        const input = operations.getAmendmentEvidence.input.parse(raw);
        expect(input.command).toEqual(amendment?.command);
        histories++;
        if (delayedHistory) await new Promise((resolve) => setTimeout(resolve, 15));
        return noEvidence || !application
          ? {
              kind: 'INDETERMINATE',
              reason: 'NO_CAUSAL_EVIDENCE',
              account: native.account,
              scope: native.scope,
              instrumentId: native.instrumentId,
              receivedAt: now(),
            }
          : { ...application, receivedAt: now() };
      }
      if (op === 'getTrades') {
        const q = operations.getTrades.input.parse(raw);
        return { queryId: q.queryId, items: [], nextCursor: null };
      }
      if (op === 'amendOrder') {
        const input = operations.amendOrder.input.parse(raw);
        sends++;
        expect(input.command.target.current).toEqual(original);
        expect(input.command.target.internalOrderId).toBe(target.id);
        const appliedAt = now();
        nativeCurrent = orderSchema.parse({
          ...native,
          clientOrderId: input.command.replacement.clientOrderId,
          quantity: input.command.replacement.size.value,
          updatedAt: appliedAt,
        });
        application = {
          kind: 'APPLIED_EVIDENCE',
          account: native.account,
          scope: native.scope,
          instrumentId: native.instrumentId,
          receivedAt: appliedAt,
          evidence: {
            executionId: '9007199254740993123',
            time: appliedAt,
            exchangeOrderId: native.exchangeOrderId!,
            oldClientOrderId: original.clientOrderId,
            newClientOrderId: input.command.replacement.clientOrderId,
            originalQuantity: original.size.value,
            newQuantity: input.command.replacement.size.value,
          },
        };
        if (unknown) throw new Error('AMBIGUOUS_DISPATCH');
        return {
          kind: 'ACCEPTED',
          ack: {
            commandId: input.authorization.commandId,
            status: 'ACKNOWLEDGED',
            exchangeId: native.exchangeOrderId,
            receivedAt: now(),
          },
        };
      }
      throw new Error('UNEXPECTED_FIXTURE_OPERATION');
    },
    async subscribe() {
      return async () => {};
    },
    async disconnect() {},
  };
  const account = {
    tenantId: target.binding.tenantId,
    connectionId: target.binding.connectionId!,
    externalAccountId: target.binding.externalAccountId,
  };
  const adapter = createExchangeAdapter({
    profile: target.binding.profile,
    account,
    adapterVersion: 'v1',
    registry,
    transport,
    authorization: { authorize: (...args) => store.authorize(...args) },
    now,
    capabilities: baseCapabilities.map((c) => ({
      ...c,
      profile: target.binding.profile,
      checkedAt: now() - 1000,
      expiresAt: now() + 60000,
      ...(unsupported && c.feature === 'AMEND_ORDER' ? { support: 'UNSUPPORTED' as const } : {}),
    })),
  });
  const engine = createOrderEngine({
    binding: target.binding,
    store,
    adapter,
    registry,
    now,
    authorization: {
      async check(_b, action) {
        return !(deny && ['AMEND'].includes(action));
      },
    },
    risk: {
      async approve(input) {
        riskCalls++;
        expect(input.operation).toBe('AMEND');
        expect(input.state.id).toBe(target.id);
        expect(input.commandHash).toBe(amendment?.commandHash);
        return {
          decisionId: randomUUID(),
          reservationId: randomUUID(),
          permissionEpoch: '1',
          expiresAt: now() + 2000,
        };
      },
    },
    fills: {
      async ingest() {
        throw new Error('NO_FIXTURE_FILLS');
      },
    },
  }) as AmendmentEngine;
  cleaners.push(
    () => engine.close(),
    () => adapter.disconnect(),
  );
  return {
    engine,
    store,
    target,
    request,
    native,
    registry,
    m,
    stats: () => ({ riskCalls, lookups, sends }),
    deny: () => {
      deny = true;
    },
    amendment: () => amendment,
    reconciliation: () => ({ histories, applications }),
    delayHistory: () => {
      delayedHistory = true;
    },
    receipts: () => ({ nativeReceipt, proofReceipt }),
    missingHistory: () => {
      noEvidence = true;
    },
    race: () => {
      nativeCurrent = orderSchema.parse({
        ...native,
        updatedAt: now(),
        status: 'PARTIALLY_FILLED',
        filledQuantity: '9.5',
        averageFillPrice: { state: 'AVAILABLE', value: original.limitPrice },
      });
    },
  };
}
it.each([false, true])(
  'server AMEND owns immutable intent/risk/attempt and never resends after ambiguous=%s replay',
  async (unknown) => {
    const f = fixture(false, unknown);
    const result = await f.engine.amend(f.target.id, f.request);
    expect(result.command).toEqual(f.target.command);
    expect(result.activeOperation).toBe('AMEND');
    expect(result.reconciliation).toBe('REQUIRED');
    expect(result.status).toBe(unknown ? 'UNKNOWN' : 'SUBMITTED');
    expect(f.stats()).toEqual({ riskCalls: 1, lookups: 1, sends: 1 });
    const before = hash(f.amendment()?.command);
    expect(await f.engine.amend(f.target.id, f.request)).toEqual(result);
    expect(hash(f.amendment()?.command)).toBe(before);
    expect(f.stats()).toEqual({ riskCalls: 1, lookups: 1, sends: 1 });
    await expect(
      f.engine.amend(f.target.id, {
        ...f.request,
        replacement: {
          ...f.request.replacement,
          size: { ...f.request.replacement.size, value: parseDecimal('8') },
        },
      }),
    ).rejects.toThrow('ORDER_IDEMPOTENCY_CONFLICT');
    expect(f.stats().sends).toBe(1);
  },
);
it('exact dispatched AMEND replay survives current metadata replacement without Risk or native I/O', async () => {
  const f = fixture();
  await f.engine.amend(f.target.id, f.request);
  const current = await f.store.read(f.target.binding, f.target.id, {
    signal: new AbortController().signal,
    deadline: Date.now() + 1000,
  });
  expect(
    f.registry.put(
      {
        instrument: { ...instrument, metadataVersion: 'v2' },
        rules: {
          ...rules,
          version: 'v2',
          effectiveAt: Date.now() - 1,
          expiresAt: Date.now() + 60000,
        },
      },
      Date.now(),
    ).ok,
  ).toBe(true);
  expect(await f.engine.amend(f.target.id, f.request)).toEqual(current);
  expect(f.stats()).toEqual({ riskCalls: 1, lookups: 1, sends: 1 });
});
it('unsupported native AMEND refuses before intent, Risk and native lookup', async () => {
  const f = fixture(true);
  await expect(f.engine.amend(f.target.id, f.request)).rejects.toThrow('ORDER_AMEND_UNSUPPORTED');
  expect(f.amendment()).toBeUndefined();
  expect(f.stats()).toEqual({ riskCalls: 0, lookups: 0, sends: 0 });
});
it('AMEND authorization denial precedes durable intent, native lookup and Risk', async () => {
  const f = fixture();
  f.deny();
  await expect(f.engine.amend(f.target.id, f.request)).rejects.toThrow(
    'ORDER_AUTHORIZATION_DENIED',
  );
  expect(f.amendment()).toBeUndefined();
  expect(f.stats()).toEqual({ riskCalls: 0, lookups: 0, sends: 0 });
});
it.each([false, true])(
  'native causal reconciliation settles AMEND after ambiguous=%s without any resend or PLACE rewrite',
  async (unknown) => {
    const f = fixture(false, unknown);
    await f.engine.amend(f.target.id, f.request);
    const resolved = await f.engine.reconcile(f.target.id);
    expect(resolved).toMatchObject({
      reconciliation: 'CONSISTENT',
      activeAttemptId: null,
      activeOperation: null,
    });
    expect(resolved.command).toEqual(f.target.command);
    expect(resolved.effectiveCommand).toMatchObject({
      size: { value: '9' },
      clientOrderId: f.amendment()?.command.replacement.clientOrderId,
    });
    expect(f.reconciliation()).toEqual({ histories: 1, applications: 1 });
    expect(await f.engine.amend(f.target.id, f.request)).toEqual(resolved);
    expect((await f.engine.reconcile(f.target.id)).reconciliation).toBe('CONSISTENT');
    expect(f.reconciliation()).toEqual({ histories: 1, applications: 1 });
    expect(f.stats().sends).toBe(1);
  },
);
it('AMEND history lookup cannot renew an earlier native Order receipt', async () => {
  const f = fixture();
  await f.engine.amend(f.target.id, f.request);
  f.delayHistory();
  await f.engine.reconcile(f.target.id);
  const { proofReceipt, nativeReceipt } = f.receipts();
  expect(proofReceipt).toBeGreaterThan(0);
  // The final Order lookup is after history; its receipt cannot certify the earlier snapshot.
  expect(proofReceipt).toBeLessThan(nativeReceipt - 5);
});
it.each(['MISSING_HISTORY', 'FILL_RACE'] as const)(
  'AMEND %s cannot weaken UNKNOWN without full correlated native application',
  async (kind) => {
    const f = fixture(false, true);
    const submitted = await f.engine.amend(f.target.id, f.request);
    if (kind === 'MISSING_HISTORY') f.missingHistory();
    else f.race();
    await expect(f.engine.reconcile(f.target.id)).rejects.toThrow(
      /ORDER_HISTORY_REQUIRED|ORDER_AMEND_APPLICATION_UNPROVED/,
    );
    const current = await f.engine.get(f.target.id);
    expect(current.activeAttemptId).toBe(submitted.activeAttemptId);
    expect(current.reconciliation).toBe('REQUIRED');
    expect(current.effectiveCommand).toBeUndefined();
    expect(f.reconciliation().applications).toBe(0);
    expect(f.stats().sends).toBe(1);
    await f.engine.amend(f.target.id, f.request);
    expect(f.stats().sends).toBe(1);
  },
);
