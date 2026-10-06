import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { lossBatchSchema, lossCheckpointSchema } from '../src/loss-journal.js';

const day = Math.floor(Date.now() / 86400000) * 86400000;
const batch = () => ({
  scope: { tenantId: randomUUID(), mode: 'TESTNET', valuationAsset: 'USDT' },
  dayStart: day,
  id: randomUUID(),
  expectedSequence: '0',
  opening: { at: day, equity: '1000', sourceId: randomUUID(), sourceHash: 'a'.repeat(64) },
  coveredThrough: day + 100,
  events: [
    { id: randomUUID(), at: day + 100, kind: 'FLOW', amount: '50' },
    { id: randomUUID(), at: day + 100, kind: 'EQUITY', amount: '1040' },
  ],
  coverage: { from: day, through: day + 100, sourceId: randomUUID(), sourceHash: 'b'.repeat(64) },
});
it('loss journal requires explicit UTC opening and complete coverage to the final equity mark', () => {
  expect(lossBatchSchema.parse(batch()).events).toHaveLength(2);
  expect(lossBatchSchema.safeParse({ ...batch(), opening: null }).success).toBe(false);
  const p = batch();
  p.opening.at++;
  expect(lossBatchSchema.safeParse(p).success).toBe(false);
});
it.each(['00', '01', '1\n', '1e2', '-1', '1.0', '9223372036854775807'])(
  'loss publisher rejects noncanonical/exhausted sequence %j',
  (expectedSequence) => {
    expect(lossBatchSchema.safeParse({ ...batch(), expectedSequence }).success).toBe(false);
  },
);
it('a continuation cannot supply a replacement opening or skip its covered interval', () => {
  const p = { ...batch(), expectedSequence: '3' };
  expect(lossBatchSchema.safeParse(p).success).toBe(false);
  expect(lossBatchSchema.parse({ ...p, opening: null }).expectedSequence).toBe('3');
  expect(
    lossBatchSchema.safeParse({
      ...p,
      opening: null,
      coverage: { ...p.coverage, through: day + 99 },
    }).success,
  ).toBe(false);
});
it('no FLOW or REALIZED may follow the final mark, and duplicate native identities reject', () => {
  const p = batch();
  p.events.reverse();
  expect(lossBatchSchema.safeParse(p).success).toBe(false);
  const q = batch();
  q.events[1]!.id = q.events[0]!.id;
  expect(lossBatchSchema.safeParse(q).success).toBe(false);
});
it('equal-time ordered FLOW then EQUITY remains explicit and exact', () => {
  const p = batch();
  expect(lossBatchSchema.parse(p).events.map((e) => e.kind)).toEqual(['FLOW', 'EQUITY']);
  p.events[1]!.amount = '9007199254740993.000000000000000001';
  expect(lossBatchSchema.parse(p).events[1]!.amount).toBe(p.events[1]!.amount);
});
it('checkpoint output uses exact storage mode and durable canonical counters', () => {
  const checkpoint = {
    scope: batch().scope,
    dayStart: day,
    sequence: '9007199254740993',
    batchId: randomUUID(),
    coveredThrough: day + 100,
    openingEquity: '1000',
    externalFlows: '50',
    netRealized: '-10',
    adjustedCurrentEquity: '990',
    adjustedPeakEquity: '1000',
    hash: 'c'.repeat(64),
  };
  expect(lossCheckpointSchema.parse(checkpoint).sequence).toBe(checkpoint.sequence);
  expect(lossCheckpointSchema.safeParse({ ...checkpoint, sequence: '1\n' }).success).toBe(false);
  expect(lossCheckpointSchema.safeParse({ ...checkpoint, mode: 'DEMO' }).success).toBe(false);
});
