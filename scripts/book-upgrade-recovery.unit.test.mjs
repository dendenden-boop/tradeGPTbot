import fs from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
async function load() {
  const url = new URL(
    '../packages/database/test/fixtures/book-upgrade-recovery.ts',
    import.meta.url,
  );
  if (!fs.existsSync(url)) throw Error('BOOK_UPGRADE_RECOVERY_MISSING');
  const compiled = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return (
    await import(
      'data:text/javascript;base64,' + Buffer.from(compiled.outputText).toString('base64')
    )
  ).bookUpgradeFixtureOperation;
}
function fixture() {
  const owner = Object.freeze({ tenantId: 'tenant-A', accountId: 'account-A', mode: 'PAPER' });
  const receipt = Object.freeze({
    kind: 'INITIAL_BOOK',
    bookId: 'fund-A',
    revision: '1',
    amount: '9007199254740993.000000000000000001',
  });
  const events = [],
    contexts = [];
  const port = { initialize: vi.fn(async () => receipt), read: vi.fn(async () => receipt) };
  const options = {
    stage: 'INITIALIZE',
    port,
    owner,
    io: () => {
      const c = Object.freeze({ sequence: contexts.length + 1 });
      contexts.push(c);
      return c;
    },
    verify: vi.fn((r) => expect(r).toEqual(receipt)),
    record: (e) => events.push(e),
  };
  return { owner, receipt, events, contexts, port, options };
}
it.each(['INITIALIZE', 'REPLAY', 'READ'])(
  'preserves acknowledged %s with exactly one original native operation and no recovery',
  async (stage) => {
    const run = await load(),
      f = fixture();
    expect(await run({ ...f.options, stage })).toBe(f.receipt);
    expect(f.port.initialize).toHaveBeenCalledTimes(stage === 'READ' ? 0 : 1);
    expect(f.port.read).toHaveBeenCalledTimes(stage === 'READ' ? 1 : 0);
    const call = (stage === 'READ' ? f.port.read : f.port.initialize).mock.calls[0];
    expect(call).toEqual([f.owner, f.contexts[0]]);
    expect(f.options.verify).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([
      { stage, outcome: 'STARTED' },
      { stage, outcome: 'ACKNOWLEDGED' },
    ]);
  },
);
it.each(['INITIALIZE', 'REPLAY', 'READ'])(
  'resolves uncertain %s only by one actual readonly recapture with fresh IO, never mutation retry',
  async (stage) => {
    const run = await load(),
      f = fixture();
    const original = stage === 'READ' ? f.port.read : f.port.initialize;
    original.mockRejectedValueOnce(Error('PAPER_BOOK_UNCERTAIN'));
    expect(await run({ ...f.options, stage })).toBe(f.receipt);
    expect(f.port.initialize).toHaveBeenCalledTimes(stage === 'READ' ? 0 : 1);
    expect(f.port.read).toHaveBeenCalledTimes(stage === 'READ' ? 2 : 1);
    expect(f.contexts).toEqual([{ sequence: 1 }, { sequence: 2 }]);
    expect(f.port.read.mock.calls.at(-1)).toEqual([f.owner, f.contexts[1]]);
    expect(f.events).toEqual([
      { stage, outcome: 'STARTED' },
      { stage, outcome: 'UNCERTAIN' },
      { stage, outcome: 'RECOVERED_READ_ONLY' },
    ]);
    expect(f.events.some((e) => e.outcome === 'ACKNOWLEDGED')).toBe(false);
  },
);
it.each([
  'PAPER_BOOK_MISSING',
  'PAPER_BOOK_CORRUPT',
  'PAPER_BOOK_OWNERSHIP',
  'PAPER_BOOK_ROLE_UNSAFE',
  'PAPER_BOOK_CLOSED',
  'PAPER_BOOK_ABORTED',
  'PAPER_BOOK_STORE_FAILED',
])('does not reinterpret %s as commit uncertainty or retry', async (code) => {
  const run = await load(),
    f = fixture(),
    error = Error(code);
  f.port.initialize.mockRejectedValueOnce(error);
  await expect(run(f.options)).rejects.toBe(error);
  expect(f.port.initialize).toHaveBeenCalledTimes(1);
  expect(f.port.read).not.toHaveBeenCalled();
  expect(f.events.at(-1)).toEqual({ stage: 'INITIALIZE', outcome: 'FAILED' });
});
it.each(['PAPER_BOOK_UNCERTAIN', 'PAPER_BOOK_MISSING'])(
  'leaves uncertain initialization unresolved when authoritative read reports %s',
  async (code) => {
    const run = await load(),
      f = fixture(),
      error = Error(code);
    f.port.initialize.mockRejectedValueOnce(Error('PAPER_BOOK_UNCERTAIN'));
    f.port.read.mockRejectedValueOnce(error);
    await expect(run(f.options)).rejects.toBe(error);
    expect(f.port.initialize).toHaveBeenCalledTimes(1);
    expect(f.port.read).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toEqual({ stage: 'INITIALIZE', outcome: 'UNRESOLVED' });
  },
);
it('rejects conflicting readonly receipt before recording recovery or continuing upgrade', async () => {
  const run = await load(),
    f = fixture();
  f.port.initialize.mockRejectedValueOnce(Error('PAPER_BOOK_UNCERTAIN'));
  f.port.read.mockResolvedValueOnce({ ...f.receipt, bookId: 'foreign-fund' });
  await expect(run(f.options)).rejects.toThrow();
  expect(f.events.at(-1)).toEqual({ stage: 'INITIALIZE', outcome: 'UNRESOLVED' });
  expect(f.port.initialize).toHaveBeenCalledTimes(1);
});
it('never treats validation errors as transport uncertainty', async () => {
  const run = await load(),
    f = fixture(),
    error = Error('PAPER_BOOK_UNCERTAIN');
  f.options.verify = () => {
    throw error;
  };
  await expect(run(f.options)).rejects.toBe(error);
  expect(f.port.read).not.toHaveBeenCalled();
});
it('does not retry or recapture because the evidence recorder throws', async () => {
  const run = await load(),
    f = fixture(),
    error = Error('PAPER_BOOK_UNCERTAIN');
  f.options.record = (e) => {
    if (e.outcome === 'ACKNOWLEDGED') throw error;
  };
  await expect(run(f.options)).rejects.toBe(error);
  expect(f.port.read).not.toHaveBeenCalled();
});
it('does not dispatch or recapture when creating IO fails before transport', async () => {
  const run = await load(),
    f = fixture(),
    error = Error('PAPER_BOOK_UNCERTAIN');
  f.options.io = () => {
    throw error;
  };
  await expect(run(f.options)).rejects.toBe(error);
  expect(f.port.initialize).not.toHaveBeenCalled();
  expect(f.port.read).not.toHaveBeenCalled();
});
it('rejects unknown fixture stages before IO or operations', async () => {
  const run = await load(),
    f = fixture();
  await expect(run({ ...f.options, stage: 'CANCEL' })).rejects.toThrow('BOOK_UPGRADE_STAGE');
  expect(f.contexts).toEqual([]);
  expect(f.port.initialize).not.toHaveBeenCalled();
  expect(f.port.read).not.toHaveBeenCalled();
});
it('wires all three exact upgrade operations and records original uncertainty without removing old monetary assertions', () => {
  const source = read('scripts/test-database.mjs');
  expect(source).toContain('bookUpgradeFixtureOperation');
  expect(source).toContain('paperBookUpgradeEvidence');
  for (const stage of ['INITIALIZE', 'REPLAY', 'READ'])
    expect(source).toContain("stage: '" + stage + "'");
  expect(source).toContain('assert.equal(initialBook.bookId, initialFunding.id)');
  expect(source).toContain("assert.equal(initialBook.revision, '1')");
  expect(source).toContain(
    'assert.deepEqual(initialBook.state.balances, initialSource.state.balances)',
  );
});
it('retains the complete original runner and32-case native suite outside reviewed additions', async () => {
  const module = './book-upgrade-recovery-legacy.mjs';
  const { beforeBookUpgradeRecovery } = await import(module);
  const digest = (s) => createHash('sha256').update(s).digest('hex');
  const runner = 'scripts/test-database.mjs',
    native = 'packages/database/test/paper-portfolio-bootstrap.integration.test.ts';
  expect(digest(beforeBookUpgradeRecovery(runner, read(runner)))).toBe(
    '9d2847162ea1c73b6c1326ccdc2a1373084c3ab00fe15ad494dd5f2f5db992e4',
  );
  expect(digest(beforeBookUpgradeRecovery(native, read(native)))).toBe(
    'e5a13d2bcf3e2c2aa8b2ab9f9c47eec7fe528f1025e79ab1f2261293533ecb7d',
  );
  expect(() =>
    beforeBookUpgradeRecovery(
      runner,
      read(runner) +
        '// BEGIN BOOK UPGRADE RECOVERY EXTRA\nchanged\n// END BOOK UPGRADE RECOVERY EXTRA\n',
    ),
  ).toThrow();
});
