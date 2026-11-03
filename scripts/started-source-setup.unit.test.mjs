import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { expect, it } from 'vitest';

const fixture = fs
  .readFileSync(
    new URL('../packages/database/test/fixtures/paper-execution-start.ts', import.meta.url),
    'utf8',
  )
  .replaceAll('\r\n', '\n');
const signature = `export async function readyExecutionStart(
  beforeEvidence?: (setup: {
    orders: Awaited<ReturnType<typeof open>>['orders'];
    binding: ReturnType<typeof bindingSchema.parse>;
    draft: ReturnType<typeof draftSchema.parse>;
  }) => Promise<void>,
) {`;
const hook = '  await beforeEvidence?.({ orders: ports.orders, binding, draft });\n';
it('started-source setup adds only an optional pre-evidence hook to the accepted START helper', () => {
  expect(fixture.split(signature)).toHaveLength(2);
  expect(fixture.split(hook)).toHaveLength(2);
  const original = fixture
    .replace(signature, 'export async function readyExecutionStart() {')
    .replace(hook, '');
  expect(createHash('sha256').update(original).digest('hex')).toBe(
    '806e35264ce573a11a995c161233d1ad875983639773d22b555427364b107f5b',
  );
});
it('started-source setup drains extra DRAFTs after bootstrap and before context and fresh market evidence', () => {
  const ast = ts.createSourceFile('fixture.ts', fixture, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'readyExecutionStart',
  );
  const calls = [];
  function visit(n) {
    if (ts.isCallExpression(n)) calls.push(n);
    ts.forEachChild(n, visit);
  }
  visit(fn);
  const find = (name) => calls.find((n) => n.expression.getText(ast).endsWith(name));
  const extra = find('beforeEvidence');
  expect(extra).toBeDefined();
  expect(ts.isAwaitExpression(extra.parent)).toBe(true);
  expect(extra.pos).toBeGreaterThan(find('book.initialize').end);
  for (const name of [
    'runtime.context',
    'Date.now',
    'snapshots.publish',
    'trades.publish',
    'admission.approve',
  ])
    expect(extra.end).toBeLessThan(find(name).pos);
});
it('started-source FIFO creates real extra DRAFTs in a drained setup group before finite evidence', () => {
  const test = fs.readFileSync(
    new URL('../packages/database/test/paper-started-source.integration.test.ts', import.meta.url),
    'utf8',
  );
  expect(test).toContain('readyExecutionStart(async ({ orders, binding, draft }) =>');
  expect(test).toContain('await Promise.allSettled([');
  expect(test).toContain('await enqueue(third!)');
  expect(test).not.toContain('const enqueue = async () =>');
});
