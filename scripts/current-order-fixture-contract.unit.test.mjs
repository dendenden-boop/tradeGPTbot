import fs from 'node:fs';
import ts from 'typescript';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const source = fs
  .readFileSync('packages/database/test/paper-execution-commit.integration.test.ts', 'utf8')
  .replaceAll('\r\n', '\n');
const ast = ts.createSourceFile('native.ts', source, ts.ScriptTarget.Latest, true);
const declaration = (name) =>
  ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
it('preserves all forty-one accepted native case bodies while adding eight independent current-target cases', () => {
  const old = [];
  let count = 0;
  function visit(n) {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === 'it' &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      count++;
      if (!n.arguments[0].text.startsWith('paper-current-order-risk:'))
        old.push([n.arguments[0].text, n.getText(ast)]);
    }
    ts.forEachChild(n, visit);
  }
  visit(ast);
  old.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  expect(count).toBe(49);
  expect(old).toHaveLength(41);
  expect(createHash('sha256').update(JSON.stringify(old)).digest('hex')).toBe(
    '4a8d94326fd1bb86f3ed7bdc28a46deb16d1751358d2ccf167b91df212c5ae56',
  );
});
it('reuses only the reviewed default fixture constructors and retains real independent explicit-proxy openings', () => {
  const names = [
    'open',
    'openExecutedBook',
    'openExecutedValuation',
    'openHistorical',
    'openCurrentRisk',
  ];
  const wrappers = [];
  function visit(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && names.includes(n.name.text))
      wrappers.push(n);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  expect(wrappers.map((n) => n.name.text)).toEqual(names);
  for (const n of wrappers) {
    expect(ts.isCallExpression(n.initializer)).toBe(true);
    expect(n.initializer.expression.getText(ast)).toBe('createNativeDefaultFixturePort');
    expect(n.initializer.arguments[1].getText(ast)).toBe('startFixtureConnection');
    const actual = declaration(n.initializer.arguments[0].getText(ast));
    expect(actual.parameters[0].name.getText(ast)).toBe('connectionString');
    expect(actual.getText(ast)).toContain('connectionString,');
    expect(actual.getText(ast)).toContain("environment: 'test'");
  }
  // Current source concurrency/restart cases retain separately created ports.
  expect(declaration('openCurrentOrderRisk')).toBeDefined();
});
async function actualReady(f) {
  // Execute the actual test-only ready body with controlled public transports.
  // No production import, backend injection or financial authority is involved.
  const body = declaration('ready').getText(ast);
  const text = ts.transpileModule(
    'export function bind(readyExecutionStart,waitForFixtureClock,startIo,randomUUID,expect){' +
      body +
      ';return ready;}',
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    },
  ).outputText;
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
  );
  return module.bind(
    async () => f,
    async () => 200,
    () => ({ signal: new AbortController().signal, deadline: 2500 }),
    randomUUID,
    expect,
  );
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
function fixture() {
  return {
    c: { model: { latencyMs: 100, latencyJitterMs: 0 } },
    request: {},
    journal: { start: vi.fn(async () => ({ startedAt: 100 })) },
    f: {
      s: { key: {}, book: { sourceSequence: '9007199254740995' }, ticker: {} },
      p: { key: {}, trade: { sourceSequence: '9007199254740995' } },
    },
    snapshots: {
      read: vi.fn(async () => ({ revision: '1' })),
      publish: vi.fn(async () => ({ status: 'APPLIED' })),
    },
    trades: {
      read: vi.fn(async () => ({ revision: '1' })),
      publish: vi.fn(async () => ({ status: 'APPLIED' })),
    },
  };
}
it.each(['heads', 'publications'])(
  'drains the other actual public %s lane after failure and never reaches a financial writer',
  async (stage) => {
    const f = fixture(),
      a = deferred(),
      b = deferred(),
      name = stage === 'heads' ? 'read' : 'publish';
    f.snapshots[name].mockImplementation(() => a.promise);
    f.trades[name].mockImplementation(() => b.promise);
    const ready = await actualReady(f),
      financial = vi.fn();
    let settled = false;
    const result = ready().then(
      (value) => {
        settled = true;
        financial(value);
        return value;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await flush();
    expect(f.snapshots[name]).toHaveBeenCalledTimes(1);
    expect(f.trades[name]).toHaveBeenCalledTimes(1);
    const error = Error('public evidence failed');
    a.reject(error);
    await flush();
    expect(settled).toBe(false);
    b.resolve(stage === 'heads' ? { revision: '1' } : { status: 'APPLIED' });
    expect(await result).toBe(error);
    expect(financial).not.toHaveBeenCalled();
    if (stage === 'heads') {
      expect(f.snapshots.publish).not.toHaveBeenCalled();
      expect(f.trades.publish).not.toHaveBeenCalled();
    }
  },
);
it('waits for both genuine APPLIED receipts and preserves lossless sequence and existing IO deadlines', async () => {
  const f = fixture(),
    a = deferred(),
    b = deferred();
  f.snapshots.publish.mockImplementation(() => a.promise);
  f.trades.publish.mockImplementation(() => b.promise);
  const ready = await actualReady(f);
  let settled = false;
  const result = ready().then((v) => {
    settled = true;
    return v;
  });
  await flush();
  a.resolve({ status: 'APPLIED' });
  await flush();
  expect(settled).toBe(false);
  b.resolve({ status: 'APPLIED' });
  expect((await result).request.kind).toBe('PAPER_EXECUTION_COMMIT');
  for (const port of [f.snapshots, f.trades]) {
    expect(port.read).toHaveBeenCalledTimes(1);
    expect(port.publish).toHaveBeenCalledTimes(1);
    expect(port.publish.mock.calls[0][1].deadline).toBe(2500);
  }
  expect(f.snapshots.publish.mock.calls[0][0].book.sourceSequence).toBe('9007199254740996');
  expect(f.trades.publish.mock.calls[0][0].trade.sourceSequence).toBe('9007199254740996');
});
