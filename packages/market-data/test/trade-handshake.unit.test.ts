import { createServer, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import { createPostgresMarketTrades } from '../src/postgres-trades.js';

it.each(['abort', 'deadline'] as const)(
  'public trade hung authentication %s physically settles',
  async (kind) => {
    const sockets = new Set<Socket>();
    const server = createServer((s) => {
      sockets.add(s);
      s.on('error', () => {});
      s.once('close', () => sockets.delete(s));
      s.resume();
    });
    await new Promise<void>((yes) => server.listen(0, '127.0.0.1', () => yes()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('LOOPBACK_FIXTURE');
    const controller = new AbortController(),
      started = performance.now();
    const timer = kind === 'abort' ? setTimeout(() => controller.abort(), 40) : undefined;
    try {
      await expect(
        createPostgresMarketTrades({
          connectionString: `postgresql://trade:unused@127.0.0.1:${address.port}/trade_test`,
          environment: 'test',
          io: {
            signal: controller.signal,
            deadline: Date.now() + (kind === 'deadline' ? 40 : 1000),
          },
        }),
      ).rejects.toThrow('MARKET_TRADE_ROLE_UNSAFE');
      expect(performance.now() - started).toBeLessThan(500);
      await new Promise<void>((yes) => setTimeout(yes, 25));
      expect(sockets.size).toBe(0);
    } finally {
      clearTimeout(timer);
      for (const s of sockets) s.destroy();
      await new Promise<void>((yes) => server.close(() => yes()));
    }
  },
);
