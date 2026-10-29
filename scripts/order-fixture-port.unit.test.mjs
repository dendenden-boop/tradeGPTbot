import fs from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
const file = 'packages/database/test/paper-admission.integration.test.ts';
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
async function factory() {
  const url = new URL('../packages/database/test/fixtures/order-fixture-port.ts', import.meta.url);
  if (!fs.existsSync(url)) throw Error('ORDER_FIXTURE_PORT_MISSING');
  const { outputText } = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')))
    .createOrderFixturePort;
}
it('owns one lazy OrderStore constructor for simultaneous native fixture openings', async () => {
  const make = await factory(),
    port = Object.freeze({ create: vi.fn() }),
    open = vi.fn(async () => port),
    get = make(open);
  expect(open).not.toHaveBeenCalled();
  const values = await Promise.all(Array.from({ length: 300 }, () => get()));
  expect(open).toHaveBeenCalledTimes(1);
  expect(values.every((v) => v === port)).toBe(true);
  expect(await get()).toBe(port);
  expect(open).toHaveBeenCalledTimes(1);
});
it('retains no tenant, command, authority or result: every method call reaches the actual port', async () => {
  const make = await factory(),
    calls = [],
    port = {
      async create(binding, draft, io) {
        calls.push([binding, draft, io]);
        return { call: calls.length, tenantId: binding.tenantId };
      },
    },
    get = make(async () => port);
  const a = [{ tenantId: 'A' }, { key: 'one' }, { deadline: 1 }],
    b = [{ tenantId: 'B' }, { key: 'two' }, { deadline: 2 }];
  expect(await (await get()).create(...a)).toEqual({ call: 1, tenantId: 'A' });
  expect(await (await get()).create(...b)).toEqual({ call: 2, tenantId: 'B' });
  expect(calls).toEqual([a, b]);
  expect(calls[0][0]).toBe(a[0]);
  expect(calls[1][2]).toBe(b[2]);
});
it('retains failed constructor without retry or alternate role/database', async () => {
  const make = await factory(),
    failure = Error('NATIVE_ROLE_UNSAFE'),
    open = vi.fn(async () => {
      throw failure;
    }),
    get = make(open);
  for (let i = 0; i < 3; i++) await expect(get()).rejects.toBe(failure);
  expect(open).toHaveBeenCalledTimes(1);
});
it('keeps separate fixture lifetimes independent and does not wrap cleanup or methods', async () => {
  const make = await factory(),
    a = { close: vi.fn() },
    b = { close: vi.fn() },
    first = make(async () => a),
    second = make(async () => b);
  expect(await first()).toBe(a);
  expect(await second()).toBe(b);
  expect((await first()).close).toBe(a.close);
  expect(a.close).not.toHaveBeenCalled();
  expect(b.close).not.toHaveBeenCalled();
});
it('wires only the fixed native OrderStore factory through existing ownership/cleanup without changing old cases or budgets', () => {
  const s = read(file);
  expect(s).toContain("import { createOrderFixturePort } from './fixtures/order-fixture-port.js';");
  expect(s).toContain('const orderFixturePort = createOrderFixturePort(() =>');
  expect(s).toContain('ownWriter(\n    createPostgresOrderStore({');
  expect(s).toContain("connectionString: required('DATABASE_EXECUTION_URL')");
  expect(s).toContain('return orderFixturePort();');
  expect(s).toContain('await Promise.all(handles.map((h) => h.close()));');
  expect(s.match(/createOrderFixturePort\(/gu)).toHaveLength(1);
  expect(read('scripts/test-database.mjs')).toContain(
    '{ env: paperAdmissionEnvironment(databases[2]), secrets, echo: true, timeoutMs: 90000 }',
  );
});
it('reconstructs the exact old OrderStore factory and rejects incomplete or unexpected fixture changes', async () => {
  const { beforeOrderFixturePort } = await import('./order-fixture-port-legacy.mjs');
  const s = read(file),
    before = beforeOrderFixturePort(file, s);
  expect(before).toContain(
    'async function openOrders() {\n  const h = await createPostgresOrderStore({',
  );
  expect(before).not.toContain('order-fixture-port.js');
  expect(() =>
    beforeOrderFixturePort(
      file,
      s.replace('BEGIN ORDER FIXTURE PORT OPEN', 'BEGIN ORDER FIXTURE PORT OTHER'),
    ),
  ).toThrow();
  expect(() =>
    beforeOrderFixturePort(
      file,
      s + '// BEGIN ORDER FIXTURE PORT EXTRA\nchanged\n// END ORDER FIXTURE PORT EXTRA\n',
    ),
  ).toThrow();
});
it('includes the new helper in physical overlap fingerprints and existing mutation probes', () => {
  const file = 'packages/database/test/fixtures/order-fixture-port.ts';
  expect(read('scripts/database-cohorts.mjs')).toContain("'" + file + "'");
  expect(read('scripts/admission-overlap.unit.test.mjs').split("'" + file + "'")).toHaveLength(3);
});
