import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAuthLimiter } from '../src/rate-limit.js';

const project = process.env['CTP_TEST_PROJECT'];
const redisUrl = process.env['REDIS_URL'];
if (!project || !/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(project) || !redisUrl) {
  throw new Error('Auth limiter hardening requires the isolated project runner');
}
const url = new URL(redisUrl);
if (!['redis:', 'rediss:'].includes(url.protocol) || url.hostname !== '127.0.0.1') {
  throw new Error('Auth limiter hardening requires isolated loopback Redis');
}
// Separate from database/runtime fixtures, including their limiter keys.
url.pathname = '/14';
const admin = new Redis(url.href, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
admin.on('error', () => {});
const limiter = createAuthLimiter(url.href);
const prefix = `hardening:${randomBytes(12).toString('hex')}`;
type Scope = 'ip' | 'operation' | 'identity';
const ownKeys = new Set<string>();
const members = new Map<string, Set<string>>();
const legacyIndex = 'ctp:auth:{rate}:index';
const storage = (key: string) => `ctp:auth:{rate}:bucket:${key}`;
const indexFor = (scope: Scope, key: string) =>
  `ctp:auth:{rate}:v2:index:${scope}:${createHash('sha256').update(key).digest('hex')[0]}`;
function bucket(scope: Scope, suffix: string, limit = 20, windowMs = 900_000) {
  const key = `${prefix}:${suffix}`;
  const stored = storage(key);
  ownKeys.add(stored);
  const index = indexFor(scope, key);
  const selected = members.get(index) ?? new Set<string>();
  selected.add(stored);
  members.set(index, selected);
  return { scope, key, limit, windowMs };
}
// The same reproduction runs against the original boolean API and the fixed API.
// Separate assertions below require the new structured contract.
function allowed(result: boolean | { allowed: boolean }): boolean {
  return typeof result === 'boolean' ? result : result.allowed;
}
const measurements: Record<string, unknown>[] = [];
beforeAll(async () => {
  await admin.connect();
  await limiter.ready();
});
afterEach(async () => {
  if (ownKeys.size) {
    await admin.del(...ownKeys);
    await admin.zrem(legacyIndex, ...ownKeys);
    for (const [index, keys] of members) await admin.zrem(index, ...keys);
  }
  ownKeys.clear();
  members.clear();
});
afterAll(async () => {
  await limiter.close();
  admin.disconnect(false);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/auth-limiter-hardening.json',
    JSON.stringify({ measurements }, null, 2) + '\n',
  );
});

