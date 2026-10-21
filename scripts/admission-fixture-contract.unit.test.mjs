// Parent1020s CI deadline is the RED performance reproduction. This guard only
// permits fixture-handle lifetime changes; no assertion, fresh operation,
// reader/restart lifecycle, producer payload or deadline may be removed.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { expect, it } from 'vitest';
const path = 'packages/database/test/paper-admission.integration.test.ts';
const fixtureOnly = new Set([
  'updatePolicy',
  'updateControl',
  'fixture',
  'fundCash',
  'openBook',
  'runtimeEvidence',
  'ownWriter',
  'configurationPort',
  'fundingPort',
  'runtimePort',
]);
const caches = new Set([
  'configurationWriter',
  'fundingWriter',
  'bookWriter',
  'runtimeWriter',
  'policyWriters',
  'controlWriters',
]);
const factories = new Set([
  'createPostgresPaperConfiguration',
  'createPostgresPaperFunding',
  'createPostgresPaperPortfolioBootstrap',
  'createPostgresPolicies',
  'createPostgresControls',
  'createPostgresPaperRuntimeObservations',
]);
const text = (file) =>
  fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const source = () =>
  ts.createSourceFile(path, text(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const hash = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const printer = ts.createPrinter({ removeComments: true });
function root(node) {
  while (
    ts.isCallExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  )
    node = node.expression;
  return ts.isIdentifier(node) ? node.text : null;
}
it('retains all72 original non-fixture statements, all33 test bodies, readers, restart helpers and cleanup', () => {
  const file = source();
  const kept = file.statements
    .filter(
      (s) =>
        !(ts.isFunctionDeclaration(s) && fixtureOnly.has(s.name?.text)) &&
        !(
          ts.isVariableStatement(s) &&
          s.declarationList.declarations.every(
            (d) => ts.isIdentifier(d.name) && caches.has(d.name.text),
          )
        ),
    )
    .map((s) => s.getText(file));
  expect(kept).toHaveLength(72);
  expect(hash(kept)).toBe('b40e952b8a9dcdf422ecaa6a7d221de59e396962a151b8af4638c4b6487bc8c9');
});
it.each([
  ['updatePolicy', 2, '3deb5ffdd5c335fdfdb3e8d50c3c1be9640f4701e93eda5c98df039770580dbb'],
  ['updateControl', 3, '2de99fb8459dd23bc0b9d9b04c2f1c671696f7afba3d21f7216135a6b1aca8c4'],
  ['fixture', 9, 'd723ac654aea53e5536a8785e95f723d56c84d53f3d58e73d85eae156fb328dd'],
  ['fundCash', 3, 'ea68480a356ae6913aa0d92246a2bb9027c54dc432e748de581474403215288d'],
  ['openBook', 0, '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'],
  ['runtimeEvidence', 5, 'dfb561375252d5bf8d89855f45785fd1721cecf28e19cd19153b0e1995e3bd2b'],
])(
  'preserves every fresh %s query/command/publication and its original parameters',
  (name, count, digest) => {
    const file = source(),
      fn = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name),
      calls = [];
    expect(fn).toBeDefined();
    const scan = (n) => {
      if (ts.isCallExpression(n)) {
        const key = root(n.expression);
        if (
          factories.has(key) ||
          fixtureOnly.has(key) ||
          caches.has(key) ||
          key === 'required' ||
          key === 'handles' ||
          (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'close')
        )
          return;
        calls.push(printer.printNode(ts.EmitHint.Unspecified, n, file));
        return;
      }
      ts.forEachChild(n, scan);
    };
    scan(fn);
    expect(calls).toHaveLength(count);
    expect(hash(calls)).toBe(digest);
  },
);
it('bounds fixture caches to eight server-owned handles and drains each through the original afterAll', () => {
  const file = source(),
    own = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'ownWriter');
  expect(own, 'Bounded shared fixture handle owner is required').toBeDefined();
  const names = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) =>
      s.declarationList.declarations
        .filter((d) => ts.isIdentifier(d.name) && caches.has(d.name.text))
        .map((d) => d.name.text),
    );
  expect(names.sort()).toEqual([...caches].sort());
  const tracked = [],
    constructors = [];
  const scan = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      root(n.expression) === 'handles' &&
      n.expression.name.text === 'push'
    )
      tracked.push(n);
    if (ts.isCallExpression(n) && root(n.expression) === 'ownWriter') constructors.push(n);
    ts.forEachChild(n, scan);
  };
  scan(own);
  expect(tracked).toHaveLength(1);
  scan(file);
  for (const call of constructors) expect(factories.has(root(call.arguments[0]))).toBe(true);
  expect(constructors).toHaveLength(7); // Four singleton writers + two maps with2authorities; foreign book URL stays fresh.
});
it('retains the whole native runner, all owner/cohort assertions and1020s/480s/90s budgets', () => {
  expect(createHash('sha256').update(text('scripts/test-database.mjs')).digest('hex')).toBe(
    '613552de72cbe9aa7e7476a52fa52b152cf21d5bbfa829342c014cb8eb7165ad',
  );
  expect(createHash('sha256').update(text('scripts/integration-proof.mjs')).digest('hex')).toBe(
    '0b5859334fc36a31c68211e1bee7e26fbd487644d5621c16a0f6a5b5846f596e',
  );
});
