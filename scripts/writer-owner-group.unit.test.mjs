import { expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
const subject = await import('./writer-owner-processes.mjs');
const missing = () => Object.assign(Error('owned group gone'), { code: 'ESRCH' });
it('waits for an exiting owned group after direct child close within the original remaining budget', async () => {
  expect(subject.waitForOwnedWriterGroup).toBeTypeOf('function');
  const began = performance.now(),
    calls = [];
  await subject.waitForOwnedWriterGroup({
    pid: 123,
    began,
    timeoutMs: 1000,
    probe: (pid, signal) => {
      calls.push([pid, signal]);
      if (performance.now() - began >= 60) throw missing();
    },
  });
  expect(performance.now() - began).toBeGreaterThanOrEqual(60);
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.every(([pid, signal]) => pid === -123 && signal === 0)).toBe(true);
});
it('a persistent group cannot receive a fresh deadline after child close', async () => {
  expect(subject.waitForOwnedWriterGroup).toBeTypeOf('function');
  const started = performance.now();
  await expect(
    subject.waitForOwnedWriterGroup({
      pid: 123,
      began: started - 900,
      timeoutMs: 1000,
      probe: () => {},
    }),
  ).rejects.toThrow('WRITER_OWNER_DEADLINE');
  expect(performance.now() - started).toBeLessThan(900);
});
it('abort and unexpected kernel probe errors never certify physical group closure', async () => {
  expect(subject.waitForOwnedWriterGroup).toBeTypeOf('function');
  const controller = new AbortController();
  controller.abort();
  await expect(
    subject.waitForOwnedWriterGroup({
      pid: 123,
      began: performance.now(),
      timeoutMs: 1000,
      signal: controller.signal,
    }),
  ).rejects.toThrow('WRITER_OWNER_ABORTED');
  await expect(
    subject.waitForOwnedWriterGroup({
      pid: 123,
      began: performance.now(),
      timeoutMs: 1000,
      probe: () => {
        throw Object.assign(Error('probe denied'), { code: 'EPERM' });
      },
    }),
  ).rejects.toThrow('WRITER_OWNER_GROUP_PROBE_FAILED');
});
