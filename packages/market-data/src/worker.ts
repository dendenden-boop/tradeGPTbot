import { createMarketDataEngine } from './engine.js';
import { createWsPool } from './pool.js';
import { feedKey, type CoverageProof } from './candles.js';
import type { EngineOptions, FeedInput, FeedIntent, IoContext, PublicFeedPort } from './ports.js';
export interface MetadataRefreshPort {
  refresh(intents: readonly FeedIntent[], context: IoContext): Promise<void>;
}
/** Bounded normalized replay plus evidence, not candles split from coarser history. */
export interface TradeRecoveryPort {
  recover(
    intent: FeedIntent,
    checkpoint: ReturnType<ReturnType<typeof createMarketDataEngine>['snapshot']>,
    context: IoContext,
  ): Promise<{
    readonly trades: readonly Extract<FeedInput, { kind: 'TRADE' }>[];
    readonly proof: CoverageProof;
  }>;
}
export function createMarketDataWorker(
  options: EngineOptions & {
    feed: PublicFeedPort;
    metadata: MetadataRefreshPort;
    recovery: TradeRecoveryPort;
  },
) {
  if (
    !options.feed ||
    typeof options.metadata?.refresh !== 'function' ||
    typeof options.recovery?.recover !== 'function'
  )
    throw new Error('SERVER_RECOVERY_PORTS_REQUIRED');
  const now = options.now ?? Date.now,
    engine = createMarketDataEngine(options),
    intents = new Map<string, { intent: FeedIntent; refs: number }>(),
    pending = new Set<string>(),
    controller = new AbortController();
  let closed = false,
    lastMetadata = 0,
    lastLease = 0,
    cycling: Promise<void> | null = null,
    closing: Promise<void> | null = null,
    interval: ReturnType<typeof setInterval> | undefined;
  const pool = createWsPool({
    port: options.feed,
    now,
    onInput: (key, input) => {
      engine.enqueue(key, input);
    },
    onGap: (key, reason) => {
      if (!intents.has(key) || closed) return;
      const checkpoint = engine.snapshot(key);
      engine.enqueue(key, {
        kind: 'GAP',
        from: checkpoint.watermark,
        to: Math.max(checkpoint.watermark + 1, now()),
        reason,
      });
      pending.add(key);
    },
  });
  const context = () => ({ signal: controller.signal, deadline: now() + 3000 });
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_r, j) => {
          timer = setTimeout(() => j(new Error('RECOVERY_DEADLINE')), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const worker = {
    async retain(intent: FeedIntent, start?: number) {
      if (closed) throw new Error('WORKER_CLOSED');
      const key = feedKey(intent.scope, intent.instrumentId),
        existing = intents.get(key);
      if (existing && existing.intent.profileId !== intent.profileId)
        throw new Error('PROFILE_CONFLICT');
      await bounded(() => options.metadata.refresh([intent], context()));
      const retained = await engine.retain(intent.scope, intent.instrumentId, start);
      try {
        pool.retain(intent);
      } catch (error) {
        await engine.release(retained);
        throw error;
      }
      if (existing) existing.refs++;
      else intents.set(key, { intent: structuredClone(intent), refs: 1 });
      if (engine.health(key).reason === 'RESTART') pending.add(key);
      return key;
    },
    async release(key: string) {
      const entry = intents.get(key);
      if (!entry) return;
      await pool.release(entry.intent);
      await engine.release(key);
      if (--entry.refs === 0) {
        intents.delete(key);
        pending.delete(key);
      }
    },
    cycle(): Promise<void> {
      if (closed) return Promise.resolve();
      if (cycling !== null) return cycling;
      cycling = (async () => {
        if (now() - lastMetadata >= 15000) {
          try {
            await bounded(() =>
              options.metadata.refresh(
                [...intents.values()].map((x) => x.intent),
                context(),
              ),
            );
            lastMetadata = now();
          } catch {
            for (const key of intents.keys()) pending.add(key);
          }
        }
        await engine.flush();
        const keys = [...pending].slice(0, 4);
        for (const key of keys) {
          pending.delete(key);
          const entry = intents.get(key);
          if (!entry) continue;
          try {
            const result = await bounded(() =>
              options.recovery.recover(entry.intent, engine.snapshot(key), context()),
            );
            if (result.trades.length > 2048) throw new Error('RECOVERY_CAPACITY');
            for (const trade of result.trades)
              if (!engine.enqueue(key, trade)) throw new Error('RECOVERY_OVERFLOW');
            if (!engine.enqueue(key, { kind: 'COVERAGE', proof: result.proof, repaired: true }))
              throw new Error('RECOVERY_OVERFLOW');
          } catch {
            const checkpoint = engine.snapshot(key);
            engine.enqueue(key, {
              kind: 'GAP',
              from: checkpoint.watermark,
              to: Math.max(checkpoint.watermark + 1, now()),
              reason: 'RECOVERY_UNVERIFIABLE',
            });
          }
        }
        await engine.flush();
        if (now() - lastLease >= 3000) {
          await engine.maintain();
          lastLease = now();
        }
        await pool.tick();
      })().finally(() => {
        cycling = null;
      });
      return cycling;
    },
    start() {
      if (closed) throw new Error('WORKER_CLOSED');
      if (interval) return;
      interval = setInterval(() => {
        void worker.cycle().catch(() => {});
      }, 250);
    },
    async settled() {
      await pool.settled();
      if (cycling !== null) await cycling;
    },
    snapshot: engine.snapshot,
    health: engine.health,
    metrics() {
      return { engine: engine.metrics(), pool: pool.metrics(), pendingRecovery: pending.size };
    },
    close(): Promise<void> {
      if (closing !== null) return closing;
      closed = true;
      controller.abort();
      if (interval) clearInterval(interval);
      closing = (async () => {
        await pool.close();
        if (cycling !== null) await cycling;
        await engine.flush();
        await engine.close();
        intents.clear();
        pending.clear();
      })();
      return closing;
    },
  };
  return Object.freeze(worker);
}
