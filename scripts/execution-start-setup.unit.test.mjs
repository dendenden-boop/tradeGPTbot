import fs from 'node:fs';
import ts from 'typescript';
import { it, expect } from 'vitest';
const source = fs.readFileSync(
  new URL('../packages/database/test/fixtures/paper-execution-start.ts', import.meta.url),
  'utf8',
);
const ast = ts.createSourceFile(
  'fixture.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
function calls(node, name) {
  const found = [];
  function visit(n) {
    if (ts.isCallExpression(n) && n.expression.getText(ast).endsWith(name)) found.push(n);
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}
const declaration = (name) =>
  ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
it('execution-start setup completes genuine funding before independent lanes and the full DRAFT before book initialization', () => {
  const fn = declaration('readyExecutionStart'),
    funding = calls(fn, 'funding.initialize')[0],
    book = calls(fn, 'book.initialize')[0],
    parallel = calls(fn, 'runIndependentFixtureSetup');
  expect(parallel).toHaveLength(1);
  expect(funding.pos).toBeLessThan(parallel[0].pos);
  expect(book.pos).toBeGreaterThan(parallel[0].end);
  const lanes = parallel[0].arguments[0];
  expect(ts.isArrayLiteralExpression(lanes)).toBe(true);
  expect(lanes.elements).toHaveLength(3);
  expect(calls(lanes.elements[0], 'orders.create')).toHaveLength(1);
  expect(calls(lanes.elements[1], 'startFixturePolicy')).toHaveLength(1);
  expect(calls(lanes.elements[2], 'runtime.head')).toHaveLength(1);
  for (const name of ['snapshots.publish', 'trades.publish']) {
    const publication = calls(fn, name);
    expect(publication).toHaveLength(1);
    expect(publication[0].pos).toBeGreaterThan(book.end);
    expect(publication[0].pos).toBeGreaterThan(calls(fn, 'runtime.context')[0].end);
    expect(publication[0].end).toBeLessThan(calls(fn, 'admission.approve')[0].pos);
  }
});
it('execution-start port constructors use three drainable readonly groups without dropping or duplicating any real authority', () => {
  const fn = declaration('open'),
    parallel = calls(fn, 'runIndependentFixtureSetup');
  expect(parallel).toHaveLength(1);
  const lanes = parallel[0].arguments[0];
  expect(ts.isArrayLiteralExpression(lanes)).toBe(true);
  expect(lanes.elements).toHaveLength(3);
  for (const name of [
    'createPostgresPaperConfiguration',
    'createPostgresPaperFunding',
    'createPostgresOrderStore',
    'createPostgresPaperPortfolioBootstrap',
    'createPostgresMarketSnapshots',
    'createPostgresMarketTrades',
    'createPostgresPaperRuntimeObservations',
    'createPostgresPolicies',
    'createPostgresControls',
    'createPostgresPaperOrderRiskPort',
    'createPostgresPaperAttemptJournal',
    'createPostgresPaperExecutionStartJournal',
    'createPostgresPaperReservationLifecycle',
  ])
    expect(calls(fn, name)).toHaveLength(
      ['createPostgresPolicies', 'createPostgresControls'].includes(name) ? 2 : 1,
    );
});
