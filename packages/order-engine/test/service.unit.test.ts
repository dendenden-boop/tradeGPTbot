/* eslint-disable @typescript-eslint/require-await -- Async contract fixtures deliberately resolve synchronously. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import {
  createExchangeAdapter,
  createInstrumentRegistry,
  orderSchema,
  operations,
  type Order,
  type AdapterTransport,
  type Authorization,
} from '@ctp/exchange-core';
import { createOrderEngine, type OrderRiskPort } from '../src/service.js';
import { state } from './fixtures.js';
import { bindingSchema, draftSchema } from '../src/domain.js';
import { memoryStore } from './memory.js';
import {
  instrument,
  rules,
  capabilities as baseCapabilities,
  account,
} from '../../exchange-core/test/fixtures/adapter.js';
const clock = () => Date.now();
const capabilities = () =>
  baseCapabilities.map((c) => ({ ...c, checkedAt: clock() - 1000, expiresAt: clock() + 60000 }));
const cleaners: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleaners.splice(0).map((f) => f()));
});
function fixture() {
  const s = state(),
    registry = createInstrumentRegistry({ capacity: 1 }),
    m = memoryStore(() => {
      const r = registry.get(instrument.scope, instrument.id, clock());
      if (!r.ok) throw new Error('ORDER_METADATA');
      return r.value.rules.version;
    });
  registry.put(
    { instrument, rules: { ...rules, effectiveAt: clock() - 1000, expiresAt: clock() + 60000 } },
    clock(),
  );
  const native = new Map<string, Order>();
  let submits = 0,
    cancels = 0,
    loss = false,
    denied = false;
  const transport: AdapterTransport = {
    async request(op, raw) {
      if (op === 'createOrder') {
        const r = operations.createOrder.input.parse(raw);
        submits++;
        native.set(
          r.command.clientOrderId,
          orderSchema.parse({
            account,
            scope: instrument.scope,
            instrumentId: instrument.id,
            internalOrderId: s.id,
            intentId: s.intentId,
            clientOrderId: r.command.clientOrderId,
            exchangeOrderId: 'remote-' + r.command.clientOrderId,
            side: r.command.side,
            type: r.command.type,
            status: 'OPEN',
            price: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
            stopPrice: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
            quantity: r.command.size.value,
            quantityUnit: 'BASE',
            filledQuantity: '0',
            averageFillPrice: { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' },
            fees: [],
            createdAt: 100,
            updatedAt: clock(),
          }),
        );
        if (loss) throw new Error('response lost');
        return {
          kind: 'ACCEPTED',
          ack: {
            commandId: r.authorization.commandId,
            status: 'ACKNOWLEDGED',
            exchangeId: 'remote-' + r.command.clientOrderId,
            receivedAt: clock(),
          },
        };
      }
      if (op === 'cancelOrder') {
        const r = operations.cancelOrder.input.parse(raw);
        cancels++;
        const n = native.get(r.command.locator.id);
        if (n) native.set(n.clientOrderId, { ...n, status: 'CANCELED', updatedAt: clock() + 1 });
        return {
          kind: 'ACCEPTED',
          ack: {
            commandId: r.authorization.commandId,
            status: 'ACKNOWLEDGED',
            exchangeId: n?.exchangeOrderId ?? null,
            receivedAt: clock(),
          },
        };
      }
      if (op === 'getOrder') {
        const r = operations.getOrder.input.parse(raw),
          n = native.get(r.locator.id);
        return n
          ? { kind: 'FOUND', order: n }
          : { kind: 'INDETERMINATE', reason: 'NOT_AUTHORITATIVE' };
      }
      if (op === 'getTrades') {
        const r = operations.getTrades.input.parse(raw);
        return { queryId: r.queryId, items: [], nextCursor: null };
      }
      throw new Error('Unsupported fixture operation');
    },
    async subscribe() {
      return () => Promise.resolve();
    },
    async disconnect() {},
  };
  const adapter = createExchangeAdapter({
    profile: s.binding.profile,
    account,
    capabilities: capabilities(),
    adapterVersion: 'v1',
    registry,
    transport,
    authorization: { authorize: (...args) => m.store.authorize(...args) },
    now: () => clock() + 10,
  });
  const risk: OrderRiskPort = {
    async approve() {
      return {
        decisionId: randomUUID(),
        reservationId: randomUUID(),
        permissionEpoch: '0',
        expiresAt: clock() + 10000,
      };
    },
  };
  const options = {
    binding: s.binding,
    authorization: {
      async check() {
        return !denied;
      },
    },
    risk,
    fills: {
      async ingest() {
        throw new Error('fixture has no fills');
      },
    },
    registry,
    store: m.store,
    adapter,
    now: () => clock() + 10,
  };
  const engine = createOrderEngine(options);
  cleaners.push(
    () => engine.close(),
    () => adapter.disconnect(),
  );
  return {
    s,
    m,
    registry,
    native,
    transport,
    options,
    engine,
    loss: () => {
      loss = true;
    },
    deny: () => {
      denied = true;
    },
    counts: () => ({ submits, cancels }),
  };
}
it('concurrent user clicks create one persisted command and conflicting key fails', async () => {
  const x = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => x.engine.create(x.s.draft)));
  expect(new Set(results.map((s) => s.id)).size).toBe(1);
  await expect(
    x.engine.create({ ...x.s.draft, order: { ...x.s.draft.order, side: 'SELL' } }),
  ).rejects.toThrow('ORDER_IDEMPOTENCY_CONFLICT');
});
it('exact mode binding and unsupported hedge/client identity fields fail closed', () => {
  const s = state();
  expect(bindingSchema.safeParse({ ...s.binding, mode: 'DEMO' }).success).toBe(false);
  expect(draftSchema.safeParse({ ...s.draft, positionSide: 'LONG' }).success).toBe(false);
  expect(
    draftSchema.safeParse({
      ...s.draft,
      order: { ...s.draft.order, clientOrderId: 'user-controlled' },
    }).success,
  ).toBe(false);
});
it.each(['LIVE', 'PAPER'] as const)('does not dispatch %s execution', async (mode) => {
  const x = fixture(),
    binding = {
      ...x.s.binding,
      mode,
      connectionId: mode === 'PAPER' ? null : x.s.binding.connectionId,
      profile: {
        ...x.s.binding.profile,
        environment: mode === 'LIVE' ? ('LIVE' as const) : ('TESTNET' as const),
      },
    };
  const adapter = {
    ...x.options.adapter,
    profile: binding.profile,
    account: mode === 'PAPER' ? null : x.options.adapter.account,
  };
  const engine = createOrderEngine({ ...x.options, binding, adapter });
  try {
    await expect(engine.submit(randomUUID())).rejects.toThrow(
      mode === 'LIVE' ? 'ORDER_LIVE_DISABLED' : 'ORDER_PAPER_ENGINE_REQUIRED',
    );
    expect(x.counts().submits).toBe(0);
  } finally {
    await engine.close();
  }
});
it('abort retains owned capacity until port promises settle and close drains them', async () => {
  const x = fixture(),
    controller = new AbortController();
  let release = () => {};
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const engine = createOrderEngine({
    ...x.options,
    authorization: {
      async check() {
        await blocked;
        return true;
      },
    },
    operationTimeoutMs: 500,
  });
  const pending = Array.from({ length: 32 }, () =>
    engine.get(randomUUID(), controller.signal).catch((e) => e as Error),
  );
  await expect(engine.get(randomUUID())).rejects.toThrow('ORDER_BUSY');
  controller.abort();
  await expect(engine.get(randomUUID())).rejects.toThrow('ORDER_BUSY');
  let closed = false;
  const closing = engine.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  expect(
    (await Promise.all(pending)).every((e) => e instanceof Error && e.message === 'ORDER_ABORTED'),
  ).toBe(true);
  await closing;
  await expect(engine.get(randomUUID())).rejects.toThrow('ORDER_CLOSED');
});
it('two execution workers dispatch one placement', async () => {
  const x = fixture();
  const s = await x.engine.create(x.s.draft);
  await Promise.all([x.engine.submit(s.id), x.engine.submit(s.id)]);
  expect(x.counts().submits).toBe(1);
});
it('fresh complete history can resolve a gap even when the positive native snapshot is unchanged', async () => {
  const x = fixture(),
    s = await x.engine.create(x.s.draft);
  await x.engine.submit(s.id);
  await x.engine.reconcile(s.id);
  await x.m.store.gap(x.s.binding, s.id, {
    signal: new AbortController().signal,
    deadline: Date.now() + 3000,
  });
  expect((await x.engine.reconcile(s.id)).reconciliation).toBe('CONSISTENT');
  expect(x.counts().submits).toBe(1);
});
it('exchange acceptance with lost response recovers by client ID across handle restart, never second POST', async () => {
  const x = fixture();
  x.loss();
  const s = await x.engine.create(x.s.draft);
  expect((await x.engine.submit(s.id)).status).toBe('UNKNOWN');
  const restarted = createOrderEngine(x.options);
  cleaners.push(() => restarted.close());
  await restarted.submit(s.id);
  expect((await restarted.reconcile(s.id)).status).toBe('SUBMITTED');
  expect(x.counts().submits).toBe(1);
});
it('negative lookup stays blocking and never authorizes resubmit', async () => {
  const x = fixture();
  x.loss();
  const s = await x.engine.create(x.s.draft);
  await x.engine.submit(s.id);
  x.native.clear();
  expect((await x.engine.reconcile(s.id)).reconciliation).toBe('REQUIRED');
  await x.engine.submit(s.id);
  expect(x.counts().submits).toBe(1);
});
it('cancel acknowledgment is pending until positive terminal lookup; identical command is not dispatched twice', async () => {
  const x = fixture();
  const s = await x.engine.create(x.s.draft);
  await x.engine.submit(s.id);
  await x.engine.reconcile(s.id);
  expect((await x.engine.cancel(s.id, 'cancel-click')).status).toBe('CANCEL_PENDING');
  await x.engine.cancel(s.id, 'cancel-click');
  expect(x.counts().cancels).toBe(1);
  expect((await x.engine.reconcile(s.id)).status).toBe('CANCELED');
});
it('revoked principal rejects all operations without exposing injected secret errors', async () => {
  const x = fixture();
  x.deny();
  await expect(x.engine.create(x.s.draft)).rejects.toThrow('ORDER_AUTHORIZATION_DENIED');
  const bad = createOrderEngine({
    ...x.options,
    authorization: { check: () => Promise.reject(new Error('SECRET_PRIVATE_VALUE')) },
  });
  cleaners.push(() => bad.close());
  await expect(bad.create(x.s.draft)).rejects.toThrow('ORDER_STORE_FAILED');
  expect(x.counts().submits).toBe(0);
});
it('cancels an existing order after metadata refresh without rewriting its placement command', async () => {
  const x = fixture(),
    s = await x.engine.create(x.s.draft);
  await x.engine.submit(s.id);
  await x.engine.reconcile(s.id);
  expect(
    x.registry.put(
      {
        instrument: { ...instrument, metadataVersion: 'v2' },
        rules: { ...rules, version: 'v2', effectiveAt: clock() - 10, expiresAt: clock() + 60000 },
      },
      clock(),
    ).ok,
  ).toBe(true);
  expect((await x.engine.cancel(s.id, 'after-refresh')).status).toBe('CANCEL_PENDING');
  expect(x.counts().cancels).toBe(1);
  expect((await x.engine.get(s.id)).command.ruleVersion).toBe('v1');
});
it('metadata replacement during asynchronous Risk evaluation prevents claim/dispatch', async () => {
  const x = fixture();
  const s = await x.engine.create(x.s.draft);
  const engine = createOrderEngine({
    ...x.options,
    risk: {
      approve: async () => {
        x.registry.put(
          {
            instrument: { ...instrument, metadataVersion: 'v2' },
            rules: {
              ...rules,
              expiresAt: clock() + 60000,
              version: 'v2',
              effectiveAt: clock() + 1,
            },
          },
          clock() + 10,
        );
        return {
          decisionId: randomUUID(),
          reservationId: randomUUID(),
          permissionEpoch: '0',
          expiresAt: clock() + 10000,
        };
      },
    },
  });
  cleaners.push(() => engine.close());
  await expect(engine.submit(s.id)).rejects.toThrow('ORDER_METADATA');
  expect(x.m.claims.size).toBe(0);
});
it('Risk denial and abort before claim do not send a mutation', async () => {
  const x = fixture();
  const s = await x.engine.create(x.s.draft);
  const engine = createOrderEngine({
    ...x.options,
    risk: { approve: () => Promise.reject(new Error('deny')) },
  });
  cleaners.push(() => engine.close());
  await expect(engine.submit(s.id)).rejects.toThrow('ORDER_STORE_FAILED');
  const c = new AbortController();
  c.abort();
  await expect(x.engine.submit(s.id, c.signal)).rejects.toThrow('ORDER_ABORTED');
  expect(x.counts().submits).toBe(0);
});
it('revocation during a durable claim prevents the following transport dispatch', async () => {
  const x = fixture(),
    engine = createOrderEngine({
      ...x.options,
      store: {
        ...x.m.store,
        async begin(...args) {
          const claim = await x.m.store.begin(...args);
          x.deny();
          return claim;
        },
      },
    });
  cleaners.push(() => engine.close());
  const s = await engine.create(x.s.draft);
  expect((await engine.submit(s.id)).status).toBe('REJECTED');
  expect(x.counts().submits).toBe(0);
});
it('one-use adapter authorization rejects reused dispatch permit', async () => {
  const x = fixture();
  const s = await x.engine.create(x.s.draft);
  await x.engine.submit(s.id);
  const c = x.m.claims.get(s.intentId)!;
  const authorization: Authorization = {
    commandId: c.intentId,
    dispatchAttemptId: c.attemptId,
    commandHash: c.commandHash,
    profile: x.s.binding.profile,
    account,
    issuedAt: clock(),
    expiresAt: clock() + 1000,
  };
  expect(await x.m.store.authorize('createOrder', { authorization, command: s.command }, {})).toBe(
    false,
  );
});
it('real loopback HTTP lost response settles and recovers without duplicate submission', async () => {
  const x = fixture();
  let posts = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      posts++;
      void x.transport
        .request('createOrder', body, {
          profile: x.s.binding.profile,
          account,
          signal: new AbortController().signal,
          deadline: Date.now() + 1000,
          correlationId: 'loopback',
        })
        .then(() => req.socket.destroy());
    } else {
      res.end('{}');
    }
  });
  let body: unknown;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error();
  const url = `http://127.0.0.1:${address.port}`;
  const transport = {
    ...x.transport,
    async request(
      op: Parameters<AdapterTransport['request']>[0],
      r: unknown,
      c: Parameters<AdapterTransport['request']>[2],
    ) {
      if (op === 'createOrder') {
        body = r;
        await fetch(url, { method: 'POST', signal: c.signal });
        throw new Error('lost');
      }
      return x.transport.request(op, r, c);
    },
  };
  const adapter = createExchangeAdapter({
    profile: x.s.binding.profile,
    account,
    capabilities: capabilities(),
    adapterVersion: 'v1',
    registry: x.registry,
    transport,
    authorization: { authorize: (...args) => x.m.store.authorize(...args) },
    now: () => clock() + 10,
  });
  const engine = createOrderEngine({ ...x.options, adapter });
  try {
    const s = await engine.create(x.s.draft);
    expect((await engine.submit(s.id)).status).toBe('UNKNOWN');
    await engine.reconcile(s.id);
    await engine.submit(s.id);
    expect(posts).toBe(1);
  } finally {
    await engine.close();
    await adapter.disconnect();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