describe('authentication limiter hardening with real Redis', () => {
  it.each([1, 3])(
    'does not let one denied IP exhaust identity capacity across %i endpoints',
    async (endpointCount) => {
      const existing = bucket('ip', 'existing-legitimate-ip', 100_000, 60_000);
      expect(allowed(await limiter.consume([existing]))).toBe(true);
      const ip = bucket('ip', 'attacker-ip', 120, 60_000);
      const operations = Array.from({ length: endpointCount }, (_, i) =>
        bucket('operation', `endpoint:${i}:ip`),
      );
      const identities = Array.from({ length: 10_020 }, (_, i) => bucket('identity', `email:${i}`));
      const latencies: number[] = [];
      let admitted = 0;
      const started = performance.now();
      for (let offset = 0; offset < identities.length; offset += 16) {
        await Promise.all(
          identities.slice(offset, offset + 16).map(async (identity, n) => {
            const began = performance.now();
            const operation = operations[(offset + n) % endpointCount];
            if (!operation) throw new Error('Missing test operation');
            if (allowed(await limiter.consume([ip, operation, identity]))) admitted += 1;
            latencies.push(performance.now() - began);
          }),
        );
      }
      const elapsedMs = performance.now() - started;
      const createdIdentities = (
        await admin.mget(...identities.map(({ key }) => storage(key)))
      ).filter((value) => value !== null).length;
      const deniedIdentity = identities[endpointCount * 20];
      if (!deniedIdentity) throw new Error('Missing denied identity');
      const deniedIdentityCreated = (await admin.exists(storage(deniedIdentity.key))) === 1;
      const legacyCardinality = await admin.zcard(legacyIndex);
      const existingAllowed = allowed(await limiter.consume([existing]));
      const otherIpAllowed = allowed(
        await limiter.consume([
          bucket('ip', 'other-ip', 120, 60_000),
          bucket('operation', 'other-ip:login'),
          bucket('identity', 'other-person'),
        ]),
      );
      latencies.sort((a, b) => a - b);
      measurements.push({
        endpointCount,
        requests: identities.length,
        admitted,
        createdIdentities,
        deniedIdentityCreated,
        legacyCardinality,
        attackRequestsToLegacyCapacity: legacyCardinality === 10_000 ? createdIdentities : null,
        existingAllowed,
        otherIpAllowed,
        elapsedMs,
        p50Ms: latencies[Math.floor(latencies.length * 0.5)],
        p95Ms: latencies[Math.floor(latencies.length * 0.95)],
        p99Ms: latencies[Math.floor(latencies.length * 0.99)],
      });
      expect(deniedIdentityCreated).toBe(false);
      expect(createdIdentities).toBe(endpointCount * 20);
      expect(admitted).toBe(endpointCount * 20);
      expect(existingAllowed).toBe(true);
      expect(otherIpAllowed).toBe(true);
      expect(await admin.get(storage(ip.key))).toBe('121');
    },
    60_000,
  );

  it('returns the actual maximum wait for all denied dimensions', async () => {
    const buckets = [
      bucket('ip', 'retry:ip', 1, 2_000),
      bucket('operation', 'retry:operation', 1, 15_000),
      bucket('identity', 'retry:identity', 1, 5_000),
    ];
    expect(allowed(await limiter.consume(buckets))).toBe(true);
    const result = await limiter.consume(buckets);
    expect(result).toMatchObject({ allowed: false });
    const retry = result.retryAfterMs;
    expect(retry).toBeGreaterThan(14_000);
    expect(retry).toBeLessThanOrEqual(15_000);
  });

  it('gates new operation and identity keys while still counting existing finer counters', async () => {
    const ip = bucket('ip', 'gate:ip', 1, 60_000);
    const operation = bucket('operation', 'gate:operation', 10);
    const identity = bucket('identity', 'gate:identity', 10);
    expect((await limiter.consume([ip, operation, identity])).allowed).toBe(true);
    const freshOperation = bucket('operation', 'gate:new-operation', 10);
    const freshIdentity = bucket('identity', 'gate:new-identity', 10);
    expect((await limiter.consume([ip, freshOperation, freshIdentity])).allowed).toBe(false);
    expect(await admin.exists(storage(freshOperation.key), storage(freshIdentity.key))).toBe(0);
    expect((await limiter.consume([ip, operation, identity])).allowed).toBe(false);
    expect(await admin.mget(storage(operation.key), storage(identity.key))).toEqual(['2', '2']);
  });

  it('keeps the identity budget shared between different source IPs', async () => {
    const identity = bucket('identity', 'distributed:email', 2);
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(
        await limiter.consume([
          bucket('ip', `distributed:ip:${i}`, 120, 60_000),
          bucket('operation', `distributed:operation:${i}`),
          identity,
        ]),
      );
    }
    expect(results.map(({ allowed }) => allowed)).toEqual([true, true, false]);
    expect(await admin.get(storage(identity.key))).toBe('3');
  });

  it('counts legacy finer counters without importing them into new indexes after a coarse denial', async () => {
    const ip = bucket('ip', 'legacy:ip', 1, 60_000);
    const operation = bucket('operation', 'legacy:operation', 10, 30_000);
    const identity = bucket('identity', 'legacy:identity', 10, 30_000);
    expect((await limiter.consume([ip])).allowed).toBe(true);
    await admin.set(storage(operation.key), '1', 'PX', 30_000);
    await admin.set(storage(identity.key), '1', 'PX', 30_000);
    expect((await limiter.consume([ip, operation, identity])).allowed).toBe(false);
    expect(await admin.mget(storage(operation.key), storage(identity.key))).toEqual(['2', '2']);
    expect(
      await admin.zscore(indexFor('operation', operation.key), storage(operation.key)),
    ).toBeNull();
    expect(
      await admin.zscore(indexFor('identity', identity.key), storage(identity.key)),
    ).toBeNull();
    expect(await admin.pttl(storage(identity.key))).toBeLessThanOrEqual(30_000);
  });

  it('isolates shard capacity, preserves existing keys and resumes after the first slot expires', async () => {
    const existing = bucket('ip', 'capacity:existing', 1000, 60_000);
    expect((await limiter.consume([existing])).allowed).toBe(true);
    const index = indexFor('ip', existing.key);
    let same;
    let other;
    for (let i = 0; !same || !other; i += 1) {
      const candidate = bucket('ip', `capacity:candidate:${i}`, 1000, 60_000);
      if (indexFor('ip', candidate.key) === index) same ??= candidate;
      else other ??= candidate;
    }
    const slots = Array.from({ length: 511 }, (_, i) => storage(`${prefix}:capacity:filler:${i}`));
    for (const key of slots) members.get(index)?.add(key);
    const time = await admin.time();
    const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
    await admin.zadd(index, ...slots.flatMap((key, i) => [now + (i === 0 ? 5_000 : 30_000), key]));
    const denied = await limiter.consume([same]);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(4_000);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(5_000);
    expect(await admin.exists(storage(same.key))).toBe(0);
    expect((await limiter.consume([existing])).allowed).toBe(true);
    expect((await limiter.consume([other])).allowed).toBe(true);
    expect(
      (
        await limiter.consume([
          existing,
          bucket('operation', 'capacity:other-scope'),
          bucket('identity', 'capacity:other-identity'),
        ])
      ).allowed,
    ).toBe(true);
    const first = slots[0];
    if (!first) throw new Error('Missing capacity fixture');
    // Advance only this owned slot's expiry; the script must prune it before admission.
    await admin.zadd(index, now - 1, first);
    expect((await limiter.consume([same])).allowed).toBe(true);
    expect(await admin.zcard(index)).toBe(512);
    expect(await admin.zscore(index, first)).toBeNull();
  });

  it('cleans expired counters from their shard when another identity is admitted', async () => {
    const expired = bucket('ip', 'expiry:old', 1, 1_000);
    const index = indexFor('ip', expired.key);
    expect((await limiter.consume([expired])).allowed).toBe(true);
    let fresh;
    for (let i = 0; !fresh; i += 1) {
      const candidate = bucket('ip', `expiry:fresh:${i}`, 1, 1_000);
      if (indexFor('ip', candidate.key) === index) fresh = candidate;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    expect(await admin.exists(storage(expired.key))).toBe(0);
    expect((await limiter.consume([fresh])).allowed).toBe(true);
    expect(await admin.zscore(index, storage(expired.key))).toBeNull();
    expect(await admin.zcard(index)).toBe(1);
  });

  it.each(['ip', 'operation', 'identity'] as const)(
    'reports only the exhausted %s dimension rather than unrelated longer windows',
    async (scope) => {
      const scopes = ['ip', 'operation', 'identity'] as const;
      const buckets = scopes.map((selected) =>
        bucket(
          selected,
          `retry-one:${selected}`,
          selected === scope ? 1 : 100,
          selected === scope ? 3_000 : 30_000,
        ),
      );
      expect((await limiter.consume(buckets)).allowed).toBe(true);
      const denied = await limiter.consume(buckets);
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBeGreaterThan(2_000);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(3_000);
    },
  );

  it('includes a coarse budget newly exhausted by an attempt denied elsewhere', async () => {
    const buckets = [
      bucket('ip', 'retry-after-write:ip', 2, 5_000),
      bucket('operation', 'retry-after-write:operation', 1, 1_000),
    ];
    expect((await limiter.consume(buckets)).allowed).toBe(true);
    const denied = await limiter.consume(buckets);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(4_000);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it.each([0, 86_410_000])(
    'fails closed on an existing counter with invalid TTL %i before writing another budget',
    async (ttl) => {
      const ip = bucket('ip', 'invalid-ttl:ip');
      const operation = bucket('operation', 'invalid-ttl:operation');
      if (ttl === 0) await admin.set(storage(operation.key), '1');
      else await admin.set(storage(operation.key), '1', 'PX', ttl);
      await expect(limiter.consume([ip, operation])).rejects.toMatchObject({
        code: 'RATE_LIMIT_UNAVAILABLE',
      });
      expect(await admin.exists(storage(ip.key))).toBe(0);
      expect(await admin.get(storage(operation.key))).toBe('1');
    },
  );
});
