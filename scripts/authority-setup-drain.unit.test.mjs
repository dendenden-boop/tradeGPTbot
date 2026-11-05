import fs from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

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
  for (const lanes of [[], [lane], [lane, lane, lane], [lane, null], null])
    await expect(run(lanes)).rejects.toThrow('AUTHORITY_FIXTURE_LANES');
  expect(lane).not.toHaveBeenCalled();
});
