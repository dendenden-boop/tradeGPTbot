import { randomUUID } from 'node:crypto';
import { recordFixture, normalizedFixtures } from '../../exchange-core/test/fixtures/domain.js';
import { marketSnapshotPublicationSchema } from '../src/durable-snapshots.js';

export function snapshotFixture() {
  const now = Date.now(),
    record = recordFixture(),
    native = normalizedFixtures();
  record.rules.effectiveAt = now - 1000;
  record.rules.expiresAt = now + 60000;
  record.instrument.exchangeSymbol = 'BTCUSDT-' + randomUUID();
  const p = marketSnapshotPublicationSchema.parse({
    id: randomUUID(),
    kind: 'SNAPSHOT',
    expectedRevision: '0',
    timestamp: now,
    key: {
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      dbInstrumentId: randomUUID(),
      dbRuleId: randomUUID(),
    },
    record,
    ticker: { ...native.ticker, exchangeTime: now, receivedAt: now },
    book: {
      ...native.book,
      exchangeTime: now,
      receivedAt: now,
      sourceSequence: '9007199254740993',
    },
  });
  if (p.kind !== 'SNAPSHOT') throw new Error('fixture');
  return p;
}
