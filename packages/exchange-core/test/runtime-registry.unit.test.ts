import { afterEach, expect, it, vi } from 'vitest';
import { setTimeout as wait } from 'node:timers/promises';
import {
  createRuntimeInstrumentRegistry,
  isRuntimeInstrumentRegistry,
  type DurableInstrumentStore,
  type RegistryReceipt,
} from '../src/runtime-registry.js';
import { createInstrumentRegistry, type InstrumentRecord } from '../src/registry.js';
import { instrument, rules, scope } from './fixtures/adapter.js';
const handles: Awaited<ReturnType<typeof createRuntimeInstrumentRegistry>>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((r) => r.close()));
});
const io = (signal = new AbortController().signal) => ({ signal, deadline: Date.now() + 3000 });
const record = (v = 'v1'): InstrumentRecord => ({
  instrument: { ...instrument, metadataVersion: v },
  rules: { ...rules, version: v, effectiveAt: Date.now() - 1000, expiresAt: Date.now() + 60000 },
});
async function fixture() {
  const a = record();
  let rows: readonly RegistryReceipt[] = [{ revision: '1', record: a }];
  const store: DurableInstrumentStore = {
    read: vi.fn(() => Promise.resolve(rows)),
    publish: vi.fn<DurableInstrumentStore['publish']>((records) => {
      rows = records.map((r) => ({
        revision: (BigInt(rows[0]?.revision ?? '0') + 1n).toString(),
        record: r,
      }));
      return Promise.resolve(rows);
    }),
    close: vi.fn(async () => {}),
  };
  const registry = await createRuntimeInstrumentRegistry({
    scope,
    instrumentIds: ['BTCUSDT'],
    store,
  });
  handles.push(registry);
  return {
    registry,
    store,
    a,
    replace: (r: readonly RegistryReceipt[]) => {
      rows = r;
    },
  };
}
it('only explicit recovered runtime composition is registered; reference and structural copies are not', async () => {
  const x = await fixture();
  expect(isRuntimeInstrumentRegistry(x.registry)).toBe(true);
  expect(isRuntimeInstrumentRegistry({ ...x.registry })).toBe(false);
  expect(isRuntimeInstrumentRegistry(createInstrumentRegistry({ capacity: 300 }))).toBe(false);
});
it('does not publish a candidate before the store acknowledges durable COMMIT', async () => {
  const x = await fixture(),
    b = record('v2');
  let resolve!: (r: readonly RegistryReceipt[]) => void;
  x.store.publish = vi.fn<DurableInstrumentStore['publish']>(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = x.registry.put(b, Date.now(), io());
  expect(x.registry.get(scope, 'BTCUSDT', Date.now())).toMatchObject({ ok: true, value: x.a });
  resolve([{ revision: '2', record: b }]);
  expect(await pending).toMatchObject({ ok: true, value: b });
  expect(x.registry.get(scope, 'BTCUSDT', Date.now())).toMatchObject({ ok: true, value: b });
});
it('reads current durable metadata after a competing publisher, without treating projection as current authority', async () => {
  const x = await fixture(),
    b = record('v2');
  x.replace([{ revision: '9007199254740993', record: b }]);
  expect(await x.registry.readCurrent(scope, 'BTCUSDT', Date.now(), io())).toMatchObject({
    ok: true,
    value: b,
  });
  expect(x.registry.get(scope, 'BTCUSDT', Date.now())).toMatchObject({ ok: true, value: b });
});
it('fails closed on missing formerly recovered rows and cannot rejuvenate the old cache', async () => {
  const x = await fixture();
  x.replace([]);
  expect(await x.registry.readCurrent(scope, 'BTCUSDT', Date.now(), io())).toMatchObject({
    ok: false,
  });
  expect(x.registry.get(scope, 'BTCUSDT', Date.now())).toMatchObject({
    ok: false,
    error: { code: 'UNAVAILABLE' },
  });
  await wait(280);
  expect(x.registry.health().ready).toBe(false);
});
it('rejects equal durable revision with conflicting immutable content', async () => {
  const x = await fixture();
  x.replace([{ revision: '1', record: record('v2') }]);
  expect(await x.registry.readCurrent(scope, 'BTCUSDT', Date.now(), io())).toMatchObject({
    ok: false,
  });
  expect(x.registry.health().ready).toBe(false);
});
it('does not publish after abort while a noncompliant diagnostic store is settling', async () => {
  const x = await fixture(),
    b = record('v2'),
    controller = new AbortController();
  let resolve!: (r: readonly RegistryReceipt[]) => void;
  x.store.publish = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = x.registry.put(b, Date.now(), io(controller.signal));
  controller.abort();
  resolve([{ revision: '2', record: b }]);
  expect(await pending).toMatchObject({ ok: false });
  expect(x.registry.health().ready).toBe(false);
});
it('does not expose stale metadata or cross-scope records and closes permanently', async () => {
  const x = await fixture();
  expect(x.registry.get({ ...scope, environment: 'DEMO' }, 'BTCUSDT', Date.now())).toMatchObject({
    ok: false,
    error: { code: 'SCOPE_MISMATCH' },
  });
  expect(x.registry.get(scope, 'BTCUSDT', x.a.rules.expiresAt)).toMatchObject({
    ok: false,
    error: { code: 'STALE_METADATA' },
  });
  await x.registry.close();
  expect(x.registry.get(scope, 'BTCUSDT', Date.now())).toMatchObject({
    ok: false,
    error: { code: 'CLOSED' },
  });
  expect(x.registry.health().retained).toBe(0);
});
it('does not attest a backend whose startup recovery fails', async () => {
  const close = vi.fn(async () => {});
  const store: DurableInstrumentStore = {
    read: () => Promise.reject(new Error('storage unavailable')),
    publish: () => Promise.resolve([]),
    close,
  };
  await expect(
    createRuntimeInstrumentRegistry({ scope, instrumentIds: ['BTCUSDT'], store }),
  ).rejects.toThrow('REGISTRY_RECOVERY_FAILED');
  expect(close).toHaveBeenCalledOnce();
});
