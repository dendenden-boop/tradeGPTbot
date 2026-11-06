import fs from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const file = 'packages/database/test/paper-risk-authority.integration.test.ts';
async function bind() {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(
    (s) =>
      (ts.isFunctionDeclaration(s) &&
        ['tenantReady', 'marketPorts', 'ownWriter'].includes(s.name?.text)) ||
      (ts.isVariableStatement(s) &&
        s.declarationList.declarations.some((d) => d.name.getText(source) === 'marketWriters')),
  );
  const code =
    'export function bind({fixture,fundCash,openOrders,openBook,ensurePolicies,createPostgresMarketSnapshots,createPostgresMarketTrades,required,handles,io}) {' +
    selected.map((s) => s.getText(source)).join('\n') +
    '\n return tenantReady;}';
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')))
    .bind;
}
it('300 tenant fixtures own only one real snapshot and trade producer while every publication stays fresh', async () => {
  const handles = [],
    snapshots = { publish: vi.fn(async () => {}), close: vi.fn(async () => {}) },
    trades = { publish: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  let index = 0;
  const createSnapshots = vi.fn(async () => snapshots),
    createTrades = vi.fn(async () => trades),
    orders = { create: vi.fn(async (binding) => ({ intentId: binding.id })) },
    book = { initialize: vi.fn(async () => {}) },
    policies = vi.fn(async () => {});
  const get = (await bind())({
    fixture: async () => {
      const id = String(index++);
      return {
        c: { owner: { tenantId: id } },
        binding: { id },
        draft: { id },
        f: { s: { id, ticker: {}, book: {} }, p: { id, trade: {} } },
      };
    },
    fundCash: async (c) => c.owner.tenantId,
    openOrders: async () => orders,
    openBook: async () => book,
    ensurePolicies: policies,
    createPostgresMarketSnapshots: createSnapshots,
    createPostgresMarketTrades: createTrades,
    required: (key) => key,
    handles,
    io: () => ({}),
  });
  for (let n = 0; n < 300; n++) {
    const value = await get();
    expect(value.request).toEqual({ owner: { tenantId: String(n) }, intentId: String(n) });
    expect(value.f.s.timestamp).toBeGreaterThan(0);
    expect(value.f.p.timestamp).toBe(value.f.s.timestamp);
  }
  expect(createSnapshots).toHaveBeenCalledTimes(1);
  expect(createTrades).toHaveBeenCalledTimes(1);
  expect(handles).toEqual([snapshots, trades]);
  for (const call of [orders.create, book.initialize, policies, snapshots.publish, trades.publish])
    expect(call).toHaveBeenCalledTimes(300);
  expect(new Set(snapshots.publish.mock.calls.map(([p]) => p.id)).size).toBe(300);
  expect(new Set(trades.publish.mock.calls.map(([p]) => p.id)).size).toBe(300);
  await Promise.all(handles.map((h) => h.close()));
  expect(snapshots.close).toHaveBeenCalledTimes(1);
  expect(trades.close).toHaveBeenCalledTimes(1);
});
