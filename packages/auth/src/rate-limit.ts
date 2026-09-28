import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';

export type RateLimitErrorCode =
  'RATE_LIMIT_INVALID' | 'RATE_LIMIT_UNAVAILABLE' | 'RATE_LIMIT_CLOSED';

export class RateLimitError extends Error {
  constructor(readonly code: RateLimitErrorCode) {
    super(code);
    this.name = 'RateLimitError';
  }
}

export interface RateBucket {
  readonly scope: 'ip' | 'operation' | 'identity';
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Remaining wait in Redis time; zero only when the attempt was admitted. */
  readonly retryAfterMs: number;
}

export interface AuthLimiter {
  consume(buckets: readonly RateBucket[]): Promise<RateLimitResult>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

// The ordered coarse gates stop rejected IPs allocating new identity buckets.
// Existing counters still count denied attempts, without extending their TTL.
// Fixed scope/hash segments bound live state without one platform-wide index:
// 3 scopes * 16 shards * 512 counters = 24,576 counters and at most 48 indexes.
// Production keys are already HMAC-derived, so clients cannot target a shard.
const consumeScript = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
local buckets = {}
-- Validate every counter/index before writing any attempt. Script errors do
-- not roll back earlier Redis commands, so validation precedes budget changes.
for i = 1, #KEYS, 2 do
  local raw = redis.call('GET', KEYS[i])
  local value = 0
  if raw then
    if #raw > 6 or not string.match(raw, '^%d+$') then
      return redis.error_reply('RATE_LIMIT_STATE_INVALID')
    end
    value = tonumber(raw)
  end
  if not value or value < 0 or value > 100001 or value ~= math.floor(value) then
    return redis.error_reply('RATE_LIMIT_STATE_INVALID')
  end
  local ttl = redis.call('PTTL', KEYS[i])
  if raw and (ttl < 1 or ttl > 86400000) then
    return redis.error_reply('RATE_LIMIT_STATE_INVALID')
  end
  local kind = redis.call('TYPE', KEYS[i + 1]).ok
  if kind ~= 'none' and kind ~= 'zset' then
    return redis.error_reply('RATE_LIMIT_STATE_INVALID')
  end
  buckets[#buckets + 1] = {
    key = KEYS[i], index = KEYS[i + 1], present = raw ~= false,
    value = value, limit = tonumber(ARGV[i]),
    ttl = raw and ttl or tonumber(ARGV[i + 1])
  }
end
local denied = false
local retry = 0
for _, bucket in ipairs(buckets) do
  redis.call('ZREMRANGEBYSCORE', bucket.index, '-inf', now)
  -- A denied coarse gate may count existing finer counters, but cannot create
  -- a new operation or identity. Scope order is validated by the caller.
  if bucket.present or not denied then
    local upstreamDenied = denied
    if bucket.value >= bucket.limit then denied = true end
    local indexed = redis.call('ZSCORE', bucket.index, bucket.key)
    if not indexed and upstreamDenied then
      -- Legacy counters retain their budget, but a denied coarse gate must not
      -- import old attack identities into the new indexes during rollout.
      bucket.write = true
    elseif not indexed and redis.call('ZCARD', bucket.index) >= 512 then
      denied = true
      local first = redis.call('ZRANGE', bucket.index, 0, 0, 'WITHSCORES')
      local delay = tonumber(first[2]) - now
      if delay < 1 or delay > 86400000 or delay ~= math.floor(delay) then
        return redis.error_reply('RATE_LIMIT_STATE_INVALID')
      end
      retry = math.max(retry, delay)
    else
      bucket.write = true
      bucket.indexWrite = true
    end
    if bucket.write then bucket.value = math.min(bucket.value + 1, bucket.limit + 1) end
  end
end
for _, bucket in ipairs(buckets) do
  if bucket.write then
    redis.call('SET', bucket.key, bucket.value, 'PX', bucket.ttl)
  end
  if bucket.indexWrite then
    redis.call('ZADD', bucket.index, now + bucket.ttl, bucket.key)
    redis.call('PEXPIRE', bucket.index, 86401000)
  end
  -- An attempt denied by another dimension can exhaust this dimension too.
  -- Include that final state so a retry is not advertised prematurely.
  if denied and bucket.value >= bucket.limit then
    retry = math.max(retry, bucket.ttl)
  end
end
if denied then return {0, math.max(1, retry)} end
return {1, 0}
`;

function validateBuckets(buckets: readonly RateBucket[]): void {
  const candidate: unknown = buckets;
  if (!Array.isArray(candidate) || buckets.length < 1 || buckets.length > 3) {
    throw new RateLimitError('RATE_LIMIT_INVALID');
  }
  const unique = new Set<string>();
  const scopes = ['ip', 'operation', 'identity'];
  for (const [index, bucket] of buckets.entries()) {
    if (
      !bucket ||
      bucket.scope !== scopes[index] ||
      typeof bucket.key !== 'string' ||
      !/^[a-z0-9:_-]{1,160}$/.test(bucket.key) ||
      !Number.isSafeInteger(bucket.limit) ||
      bucket.limit < 1 ||
      bucket.limit > 100_000 ||
      !Number.isSafeInteger(bucket.windowMs) ||
      bucket.windowMs < 1_000 ||
      bucket.windowMs > 86_400_000 ||
      unique.has(bucket.key)
    ) {
      throw new RateLimitError('RATE_LIMIT_INVALID');
    }
    unique.add(bucket.key);
  }
}

export function createAuthLimiter(redisUrl: string): AuthLimiter {
  // URL validation belongs to @ctp/config. Never copy this URL into errors.
  let redis: Redis;
  try {
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
      disconnectTimeout: 100,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      reconnectOnError: () => false,
      connectionName: 'ctp-auth-limiter',
    });
  } catch {
    throw new RateLimitError('RATE_LIMIT_INVALID');
  }
  redis.on('error', () => {});
  let closed = false;
  let disconnectRequested = false;
  let connecting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const isReady = () => redis.status === 'ready';

  function disconnect(): void {
    // ioredis adds a close listener for every disconnect call. Concurrent
    // deadlines share one connection and must request teardown only once.
    if (disconnectRequested) return;
    disconnectRequested = true;
    redis.disconnect(false);
  }

  async function connect(): Promise<void> {
    if (disconnectRequested && redis.status !== 'end') {
      throw new RateLimitError('RATE_LIMIT_UNAVAILABLE');
    }
    if (isReady()) return;
    if (!connecting) {
      if (redis.status !== 'wait' && redis.status !== 'end') {
        throw new RateLimitError('RATE_LIMIT_UNAVAILABLE');
      }
      disconnectRequested = false;
      connecting = redis.connect().finally(() => {
        connecting = undefined;
      });
    }
    await connecting;
    if (closed || !isReady()) throw new RateLimitError('RATE_LIMIT_UNAVAILABLE');
  }

  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new RateLimitError('RATE_LIMIT_CLOSED'));
    if (pending.size >= 32) return Promise.reject(new RateLimitError('RATE_LIMIT_UNAVAILABLE'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = connect().then(() => {
      if (closed) throw new RateLimitError('RATE_LIMIT_CLOSED');
      return operation();
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        disconnect();
        reject(new RateLimitError('RATE_LIMIT_UNAVAILABLE'));
      }, 1_000);
    });
    // Disconnect rejects outstanding Redis commands. Keep their work accounted
    // for until it settles; a timed-out caller never creates a hidden queue.
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return Promise.race([work, deadline])
      .catch(() => {
        throw new RateLimitError('RATE_LIMIT_UNAVAILABLE');
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  }

  return {
    async consume(buckets) {
      validateBuckets(buckets);
      // Retain counter names and remaining budgets across the index upgrade.
      // The unused legacy global index expires after its last old-version write.
      const keys = buckets.flatMap(({ key, scope }) => [
        `ctp:auth:{rate}:bucket:${key}`,
        `ctp:auth:{rate}:v2:index:${scope}:${createHash('sha256').update(key).digest('hex')[0]}`,
      ]);
      const args = buckets.flatMap(({ limit, windowMs }) => [limit, windowMs]);
      return run(async () => {
        const result = await redis.eval(consumeScript, keys.length, ...keys, ...args);
        if (
          !Array.isArray(result) ||
          result.length !== 2 ||
          (result[0] !== 0 && result[0] !== 1) ||
          !Number.isSafeInteger(result[1]) ||
          (result[0] === 1 ? result[1] !== 0 : result[1] < 1 || result[1] > 86_400_000)
        )
          throw new RateLimitError('RATE_LIMIT_UNAVAILABLE');
        return { allowed: result[0] === 1, retryAfterMs: result[1] as number };
      });
    },
    async ready() {
      await run(async () => {
        if ((await redis.ping()) !== 'PONG') throw new RateLimitError('RATE_LIMIT_UNAVAILABLE');
      });
    },
    close() {
      if (!closing) {
        closed = true;
        disconnect();
        closing = Promise.allSettled([...pending]).then(() => undefined);
      }
      return closing;
    },
  };
}
