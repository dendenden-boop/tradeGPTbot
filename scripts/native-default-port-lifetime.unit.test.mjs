import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createNativeDefaultFixturePort as make } from '../packages/database/test/fixtures/native-default-port.js';
import { beforeNativeDefaultPort } from './native-default-port-legacy.mjs';

const server = 'postgres://fixed-fixture-default';
const port = () => ({
  perform: vi.fn(async (request) => request),
  reconcile: vi.fn(async (request) => request),
  close: vi.fn(async () => {}),
});
const gate = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

it('coalesces repeated default role constructors while every current request reaches the actual method', async () => {
  const actual = port(),
    open = vi.fn(async () => actual),
    get = make(open, () => server);
  const handles = await Promise.all(Array.from({ length: 300 }, () => get()));
  expect(open).toHaveBeenCalledTimes(1);
  for (let n = 0; n < handles.length; n++) {
    const request = { revision: n },
      io = { deadline: n + 1 };
    expect(await handles[n].perform(request, io)).toBe(request);
    expect(actual.perform).toHaveBeenLastCalledWith(request, io);
  }
  expect(actual.perform).toHaveBeenCalledTimes(300);
});

it('forwards concurrent calls independently with the actual receiver, arguments and unshared operation identity', async () => {
  const pending = gate(),
    entered = [],
    actual = {
      ...port(),
      perform(request, io) {
        expect(this).toBe(actual);
        const client = { request, io };
        entered.push(client);
        return pending.promise.then(() => client);
      },
    },
    get = make(
      async () => actual,
      () => server,
    ),
    handle = await get();
  const a = handle.perform('A', {}),
    b = handle.perform('B', {});
  expect(entered).toHaveLength(2);
  expect(entered[0]).not.toBe(entered[1]);
  pending.release();
  expect(await a).toBe(entered[0]);
  expect(await b).toBe(entered[1]);
});

it('keeps every explicit proxy or nondefault connection on a fresh actual constructor', async () => {
  const open = vi.fn(async () => port()),
    get = make(open, () => server),
    proxy = 'postgres://fixture-proxy';
  const a = await get(proxy),
    b = await get(proxy);
  expect(a).not.toBe(b);
  expect(open).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenNthCalledWith(1, proxy);
  expect(open).toHaveBeenNthCalledWith(2, proxy);
});

it('waits for one real physical close before constructing a fresh default lifetime', async () => {
  const closing = gate(),
    actual = { ...port(), close: vi.fn(() => closing.promise) },
    open = vi.fn().mockResolvedValueOnce(actual).mockResolvedValueOnce(port()),
    get = make(open, () => server),
    first = await get();
  const stop = first.close(),
    reopened = get();
  try {
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    closing.release();
    await stop;
    await reopened;
  }
  expect(open).toHaveBeenCalledTimes(2);
  await first.close();
  expect(actual.close).toHaveBeenCalledTimes(1);
});

it('retains failed physical cleanup without retrying or replacing the default authority', async () => {
  const error = Error('PHYSICAL_CLOSE_FAILED'),
    actual = {
      ...port(),
      close: vi.fn(async () => {
        throw error;
      }),
    },
    open = vi.fn(async () => actual),
    get = make(open, () => server),
    first = await get();
  await expect(first.close()).rejects.toBe(error);
  await expect(get()).rejects.toBe(error);
  expect(open).toHaveBeenCalledTimes(1);
});

it('retains a failed default constructor instead of silently retrying it', async () => {
  const error = Error('ROLE_UNSAFE'),
    open = vi.fn(async () => {
      throw error;
    }),
    get = make(open, () => server);
  await expect(get()).rejects.toBe(error);
  await expect(get()).rejects.toBe(error);
  expect(open).toHaveBeenCalledTimes(1);
});

it('keeps closed handles bound to their old actual instance after a genuine reopen', async () => {
  let closed = false;
  const error = Error('CLOSED'),
    a = {
      ...port(),
      perform: async () => {
        if (closed) throw error;
        return 'A';
      },
      close: vi.fn(async () => {
        closed = true;
      }),
    },
    b = port(),
    open = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b),
    get = make(open, () => server),
    old = await get();
  await old.close();
  const fresh = await get();
  await expect(old.perform()).rejects.toBe(error);
  await fresh.perform('B');
  expect(b.perform).toHaveBeenCalledWith('B');
  expect(open).toHaveBeenCalledTimes(2);
});

it('does not cache data snapshots, accessors or non-method properties as port authority', async () => {
  for (const actual of [
    { ...port(), snapshot: {} },
    Object.defineProperty(port(), 'policy', { get: () => ({}) }),
  ]) {
    await expect(
      make(
        async () => actual,
        () => server,
      )(),
    ).rejects.toThrow('NATIVE_FIXTURE_METHODS_REQUIRED');
  }
});

it('preserves all69 native statements and original budgets with a reviewed helper and mutation probes', () => {
  const file = 'packages/database/test/paper-admission.integration.test.ts',
    read = (name) =>
      readFileSync(new URL('../' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
    source = read(file);
  expect(source).toContain('// BEGIN NATIVE DEFAULT PORT IMPORT');
  expect(createHash('sha256').update(beforeNativeDefaultPort(file, source)).digest('hex')).toBe(
    '4b455dfbe1ba2be92d97da16b3d1147af8201df9e6218d16488568a67d2a6c33',
  );
  expect(() =>
    beforeNativeDefaultPort(
      file,
      source.replace('BEGIN NATIVE DEFAULT PORT LIFECYCLE', 'BEGIN NATIVE DEFAULT PORT OTHER'),
    ),
  ).toThrow();
  const helper = 'packages/database/test/fixtures/native-default-port.ts';
  expect(read('scripts/database-cohorts.mjs')).toContain("'" + helper + "'");
  expect(read('scripts/admission-overlap.unit.test.mjs').split("'" + helper + "'")).toHaveLength(3);
  expect(read('scripts/test-database.mjs')).toContain('secrets, echo: true, timeoutMs: 90000');
});
