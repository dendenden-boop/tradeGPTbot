import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  decimalSchema,
  nonNegativeDecimalSchema,
  positiveDecimalSchema,
  decimalAdd,
  decimalSubtract,
  decimalCompare,
  parseDecimal,
  immutable,
  timestampSchema,
} from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';

const digest = z.string().regex(/^[a-f0-9]{64}$/u),
  uuid = z.uuid().refine((s) => s === s.toLowerCase()),
  asset = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/u),
  counter = z
    .string()
    .refine((s) => /^[1-9][0-9]{0,18}$/u.exec(s)?.[0] === s && BigInt(s) <= 9223372036854775807n);
const scopeSchema = z.strictObject({
  tenantId: uuid,
  mode: z.literal('PAPER'),
  valuationAsset: asset,
});
const proof = z.strictObject({ id: uuid, sourceHash: digest, at: timestampSchema });
const baselineFields = {
  id: uuid,
  sourceHash: digest,
  utcDayStart: timestampSchema,
  at: timestampSchema,
  equity: positiveDecimalSchema,
  expiresAt: timestampSchema,
};
const baselineSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...baselineFields, kind: z.literal('PAPER_INCEPTION'), fundingId: uuid }),
  z.strictObject({ ...baselineFields, kind: z.literal('UTC_EQUITY'), fundingId: z.null() }),
]);
const flowSchema = proof.extend({ accountId: uuid, asset, amount: decimalSchema });
const realizedSchema = proof.extend({ asset, amount: decimalSchema });
const pointSchema = proof.extend({
  equity: nonNegativeDecimalSchema,
  revision: counter,
  status: z.enum(['APPLIED', 'DUPLICATE']),
});
const projectionBody = z.strictObject({
  kind: z.literal('PAPER_CURRENT_LOSS_PROJECTION'),
  scope: scopeSchema,
  executionId: uuid,
  baseline: baselineSchema,
  utcDayStart: timestampSchema,
  asOf: timestampSchema,
  validUntil: timestampSchema,
  coveredThrough: timestampSchema,
  complete: z.boolean(),
  actualEquity: nonNegativeDecimalSchema,
  adjustedOpeningEquity: positiveDecimalSchema,
  adjustedCurrentEquity: decimalSchema,
  adjustedPeakEquity: positiveDecimalSchema,
  externalFlows: decimalSchema,
  dailyNetRealizedPnl: decimalSchema,
  flowHistoryHash: digest,
  realizedHistoryHash: digest,
  evidenceHash: digest,
});
const projectionSchema = projectionBody.extend({ hash: digest });
const input = z.strictObject({
  scope: scopeSchema,
  executionId: uuid,
  capturedAt: timestampSchema,
  validUntil: timestampSchema,
  maxEvidenceAgeMs: z.number().int().min(1).max(5000),
  baseline: baselineSchema,
  flows: z.array(flowSchema).min(1).max(1000),
  realized: z.array(realizedSchema).max(1000),
  points: z.array(pointSchema).max(1000),
  current: proof.extend({ sourceAt: timestampSchema, equity: nonNegativeDecimalSchema }),
  coverage: z.strictObject({
    id: uuid,
    sourceHash: digest,
    from: timestampSchema,
    through: timestampSchema,
    complete: z.boolean(),
    previousHash: digest.nullable(),
  }),
  previous: projectionSchema.nullable(),
});
export type PaperCurrentLossProjection = z.infer<typeof projectionSchema>;
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const sub = (a: string, b: string) => decimalSubtract(parseDecimal(a), parseDecimal(b));
const cmp = (a: string, b: string) => decimalCompare(parseDecimal(a), parseDecimal(b));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const max = (a: string, b: string) => parseDecimal(cmp(a, b) >= 0 ? a : b);
function fail(code = 'EVIDENCE'): never {
  throw Error('PAPER_CURRENT_LOSS_' + code);
}
function bounded(raw: unknown) {
  const active = new WeakSet<object>();
  let nodes = 0,
    bytes = 0;
  function visit(value: unknown, depth: number) {
    if (++nodes > 50000 || depth > 12) fail('INPUT');
    if (typeof value === 'string') bytes += Buffer.byteLength(value);
    else if (value === null || typeof value === 'boolean') return;
    else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) fail('INPUT');
    } else if (typeof value === 'object') {
      if (active.has(value)) fail('INPUT');
      active.add(value);
      if (Array.isArray(value)) {
        if (value.length > 1000 || Reflect.ownKeys(value).length !== value.length + 1)
          fail('INPUT');
        for (let i = 0; i < value.length; i++) {
          const d = Object.getOwnPropertyDescriptor(value, String(i));
          if (!d?.enumerable || !('value' in d)) fail('INPUT');
          visit(d.value, depth + 1);
        }
      } else {
        const proto = Object.getPrototypeOf(value) as unknown,
          keys = Reflect.ownKeys(value);
        if ((proto !== null && proto !== Object.prototype) || keys.length > 64) fail('INPUT');
        for (const key of keys) {
          if (typeof key !== 'string' || key.length > 128) fail('INPUT');
          const d = Object.getOwnPropertyDescriptor(value, key);
          if (!d?.enumerable || !('value' in d)) fail('INPUT');
          bytes += Buffer.byteLength(key);
          visit(d.value, depth + 1);
        }
      }
      active.delete(value);
    } else fail('INPUT');
    if (bytes > 2097152) fail('INPUT');
  }
  visit(raw, 0);
}
function distinct(items: readonly { id: string }[]) {
  if (new Set(items.map((v) => v.id)).size !== items.length) fail('HISTORY');
}
const ordered = <T extends { id: string }>(items: readonly T[]) =>
  [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
/** Private content projection, never source/coverage authority. Only the fixed
 * authenticated SQL graph and durable checkpoint lifecycle can certify it.
 * An incomplete bounded batch remains incomplete even when its arithmetic is
 * valid; this function issues no certificate, monetary effect or permission. */
export function projectPaperCurrentLoss(raw: unknown, now: number) {
  try {
    bounded(raw);
    timestampSchema.parse(now);
    const w = input.parse(raw),
      day = Math.floor(now / 86400000) * 86400000,
      b = w.baseline;
    if (
      now >= w.validUntil ||
      now >= b.expiresAt ||
      b.utcDayStart !== day ||
      now >= w.current.sourceAt + w.maxEvidenceAgeMs + 1
    )
      fail('EXPIRED');
    if (
      w.capturedAt > now ||
      w.current.at !== w.capturedAt ||
      w.current.sourceAt > w.capturedAt ||
      b.utcDayStart % 86400000 !== 0 ||
      b.at < day ||
      b.at > w.capturedAt ||
      b.expiresAt > day + 86400000 ||
      w.validUntil <= w.capturedAt ||
      w.coverage.from !== b.at ||
      w.coverage.through !== w.capturedAt
    )
      fail();
    for (const events of [w.flows, w.realized, w.points]) distinct(events);
    if ([...w.flows, ...w.realized].some((e) => e.asset !== w.scope.valuationAsset)) fail();
    if ([...w.flows, ...w.realized, ...w.points].some((e) => e.at > w.capturedAt)) fail('HISTORY');
    if (w.points.some((e) => e.at < b.at)) fail('HISTORY');
    if (b.kind === 'UTC_EQUITY') {
      if (b.at !== day) fail('BASELINE');
    } else {
      const genesis = w.flows.find((f) => f.id === b.fundingId);
      if (
        !genesis ||
        genesis.at !== b.at ||
        genesis.amount !== b.equity ||
        w.flows.some((f) => f.at < b.at || (f.id !== genesis.id && f.at === b.at))
      )
        fail('BASELINE');
    }
    const historyHash = (events: readonly { id: string; at: number }[], through: number) =>
      hash(ordered(events.filter((e) => e.at <= through)));
    let peak = b.equity,
      covered = b.at;
    if (w.previous) {
      const { hash: retainedHash, ...body } = w.previous;
      if (
        hash(body) !== retainedHash ||
        w.coverage.previousHash !== retainedHash ||
        !same(w.previous.scope, w.scope) ||
        w.previous.executionId !== w.executionId ||
        w.previous.asOf > w.capturedAt ||
        w.previous.utcDayStart > day ||
        w.previous.flowHistoryHash !== historyHash(w.flows, w.previous.asOf) ||
        w.previous.realizedHistoryHash !== historyHash(w.realized, w.previous.asOf)
      )
        fail('HISTORY');
      if (w.previous.utcDayStart === day) {
        if (!same(w.previous.baseline, b)) fail('BASELINE');
        peak = max(peak, w.previous.adjustedPeakEquity);
        covered = w.previous.coveredThrough;
      } else if (b.kind !== 'UTC_EQUITY') fail('BASELINE');
    } else if (w.coverage.previousHash !== null) fail('HISTORY');
    const external = (through: number) =>
      w.flows
        .filter(
          (f) =>
            f.at >= b.at &&
            f.at <= through &&
            (b.kind !== 'PAPER_INCEPTION' || f.id !== b.fundingId),
        )
        .reduce((sum, f) => add(sum, f.amount), '0');
    const equalClock = new Map<number, string>();
    for (const p of w.points) {
      const previous = equalClock.get(p.at);
      if (previous !== undefined && previous !== p.equity) fail('HISTORY');
      equalClock.set(p.at, p.equity);
      peak = max(peak, sub(p.equity, external(p.at)));
    }
    const flows = external(w.capturedAt),
      current = sub(w.current.equity, flows);
    peak = max(peak, current);
    const body = projectionBody.parse({
      kind: 'PAPER_CURRENT_LOSS_PROJECTION',
      scope: w.scope,
      executionId: w.executionId,
      baseline: b,
      utcDayStart: day,
      asOf: w.capturedAt,
      validUntil: Math.min(
        w.validUntil,
        b.expiresAt,
        day + 86400000,
        w.current.sourceAt + w.maxEvidenceAgeMs + 1,
      ),
      coveredThrough: w.coverage.complete ? w.capturedAt : covered,
      complete: w.coverage.complete,
      actualEquity: w.current.equity,
      adjustedOpeningEquity: b.equity,
      adjustedCurrentEquity: current,
      adjustedPeakEquity: peak,
      externalFlows: flows,
      dailyNetRealizedPnl: w.realized
        .filter((e) => e.at >= b.at)
        .reduce((sum, e) => add(sum, e.amount), '0'),
      flowHistoryHash: historyHash(w.flows, w.capturedAt),
      realizedHistoryHash: historyHash(w.realized, w.capturedAt),
      evidenceHash: hash({ coverage: w.coverage, points: ordered(w.points), current: w.current }),
    });
    return immutable({ ...body, hash: hash(body) });
  } catch (error) {
    if (
      error instanceof Error &&
      /^PAPER_CURRENT_LOSS_(INPUT|EVIDENCE|HISTORY|BASELINE|EXPIRED)$/u.test(error.message)
    )
      throw error;
    fail('INPUT');
  }
}
