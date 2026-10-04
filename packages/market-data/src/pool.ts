import { feedKey } from './candles.js';
import type { FeedConnection, FeedInput, FeedIntent, PublicFeedPort } from './ports.js';
type Shard = {
  id: number;
  profileId: string;
  topics: Map<string, FeedIntent>;
  generation: number;
  controller: AbortController | null;
  connection: FeedConnection | null;
  task: Promise<void> | null;
  retryAt: number;
  attempts: number;
  healthySince: number | null;
  dirty: boolean;
};
export function createWsPool(options: {
  port: PublicFeedPort;
  onInput: (key: string, input: FeedInput) => void;
  onGap: (key: string, reason: string) => void;
  now?: () => number;
  random?: () => number;
}) {
  if (
    !options.port ||
    !Number.isSafeInteger(options.port.maxTopics) ||
    options.port.maxTopics < 1 ||
    options.port.maxTopics > 1024 ||
    !Number.isSafeInteger(options.port.maxConnections) ||
    options.port.maxConnections < 1 ||
    options.port.maxConnections > 32
  )
    throw new Error('INVALID_POOL_PORT');
  const now = options.now ?? Date.now,
    random = options.random ?? Math.random,
    shards: Shard[] = [],
    refs = new Map<string, { count: number; shard: Shard }>();
  let closed = false,
    nextId = 0;
  function run(shard: Shard, work: () => Promise<void>) {
    shard.task = work().finally(() => {
      shard.task = null;
    });
    void shard.task.catch(() => {});
  }
  async function stop(s: Shard) {
    s.generation++;
    s.controller?.abort();
    if (s.connection) {
      const c = s.connection;
      s.connection = null;
      await c.close();
    }
    s.controller = null;
    s.healthySince = null;
  }
  function gap(s: Shard, generation: number, reason: string) {
    if (closed || s.generation !== generation) return;
    for (const key of s.topics.keys()) options.onGap(key, reason);
    const stable = s.healthySince !== null && now() - s.healthySince >= 60000;
    s.attempts = stable ? 0 : s.attempts + 1;
    const jitter = random();
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new Error('INVALID_JITTER');
    s.retryAt = now() + Math.floor(jitter * Math.min(30000, 250 * 2 ** Math.min(s.attempts, 8)));
    // During establishment its promise owns the slot and cleanup; do not free it early.
    if (s.task) {
      s.generation++;
      s.controller?.abort();
      return;
    }
    run(s, () => stop(s));
  }
  return Object.freeze({
    retain(intent: FeedIntent) {
      if (closed) throw new Error('POOL_CLOSED');
      const key = feedKey(intent.scope, intent.instrumentId),
        existing = refs.get(key);
      if (existing) {
        if (existing.shard.profileId !== intent.profileId) throw new Error('PROFILE_CONFLICT');
        existing.count++;
        return key;
      }
      let s = shards.find(
        (x) => x.profileId === intent.profileId && x.topics.size < options.port.maxTopics,
      );
      if (!s) {
        if (
          shards.filter((x) => x.topics.size > 0 || x.task !== null || x.connection !== null)
            .length >= options.port.maxConnections
        )
          throw new Error('CONNECTION_CAPACITY');
        s = shards.find((x) => x.topics.size === 0 && x.task === null && x.connection === null);
        if (s) {
          s.profileId = intent.profileId;
          s.retryAt = 0;
          s.attempts = 0;
        } else {
          s = {
            id: nextId++,
            profileId: intent.profileId,
            topics: new Map(),
            generation: 0,
            controller: null,
            connection: null,
            task: null,
            retryAt: 0,
            attempts: 0,
            healthySince: null,
            dirty: true,
          };
          shards.push(s);
        }
      }
      s.topics.set(key, structuredClone(intent));
      s.dirty = true;
      refs.set(key, { count: 1, shard: s });
      return key;
    },
    async release(intent: FeedIntent) {
      const key = feedKey(intent.scope, intent.instrumentId),
        r = refs.get(key);
      if (!r) return;
      if (--r.count > 0) return;
      refs.delete(key);
      r.shard.topics.delete(key);
      r.shard.dirty = true;
      if (r.shard.topics.size === 0) {
        r.shard.controller?.abort();
        if (r.shard.task) await r.shard.task;
        await stop(r.shard);
      }
    },
    tick() {
      if (closed) return Promise.resolve();
      for (const s of shards) {
        if (s.task || s.topics.size === 0 || s.retryAt > now() || (!s.dirty && s.connection))
          continue;
        run(s, async () => {
          if (s.connection) {
            for (const key of s.topics.keys()) options.onGap(key, 'RESHARD');
            await stop(s);
          }
          if (closed || s.topics.size === 0) return;
          const controller = new AbortController();
          s.controller = controller;
          const generation = ++s.generation;
          const intents = [...s.topics.values()];
          s.dirty = false;
          const timer = setTimeout(() => controller.abort(), 5000);
          try {
            const connection = await options.port.open(
              intents,
              { signal: controller.signal, deadline: now() + 5000 },
              (key, input) => {
                if (!closed && s.generation === generation && s.topics.has(key))
                  options.onInput(key, input);
              },
              (reason) => gap(s, generation, reason),
            );
            if (closed || controller.signal.aborted || s.generation !== generation) {
              await connection.close();
              return;
            }
            s.connection = connection;
            s.healthySince = now();
          } catch {
            if (!closed && s.generation === generation) gap(s, generation, 'SOURCE_CLOSED');
          } finally {
            clearTimeout(timer);
            if (!s.connection) {
              s.controller = null;
              s.healthySince = null;
            }
          }
        });
      }
      return Promise.resolve();
    },
    async settled() {
      await Promise.all(shards.flatMap((s) => (s.task !== null ? [s.task] : [])));
    },
    metrics() {
      return {
        topics: refs.size,
        connections: shards.filter((s) => s.connection !== null || s.task !== null).length,
        shards: shards.filter((s) => s.topics.size > 0).length,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const s of shards) {
        s.generation++;
        s.controller?.abort();
      }
      await Promise.all(shards.flatMap((s) => (s.task !== null ? [s.task] : [])));
      for (const s of shards) await stop(s);
      refs.clear();
      shards.length = 0;
    },
  });
}
