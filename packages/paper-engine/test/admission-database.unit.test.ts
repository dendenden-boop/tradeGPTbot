import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

const moduleUrl = new URL('../src/admission-database.ts', import.meta.url);
async function load() {
  expect(
    existsSync(fileURLToPath(moduleUrl)),
    'Bounded PAPER admission database transport is required',
  ).toBe(true);
  const loaded: unknown = await import(moduleUrl.href);
  const create = (loaded as Record<string, unknown>).openPaperAdmissionDatabase;
  expect(create).toBeTypeOf('function');
  return create as (options: unknown) => Promise<{ close(): Promise<void> }>;
}

it.each(['abort', 'deadline'] as const)(
  'physically drains a real hung admission handshake on %s',
  async (kind) => {
    const open = await load();
    const sockets = new Set<Socket>();
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const listener = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      socket.resume();
      accept();
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw Error('fixture');
    const controller = new AbortController(),
      start = performance.now();
    const opening = open({
      connectionString: `postgresql://fixture:private-canary@127.0.0.1:${address.port}/paper`,
      environment: 'test',
      io: { signal: controller.signal, deadline: Date.now() + (kind === 'deadline' ? 250 : 2000) },
    });
    try {
      await Promise.race([
        accepted,
        opening.then(async (h) => {
          await h.close();
          throw Error('Unexpected unverified role');
        }),
      ]);
      if (kind === 'abort') controller.abort();
      await expect(opening).rejects.toThrow('PAPER_ADMISSION_ABORTED');
      const until = Date.now() + 1000;
      while (sockets.size && Date.now() < until) await delay(5);
      expect(sockets.size).toBe(0);
      expect(performance.now() - start).toBeLessThan(1500);
      try {
        await opening;
      } catch (error) {
        expect((error as Error).message).not.toContain('private-canary');
        expect(JSON.stringify(error)).not.toContain('private-canary');
      }
    } finally {
      controller.abort();
      await opening.catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  },
);

it('does not expose server SQL transport on either public package entrypoint', async () => {
  expect(
    existsSync(fileURLToPath(moduleUrl)),
    'Bounded PAPER admission database transport is required',
  ).toBe(true);
  const root = await import('../src/index.js'),
    risk = await import('../src/risk.js');
  expect(root).not.toHaveProperty('openPaperAdmissionDatabase');
  expect(risk).not.toHaveProperty('openPaperAdmissionDatabase');
});
