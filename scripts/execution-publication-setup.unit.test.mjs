import fs from 'node:fs';
import ts from 'typescript';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { runIndependentFixtureSetup } from '../packages/database/test/fixtures/native-default-port.js';
import {
  beforeExecutionPublications,
  beforeExecutionPublicationFingerprint,
} from './execution-publication-legacy.mjs';

const source = fs.readFileSync('packages/database/test/fixtures/paper-execution-start.ts', 'utf8');
const begin = source.indexOf('  const now = Date.now();');
const end = source.indexOf('  const identity = (', begin);
it('preserves the exact accepted fixture below the publication-only change and all 49 original native bodies', () => {
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  expect(hash(beforeExecutionPublications(source.replaceAll('\r\n', '\n')))).toBe(
    '22fc143b5771bef5b886cb7122bdc4a60c2db9758d29f9560c1ec18ddf4285fb',
  );
  const runner = fs.readFileSync('scripts/database-cohorts.mjs', 'utf8').replaceAll('\r\n', '\n');
  expect(hash(beforeExecutionPublicationFingerprint('scripts/database-cohorts.mjs', runner))).toBe(
    '3a4c22aa3fd564bd36f943f8f58672632d7235a3b92b2f746157a91985b3ffb9',
  );
  const native = fs
    .readFileSync('packages/database/test/paper-execution-commit.integration.test.ts', 'utf8')
    .replaceAll('\r\n', '\n');
  const ast = ts.createSourceFile('native.ts', native, ts.ScriptTarget.Latest, true),
    cases = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'it' &&
      ts.isStringLiteral(node.arguments[0])
    )
      cases.push([node.arguments[0].text, node.getText(ast)]);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  cases.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  expect(cases).toHaveLength(49);
  expect(hash(JSON.stringify(cases))).toBe(
    'f4825aff6e39ec5635fea2d68fddd6e0529673087b918bd74bd4d789bc7644ac',
  );
  for (const name of ['snapshots', 'trades', 'runtime'])
    expect(() =>
      beforeExecutionPublications(
        source
          .replaceAll('\r\n', '\n')
          .replace('() => ports.' + name + '.publish', '() => ports.' + name + '.read'),
      ),
    ).toThrow('EXECUTION_PUBLICATION_REVIEW_REQUIRED');
});
async function actualPublications(ports) {
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const body = source.slice(begin, end);
  const compiled = ts.transpileModule(
    'export async function perform(f,c,head,context,ports,startIo,randomUUID,parseDecimal,paperRuntimeDependencies,runIndependentFixtureSetup){' +
      body +
      '}',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
  ).outputText;
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
  );
  const f = { p: { trade: {} }, s: { book: { bids: [], asks: [] }, ticker: {} } };
  return module.perform(
    f,
    { owner: {}, id: randomUUID() },
    { revision: '7' },
    {
      configurationHash: 'hash',
      current: { permissionEpoch: '1', userSessionEpoch: '2', accountVersion: '3' },
    },
    ports,
    () => ({ deadline: 2500 }),
    randomUUID,
    (value) => value,
    ['DATABASE'],
    runIndependentFixtureSetup,
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
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
it.each(['success', 'snapshot failure', 'trade failure', 'runtime failure'])(
  'starts and drains all three independent actual evidence publications before admission: %s',
  async (outcome) => {
    const gates = [deferred(), deferred(), deferred()];
    const calls = gates.map((g) => vi.fn(() => g.promise));
    const ports = {
      snapshots: { publish: calls[0] },
      trades: { publish: calls[1] },
      runtime: { publish: calls[2] },
    };
    let settled = false;
    const admission = vi.fn();
    const result = actualPublications(ports).then(
      (value) => {
        settled = true;
        admission();
        return value;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    // Observe every lane independently; always drain the test's own gates.
    const observed = gates.map((g) => g.promise.catch((error) => error));
    try {
      await flush();
      expect(calls.map((call) => call.mock.calls.length)).toEqual([1, 1, 1]);
      expect(settled).toBe(false);
      const failed = ['snapshot failure', 'trade failure', 'runtime failure'].indexOf(outcome);
      const error = Error('PUBLICATION_FAILED');
      for (let i = 0; i < 2; i++) {
        if (i === failed) gates[i].reject(error);
        else gates[i].resolve({ status: 'APPLIED' });
      }
      await flush();
      expect(settled).toBe(false);
      expect(admission).not.toHaveBeenCalled();
      if (failed === 2) gates[2].reject(error);
      else gates[2].resolve({ status: 'APPLIED' });
      if (failed >= 0) {
        expect(await result).toBe(error);
        expect(admission).not.toHaveBeenCalled();
      } else {
        await result;
        expect(admission).toHaveBeenCalledTimes(1);
      }
      for (const call of calls) expect(call.mock.calls[0][1]).toEqual({ deadline: 2500 });
    } finally {
      for (const gate of gates) gate.resolve({ status: 'APPLIED' });
      await Promise.allSettled([...observed, result]);
    }
  },
);
