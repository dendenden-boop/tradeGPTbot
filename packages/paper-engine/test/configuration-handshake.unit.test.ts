import { createServer, type Socket } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createPostgresPaperConfiguration } from '../src/postgres-configuration.js';

it.each(['abort', 'deadline'] as const)(
  'configuration %s settles a physically hung PostgreSQL authentication socket',
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
    const op = createPostgresPaperConfiguration({
      connectionString: `postgresql://paper:fixture@127.0.0.1:${address.port}/fixture`,
      environment: 'test',
      io: { signal: controller.signal, deadline: Date.now() + (kind === 'deadline' ? 100 : 3000) },
    }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      for (let i = 0; i < 30 && sockets.size === 0; i++) await wait(5);
      expect(sockets.size).toBe(1);
      if (kind === 'abort') controller.abort();
      await wait(350);
      expect({ settled, sockets: sockets.size }).toEqual({ settled: true, sockets: 0 });
    } finally {
      await op;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
