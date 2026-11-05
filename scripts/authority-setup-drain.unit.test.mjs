import fs from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { beforeAuthoritySetup } from './authority-setup-legacy.mjs';

async function factory() {
  const file = new URL('../packages/database/test/fixtures/authority-setup.ts', import.meta.url);
  if (!fs.existsSync(file)) throw Error('AUTHORITY_FIXTURE_PAIR_MISSING');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')))
    .settleAuthorityFixturePair;
}
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it('starts both independent real setup lanes before either one settles, retaining tuple order', async () => {
  const run = await factory(),
    a = gate(),
    b = gate();
  const lanes = [vi.fn(() => a.promise), vi.fn(() => b.promise)];
  const result = run(lanes);
  await flush();
  for (const lane of lanes) expect(lane).toHaveBeenCalledTimes(1);
  b.resolve('orders');
  a.resolve('funding');
  expect(await result).toEqual(['funding', 'orders']);
});
it.each(['sync', 'async'])(
  'drains the other physical lane after %s failure without returning a partially ready fixture',
  async (kind) => {
    const run = await factory(),
      other = gate(),
      failure = Error('setup failed');
    let settled = false;
    const bad = vi.fn(() => {
      if (kind === 'sync') throw failure;
      return Promise.reject(failure);
    });
    const good = vi.fn(() => other.promise);
    const result = run([bad, good]).catch((error) => {
      settled = true;
      return error;
    });
    await flush();
    expect(good).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    other.resolve({});
    expect(await result).toBe(failure);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  },
);
it('reports original lane ordering after multiple failures, including undefined rejection', async () => {
  const run = await factory(),
    a = gate(),
    b = gate();
  const result = run([() => a.promise, () => b.promise]).then(
    () => 'unsafe',
    (e) => e,
  );
  b.reject(Error('later lane'));
  a.reject(undefined);
  expect(await result).toBeUndefined();
});
it('performs fresh work for every setup and retains no tenant, authority, receipt or result', async () => {
  const run = await factory(),
    a = vi.fn(async () => ({ nonce: {} })),
    b = vi.fn(async () => ({}));
  const first = await run([a, b]),
    second = await run([a, b]);
  expect(first[0]).not.toBe(second[0]);
  expect(first[1]).not.toBe(second[1]);
  expect(a).toHaveBeenCalledTimes(2);
  expect(b).toHaveBeenCalledTimes(2);
});
it('fails closed before any setup for invalid lane shapes', async () => {
  const run = await factory(),
    lane = vi.fn(async () => ({}));
  for (const lanes of [[], [lane], [lane, lane, lane], [lane, null], Array(2), null])
    await expect(run(lanes)).rejects.toThrow('AUTHORITY_FIXTURE_LANES');
  expect(lane).not.toHaveBeenCalled();
});

const path = 'packages/database/test/paper-risk-authority.integration.test.ts';
const source = () =>
  fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
it('retains the entire previous native fixture, including all 78 assertions and every reader/restart probe', () => {
  const original = beforeAuthoritySetup(path, source());
  expect(createHash('sha256').update(original).digest('hex')).toBe(
    '1e300663900da6519ba882335b2eef0c9d77f98349420a9c9473d041b78a68ce',
  );
  expect(beforeAuthoritySetup(path, original)).toBe(original);
});
it.each(['prepared', 'ready'])(
  'preserves every real %s setup call and payload without memoizing evidence or policies',
  (name) => {
    const printer = ts.createPrinter({ removeComments: true });
    function calls(text) {
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const node = file.statements.find(
          (s) => ts.isFunctionDeclaration(s) && s.name?.text === name,
        ),
        result = [];
      function scan(n) {
        if (
          ts.isCallExpression(n) &&
          !['settleAuthorityFixturePair', 'runIndependentFixtureSetup'].includes(
            n.expression.getText(file),
          )
        )
          result.push(printer.printNode(ts.EmitHint.Unspecified, n, file));
        ts.forEachChild(n, scan);
      }
      scan(node);
      return result.sort();
    }
    const current = source();
    expect(calls(current)).toEqual(calls(beforeAuthoritySetup(path, current)));
  },
);
it('rejects unreviewed changes even inside any new fixture setup block', () => {
  const current = source(),
    blocks = [
      ...current.matchAll(
        /^\/\/ BEGIN AUTHORITY FIXTURE SETUP ([A-Z_]+)\n[\s\S]*?^\/\/ END AUTHORITY FIXTURE SETUP \1\n/gm,
      ),
    ];
  expect(blocks).toHaveLength(4);
  for (const [block] of blocks) {
    const at = current.indexOf(block) + block.indexOf('\n') + 1;
    expect(() =>
      beforeAuthoritySetup(path, current.slice(0, at) + '// unreviewed\n' + current.slice(at)),
    ).toThrow('AUTHORITY_SETUP_REVIEW_REQUIRED');
  }
  expect(() =>
    beforeAuthoritySetup(
      path,
      current + '// BEGIN AUTHORITY FIXTURE SETUP EXTRA\n// END AUTHORITY FIXTURE SETUP EXTRA\n',
    ),
  ).toThrow('AUTHORITY_SETUP_REVIEW_REQUIRED');
});

it('never creates an Order draft before real funding initialization has physically settled', async () => {
  const text = source(),
    ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const prepared = ast.statements
    .find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'prepared')
    .getText(ast);
  const code =
    'export function bind({fixture,randomUUID,fundingPort,openOrders,paperFundingSchema,io,settleAuthorityFixturePair}) {' +
    prepared +
    '\nreturn prepared;}';
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  const { bind } = await import(
    'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
  );
  const fund = gate(),
    created = vi.fn(async () => ({ id: 'original-order' }));
  const opening = bind({
    fixture: async () => ({
      c: { owner: { tenantId: 'A' }, id: 'config' },
      binding: {},
      draft: {},
    }),
    randomUUID: () => 'funding-id',
    fundingPort: async () => ({ initialize: () => fund.promise }),
    openOrders: async () => ({ create: created }),
    paperFundingSchema: { parse: (value) => value },
    io: () => ({}),
    settleAuthorityFixturePair: await factory(),
  })();
  for (let n = 0; n < 12; n++) await Promise.resolve();
  expect(created).not.toHaveBeenCalled();
  fund.resolve({});
  expect((await opening).order).toEqual({ id: 'original-order' });
  expect(created).toHaveBeenCalledTimes(1);
});
