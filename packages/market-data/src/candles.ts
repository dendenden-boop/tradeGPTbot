import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  candleSchema,
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  idSchema,
  marketScopeSchema,
  parseDecimal,
  timestampSchema,
  tradeTickSchema,
  type Candle,
  type MarketScope,
  type TradeTick,
} from '@ctp/exchange-core';

export const timeframes = [30000, 60000, 180000, 300000, 900000, 1800000, 3600000] as const;
const names = ['30s', '1m', '3m', '5m', '15m', '30m', '1h'] as const;
export type Quality = 'UNVERIFIABLE' | 'VERIFIED' | 'EMPTY_VERIFIED' | 'GAP' | 'LATE_CORRECTION';
type Point = { time: number; identity: string; price: string };
export interface Bar {
  timeframeMs: number;
  openTime: number;
  closeTime: number;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  baseVolume: string;
  quoteVolume: string | null;
  tradeCount: number | null;
  first: Point | null;
  last: Point | null;
  complete: boolean;
  quality: Quality;
  revision: number;
  candle: Candle | null;
}
export interface CoverageProof {
  readonly from: number;
  readonly to: number;
  readonly cursor: string;
  readonly evidence: 'RECONCILED_TRADES' | 'CONTIGUOUS_NATIVE_SEQUENCE';
}
export interface CandleState {
  format: 1;
  scope: MarketScope;
  instrumentId: string;
  start: number;
  watermark: number;
  acceptAfter: number;
  cursor: string | null;
  bars: Bar[];
  seen: { identity: string; hash: string; time: number }[];
  coverage: { from: number; to: number }[];
  gaps: { from: number; to: number; reason: string }[];
}
const RETENTION = 60000,
  MAX_SEEN = 2048,
  MAX_BARS = 256;
