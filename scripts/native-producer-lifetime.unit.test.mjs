import fs from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { createOrderFixturePort } from '../packages/database/test/fixtures/order-fixture-port.js';

const files = [
  'packages/database/test/paper-risk-portfolio.integration.test.ts',
  'packages/database/test/paper-book-source.integration.test.ts',
];
async function actualOrderFactory(path, deps) {
  const text = fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = source.statements.filter(
    (s) =>
      (ts.isFunctionDeclaration(s) && s.name?.text === 'openOrders') ||
      (ts.isVariableStatement(s) &&
        s.declarationList.declarations.some((d) => d.name.getText(source) === 'orderFixturePort')),
  );
  const code =
    'export function bind({createPostgresOrderStore,required,handles,createOrderFixturePort,ownWriter}) {' +
    statements.map((s) => s.getText(source)).join('\n') +
    '\nreturn openOrders;}';
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return (
    await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'))
  ).bind(deps);
}
it.each(files)(
  'owns one actual OrderStore constructor across 300 independent fixture calls in %s',
  async (file) => {
    const handles = [],
      create = vi.fn(async (binding, draft) => ({ tenantId: binding.tenantId, key: draft.key }));
    const actual = Object.freeze({ create, close: vi.fn(async () => {}) }),
      open = vi.fn(async () => actual);
    const get = await actualOrderFactory(file, {
      createPostgresOrderStore: open,
      required: () => 'server-owned-fixed',
      handles,
      createOrderFixturePort,
      ownWriter: (promise) =>
        promise.then((h) => {
          handles.push(h);
          return h;
        }),
    });
    const ports = await Promise.all(Array.from({ length: 300 }, () => get()));
    expect(open).toHaveBeenCalledTimes(1);
    expect(handles).toEqual([actual]);
    for (let n = 0; n < ports.length; n++)
      expect(
        await ports[n].create({ tenantId: 'tenant-' + n }, { key: 'intent-' + n }, {}),
      ).toEqual({ tenantId: 'tenant-' + n, key: 'intent-' + n });
    expect(create).toHaveBeenCalledTimes(300);
    expect(actual.close).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith({
      connectionString: 'server-owned-fixed',
      environment: 'test',
    });
  },
);
