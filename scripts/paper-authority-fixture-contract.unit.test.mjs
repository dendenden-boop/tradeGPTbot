// Test-only fixture lifetimes; every existing test, reader and fresh operation stays mandatory.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { expect, it } from 'vitest';
const path = 'packages/database/test/paper-risk-authority.integration.test.ts';
const text = () =>
  fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const source = () =>
  ts.createSourceFile(path, text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const hash = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const changing = new Set(['openBook', 'ready', 'runtimeEvidence', 'runtimePort', 'marketPorts']);
const caches = new Set(['bookWriter', 'runtimeWriter', 'marketWriters']);
const constructors = new Set([
  'createPostgresPaperPortfolioBootstrap',
  'createPostgresPaperRuntimeObservations',
  'createPostgresMarketSnapshots',
  'createPostgresMarketTrades',
]);
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
it('preserves all original authority test bodies, readers, restart/role probes, fixture payloads and cleanup', () => {
  const file = source();
  const preserved = file.statements
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
    .map((s) => s.getText(file));
  expect(preserved).toHaveLength(95);
  expect(hash(preserved)).toBe('db51ef4b351272b8ffb6514293305b2b5f8422dcdafa09b0272562943d4917b5');
});
it.each([
  ['openBook', 1, 'c014dd5ac00039d6a8c0c41f5f9b38cd48e35997064269199e34db495329443f'],
  ['ready', 6, 'fc8de0f70bd7d95077f2bf4f0b085721e52e4cdbb4c590f2520bf0918559ca42'],
  ['runtimeEvidence', 5, 'dfb561375252d5bf8d89855f45785fd1721cecf28e19cd19153b0e1995e3bd2b'],
])('preserves all fresh %s operations and original parameters', (name, count, digest) => {
  const file = source(),
    fn = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name),
    calls = [];
  expect(fn).toBeDefined();
  function scan(n) {
    if (ts.isCallExpression(n)) {
      if (
        constructors.has(root(n.expression)) ||
        ['handles', 'runtimePort', 'marketPorts', 'ownWriter'].includes(root(n.expression)) ||
        (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'close')
      )
        return;
      calls.push(printer.printNode(ts.EmitHint.Unspecified, n, file));
      return;
    }
    ts.forEachChild(n, scan);
  }
  scan(fn);
  expect(calls).toHaveLength(count);
  expect(hash(calls)).toBe(digest);
});
it('bounds new authority producer handles to four and retains fresh foreign-book probes', () => {
  const file = source();
  const declared = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) =>
      s.declarationList.declarations
        .filter((d) => ts.isIdentifier(d.name) && caches.has(d.name.text))
        .map((d) => d.name.text),
    );
  expect(declared.sort()).toEqual([...caches].sort());
  const fn = (name) =>
    file.statements
      .find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name)
      ?.getText(file);
  expect(fn('openBook')).toContain("connectionString === required('DATABASE_PAPER_BOOK_URL')");
  expect(fn('openBook')).toContain('bookWriter ??=');
  expect(fn('openBook')).toContain('handles.push(h)');
  expect(fn('runtimePort')).toContain('runtimeWriter ??= ownWriter(');
  expect(fn('marketPorts')).toContain('marketWriters ??= Promise.all(');
  expect(fn('marketPorts')?.match(/ownWriter\(/gu)).toHaveLength(2);
});
