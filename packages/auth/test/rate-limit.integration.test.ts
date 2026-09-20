import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthLimiter } from '../src/rate-limit.js';

const project = process.env['CTP_TEST_PROJECT'];
const redisUrl = process.env['REDIS_URL'];
if (!project || !/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(project) || !redisUrl) {
  throw new Error('Auth limiter integration requires the isolated project runner');
}
const url = new URL(redisUrl);
if (!['redis:', 'rediss:'].includes(url.protocol) || url.hostname !== '127.0.0.1') {
  throw new Error('Auth limiter integration requires the isolated loopback Redis');
}
const admin = new Redis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  commandTimeout: 5_000,
});
admin.on('error', () => {});
const limiter = createAuthLimiter(redisUrl);
const prefix = `test:${randomBytes(12).toString('hex')}`;
const ownKeys = new Set<string>();
const index = 'ctp:auth:{rate}:index';
const bucket = (suffix: string) => {
  const key = `${prefix}:${suffix}`;
  ownKeys.add(`ctp:auth:{rate}:bucket:${key}`);
  return key;
};
beforeAll(async () => {
  await admin.connect();
  await limiter.ready();
});
afterAll(async () => {
  await limiter.close();
  if (ownKeys.size) {
    await admin.del(...ownKeys);
    await admin.zrem(index, ...ownKeys);
  }
  admin.disconnect(false);
});

describe('real Redis authentication rate limiting', () => {
  it('admits exactly the budget across competing callers atomically', async () => {
    const key = bucket('race');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume([{ key, limit: 5, windowMs: 60_000 }])),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await admin.get(`ctp:auth:{rate}:bucket:${key}`)).toBe('6');
  });

  it('counts every dimension when a different dimension denies the attempt', async () => {
    const ip = bucket('ip');
    const email = bucket('email');
    const buckets = [
      { key: ip, limit: 3, windowMs: 60_000 },
      { key: email, limit: 1, windowMs: 60_000 },
    ];
    expect(await limiter.consume(buckets)).toBe(true);
    expect(await limiter.consume(buckets)).toBe(false);
    expect(await limiter.consume(buckets)).toBe(false);
    expect(
      await admin.mget(`ctp:auth:{rate}:bucket:${ip}`, `ctp:auth:{rate}:bucket:${email}`),
    ).toEqual(['3', '2']);
  });

  it('expires fixed windows and does not extend lockouts on denied requests', async () => {
    const key = bucket('expiry');
    const stored = `ctp:auth:{rate}:bucket:${key}`;
    const buckets = [{ key, limit: 1, windowMs: 1_000 }];
    expect(await limiter.consume(buckets)).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(await limiter.consume(buckets)).toBe(false);
    expect(await admin.pttl(stored)).toBeLessThan(850);
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    expect(await limiter.consume(buckets)).toBe(true);
  });

  it('caps live key cardinality and fails closed without partially creating buckets', async () => {
    const now = Date.now();
    const fillers = Array.from(
      { length: 10_000 },
      (_, i) => `ctp:auth:{rate}:bucket:${bucket(`capacity${i}`)}`,
    );
    try {
      await admin.zadd(index, ...fillers.flatMap((key) => [now + 60_000, key]));
      const key = bucket('capacity-denied');
      expect(await limiter.consume([{ key, limit: 5, windowMs: 60_000 }])).toBe(false);
      expect(await admin.exists(`ctp:auth:{rate}:bucket:${key}`)).toBe(0);
    } finally {
      await admin.zrem(index, ...fillers);
    }
  });

  it.each(['not-a-counter', '', '-1', '0.5', '1e2', 'NaN', 'inf', '100002'])(
    'fails closed on corrupt counter %j before changing the other buckets',
    async (value) => {
      const first = bucket(`unchanged:${ownKeys.size}`);
      const corrupt = bucket(`corrupt:${ownKeys.size}`);
      const stored = `ctp:auth:{rate}:bucket:${corrupt}`;
      await admin.set(stored, value, 'PX', 60_000);
      await expect(
        limiter.consume([
          { key: first, limit: 5, windowMs: 60_000 },
          { key: corrupt, limit: 5, windowMs: 60_000 },
        ]),
      ).rejects.toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
      expect(await admin.exists(`ctp:auth:{rate}:bucket:${first}`)).toBe(0);
      expect(await admin.get(stored)).toBe(value);
    },
  );
});
