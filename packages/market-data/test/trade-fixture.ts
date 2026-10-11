import { randomUUID } from 'node:crypto';
import { normalizedFixtures } from '../../exchange-core/test/fixtures/domain.js';
import { snapshotFixture } from './snapshot-fixture.js';
import { marketTradePublicationSchema } from '../src/durable-trades.js';

export function tradeFixture() {
  const p = snapshotFixture();
  const result = marketTradePublicationSchema.parse({
    id: randomUUID(),
    kind: 'TRADE' as const,
    key: p.key,
    expectedRevision: '0',
    timestamp: p.timestamp,
    record: p.record,
    trade: {
      ...normalizedFixtures().tradeTick,
      scope: p.key.scope,
      instrumentId: p.key.instrumentId,
      tradeId: 'trade-' + randomUUID(),
      sourceSequence: '9007199254740993' as string | null,
      exchangeTime: p.timestamp,
      receivedAt: p.timestamp,
    },
  });
  if (result.kind !== 'TRADE') throw new Error('TRADE_FIXTURE');
  return result;
}
