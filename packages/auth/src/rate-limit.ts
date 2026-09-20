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
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface AuthLimiter {
  consume(buckets: readonly RateBucket[]): Promise<boolean>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

// One atomic operation counts every supplied dimension, including denied
// attempts. Redis time controls fixed-window expiry. The shared index caps the
// number of live keys, so rotating email addresses cannot grow memory forever.
const consumeScript = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local values = {}
local newKeys = 0
for i = 2, #KEYS do
  local raw = redis.call('GET', KEYS[i])
  -- Missing keys start at zero. Lua's raw and tonumber(raw) or 0 would also
  -- replace corrupt, nonnumeric values with zero and silently reset a budget.
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
  values[i] = value
  if not redis.call('ZSCORE', KEYS[1], KEYS[i]) then newKeys = newKeys + 1 end
end
if redis.call('ZCARD', KEYS[1]) + newKeys > 10000 then return 0 end
local allowed = 1
for i = 2, #KEYS do
  local limit = tonumber(ARGV[(i - 2) * 2 + 1])
  local window = tonumber(ARGV[(i - 2) * 2 + 2])
  local value = values[i]
  if value >= limit then allowed = 0 end
  local ttl = redis.call('PTTL', KEYS[i])
  if ttl < 1 then ttl = window end
  redis.call('SET', KEYS[i], math.min(value + 1, limit + 1), 'PX', ttl)
  redis.call('ZADD', KEYS[1], now + ttl, KEYS[i])
end
redis.call('PEXPIRE', KEYS[1], 86401000)
return allowed
`;

function validateBuckets(buckets: readonly RateBucket[]): void {
  const candidate: unknown = buckets;
  if (!Array.isArray(candidate) || buckets.length < 1 || buckets.length > 4) {
    throw new RateLimitError('RATE_LIMIT_INVALID');
  }
  const unique = new Set<string>();
  for (const bucket of buckets) {
    if (
      !bucket ||
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
      const keys = buckets.map(({ key }) => `ctp:auth:{rate}:bucket:${key}`);
      const args = buckets.flatMap(({ limit, windowMs }) => [limit, windowMs]);
      return run(async () => {
        const result = await redis.eval(
          consumeScript,
          keys.length + 1,
          'ctp:auth:{rate}:index',
          ...keys,
          ...args,
        );
        if (result !== 0 && result !== 1) throw new RateLimitError('RATE_LIMIT_UNAVAILABLE');
        return result === 1;
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
