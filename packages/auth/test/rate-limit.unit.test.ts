import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAuthLimiter } from '../src/rate-limit.js';

describe('authentication limiter failure boundaries', () => {
  it('rejects invalid, duplicate, excessive or unbounded buckets before connecting', async () => {
    const limiter = createAuthLimiter('redis://127.0.0.1:1/0');
    const valid = { key: 'signup:abc123', limit: 5, windowMs: 15_000 };
    for (const buckets of [
      [],
      [valid, valid],
      Array.from({ length: 5 }, (_, i) => ({ ...valid, key: `key${i}` })),
      [{ ...valid, key: 'email@example.invalid' }],
      [{ ...valid, key: 'a'.repeat(161) }],
      [{ ...valid, limit: 0 }],
      [{ ...valid, limit: Number.NaN }],
      [{ ...valid, windowMs: 999 }],
      [{ ...valid, windowMs: 86_400_001 }],
    ]) {
      await expect(limiter.consume(buckets)).rejects.toMatchObject({ code: 'RATE_LIMIT_INVALID' });
    }
    await limiter.close();
  });

  it('fails closed within one second with a shared connection and bounded callers', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      // Blackhole Redis protocol commands.
      socket.on('data', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_REDIS_ADDRESS_INVALID');
    const limiter = createAuthLimiter(
      `redis://runtime:secret-should-not-leak@127.0.0.1:${address.port}/0`,
    );
    try {
      const started = performance.now();
      const results = await Promise.allSettled(Array.from({ length: 64 }, () => limiter.ready()));
      expect(performance.now() - started).toBeLessThan(1_750);
      expect(results).toHaveLength(64);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({ message: 'RATE_LIMIT_UNAVAILABLE' });
      }
      expect(sockets.size).toBeLessThanOrEqual(1);
      await limiter.close();
      await expect(limiter.ready()).rejects.toMatchObject({ code: 'RATE_LIMIT_CLOSED' });
      await limiter.close();
    } finally {
      await limiter.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