export function feedKey(scope: MarketScope, instrumentId: string): string {
  const s = marketScopeSchema.parse(scope);
  return JSON.stringify([
    s.exchange,
    s.market,
    s.environment,
    s.region,
    idSchema.parse(instrumentId),
  ]);
}
export function createCandleState(
  scope: MarketScope,
  instrumentId: string,
  start: number,
): CandleState {
  return {
    format: 1,
    scope: marketScopeSchema.parse(scope),
    instrumentId: idSchema.parse(instrumentId),
    start: timestampSchema.parse(start),
    watermark: start,
    acceptAfter: start,
    cursor: null,
    bars: [],
    seen: [],
    coverage: [],
    gaps: [],
  };
}
/** A durable checkpoint is data, not an authority; corrupt or oversized state fails closed. */
export function restoreCandleState(raw: unknown): CandleState {
  const point = z.strictObject({
    time: timestampSchema,
    identity: z.string().max(512),
    price: z.string().max(80),
  });
  const range = z
    .strictObject({ from: timestampSchema, to: timestampSchema })
    .refine((r) => r.to > r.from);
  const bar = z.strictObject({
    timeframeMs: z.number().refine((t) => timeframes.some((tf) => tf === t)),
    openTime: timestampSchema,
    closeTime: timestampSchema,
    open: z.string().nullable(),
    high: z.string().nullable(),
    low: z.string().nullable(),
    close: z.string().nullable(),
    baseVolume: z.string(),
    quoteVolume: z.string().nullable(),
    tradeCount: z.number().int().nonnegative().safe().nullable(),
    first: point.nullable(),
    last: point.nullable(),
    complete: z.boolean(),
    quality: z.enum(['UNVERIFIABLE', 'VERIFIED', 'EMPTY_VERIFIED', 'GAP', 'LATE_CORRECTION']),
    revision: z.number().int().nonnegative().safe(),
    candle: candleSchema.nullable(),
  });
  const schema = z.strictObject({
    format: z.literal(1),
    scope: marketScopeSchema,
    instrumentId: idSchema,
    start: timestampSchema,
    watermark: timestampSchema,
    acceptAfter: timestampSchema,
    cursor: idSchema.nullable(),
    bars: z.array(bar).max(MAX_BARS),
    seen: z
      .array(
        z.strictObject({
          identity: z.string().max(512),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          time: timestampSchema,
        }),
      )
      .max(MAX_SEEN),
    coverage: z.array(range).max(128),
    gaps: z
      .array(
        z
          .strictObject({ from: timestampSchema, to: timestampSchema, reason: idSchema })
          .refine((r) => r.to > r.from),
      )
      .max(128),
  });
  if (Buffer.byteLength(JSON.stringify(raw)) > 524288) throw new Error('STATE_CAPACITY');
  const s: CandleState = schema.parse(raw);
  if (
    s.start > s.acceptAfter ||
    s.acceptAfter > s.watermark ||
    new Set(s.seen.map((x) => x.identity)).size !== s.seen.length ||
    new Set(s.bars.map((b) => `${b.timeframeMs}:${b.openTime}`)).size !== s.bars.length
  )
    throw new Error('CORRUPT_STATE');
  for (const b of s.bars) {
    if (b.first === null) {
      if (
        b.last !== null ||
        b.open !== null ||
        b.high !== null ||
        b.low !== null ||
        b.close !== null ||
        b.baseVolume !== '0' ||
        (b.quoteVolume !== null && b.quoteVolume !== '0') ||
        b.tradeCount !== 0
      )
        throw new Error('CORRUPT_EMPTY_STATE');
    } else {
      if (
        !b.last ||
        b.first.price !== b.open ||
        b.last.price !== b.close ||
        b.first.time < b.openTime ||
        b.first.time >= b.closeTime ||
        b.last.time < b.openTime ||
        b.last.time >= b.closeTime ||
        before(b.last, b.first) ||
        b.baseVolume === '0' ||
        b.tradeCount === 0 ||
        b.quality === 'EMPTY_VERIFIED'
      )
        throw new Error('CORRUPT_STATE');
    }
    if (
      b.openTime % b.timeframeMs !== 0 ||
      b.closeTime !== b.openTime + b.timeframeMs ||
      (b.first === null) !== (b.open === null) ||
      (b.last === null) !== (b.close === null) ||
      (b.complete && !['VERIFIED', 'EMPTY_VERIFIED'].includes(b.quality))
    )
      throw new Error('CORRUPT_STATE');
    const previous = JSON.stringify(b.candle);
    materialize(s, b);
    if (JSON.stringify(b.candle) !== previous) throw new Error('CORRUPT_STATE');
  }
  return s;
}
export function advanceEventWatermark(s: CandleState, exchangeTime: number): void {
  timestampSchema.parse(exchangeTime);
  s.watermark = Math.max(s.watermark, exchangeTime - 2000, s.start);
  s.acceptAfter = Math.max(s.acceptAfter, s.watermark - RETENTION);
  s.seen = s.seen.filter((x) => x.time >= s.acceptAfter);
}
function before(a: Point, b: Point): boolean {
  return a.time < b.time || (a.time === b.time && a.identity < b.identity);
}
function empty(tf: number, at: number): Bar {
  return {
    timeframeMs: tf,
    openTime: at,
    closeTime: at + tf,
    open: null,
    high: null,
    low: null,
    close: null,
    baseVolume: '0',
    quoteVolume: '0',
    tradeCount: 0,
    first: null,
    last: null,
    complete: false,
    quality: 'UNVERIFIABLE',
    revision: 0,
    candle: null,
  };
}
function materialize(s: CandleState, b: Bar): void {
  if (b.open === null || b.high === null || b.low === null || b.close === null) {
    b.candle = null;
    return;
  }
  const timeframe = names[timeframes.indexOf(b.timeframeMs as (typeof timeframes)[number])];
  if (!timeframe) throw new Error('INVALID_TIMEFRAME');
  b.candle = candleSchema.parse({
    scope: s.scope,
    instrumentId: s.instrumentId,
    timeframe,
    openTime: b.openTime,
    closeTime: b.closeTime,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    baseVolume: b.baseVolume,
    quoteVolume:
      b.quoteVolume === null
        ? { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' }
        : { state: 'AVAILABLE', value: b.quoteVolume },
    numberOfTrades: b.tradeCount,
    complete: b.complete,
    quality: b.complete ? 'COMPLETE' : b.quality === 'GAP' ? 'GAP' : 'PARTIAL',
    revision: b.revision,
    provenance: 'AGGREGATED_TRADES',
  });
}
function intersects(s: CandleState, b: Bar): boolean {
  return s.gaps.some((g) => g.from < b.closeTime && g.to > b.openTime);
}
function trim(s: CandleState): void {
  s.seen = s.seen.filter((x) => x.time >= s.acceptAfter);
  // Closed historical rows already belong to the store; only the correction window remains hot.
  s.bars = s.bars.filter((b) => b.closeTime >= s.acceptAfter);
  const floor = Math.floor(s.acceptAfter / 3600000) * 3600000;
  s.coverage = s.coverage
    .filter((c) => c.to > floor)
    .map((c) => ({ from: Math.max(floor, c.from), to: c.to }));
  s.gaps = s.gaps.filter((g) => g.to > floor).map((g) => ({ ...g, from: Math.max(floor, g.from) }));
}
/** Validate all seven changes before mutating state; no financial arithmetic uses Number. */
export function applyTrade(
  s: CandleState,
  raw: unknown,
  executionCount: number | null = 1,
): 'APPLIED' | 'DUPLICATE' {
  const t: TradeTick = tradeTickSchema.parse(raw);
  if (
    feedKey(t.scope, t.instrumentId) !== feedKey(s.scope, s.instrumentId) ||
    t.quantityUnit !== 'BASE'
  )
    throw new Error('TRADE_SCOPE_OR_UNIT');
  if (t.exchangeTime < s.acceptAfter) throw new Error('OUTSIDE_RETENTION');
  if (t.exchangeTime > t.receivedAt + 5000) throw new Error('CLOCK_DRIFT');
  if (executionCount !== null && (!Number.isSafeInteger(executionCount) || executionCount < 1))
    throw new Error('INVALID_EXECUTION_COUNT');
  const identity = JSON.stringify([t.identityScope, t.tradeId]);
  const hash = createHash('sha256')
    .update(JSON.stringify({ ...t, receivedAt: 0, executionCount }))
    .digest('hex');
  const seen = s.seen.find((x) => x.identity === identity);
  if (seen) {
    if (seen.hash !== hash) throw new Error('IDENTITY_CONFLICT');
    return 'DUPLICATE';
  }
  if (s.seen.filter((x) => x.time >= s.acceptAfter).length >= MAX_SEEN)
    throw new Error('DEDUP_CAPACITY');
  const point = { time: t.exchangeTime, identity, price: t.price };
  const changes = timeframes.map((tf) => {
    const at = Math.floor(t.exchangeTime / tf) * tf;
    const old = s.bars.find((b) => b.timeframeMs === tf && b.openTime === at);
    const b = structuredClone(old ?? empty(tf, at));
    const quote = decimalMultiply(t.price, t.quantity);
    b.baseVolume = decimalAdd(parseDecimal(b.baseVolume), t.quantity);
    b.quoteVolume = b.quoteVolume === null ? null : decimalAdd(parseDecimal(b.quoteVolume), quote);
    b.tradeCount =
      executionCount === null || b.tradeCount === null ? null : b.tradeCount + executionCount;
    if (b.tradeCount !== null && !Number.isSafeInteger(b.tradeCount))
      throw new Error('TRADE_COUNT_OVERFLOW');
    if (!b.first || before(point, b.first)) b.first = point;
    if (!b.last || before(b.last, point)) b.last = point;
    b.open = b.first.price;
    b.close = b.last.price;
    if (b.high === null || decimalCompare(t.price, parseDecimal(b.high)) > 0) b.high = t.price;
    if (b.low === null || decimalCompare(t.price, parseDecimal(b.low)) < 0) b.low = t.price;
    if (old?.complete || b.closeTime <= s.watermark) {
      b.revision++;
      b.complete = false;
      b.quality = intersects(s, b) ? 'GAP' : 'LATE_CORRECTION';
    } else if (intersects(s, b)) b.quality = 'GAP';
    materialize(s, b);
    return b;
  });
  const retained = s.bars.filter(
    (b) =>
      b.closeTime >= s.acceptAfter &&
      !changes.some((x) => x.timeframeMs === b.timeframeMs && x.openTime === b.openTime),
  );
  if (retained.length + changes.length > MAX_BARS) throw new Error('BAR_CAPACITY');
  trim(s);
  s.bars = [...retained, ...changes].sort(
    (a, b) => a.timeframeMs - b.timeframeMs || a.openTime - b.openTime,
  );
  s.seen.push({ identity, hash, time: t.exchangeTime });
  return 'APPLIED';
}
export function applyGap(s: CandleState, from: number, to: number, reason: string): void {
  timestampSchema.parse(from);
  timestampSchema.parse(to);
  idSchema.parse(reason);
  if (to <= from) throw new Error('INVALID_GAP');
  const overlapping = s.gaps.filter((g) => g.from <= to && g.to >= from),
    remaining = s.gaps.filter((g) => !overlapping.includes(g));
  if (remaining.length >= 128) throw new Error('GAP_CAPACITY');
  s.gaps = [
    ...remaining,
    {
      from: Math.min(from, ...overlapping.map((g) => g.from)),
      to: Math.max(to, ...overlapping.map((g) => g.to)),
      reason,
    },
  ];
  for (const b of s.bars)
    if (intersects(s, b)) {
      if (b.closeTime <= s.watermark && b.quality !== 'GAP') b.revision++;
      b.complete = false;
      b.quality = 'GAP';
      materialize(s, b);
    }
}
/** Only a trusted recovery/source port may issue coverage, never a timer or heartbeat. */
export function applyCoverage(s: CandleState, proof: CoverageProof, repaired = false): void {
  timestampSchema.parse(proof.from);
  timestampSchema.parse(proof.to);
  idSchema.parse(proof.cursor);
  if (
    proof.to <= proof.from ||
    proof.to - proof.from > 3600000 ||
    !['RECONCILED_TRADES', 'CONTIGUOUS_NATIVE_SEQUENCE'].includes(proof.evidence)
  )
    throw new Error('INVALID_COVERAGE');
  const next = structuredClone(s);
  trim(next);
  const merged = [...next.coverage, { from: proof.from, to: proof.to }].sort(
    (a, b) => a.from - b.from,
  );
  next.coverage = [];
  for (const c of merged) {
    const previous = next.coverage.at(-1);
    if (previous && c.from <= previous.to) previous.to = Math.max(previous.to, c.to);
    else next.coverage.push(c);
  }
  if (next.coverage.length > 128) throw new Error('COVERAGE_CAPACITY');
  if (repaired) {
    if (proof.evidence !== 'RECONCILED_TRADES') throw new Error('INVALID_REPAIR');
    next.gaps = next.gaps.flatMap((g) => {
      if (g.to <= proof.from || g.from >= proof.to) return [g];
      return [
        ...(g.from < proof.from ? [{ ...g, to: proof.from }] : []),
        ...(g.to > proof.to ? [{ ...g, from: proof.to }] : []),
      ];
    });
  }
  for (const tf of timeframes) {
    for (
      let at = Math.ceil(Math.max(proof.from, next.acceptAfter) / tf) * tf;
      at + tf <= proof.to;
      at += tf
    ) {
      if (!next.bars.some((b) => b.timeframeMs === tf && b.openTime === at))
        next.bars.push(empty(tf, at));
    }
  }
  if (next.bars.length > MAX_BARS) throw new Error('BAR_CAPACITY');
  next.watermark = Math.max(next.watermark, proof.to);
  next.cursor = proof.cursor;
  next.acceptAfter = Math.max(next.acceptAfter, proof.to - RETENTION);
  for (const b of next.bars) {
    if (b.closeTime > proof.to) continue;
    const previous = s.bars.find(
      (x) => x.timeframeMs === b.timeframeMs && x.openTime === b.openTime,
    );
    const covered = next.coverage.some((c) => c.from <= b.openTime && c.to >= b.closeTime);
    if (intersects(next, b)) {
      b.quality = 'GAP';
      b.complete = false;
    } else if (covered && (b.quality !== 'LATE_CORRECTION' || repaired)) {
      b.quality = b.first ? 'VERIFIED' : 'EMPTY_VERIFIED';
      b.complete = true;
    }
    materialize(next, b);
    if (
      previous &&
      previous.closeTime <= s.watermark &&
      JSON.stringify(previous) !== JSON.stringify(b)
    ) {
      b.revision++;
      materialize(next, b);
    }
  }
  next.seen = next.seen.filter((x) => x.time >= next.acceptAfter);
  next.bars.sort((a, b) => a.timeframeMs - b.timeframeMs || a.openTime - b.openTime);
  Object.assign(s, next);
}
