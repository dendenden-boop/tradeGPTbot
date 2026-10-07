import { createServer, type Socket } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createPostgresInstrumentRegistry } from '../src/postgres-instrument-registry.js';
import { scope } from '../../exchange-core/test/fixtures/adapter.js';

it.each(['abort', 'deadline'] as const)(
  'registry %s destroys a PostgreSQL socket whose handshake never responds',
  async (kind) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('data', () => {});
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP_PORT');
    const controller = new AbortController();
    let settled = false;
    const operation = createPostgresInstrumentRegistry({
      connectionString: `postgresql://fixture:fixture@127.0.0.1:${address.port}/fixture`,
      environment: 'test',
      scope,
      instrumentIds: ['BTCUSDT'],
      io: { signal: controller.signal, deadline: Date.now() + (kind === 'deadline' ? 80 : 3000) },
    }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      for (let i = 0; i < 20 && sockets.size === 0; i++) await wait(5);
      expect(sockets.size).toBe(1);
      if (kind === 'abort') controller.abort();
      await wait(350);
      expect({ sockets: sockets.size, settled }).toEqual({ sockets: 0, settled: true });
    } finally {
      await operation;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
