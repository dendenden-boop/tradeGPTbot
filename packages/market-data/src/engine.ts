import { randomUUID } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { idSchema, marketScopeSchema, tradeTickSchema, type MarketScope } from '@ctp/exchange-core';
import { z } from 'zod';
import {
  advanceEventWatermark,
  applyCoverage,
  applyGap,
  applyTrade,
  createCandleState,
  feedKey,
  restoreCandleState,
  type CandleState,
} from './candles.js';
import type { EngineOptions, FeedInput, MarketEvent, StoredPartition } from './ports.js';

type Partition = {
  refs: number;
  stored: StoredPartition;
  lastValid: number | null;
  reason: string | null;
  blocked: boolean;
  bytes: number;
};
const inputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('TRADE'),
    tick: tradeTickSchema,
    metadataVersion: idSchema,
    executionCount: z.number().int().positive().safe().nullable(),
  }),
  z.strictObject({
    kind: z.literal('COVERAGE'),
    proof: z.strictObject({
      from: z.number().int().nonnegative().safe(),
      to: z.number().int().nonnegative().safe(),
      cursor: idSchema,
      evidence: z.enum(['RECONCILED_TRADES', 'CONTIGUOUS_NATIVE_SEQUENCE']),
    }),
    repaired: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('GAP'),
    from: z.number().int().nonnegative().safe(),
    to: z.number().int().nonnegative().safe(),
    reason: idSchema,
  }),
]);
export function createMarketDataEngine(options: EngineOptions) {
  if (
    !options.registry ||
    typeof options.registry.get !== 'function' ||
    !options.store ||
    typeof options.store.acquire !== 'function' ||
    typeof options.store.commit !== 'function'
  )
    throw new Error('RUNTIME_PORTS_REQUIRED');
  const settings = z
    .strictObject({
      maxInstruments: z.number().int().min(1).max(10000),
      maxQueue: z.number().int().min(1).max(50000),
      maxQueueBytes: z.number().int().min(512).max(33554432),
      maxStateBytes: z.number().int().min(524288).max(268435456),
      staleAfterMs: z.number().int().min(1000).max(60000),
    })
    .parse({
      maxInstruments: options.maxInstruments ?? 1000,
      maxQueue: options.maxQueue ?? 50000,
      maxQueueBytes: options.maxQueueBytes ?? 33554432,
      maxStateBytes: options.maxStateBytes ?? 134217728,
      staleAfterMs: options.staleAfterMs ?? 15000,
    });
  const now = options.now ?? Date.now,
    owner = randomUUID(),
    partitions = new Map<string, Partition>(),
    retaining = new Map<string, Promise<void>>(),
    gaps = new Map<string, string>();
  let queue: { key: string; input: FeedInput; bytes: number }[] = [],
    queuedBytes = 0,
    stateBytes = 0,
    closed = false,
    flushing: Promise<void> | undefined,
    dropped = 0,
    committed = 0,
    inFlight = 0;
  const context = () => ({ signal: new AbortController().signal, deadline: now() + 3000 });
  function health(key: string) {
    const p = partitions.get(key);
    if (!p) throw new Error('UNKNOWN_FEED');
    return {
      freshness:
        p.blocked ||
        p.reason !== null ||
        p.lastValid === null ||
        now() - p.lastValid > settings.staleAfterMs
          ? ('STALE' as const)
          : ('FRESH' as const),
      reason: p.reason,
      lastValid: p.lastValid,
      watermark: p.stored.state.watermark,
      epoch: p.stored.epoch,
    };
  }
  async function process(
    key: string,
    jobs: readonly FeedInput[],
    gap: string | undefined,
  ): Promise<void> {
    const p = partitions.get(key);
    if (!p || p.blocked) return;
    const before = p.stored.state,
      next = structuredClone(before),
      events: MarketEvent[] = [];
    let lastValid = p.lastValid,
      reason = p.reason === 'AWAITING_DATA' ? null : p.reason;
    try {
      const record = options.registry.get(next.scope, next.instrumentId, now());
      if (!record.ok) throw new Error('STALE_METADATA');
      let processed = 0;
      for (const input of jobs) {
        if (++processed % 32 === 0) await yieldLoop();
        if (input.kind === 'TRADE') {
          if (
            input.metadataVersion !== record.value.instrument.metadataVersion ||
            input.tick.exchangeTime > now() + 5000 ||
            input.tick.receivedAt > now() + 5000
          )
            throw new Error('SOURCE_IDENTITY_OR_CLOCK');
          applyTrade(next, input.tick, input.executionCount);
          advanceEventWatermark(next, input.tick.exchangeTime);
          lastValid = Math.max(lastValid ?? 0, input.tick.receivedAt);
        } else if (input.kind === 'COVERAGE') {
          applyCoverage(next, input.proof, input.repaired);
          if (input.repaired) reason = null;
        } else {
          applyGap(next, input.from, input.to, input.reason);
          reason = input.reason;
        }
      }
      if (gap) {
        applyGap(next, next.watermark, Math.max(next.watermark + 1, now()), gap);
        reason = gap;
      }
    } catch {
      // Discard the whole candidate batch. A malformed/conflicting frame cannot partially commit.
      Object.assign(next, structuredClone(before));
      reason = 'SOURCE_INVALID';
      applyGap(next, next.watermark, Math.max(next.watermark + 1, now()), reason);
    }
    if (reason && reason !== p.reason)
      events.push({ id: randomUUID(), key, type: 'MARKET_GAP', bar: null, reason });
    for (const b of next.bars) {
      if (b.closeTime > next.watermark) continue;
      const old = before.bars.find(
        (x) => x.timeframeMs === b.timeframeMs && x.openTime === b.openTime,
      );
      const previouslyClosed = old !== undefined && old.closeTime <= before.watermark;
      if (previouslyClosed && JSON.stringify(old) === JSON.stringify(b)) continue;
      events.push({
        id: randomUUID(),
        key,
        type: previouslyClosed ? 'CANDLE_REVISED' : 'CANDLE_CLOSED',
        bar: structuredClone(b),
        reason: null,
      });
    }
    try {
      const validated = restoreCandleState(next),
        bytes = Buffer.byteLength(JSON.stringify(validated));
      if (stateBytes - p.bytes + bytes > settings.maxStateBytes) throw new Error('STATE_CAPACITY');
      const stored = await options.store.commit(key, owner, p.stored, validated, events, context());
      stateBytes += bytes - p.bytes;
      p.bytes = bytes;
      p.stored = stored;
      p.reason = reason;
      p.lastValid = lastValid;
      committed++;
    } catch {
      p.blocked = true;
      p.reason = 'STORE_FAILED';
    }
  }
  return Object.freeze({
    async retain(
      scope: MarketScope,
      instrumentId: string,
      start = Math.floor(now() / 30000) * 30000,
    ): Promise<string> {
      if (closed) throw new Error('ENGINE_CLOSED');
      const key = feedKey(marketScopeSchema.parse(scope), instrumentId);
      const pending = retaining.get(key);
      if (pending) await pending;
      const current = partitions.get(key);
      if (current) {
        current.refs++;
        return key;
      }
      if (partitions.size + retaining.size >= settings.maxInstruments)
        throw new Error('INSTRUMENT_CAPACITY');
      const task = (async () => {
        const record = options.registry.get(scope, instrumentId, now());
        if (!record.ok) throw new Error('STALE_METADATA');
        const stored = await options.store.acquire(
          key,
          owner,
          createCandleState(scope, instrumentId, start),
          context(),
        );
        const state = restoreCandleState(stored.state);
        if (feedKey(state.scope, state.instrumentId) !== key) throw new Error('CHECKPOINT_SCOPE');
        const bytes = Buffer.byteLength(JSON.stringify(state));
        if (stateBytes + bytes > settings.maxStateBytes || closed) {
          await options.store.release(key, owner, stored.epoch, context());
          throw new Error('STATE_CAPACITY');
        }
        partitions.set(key, {
          refs: 1,
          stored: { ...stored, state },
          lastValid: null,
          reason: stored.version > 0 ? 'RESTART' : 'AWAITING_DATA',
          blocked: false,
          bytes,
        });
        stateBytes += bytes;
      })();
      retaining.set(key, task);
      try {
        await task;
      } finally {
        retaining.delete(key);
      }
      return key;
    },
    enqueue(key: string, raw: FeedInput): boolean {
      const p = partitions.get(key);
      if (closed || !p || p.blocked) return false;
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) {
        gaps.set(key, 'MALFORMED');
        dropped++;
        return false;
      }
      const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
      if (
        queue.length + inFlight >= settings.maxQueue ||
        queuedBytes + bytes > settings.maxQueueBytes
      ) {
        gaps.set(key, 'OVERFLOW');
        dropped++;
        return false;
      }
      queue.push({ key, input: structuredClone(parsed.data), bytes });
      queuedBytes += bytes;
      return true;
    },
    flush(): Promise<void> {
      if (flushing) return flushing;
      flushing = (async () => {
        while (queue.length || gaps.size) {
          const batch = queue.splice(0, 2048),
            byKey = new Map<string, FeedInput[]>();
          inFlight += batch.length;
          for (const job of batch) {
            const list = byKey.get(job.key) ?? [];
            list.push(job.input);
            byKey.set(job.key, list);
          }
          for (const key of gaps.keys()) if (!byKey.has(key)) byKey.set(key, []);
          for (const [key, jobs] of byKey) {
            const gap = gaps.get(key);
            gaps.delete(key);
            await process(key, jobs, gap);
            inFlight -= jobs.length;
            queuedBytes -= batch.filter((j) => j.key === key).reduce((sum, j) => sum + j.bytes, 0);
            await yieldLoop();
          }
        }
      })().finally(() => {
        flushing = undefined;
      });
      return flushing;
    },
    health,
    async maintain() {
      if (closed) return;
      if (flushing) await flushing;
      const entries = [...partitions.entries()];
      for (let at = 0; at < entries.length; at += 4)
        await Promise.all(
          entries.slice(at, at + 4).map(async ([key, p]) => {
            if (p.blocked) return;
            try {
              const renewed = await options.store.acquire(key, owner, p.stored.state, context());
              if (renewed.epoch !== p.stored.epoch || renewed.version !== p.stored.version)
                throw new Error('OWNER_FENCED');
            } catch {
              p.blocked = true;
              p.reason = 'STORE_FAILED';
            }
          }),
        );
    },
    snapshot(key: string): CandleState {
      const p = partitions.get(key);
      if (!p) throw new Error('UNKNOWN_FEED');
      return structuredClone(p.stored.state);
    },
    metrics() {
      return {
        instruments: partitions.size,
        queued: queue.length + inFlight,
        queuedBytes,
        stateBytes,
        dropped,
        committed,
      };
    },
    async release(key: string) {
      const p = partitions.get(key);
      if (!p) return;
      if (--p.refs > 0) return;
      if (flushing) await flushing;
      await options.store.release(key, owner, p.stored.epoch, context());
      partitions.delete(key);
      stateBytes -= p.bytes;
      queue = queue.filter((j) => {
        if (j.key !== key) return true;
        queuedBytes -= j.bytes;
        return false;
      });
      gaps.delete(key);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(retaining.values());
      if (flushing) await flushing;
      for (const [key, p] of partitions)
        await options.store.release(key, owner, p.stored.epoch, context()).catch(() => {});
      partitions.clear();
      queue = [];
      gaps.clear();
      queuedBytes = 0;
      stateBytes = 0;
    },
  });
}
