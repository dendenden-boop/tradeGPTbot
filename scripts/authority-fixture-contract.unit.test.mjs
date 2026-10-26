import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The existing native78/90s invocation is the performance regression. Only
// write-only fixture ownership may change; all original tests, readers,
// assertion helpers and cleanup must remain byte-equivalent after LF normalization.
const fixtureOnly = new Set([
  'updatePolicy',
  'updateControl',
  'fixture',
  'prepared',
  'fundCash',
  'ownWriter',
  'configurationPort',
  'fundingPort',
  // Producer calls/payloads in these three helpers remain pinned by the
  // complementary paper-authority fixture contract; no reader is excluded.
  'openBook',
  'ready',
  'runtimeEvidence',
  'runtimePort',
  'marketPorts',
]);
const writerCaches = new Set([
  'configurationWriter',
  'fundingWriter',
  'policyWriters',
  'controlWriters',
  'bookWriter',
  'runtimeWriter',
  'marketWriters',
]);
const source = (file, kind = ts.ScriptKind.TS) =>
  ts.createSourceFile(
    file,
    fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
const hash = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
function rootCall(node) {
  while (
    ts.isCallExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  )
    node = node.expression;
  return ts.isIdentifier(node) ? node.text : null;
}
it('retains every original authority assertion, reader/restart helper, cleanup and native78 owner invocation', () => {
  const file = source('packages/database/test/paper-risk-authority.integration.test.ts');
  const kept = file.statements
    .filter((statement) => {
      if (ts.isFunctionDeclaration(statement) && fixtureOnly.has(statement.name?.text)) {
        const assertions = [];
        const scan = (node) => {
          if (
            ts.isCallExpression(node) &&
            ['expect', 'it', 'afterAll', 'beforeAll', 'afterEach', 'beforeEach'].includes(
              rootCall(node),
            )
          )
            assertions.push(node.getText(file));
          ts.forEachChild(node, scan);
        };
        scan(statement);
        expect(assertions).toEqual([]);
        return false;
      }
      return !(
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.every(
          (d) => ts.isIdentifier(d.name) && writerCaches.has(d.name.text),
        )
      );
    })
    .map((statement) => statement.getText(file));
  expect(kept).toHaveLength(83);
  expect(hash(kept)).toBe('0f575539440a19e4dec24ef8203f3b5dcbec21a0b5c337094196ea326e7e14f8');
  const script = source('scripts/test-database.mjs', ts.ScriptKind.JS),
    owner = [];
  const scan = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'run' &&
      node.arguments[1]
        ?.getText(script)
        .includes("'packages/database/test/paper-risk-authority.integration.test.ts'")
    ) {
      let parent = node.parent;
      while (
        parent &&
        !(
          ts.isIfStatement(parent) &&
          parent.expression.getText(script) === "proof.mode !== 'cohorts'"
        )
      )
        parent = parent.parent;
      expect(parent, 'Owner invocation must remain inside the explicit CI partition').toBeDefined();
      // Canonicalize only the extra wrapper indentation; every original
      // argument, environment field and 90s deadline keeps its original hash.
      owner.push(node.getText(script).replace(/\n {2}/gu, '\n'));
    }
    ts.forEachChild(node, scan);
  };
  scan(script);
  expect(owner).toHaveLength(1);
  expect(hash(owner)).toBe('949daa6c1f483952934ce345b2acac240acd0a450f396461ab5e11632c4a939d');
});
