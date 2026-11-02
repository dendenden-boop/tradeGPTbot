import { expect, it, vi } from 'vitest';
import * as fixtures from '../packages/database/test/fixtures/native-default-port.js';
import { readFileSync } from 'node:fs';

function scheduler() {
  const run = fixtures['runIndependentFixtureSetup'];
  if (typeof run !== 'function') throw Error('NATIVE_SETUP_BARRIERS_MISSING');
  return run;
}
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

it('starts all three independent fixture lanes without waiting for another lane to complete', async () => {
  const run = scheduler(), gates = [gate(), gate(), gate()];
  const calls = gates.map(g => vi.fn(() => g.promise));
  const pending = run(calls);
  await flush();
  for (const call of calls) expect(call).toHaveBeenCalledTimes(1);
  gates[2].resolve('market'); gates[0].resolve('funding'); gates[1].resolve('order');
  expect(await pending).toEqual(['funding', 'order', 'market']);
});

it('never returns a ready fixture until every real lane settles', async () => {
  const run = scheduler(), last = gate(); let settled = false;
  const pending = run([async () => 'funding', async () => 'order', () => last.promise]);
  void pending.then(() => { settled = true; });
  await flush(); expect(settled).toBe(false);
  last.resolve('market');
  expect(await pending).toEqual(['funding', 'order', 'market']);
});

it('drains independent operations after synchronous failure without returning partial authority', async () => {
  const run = scheduler(), last = gate(), failure = Error('setup failed'), calls = [];
  let settled = false;
  const pending = run([
    () => { calls.push('funding'); throw failure; },
    async () => { calls.push('order'); return {}; },
    () => { calls.push('market'); return last.promise; },
  ]);
  const outcome = pending.then(() => { settled = true; return 'unexpected'; }, e => { settled = true; return e; });
  await flush(); expect(calls).toEqual(['funding', 'order', 'market']); expect(settled).toBe(false);
  last.resolve({}); expect(await outcome).toBe(failure);
});

it('drains asynchronous failures and reports the original first lane error without a retry', async () => {
  const run = scheduler(), first = gate(), last = gate();
  const failures = [Error('funding failure'), Error('market failure')];
  const calls = [vi.fn(() => first.promise), vi.fn(async () => ({})), vi.fn(() => last.promise)];
  const outcome = run(calls).catch(e => e);
  await flush(); last.reject(failures[1]); await flush(); first.reject(failures[0]);
  expect(await outcome).toBe(failures[0]);
  for (const call of calls) expect(call).toHaveBeenCalledTimes(1);
});

it('preserves even an undefined rejection as failure rather than a successful fixture', async () => {
  const run = scheduler(); let accepted = false;
  await run([async () => ({}), () => Promise.reject(undefined), async () => ({})])
    .then(() => { accepted = true; }, e => { expect(e).toBeUndefined(); });
  expect(accepted).toBe(false);
});

it('executes fresh real setup on every invocation without memoizing financial results', async () => {
  const run = scheduler(), calls = [vi.fn(async () => ({})), vi.fn(async () => ({})), vi.fn(async () => ({}))];
  const before = await run(calls), after = await run(calls);
  for (let n = 0; n < 3; n++) { expect(calls[n]).toHaveBeenCalledTimes(2); expect(before[n]).not.toBe(after[n]); }
});

it('rejects invalid lane count before executing setup and bounds concurrency to exactly three lanes', async () => {
  const run = scheduler(), call = vi.fn(async () => ({}));
  for (const operations of [[], [call], [call, call], [call, call, call, call]])
    await expect(run(operations)).rejects.toThrow('NATIVE_SETUP_LANES');
  expect(call).not.toHaveBeenCalled();
});

it('the real native fixture explicitly composes funding/book, draft order and market/policy setup lanes', () => {
  const source = readFileSync('packages/database/test/paper-admission.integration.test.ts', 'utf8');
  expect(source).toContain('// BEGIN NATIVE SETUP BARRIERS');
  expect(source).toContain('await runIndependentFixtureSetup([');
  expect(source).toContain('// END NATIVE SETUP BARRIERS');
});
