import fs from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const native = 'packages/database/test/paper-admission.integration.test.ts';
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
async function factory() {
  const file = new URL(
    '../packages/database/test/fixtures/admission-fixture-port.ts',
    import.meta.url,
  );
  if (!fs.existsSync(file)) throw Error('ADMISSION_FIXTURE_PORT_MISSING');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')))
    .createAdmissionFixturePort;
}
const port = () => ({ approve: vi.fn(), reconcileApproval: vi.fn(), close: vi.fn(async () => {}) });
it('owns one lazy actual admission transport for300 simultaneous default openings, never300 authority constructors', async () => {
  const make = await factory(),
    actual = port(),
    open = vi.fn(async () => actual),
    get = make(open);
  expect(open).not.toHaveBeenCalled();
  const all = await Promise.all(Array.from({ length: 300 }, () => get()));
  expect(open).toHaveBeenCalledTimes(1);
  expect(all.every((p) => p === all[0])).toBe(true);
  expect(await get()).toBe(all[0]);
});
it('forwards every approve/reconciliation input, IO and receiver to actual authority without caching financial results', async () => {
  const make = await factory(),
    calls = [],
    actual = {
      async approve(...args) {
        expect(this).toBe(actual);
        calls.push(['approve', ...args]);
        return { id: calls.length };
      },
      async reconcileApproval(...args) {
        expect(this).toBe(actual);
        calls.push(['read', ...args]);
        return { id: calls.length };
      },
      async close() {
        expect(this).toBe(actual);
      },
    },
    get = make(async () => actual),
    a = [{ tenantId: 'A', key: 'same' }, { deadline: 1 }],
    b = [{ tenantId: 'B', key: 'same' }, { deadline: 2 }];
  expect(await (await get()).approve(...a)).toEqual({ id: 1 });
  expect(await (await get()).approve(...a)).toEqual({ id: 2 });
  expect(await (await get()).reconcileApproval(...b)).toEqual({ id: 3 });
  expect(calls).toEqual([
    ['approve', ...a],
    ['approve', ...a],
    ['read', ...b],
  ]);
  expect(calls[0][1]).toBe(a[0]);
  expect(calls[2][2]).toBe(b[1]);
});
it('actual close retires only that lifetime, preserves physical restart and is idempotent', async () => {
  const make = await factory(),
    a = port(),
    b = port(),
    open = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b),
    get = make(open),
    first = await get();
  await first.close();
  const second = await get();
  expect(second).not.toBe(first);
  expect(open).toHaveBeenCalledTimes(2);
  await first.close();
  expect(a.close).toHaveBeenCalledTimes(1);
  expect(await get()).toBe(second);
  await second.close();
  expect(b.close).toHaveBeenCalledTimes(1);
});
it('does not construct a new transport until actual close physically settles', async () => {
  const make = await factory();
  let release;
  const stopped = new Promise((r) => (release = r)),
    a = { ...port(), close: vi.fn(() => stopped) },
    b = port(),
    open = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b),
    get = make(open),
    first = await get();
  const closing = first.close();
  let delivered = false;
  const next = get().then((v) => {
    delivered = true;
    return v;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(delivered).toBe(false);
  expect(open).toHaveBeenCalledTimes(1);
  release();
  await closing;
  expect(await next).not.toBe(first);
  expect(open).toHaveBeenCalledTimes(2);
});
it('retains failed constructor, without alternate credentials, fallback or automatic retry', async () => {
  const make = await factory(),
    error = Error('ROLE_UNSAFE'),
    open = vi.fn(async () => {
      throw error;
    }),
    get = make(open);
  for (let n = 0; n < 3; n++) await expect(get()).rejects.toBe(error);
  expect(open).toHaveBeenCalledTimes(1);
});
it('failed close cannot secretly replace broken authority with a healthy new instance', async () => {
  const make = await factory(),
    error = Error('PHYSICAL_CLOSE_FAILED'),
    a = {
      ...port(),
      close: vi.fn(async () => {
        throw error;
      }),
    },
    open = vi.fn(async () => a),
    get = make(open),
    first = await get();
  await expect(first.close()).rejects.toBe(error);
  await expect(get()).rejects.toBe(error);
  await expect(first.close()).rejects.toBe(error);
  expect(open).toHaveBeenCalledTimes(1);
  expect(a.close).toHaveBeenCalledTimes(1);
});
it('old closed handles continue reaching old actual port and cannot redirect into a reopened authority', async () => {
  const make = await factory();
  let closed = false;
  const error = Error('CLOSED'),
    a = {
      ...port(),
      approve: vi.fn(async () => {
        if (closed) throw error;
        return 'A';
      }),
      close: vi.fn(async () => {
        closed = true;
      }),
    },
    b = { ...port(), approve: vi.fn(async () => 'B') },
    open = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b),
    get = make(open),
    first = await get();
  await first.close();
  const second = await get();
  await expect(first.approve({}, {})).rejects.toBe(error);
  expect(await second.approve({}, {})).toBe('B');
  expect(b.approve).toHaveBeenCalledTimes(1);
});
it('separate fixture owners never share lifetime or account authority', async () => {
  const make = await factory(),
    a = port(),
    b = port(),
    getA = make(async () => a),
    getB = make(async () => b);
  const first = await getA(),
    second = await getB();
  expect(first).not.toBe(second);
  await first.close();
  expect(b.close).not.toHaveBeenCalled();
  expect(await getB()).toBe(second);
});
it('preserves all69 actual native bodies and options while fingerprinting/probing the new fixture lifetime', async () => {
  const name = './admission-port-lifetime-legacy.mjs';
  const { beforeAdmissionFixturePort } = await import(name);
  expect(
    createHash('sha256')
      .update(beforeAdmissionFixturePort(native, read(native)))
      .digest('hex'),
  ).toBe('4e497bdf4ae8228c2d0069851ffd0f9f7c1911809391ba73aaf14ab60726a245');
  expect(() =>
    beforeAdmissionFixturePort(
      native,
      read(native).replace(
        'BEGIN ADMISSION FIXTURE PORT OPEN',
        'BEGIN ADMISSION FIXTURE PORT OTHER',
      ),
    ),
  ).toThrow();
  const helper = 'packages/database/test/fixtures/admission-fixture-port.ts';
  expect(read('scripts/database-cohorts.mjs')).toContain("'" + helper + "'");
  expect(read('scripts/admission-overlap.unit.test.mjs').split("'" + helper + "'")).toHaveLength(3);
  expect(read('scripts/test-database.mjs')).toContain('secrets, echo: true, timeoutMs: 90000');
  expect(read(native)).toContain('await Promise.all(handles.map((h) => h.close()));');
});
