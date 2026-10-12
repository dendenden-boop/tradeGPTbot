import { afterEach, expect, it, vi } from 'vitest';
import { createExchangeAdapter, createInstrumentRegistry } from '@ctp/exchange-core';
import { createOrderEngine } from '../src/service.js';
import { bindingSchema, draftSchema } from '../src/domain.js';
import { state } from './fixtures.js';
import { memoryStore } from './memory.js';
import { instrument, rules } from '../../exchange-core/test/fixtures/adapter.js';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});
function fixture(change: Record<string, unknown> = {}) {
  const s = state(),
    now = () => Date.now();
  const binding = bindingSchema.parse({
    ...s.binding,
    mode: 'PAPER',
    connectionId: null,
    profile: {
      ...s.binding.profile,
      accountMode: 'SIMULATED',
      endpointProfileId: 'paper-spot-v1',
      profileVersion: 'spot-l2-taker-v1',
      ...change,
    },
  });
  const registry = createInstrumentRegistry({ capacity: 1 });
  registry.put(
    { instrument, rules: { ...rules, effectiveAt: now() - 1000, expiresAt: now() + 60000 } },
    now(),
  );
  const m = memoryStore();
  const request = vi.fn(() => Promise.reject(new Error('TEST_TRANSPORT_MUST_NOT_RUN')));
  const adapter = createExchangeAdapter({
    profile: binding.profile,
    account: null,
    capabilities: [],
    adapterVersion: 'paper-draft-test',
    registry,
    now,
    transport: {
      request,
      subscribe: () => Promise.reject(new Error('TEST_STREAM_MUST_NOT_RUN')),
      disconnect: () => Promise.resolve(),
    },
  });
  const approve = vi.fn(() => Promise.reject(new Error('TEST_RISK_MUST_NOT_RUN')));
  const ingest = vi.fn(() => Promise.reject(new Error('TEST_FILL_MUST_NOT_RUN')));
  const check = vi.fn(() => Promise.resolve(true));
  const engine = createOrderEngine({
    binding,
    authorization: { check },
    risk: { approve },
    fills: { ingest },
    registry,
    store: m.store,
    adapter,
    now,
  });
  closes.push(
    () => engine.close(),
    () => adapter.disconnect(),
  );
  return { binding, draft: s.draft, engine, m, check, approve, ingest, request, registry, now };
}
it('common PAPER draft creation invokes authorization but neither Risk nor transport nor Portfolio', async () => {
  const f = fixture(),
    result = await f.engine.create(f.draft);
  expect(result.binding).toEqual(f.binding);
  expect(result.command.clientOrderId).toBe('1');
  expect(f.check).toHaveBeenCalledWith(f.binding, 'CREATE', expect.any(Object));
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.ingest).not.toHaveBeenCalled();
});
it('PAPER CREATE authorization denial cannot persist a draft', async () => {
  const f = fixture();
  f.check.mockResolvedValue(false);
  await expect(f.engine.create(f.draft)).rejects.toThrow('ORDER_AUTHORIZATION_DENIED');
  expect(f.m.orders.size).toBe(0);
});
it.each(['credential', 'endpoint', 'version', 'accountMode'])(
  'PAPER %s profile cannot create a new common intent',
  async (kind) => {
    const change =
      kind === 'credential'
        ? { credentialRef: 'forbidden' }
        : kind === 'endpoint'
          ? { endpointProfileId: 'test-reference' }
          : kind === 'version'
            ? { profileVersion: 'v2' }
            : { accountMode: 'SPOT' };
    const f = fixture(change);
    await expect(f.engine.create(f.draft)).rejects.toThrow('ORDER_PAPER_CONFIGURATION');
    expect(f.m.orders.size).toBe(0);
  },
);
it('PAPER POST_ONLY is rejected before common intent creation', async () => {
  const f = fixture();
  const draft = draftSchema.parse({
    ...f.draft,
    order: { ...f.draft.order, type: 'LIMIT', limitPrice: '10', timeInForce: 'POST_ONLY' },
  });
  await expect(f.engine.create(draft)).rejects.toThrow('ORDER_PAPER_ORDER_UNSUPPORTED');
  expect(f.m.orders.size).toBe(0);
});
it('exact PAPER service replay remains durable-lookup-first after metadata replacement', async () => {
  const f = fixture(),
    original = await f.engine.create(f.draft);
  f.registry.put(
    {
      instrument: { ...instrument, metadataVersion: 'v2' },
      rules: { ...rules, version: 'v2', effectiveAt: f.now() - 1, expiresAt: f.now() + 60000 },
    },
    f.now(),
  );
  expect(await f.engine.create(f.draft)).toEqual(original);
  await expect(f.engine.create({ ...f.draft, key: 'new-stale-key' })).rejects.toThrow(
    'ORDER_METADATA',
  );
  expect(f.m.orders.size).toBe(1);
});
it('PAPER submit cancel and amend remain disabled before Risk attempt or transport', async () => {
  const f = fixture(),
    s = await f.engine.create(f.draft);
  await expect(f.engine.submit(s.id)).rejects.toThrow('ORDER_PAPER_ENGINE_REQUIRED');
  await expect(f.engine.cancel(s.id, 'cancel-key')).rejects.toThrow('ORDER_PAPER_ENGINE_REQUIRED');
  await expect(
    f.engine.amend(s.id, {
      key: 'amend-key',
      expectedVersion: '1',
      dbRuleId: f.draft.dbRuleId,
      replacement: f.draft.order,
    }),
  ).rejects.toThrow('ORDER_PAPER_ENGINE_REQUIRED');
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.ingest).not.toHaveBeenCalled();
});
