import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import * as market from '../src/index.js';
import { recordFixture } from '../../exchange-core/test/fixtures/domain.js';
import type { z } from 'zod';

function schema(): z.ZodType {
  const value = Reflect.get(market, 'marketSnapshotPublicationSchema') as z.ZodType | undefined;
  expect(value, 'production durable Market Data evidence contract is missing').toBeDefined();
  return value!;
}
const fixture = () => {
  const now = Date.now(),
    record = recordFixture();
  record.rules.effectiveAt = now - 1000;
  record.rules.expiresAt = now + 60000;
  return {
    id: randomUUID(),
    expectedRevision: '0',
    timestamp: now,
    kind: 'SNAPSHOT',
    key: {
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      dbInstrumentId: randomUUID(),
      dbRuleId: randomUUID(),
    },
    record,
    ticker: {
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      receivedAt: now,
      exchangeTime: now,
      last: { state: 'AVAILABLE', value: '10' },
      bid: { state: 'AVAILABLE', value: '9.9' },
      ask: { state: 'AVAILABLE', value: '10.1' },
      baseVolume: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      quoteVolume: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      change: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      freshness: 'FRESH',
    },
    book: {
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      receivedAt: now,
      exchangeTime: null,
      kind: 'SNAPSHOT',
      bids: [{ price: '9.9', quantity: '2' }],
      asks: [{ price: '10.1', quantity: '2' }],
      sourceSequence: '9007199254740993',
      previousSequence: null,
      checksum: null,
      snapshotVersion: randomUUID(),
      stale: false,
    },
  };
};
it('requires a production PostgreSQL snapshot factory, not a volatile cache default', () => {
  expect(Reflect.get(market, 'createPostgresMarketSnapshots')).toBeTypeOf('function');
});
it('accepts a bounded native book/ticker pair with exact current metadata and lossless sequence', () => {
  const input = fixture();
  expect(schema().parse(input)).toEqual(input);
});
it.each(['01', '1\n', '-1', '1.0', '9223372036854775807'])(
  'rejects noncanonical/exhausted expected revision %j',
  (expectedRevision) => {
    expect(schema().safeParse({ ...fixture(), expectedRevision }).success).toBe(false);
  },
);
it.each([
  'recordId',
  'ruleId',
  'tickerScope',
  'bookId',
  'delta',
  'stale',
  'noOrdering',
  'duplicateLevel',
  'unknown',
])('rejects conflicting/incomplete native market evidence: %s', (kind) => {
  const p = fixture();
  if (kind === 'recordId') p.record.instrument.id = 'foreign';
  if (kind === 'ruleId') p.record.rules.instrumentId = 'foreign';
  if (kind === 'tickerScope') p.ticker.scope = { ...p.ticker.scope, environment: 'DEMO' };
  if (kind === 'bookId') p.book.instrumentId = 'foreign';
  if (kind === 'delta') p.book.kind = 'DELTA';
  if (kind === 'stale') p.book.stale = true;
  if (kind === 'noOrdering') p.book.sourceSequence = null as unknown as string;
  if (kind === 'duplicateLevel') p.book.bids.push({ ...p.book.bids[0]! });
  const raw = kind === 'unknown' ? { ...p, balances: [] } : p;
  expect(schema().safeParse(raw).success).toBe(false);
});
it('GAP is an explicit durable evidence event with no guessed quote or accounting state', () => {
  const p = fixture(),
    gap = {
      id: p.id,
      key: p.key,
      expectedRevision: '0',
      timestamp: p.timestamp,
      kind: 'GAP',
      reason: 'STREAM_LOST',
    };
  expect(schema().parse(gap)).toEqual(gap);
  expect(schema().safeParse({ ...gap, book: p.book }).success).toBe(false);
});
