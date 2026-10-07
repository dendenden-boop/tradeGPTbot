import { createServer } from 'node:http';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createMarketDataWorker } from '../src/worker.js';
import type { IoContext } from '../src/ports.js';
import { registry, scope, storeFixture } from './fixtures.js';

afterEach(() => vi.useRealTimers());

it.each(['METADATA', 'RECOVERY'] as const)(
  '%s deadline aborts the actual socket and settles the port before retry',
  async (kind) => {
    const sockets = new Set<Socket>();
    const server = createServer(() => {});
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('TEST_ADDRESS');
    const port = address.port;
    let pending = 0,
      maxPending = 0;
    const aborted: boolean[] = [];
    let gap: (reason: string) => void = () => {},
      clock = 31000;
    function physical(context: IoContext) {
      pending++;
      maxPending = Math.max(maxPending, pending);
      return new Promise<void>((resolve, reject) => {
        const req = request({
          hostname: '127.0.0.1',
          port,
          path: '/',
          signal: context.signal,
        });
        req.once('error', () => {});
        req.once('close', () => {
          pending--;
          aborted.push(context.signal.aborted);
          if (context.signal.aborted) reject(new Error('ABORTED'));
          else resolve();
        });
        req.end();
      });
    }
    const worker = createMarketDataWorker({
      registry: registry(1),
      store: storeFixture().store,
      feed: {
        maxTopics: 1,
        maxConnections: 1,
        open: (_intents, _context, _input, onGap) => {
          gap = onGap;
          return Promise.resolve({ close: () => Promise.resolve() });
        },
      },
      metadata: {
        refresh: (_intents, context) =>
          kind === 'METADATA' ? physical(context) : Promise.resolve(),
      },
      recovery: {
        recover: async (_intent, _checkpoint, context) => {
          await physical(context);
          throw new Error('UNEXPECTED_RECOVERY_RETURN');
        },
      },
      now: () => clock,
    });
    try {
      const intent = { scope, instrumentId: 'BTCUSDT', profileId: 'binance-spot-testnet-v1' };
      if (kind === 'RECOVERY') {
        await worker.retain(intent, 0);
        await worker.cycle();
        await worker.settled();
      }
      for (let i = 0; i < 3; i++) {
        if (kind === 'RECOVERY' && i > 0) {
          clock += 31000;
          await worker.cycle();
          await worker.settled();
        }
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        if (kind === 'RECOVERY') gap('SOURCE_GAP');
        const work = kind === 'METADATA' ? worker.retain(intent) : worker.cycle();
        const completed = kind === 'METADATA' ? expect(work).rejects.toThrow() : work;
        await new Promise<void>((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(3000);
        await completed;
        vi.useRealTimers();
        for (let j = 0; j < 20 && pending > 0; j++)
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        expect(pending).toBe(0);
      }
      expect(maxPending).toBe(1);
      expect(aborted).toEqual([true, true, true]);
      expect(worker.metrics().engine.instruments).toBe(kind === 'METADATA' ? 0 : 1);
      expect(worker.metrics().pendingOperations).toBe(0);
    } finally {
      await worker.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it('a port violating physical settlement stays tracked and cannot accumulate retries', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const worker = createMarketDataWorker({
    registry: registry(1),
    store: storeFixture().store,
    feed: { maxTopics: 1, maxConnections: 1, open: () => Promise.reject(new Error('UNEXPECTED')) },
    metadata: {
      refresh() {
        calls++;
        return new Promise<void>(() => {});
      },
    },
    recovery: { recover: () => Promise.reject(new Error('UNEXPECTED')) },
    now: () => 31000,
  });
  const intent = { scope, instrumentId: 'BTCUSDT', profileId: 'binance-spot-testnet-v1' };
  const retain = worker.retain(intent);
  const rejected = expect(retain).rejects.toThrow('RECOVERY_PORT_DID_NOT_SETTLE');
  await vi.advanceTimersByTimeAsync(3250);
  await rejected;
  expect(worker.metrics()).toMatchObject({ pendingOperations: 1, unsafePort: true });
  for (let i = 0; i < 10; i++)
    await expect(worker.retain(intent)).rejects.toThrow('RECOVERY_PORT_UNSAFE');
  expect(calls).toBe(1);
  const close = worker.close();
  await vi.advanceTimersByTimeAsync(250);
  await close;
  expect(worker.metrics()).toMatchObject({ pendingOperations: 1, unsafePort: true });
});

it('parent shutdown aborts a pending refresh and waits for actual port settlement', async () => {
  let active = 0,
    cancelled = false;
  const worker = createMarketDataWorker({
    registry: registry(1),
    store: storeFixture().store,
    feed: { maxTopics: 1, maxConnections: 1, open: () => Promise.reject(new Error('UNEXPECTED')) },
    metadata: {
      refresh(_intents, context) {
        active++;
        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              setImmediate(() => {
                active--;
                cancelled = true;
                reject(new Error('ABORTED'));
              });
            },
            { once: true },
          );
        });
      },
    },
    recovery: { recover: () => Promise.reject(new Error('UNEXPECTED')) },
    now: () => 31000,
  });
  const retain = worker.retain({
    scope,
    instrumentId: 'BTCUSDT',
    profileId: 'binance-spot-testnet-v1',
  });
  const rejected = expect(retain).rejects.toThrow();
  await Promise.resolve();
  expect(active).toBe(1);
  await worker.close();
  await rejected;
  expect(cancelled).toBe(true);
  expect(active).toBe(0);
  expect(worker.metrics()).toMatchObject({ pendingOperations: 0, unsafePort: false });
});
