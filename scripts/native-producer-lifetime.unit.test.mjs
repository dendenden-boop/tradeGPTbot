import fs from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createOrderFixturePort } from '../packages/database/test/fixtures/order-fixture-port.js';
import { beforeNativeProducerLifetime } from './native-producer-lifetime-legacy.mjs';

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

it.each([
  [files[0], '7127adbc321026a83208071c92e46580b4c90090100933fce7062323e6f9f6f1'],
  [files[1], 'ba1bec74e31c9a1fcdc4df38dc3a09766f588833e4653df15eaca5418a23a408'],
])(
  'retains all original native assertions, readers, restart probes and cleanup in %s',
  (file, expected) => {
    const source = fs
        .readFileSync(new URL('../' + file, import.meta.url), 'utf8')
        .replaceAll('\r\n', '\n'),
      old = beforeNativeProducerLifetime(file, source);
    expect(createHash('sha256').update(old).digest('hex')).toBe(expected);
    expect(beforeNativeProducerLifetime(file, old)).toBe(old);
    for (const [block] of source.matchAll(
      /^[ \t]*\/\/ BEGIN NATIVE PRODUCER LIFETIME ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END NATIVE PRODUCER LIFETIME \1\n/gm,
    )) {
      const at = source.indexOf(block) + block.indexOf('\n') + 1;
      expect(() =>
        beforeNativeProducerLifetime(
          file,
          source.slice(0, at) + '// unreviewed\n' + source.slice(at),
        ),
      ).toThrow('NATIVE_PRODUCER_LIFETIME_REVIEW_REQUIRED');
    }
  },
);
it.each(['fixture', 'prepared'])(
  'retains every genuine book-source %s SQL call and payload',
  (name) => {
    const text = fs
        .readFileSync(new URL('../' + files[1], import.meta.url), 'utf8')
        .replaceAll('\r\n', '\n'),
      printer = ts.createPrinter({ removeComments: true });
    function calls(text) {
      const source = ts.createSourceFile(
          files[1],
          text,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
        fn = source.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name),
        found = [];
      function visit(node) {
        if (ts.isCallExpression(node)) {
          let root = node.expression;
          while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root))
            root = root.expression;
          if (
            (ts.isIdentifier(root) &&
              [
                'createPostgresPaperConfiguration',
                'createPostgresPaperFunding',
                'configurationPort',
                'fundingPort',
              ].includes(root.text)) ||
            (ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === 'close')
          )
            return;
          found.push(printer.printNode(ts.EmitHint.Unspecified, node, source));
          return;
        }
        ts.forEachChild(node, visit);
      }
      visit(fn);
      return found.sort();
    }
    expect(calls(text)).toEqual(calls(beforeNativeProducerLifetime(files[1], text)));
  },
);
it('bounds default book producers, preserves fresh explicit URLs and never caches method results', async () => {
  const file = files[1],
    text = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'),
    ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const variables = new Set(['configurationWriter', 'fundingWriter', 'bookWriter']),
    functions = new Set(['ownWriter', 'configurationPort', 'fundingPort', 'openBook']);
  const statements = ast.statements.filter(
    (n) =>
      (ts.isFunctionDeclaration(n) && functions.has(n.name?.text)) ||
      (ts.isVariableStatement(n) &&
        n.declarationList.declarations.every((d) => variables.has(d.name.getText(ast)))),
  );
  const code =
    'export function bind({handles,required,createPostgresPaperConfiguration,createPostgresPaperFunding,createPostgresPaperPortfolioBootstrap}) {' +
    statements.map((n) => n.getText(ast)).join('\n') +
    '\nreturn {configurationPort,fundingPort,openBook};}';
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  const { bind } = await import(
    'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
  );
  const handles = [],
    ports = [];
  const constructor = () =>
    vi.fn(async () => {
      const port = {
        register: vi.fn(async (request) => ({ request, stamp: {} })),
        initialize: vi.fn(async (request) => ({ request, stamp: {} })),
        close: vi.fn(async () => {}),
      };
      ports.push(port);
      return port;
    });
  const config = constructor(),
    fund = constructor(),
    book = constructor();
  const get = bind({
    handles,
    required: () => 'fixed-server-owned',
    createPostgresPaperConfiguration: config,
    createPostgresPaperFunding: fund,
    createPostgresPaperPortfolioBootstrap: book,
  });
  for (let n = 0; n < 300; n++) {
    const cfg = await get.configurationPort(),
      funding = await get.fundingPort(),
      bootstrap = await get.openBook();
    const request = { owner: n };
    expect((await cfg.register(request)).request).toBe(request);
    expect((await funding.initialize(request)).request).toBe(request);
    expect((await bootstrap.initialize(request)).request).toBe(request);
  }
  for (const construct of [config, fund, book]) expect(construct).toHaveBeenCalledTimes(1);
  expect(handles).toHaveLength(3);
  expect(ports[0].register).toHaveBeenCalledTimes(300);
  expect(ports[1].initialize).toHaveBeenCalledTimes(300);
  expect(ports[2].initialize).toHaveBeenCalledTimes(300);
  expect(await get.openBook('foreign-explicit')).not.toBe(await get.openBook('foreign-explicit'));
  expect(book).toHaveBeenCalledTimes(3);
  expect(handles).toHaveLength(5);
  for (const port of ports) expect(port.close).not.toHaveBeenCalled();
  await Promise.all(handles.map((h) => h.close()));
  for (const port of ports) expect(port.close).toHaveBeenCalledTimes(1);
});
