import { expect, it } from 'vitest';
import * as market from '../src/index.js';
import { tradeFixture } from './trade-fixture.js';

it('exports the durable public trade journal without financial authority', () => {
  expect(market.createPostgresMarketTrades).toBeTypeOf('function');
  expect(market.marketTradePublicationSchema).toBeDefined();
});
it('accepts exact normalized Spot source, current record and lossless native sequence', () => {
  const p = tradeFixture();
  expect(market.marketTradePublicationSchema.parse(p)).toEqual(p);
});
it('preserves a 128-digit native sequence as a string', () => {
  const p = tradeFixture();
  expect(
    market.marketTradePublicationSchema.parse({
      ...p,
      trade: { ...p.trade, sourceSequence: '9'.repeat(128) },
    }),
  ).toMatchObject({ trade: { sourceSequence: '9'.repeat(128) } });
});
it('permits native timestamp ordering when a source provides no sequence', () => {
  const p = tradeFixture();
  expect(
    market.marketTradePublicationSchema.safeParse({
      ...p,
      trade: { ...p.trade, sourceSequence: null },
    }).success,
  ).toBe(true);
});
it('supports a strict durable GAP publication rather than fabricated trade volume', () => {
  const { id, key, expectedRevision, timestamp } = tradeFixture();
  expect(
    market.marketTradePublicationSchema.parse({
      id,
      key,
      expectedRevision,
      timestamp,
      kind: 'GAP',
      reason: 'NATIVE_STREAM_GAP',
    }),
  ).toMatchObject({ kind: 'GAP' });
});
it.each([
  'tenantId',
  'accountId',
  'credentials',
  'url',
  'riskGrant',
  'reservationId',
  'volumeUsed',
])('rejects caller authority field %s', (field) => {
  expect(
    market.marketTradePublicationSchema.safeParse({ ...tradeFixture(), [field]: 'untrusted' })
      .success,
  ).toBe(false);
});
it.each(['-1', '01', '1.0', '1e3', '9'.repeat(129), 9007199254740992])(
  'rejects noncanonical native sequence %s',
  (sequence) => {
    const p = tradeFixture();
    expect(
      market.marketTradePublicationSchema.safeParse({
        ...p,
        trade: { ...p.trade, sourceSequence: sequence },
      }).success,
    ).toBe(false);
  },
);
it.each(['-1', '01', '1.0', '9223372036854775807', 1])(
  'rejects unsafe expected head revision %s',
  (revision) => {
    expect(
      market.marketTradePublicationSchema.safeParse({
        ...tradeFixture(),
        expectedRevision: revision,
      }).success,
    ).toBe(false);
  },
);
it.each(['SPOT', 'LINEAR_PERPETUAL'])('rejects wrong native source scope for %s', (marketType) => {
  const p = tradeFixture();
  expect(
    market.marketTradePublicationSchema.safeParse({
      ...p,
      trade: { ...p.trade, scope: { ...p.trade.scope, market: marketType, environment: 'DEMO' } },
    }).success,
  ).toBe(false);
});
it('rejects derivatives from this explicitly Spot-only publication path', () => {
  const p = tradeFixture();
  expect(
    market.marketTradePublicationSchema.safeParse({
      ...p,
      key: { ...p.key, scope: { ...p.key.scope, market: 'LINEAR_PERPETUAL' } },
    }).success,
  ).toBe(false);
});
it('rejects wrong instrument and unsupported native quantity units', () => {
  const p = tradeFixture();
  for (const change of [{ instrumentId: 'wrong' }, { quantityUnit: 'CONTRACTS' }])
    expect(
      market.marketTradePublicationSchema.safeParse({ ...p, trade: { ...p.trade, ...change } })
        .success,
    ).toBe(false);
});
it.each(['', 'native id', 'native\n', '\u200b', 'тест'])(
  'rejects unsupported opaque native identity %s',
  (tradeId) => {
    const p = tradeFixture();
    expect(
      market.marketTradePublicationSchema.safeParse({ ...p, trade: { ...p.trade, tradeId } })
        .success,
    ).toBe(false);
  },
);
it('rejects unknown trade or record constraints instead of treating them as supported', () => {
  const p = tradeFixture();
  expect(
    market.marketTradePublicationSchema.safeParse({
      ...p,
      trade: { ...p.trade, newConstraint: true },
    }).success,
  ).toBe(false);
  expect(
    market.marketTradePublicationSchema.safeParse({
      ...p,
      record: { ...p.record, newConstraint: true },
    }).success,
  ).toBe(false);
});
it('does not turn schema validity or serialization into freshness certification', () => {
  const p = tradeFixture();
  const copy = market.marketTradePublicationSchema.parse(JSON.parse(JSON.stringify(p)));
  expect(copy).toEqual(p);
  expect('grant' in copy).toBe(false);
  expect('certificate' in copy).toBe(false);
});
