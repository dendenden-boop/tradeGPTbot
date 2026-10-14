import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseDecimal } from '@ctp/exchange-core';
import { decodePaperRiskValuationSource } from '../src/risk-valuation-domain.js';
import { riskPortfolioFixture } from './risk-portfolio-fixtures.js';
import { snapshotFixture } from '../../market-data/test/snapshot-fixture.js';

function fixture(count = 2) {
  const inventory = riskPortfolioFixture(count),
    publication = snapshotFixture();
  const scope = {
    exchange: 'BINANCE' as const,
    market: 'SPOT' as const,
    region: 'global',
    environment: 'LIVE' as const,
  };
  publication.key.scope = scope;
  publication.record.instrument.scope = scope;
  publication.record.rules.scope = scope;
  publication.ticker.scope = scope;
  publication.book.scope = scope;
  publication.timestamp = 200000;
  publication.ticker.receivedAt = publication.ticker.exchangeTime = 200000;
  publication.book.receivedAt = publication.book.exchangeTime = 200000;
  publication.record.rules.effectiveAt = 199000;
  publication.record.rules.expiresAt = 260000;
  publication.ticker.last = { state: 'AVAILABLE', value: parseDecimal('2') };
  const market = () => {
    const publicationText = JSON.stringify(publication);
    return {
      id: publication.id,
      revision: '1',
      publicationText,
      hash: createHash('sha256').update(publicationText).digest('hex'),
    };
  };
  const wire = { kind: 'PAPER_RISK_VALUATION_CAPTURE', inventory, markets: [market()] };
  return {
    wire,
    publication,
    market,
    decode: () => decodePaperRiskValuationSource(wire, inventory.owner, 200000),
  };
}
it('complete trusted capture projects exact current values while preserving historical seed times', () => {
  const f = fixture(),
    r = f.decode();
  expect(r).toMatchObject({
    kind: 'PAPER_RISK_VALUATION_SOURCE',
    valuation: {
      equity: '18014398509481986.000000000000000004',
      accounts: [{ snapshotAt: 2000 }, { snapshotAt: 2000 }],
    },
  });
  expect(Object.isFrozen(r)).toBe(true);
  expect(r).not.toHaveProperty('grant');
  expect(r).not.toHaveProperty('certificate');
});
it('100 accounts share one observed market without double counting its account scoped values', () => {
  expect(fixture(100).decode()).toMatchObject({
    valuation: { equity: '900719925474099300.0000000000000002' },
  });
});
it.each([
  'missing',
  'duplicate',
  'foreign',
  'unused',
  'no-last',
  'stale',
  'future',
  'expired-rules',
  'future-rules',
  'wrong-hash',
  'wrong-id',
  'unknown-field',
  'future-inventory',
  'wrong-owner',
  'invalid-json',
  'oversize',
] as const)('%s capture cannot yield any partial valuation', (kind) => {
  const f = fixture();
  if (kind === 'missing') f.wire.markets = [];
  if (kind === 'duplicate') f.wire.markets.push(f.market());
  if (kind === 'foreign') f.publication.key.scope = { ...f.publication.key.scope, region: 'other' };
  if (kind === 'unused') f.publication.record.instrument.baseAsset = 'ETH';
  if (kind === 'no-last')
    f.publication.ticker.last = { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' };
  if (kind === 'stale') f.publication.ticker.exchangeTime = 194999;
  if (kind === 'future') f.publication.book.receivedAt = 200001;
  if (kind === 'expired-rules') f.publication.record.rules.expiresAt = 200000;
  if (kind === 'future-rules') f.publication.record.rules.effectiveAt = 200001;
  f.wire.markets =
    kind === 'missing' ? [] : kind === 'duplicate' ? [f.market(), f.market()] : [f.market()];
  if (kind === 'wrong-hash') f.wire.markets[0]!.hash = 'a'.repeat(64);
  if (kind === 'wrong-id') f.wire.markets[0]!.id = f.publication.key.dbInstrumentId;
  if (kind === 'unknown-field') Object.assign(f.wire, { prices: [] });
  if (kind === 'future-inventory') f.wire.inventory.asOf = 200001;
  if (kind === 'wrong-owner') f.wire.inventory.owner.mode = 'DEMO' as 'PAPER';
  if (kind === 'invalid-json') f.wire.markets[0]!.publicationText = '{';
  if (kind === 'oversize') f.wire.markets[0]!.publicationText += ' '.repeat(1048576);
  expect(f.decode).toThrow(/PAPER_RISK_VALUATION_(INPUT|CORRUPT|MARKET|STALE|CAPACITY)/);
});
it('metadata expiry bounds the source even when all public observations are fresh', () => {
  const f = fixture();
  f.publication.record.rules.expiresAt = 200010;
  f.wire.markets = [f.market()];
  expect(f.decode()).toHaveProperty('validUntil', 200010);
});
it('oldest native observation rather than received time bounds source freshness', () => {
  const f = fixture();
  f.publication.ticker.exchangeTime = 198000;
  f.wire.markets = [f.market()];
  expect(f.decode()).toHaveProperty('validUntil', 203001);
});
it('lossless durable head revision survives values greater than Number.MAX_SAFE_INTEGER', () => {
  const f = fixture();
  f.wire.markets[0]!.revision = '9007199254740993';
  expect(f.decode()).toMatchObject({ markets: [{ revision: '9007199254740993' }] });
});
it('unchanged inventory plus replaced durable price changes source identity without replacing seed identity', () => {
  const f = fixture(),
    a = f.decode();
  f.publication.ticker.last = { state: 'AVAILABLE', value: parseDecimal('3') };
  f.wire.markets = [f.market()];
  const b = f.decode();
  expect(b).not.toEqual(a);
  expect(b).toHaveProperty('valuation.portfolioHash');
});
