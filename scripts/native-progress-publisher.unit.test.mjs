import { expect, it } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
const witness = (state = 'pass') => ({
  id: 'native-case-1', name: 'completed native owner progress witness',
  result: { state, duration: 1, errors: undefined }, meta: { native: true },
});
async function open(send) {
  const module = await import('./fixtures/native-progress-publisher.mjs').catch(() => ({}));
  expect(module.createNativeProgressPublisher).toBeTypeOf('function');
  return module.createNativeProgressPublisher(send);
}
it('delivers the actual native completion even when the installed throttle loses its exact100ms trailing wakeup', async () => {
  const require = createRequire(import.meta.resolve('vitest/package.json'));
  const source = fs.readFileSync(path.join(path.dirname(require.resolve('@vitest/runner')), 'chunk-artifact.js'), 'utf8');
  const begin = source.indexOf('function throttle(fn, ms) {'), end = source.indexOf('// throttle based', begin);
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  let now = 1000, callback, scheduled = 0, deliveries = 0;
  const throttle = vm.runInNewContext('(' + source.slice(begin, end).trim() + ')', {
    unixNow: () => now, clearTimeout: () => {},
    setTimeout: (fn) => { callback = fn; scheduled++; return 1; },
  });
  const send = throttle(() => deliveries++, 100);
  send(); send(); now = 1100; callback();
  expect(deliveries).toBe(1); expect(scheduled).toBe(1);
  const received = [], publish = await open((...args) => { received.push(args); });
  const task = witness(); await publish(task);
  expect(received).toEqual([[[[task.id, task.result, task.meta]], [[task.id, 'test-finished', undefined]]]]);
});
it('does not invent completion for pending, failed, skipped or a different native task', async () => {
  for (const task of [witness('run'), witness('fail'), witness('skip'), { ...witness(), name: 'another case' }]) {
    const received = [], publish = await open((...args) => { received.push(args); });
    await publish(task); expect(received).toEqual([]);
  }
});
it('sends a real passed witness once and propagates failure without retry', async () => {
  let calls = 0;
  const publish = await open(async () => { calls++; throw Error('NATIVE_COMPLETION_DELIVERY_FAILED'); });
  await expect(publish(witness())).rejects.toThrow('NATIVE_COMPLETION_DELIVERY_FAILED');
  await publish(witness()); expect(calls).toBe(1);
});
it('configures the explicit sender only for the owned progress fixture, preserving native reporter and deadlines', () => {
  const fixture = fs.readFileSync(new URL('./native-progress.unit.test.mjs', import.meta.url), 'utf8');
  expect(fixture).toContain('runner:');
  expect(fixture).toContain('native-progress-runner.mjs');
  expect(fixture).toContain('super.onTestCaseResult(event)');
  expect(fixture).toContain('timeoutMs: 8000');
  expect(fixture).toContain('Date.now() + 6000');
  expect(fs.readFileSync(new URL('../vitest.database.config.ts', import.meta.url), 'utf8')).not.toContain('native-progress-runner');
});
