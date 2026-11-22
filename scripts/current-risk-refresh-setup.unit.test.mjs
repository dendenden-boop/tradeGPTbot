import fs from 'node:fs';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const text = fs.readFileSync(
  'packages/database/test/paper-execution-commit.integration.test.ts',
  'utf8',
);
const ast = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(
  (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'refreshCurrentRiskEvidence',
);
async function actualTarget(f, publications) {
  const fn = ast.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'currentOrderTargetReady',
  );
  const source = ts.transpileModule(
    'export function bind(ready,open,startIo,randomUUID,parseDecimal,startFixtureSql,startFixturePolicy,refreshValuationMark,refreshCurrentRiskEvidence,currentRiskRequest){' +
      fn.getText(ast) +
      ';return currentOrderTargetReady;}',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
  ).outputText;
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  const execute = vi.fn(async () => {});
  return {
    execute,
    perform: module.bind(
      async () => f,
      async () => ({ execute }),
      () => ({ deadline: 2500 }),
      randomUUID,
      (value) => value,
      async () => ({ rows: [{ hash: 'hash', command: 'original command' }] }),
      async () => {},
      publications[0],
      publications[1],
      () => ({ kind: 'PAPER_CURRENT_RISK_CAPTURE' }),
    ),
  };
}
async function actual() {
  const source = ts.transpileModule(
    'export function bind(startIo,randomUUID,paperRuntimeDependencies,expect){' +
      declaration.getText(ast) +
      ';return refreshCurrentRiskEvidence;}',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
  ).outputText;
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  return module.bind(() => ({ deadline: 2500 }), randomUUID, ['DATABASE'], expect);
}
const gate = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
function fixture() {
  return {
    c: { owner: {}, id: 'config' },
    f: { p: { key: {}, trade: { sourceSequence: '9007199254740995' } } },
    runtime: {
      context: vi.fn(async () => ({
        configurationHash: 'hash',
        current: { permissionEpoch: '1', userSessionEpoch: '2', accountVersion: '3' },
      })),
      head: vi.fn(async () => ({ revision: '4' })),
      publish: vi.fn(async () => ({ status: 'APPLIED' })),
    },
    trades: {
      read: vi.fn(async () => ({ revision: '7' })),
      publish: vi.fn(async () => ({ status: 'APPLIED' })),
    },
  };
}
it.each(['context', 'head', 'trade'])(
  'drains every genuine current evidence read before rejecting %s and never publishes on failed read',
  async (failed) => {
    const f = fixture(),
      gates = [gate(), gate(), gate()],
      calls = [f.runtime.context, f.runtime.head, f.trades.read];
    calls.forEach((call, i) => call.mockImplementation(() => gates[i].promise));
    const refresh = await actual();
    let settled = false;
    const result = refresh(f).then(
      () => {
        settled = true;
        return 'PASS';
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    const observed = gates.map((g) => g.promise.catch((error) => error));
    try {
      await flush();
      expect(calls.map((call) => call.mock.calls.length)).toEqual([1, 1, 1]);
      const index = ['context', 'head', 'trade'].indexOf(failed),
        error = Error('READ_FAILED');
      gates[index].reject(error);
      await flush();
      expect(settled).toBe(false);
      expect(f.runtime.publish).not.toHaveBeenCalled();
      expect(f.trades.publish).not.toHaveBeenCalled();
      for (let i = 0; i < 3; i++)
        if (i !== index)
          gates[i].resolve(
            i === 0 ? { configurationHash: 'hash', current: {} } : { revision: '7' },
          );
      expect(await result).toBe(error);
      expect(f.runtime.publish).not.toHaveBeenCalled();
      expect(f.trades.publish).not.toHaveBeenCalled();
    } finally {
      for (const g of gates) g.resolve({ revision: '7' });
      await Promise.allSettled([...observed, result]);
    }
  },
);
it.each(['runtime', 'trade'])(
  'drains both independent public writes before propagating %s failure without a positive setup result',
  async (failed) => {
    const f = fixture(),
      gates = [gate(), gate()],
      calls = [f.runtime.publish, f.trades.publish];
    calls.forEach((call, i) => call.mockImplementation(() => gates[i].promise));
    const refresh = await actual();
    let settled = false;
    const success = vi.fn();
    const result = refresh(f).then(
      (value) => {
        settled = true;
        success();
        return value;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    const observed = gates.map((g) => g.promise.catch((error) => error));
    try {
      await flush();
      expect(calls.map((call) => call.mock.calls.length)).toEqual([1, 1]);
      const index = failed === 'runtime' ? 0 : 1,
        error = Error('PUBLICATION_FAILED');
      gates[index].reject(error);
      await flush();
      expect(settled).toBe(false);
      expect(success).not.toHaveBeenCalled();
      gates[1 - index].resolve({ status: 'APPLIED' });
      expect(await result).toBe(error);
      expect(success).not.toHaveBeenCalled();
    } finally {
      for (const g of gates) g.resolve({ status: 'APPLIED' });
      await Promise.allSettled([...observed, result]);
    }
  },
);
it.each([undefined, '9007199254741001'])(
  'preserves current actual or explicitly captured trade revision %s and lossless sequence without changing IO',
  async (known) => {
    const f = fixture(),
      refresh = await actual();
    await refresh(f, known);
    expect(f.trades.read).toHaveBeenCalledTimes(known === undefined ? 1 : 0);
    expect(f.runtime.context).toHaveBeenCalledTimes(1);
    expect(f.runtime.head).toHaveBeenCalledTimes(1);
    expect(f.runtime.publish).toHaveBeenCalledTimes(1);
    expect(f.trades.publish).toHaveBeenCalledTimes(1);
    const publication = f.trades.publish.mock.calls[0][0],
      revision = known ?? '7';
    expect(publication.expectedRevision).toBe(revision);
    expect(publication.trade.sourceSequence).toBe(
      (9007199254740995n + BigInt(revision) + 1n).toString(),
    );
    for (const call of [f.runtime.context, f.runtime.head, f.runtime.publish, f.trades.publish])
      expect(call.mock.calls[0][1]).toEqual({ deadline: 2500 });
  },
);

it.each(['mark', 'runtime', 'success'])(
  'drains both independent current-target evidence refreshes before returning its exact scope: %s',
  async (outcome) => {
    const gates = [gate(), gate()],
      publications = gates.map((g) => vi.fn(() => g.promise));
    const f = {
      c: { owner: { tenantId: 'tenant' } },
      draft: { dbRuleId: 'rule', order: { ruleVersion: 'v1' } },
      binding: {},
      f: { s: { record: { instrument: { baseAsset: 'BTC' } } } },
      orders: { create: vi.fn(async () => ({ id: 'target', intentId: 'intent' })) },
    };
    const target = await actualTarget(f, publications);
    let settled = false;
    const result = target.perform().then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    const observed = gates.map((g) => g.promise.catch((error) => error));
    try {
      await flush();
      expect(publications.map((call) => call.mock.calls.length)).toEqual([1, 1]);
      expect(target.execute).toHaveBeenCalledTimes(1);
      expect(f.orders.create).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      const failed = outcome === 'mark' ? 0 : outcome === 'runtime' ? 1 : -1,
        error = Error('TARGET_EVIDENCE_FAILED');
      if (failed >= 0) gates[failed].reject(error);
      else gates[0].resolve();
      await flush();
      expect(settled).toBe(false);
      if (failed >= 0) gates[1 - failed].resolve();
      else gates[1].resolve();
      if (failed >= 0) expect(await result).toBe(error);
      else
        expect((await result).request).toEqual({
          kind: 'PAPER_CURRENT_ORDER_RISK_CAPTURE',
          source: { kind: 'PAPER_CURRENT_RISK_CAPTURE' },
          target: { orderId: 'target', intentId: 'intent', commandHash: 'hash' },
        });
    } finally {
      for (const g of gates) g.resolve();
      await Promise.allSettled([...observed, result]);
    }
  },
);
