// RED source CI39924615978 exceeded the unchanged1020s parent after1370tests.
// Producer lifetimes only; the original financial readers/assertions remain pinned.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { expect, it } from 'vitest';
const path = 'packages/database/test/paper-risk-portfolio.integration.test.ts';
const source = () =>
  ts.createSourceFile(
    path,
    fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
const changing = new Set([
  'fixture',
  'prepared',
  'inventoryFixture',
  'openBook',
  'ownWriter',
  'configurationPort',
  'fundingPort',
]);
const caches = new Set(['configurationWriter', 'fundingWriter', 'bookWriter']);
const factories = new Set([
  'createPostgresPaperConfiguration',
  'createPostgresPaperFunding',
  'createPostgresPaperPortfolioBootstrap',
]);
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const printer = ts.createPrinter({ removeComments: true });
function root(n) {
  while (
    ts.isCallExpression(n) ||
    ts.isPropertyAccessExpression(n) ||
    ts.isElementAccessExpression(n)
  )
    n = n.expression;
  return ts.isIdentifier(n) ? n.text : null;
}
it('preserves every original portfolio native test body, financial reader, restart/role helper and cleanup', () => {
  const f = source();
  const kept = f.statements
    .filter(
      (s) =>
        !(ts.isFunctionDeclaration(s) && changing.has(s.name?.text)) &&
        !(
          ts.isVariableStatement(s) &&
          s.declarationList.declarations.every(
            (d) => ts.isIdentifier(d.name) && caches.has(d.name.text),
          )
        ),
    )
    .map((s) => s.getText(f));
  expect(kept).toHaveLength(59);
  expect(hash(kept)).toBe('ae26c7eca224b733f467ce68a734c266aa2c4a63d08197a0b35cad7384edf2dc');
});
it.each([
  ['fixture', 9, 'd723ac654aea53e5536a8785e95f723d56c84d53f3d58e73d85eae156fb328dd'],
  ['prepared', 5, '805ad6cbc66cf92f95a87b2b523463d7b5ccff0a74e9d23388d1a381f317ef4a'],
  ['inventoryFixture', 8, 'db13dc9453f08bb988f384b7416e8c1569917004ae9caa532ced06aa02865d89'],
  ['openBook', 1, 'c014dd5ac00039d6a8c0c41f5f9b38cd48e35997064269199e34db495329443f'],
])('retains fresh portfolio %s operations and parameters', (name, count, digest) => {
  const f = source(),
    fn = f.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name),
    calls = [];
  expect(fn).toBeDefined();
  function scan(n) {
    if (ts.isCallExpression(n)) {
      if (
        factories.has(root(n.expression)) ||
        ['handles', 'ownWriter', 'configurationPort', 'fundingPort'].includes(root(n.expression)) ||
        (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'close')
      )
        return;
      calls.push(printer.printNode(ts.EmitHint.Unspecified, n, f));
      return;
    }
    ts.forEachChild(n, scan);
  }
  scan(fn);
  expect(calls).toHaveLength(count);
  expect(hash(calls)).toBe(digest);
});
it('bounds default configuration funding and book producers to three and keeps explicit URL probes fresh', () => {
  const f = source();
  const names = f.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) =>
      s.declarationList.declarations
        .filter((d) => ts.isIdentifier(d.name) && caches.has(d.name.text))
        .map((d) => d.name.text),
    );
  expect(names.sort()).toEqual([...caches].sort());
  const fn = (name) =>
    f.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name)?.getText(f);
  expect(fn('configurationPort')).toContain('configurationWriter ??= ownWriter(');
  expect(fn('fundingPort')).toContain('fundingWriter ??= ownWriter(');
  expect(fn('openBook')).toContain('arguments.length === 0');
  expect(fn('openBook')).toContain('bookWriter ??= ownWriter(');
  expect(fn('openBook')).toContain('handles.push(h)');
  expect(fn('ownWriter')).toContain('handles.push(handle)');
});
