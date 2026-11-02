import fs from 'node:fs';
import ts from 'typescript';
import { it, expect } from 'vitest';

it('history mutation fixture inserts a boundary edit without an incomplete newline replacement', () => {
  const source = fs.readFileSync(
    new URL('./execution-start-history.unit.test.mjs', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'history.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const incomplete = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'replace' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === '\n'
    ) {
      incomplete.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(incomplete).toEqual([]);
});
