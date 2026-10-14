import { expect, it } from 'vitest';
import { reconstructUtcLoss } from '@ctp/risk-engine';
import { decodePaperRiskLossSource } from '../src/risk-loss-domain.js';
import { cashLossFixture } from './risk-loss-fixtures.js';
import { riskPortfolioFixture } from './risk-portfolio-fixtures.js';
import { decodePaperRiskPortfolioSource } from '../src/risk-portfolio-domain.js';

const day = 86400000;
function decode(w: ReturnType<typeof cashLossFixture>, now = w.inventory.asOf) {
  return decodePaperRiskLossSource(w, w.inventory.owner, now);
}
it('UTC opening excludes funding at midnight and flow-adjusted peak never counts seed capital as profit', () => {
  const w = cashLossFixture([day - 1, day, day + 500]);
  const r = decode(w);
  expect(r.evidence.opening).toMatchObject({ at: day, equity: '1000' });
  expect(r.evidence.events.map((e) => [e.kind, e.at, e.amount])).toEqual([
    ['FLOW', day, '1000'],
    ['FLOW', day + 500, '1000'],
    ['EQUITY', day + 1000, '3000'],
  ]);
  expect(reconstructUtcLoss(r.evidence, r.evidence.scope, r.asOf, 5000)).toMatchObject({
    adjustedOpeningEquity: '1000',
    adjustedCurrentEquity: '1000',
    adjustedPeakEquity: '1000',
    externalFlows: '2000',
    dailyNetRealizedPnl: '0',
  });
  expect(r.inventory.accounts.map((a) => a.state.snapshotAt)).toEqual([day - 1, day, day + 500]);
  expect(Object.isFrozen(r.evidence.events)).toBe(true);
  expect(r).not.toHaveProperty('grant');
  expect(r).not.toHaveProperty('reservationId');
});
it('100 complete cash accounts preserve amounts above Number precision and tiny decimal fractions', () => {
  const w = cashLossFixture(
    Array.from({ length: 100 }, () => day),
    day + 1000,
    '9007199254740993.000000000000000001',
  );
  const r = decode(w);
  expect(r.actualEquity).toBe('900719925474099300.0000000000000001');
  expect(reconstructUtcLoss(r.evidence, r.evidence.scope, r.asOf, 5000)).toMatchObject({
    adjustedCurrentEquity: '0',
    externalFlows: r.actualEquity,
  });
});
it('freshness is exclusive and cannot cross the UTC day boundary', () => {
  const w = cashLossFixture([1001], 2 * day - 1);
  expect(decode(w).validUntil).toBe(2 * day);
  expect(() => decode(w, 2 * day)).toThrow('PAPER_RISK_LOSS_STALE');
  const fresh = cashLossFixture();
  expect(decode(fresh, fresh.inventory.asOf + 4999).validUntil).toBe(fresh.inventory.asOf + 5000);
  expect(() => decode(fresh, fresh.inventory.asOf + 5000)).toThrow('PAPER_RISK_LOSS_STALE');
});
it('restart-equivalent reconstruction retains funding event identities and never reuses a final mark with changed content', () => {
  const w = cashLossFixture([day]);
  const a = decode(w),
    replay = decode(structuredClone(w));
  expect(replay).toEqual(a);
  const later = structuredClone(w);
  later.inventory.asOf++;
  for (const b of later.inventory.books) b.asOf++;
  const b = decode(later);
  expect(b.evidence.events[0]).toEqual(a.evidence.events[0]);
  expect(b.evidence.events.at(-1)!.id).not.toBe(a.evidence.events.at(-1)!.id);
});
it.each([
  'missing',
  'duplicate',
  'foreign-account',
  'wrong-ledger',
  'wrong-time',
  'future-time',
  'unknown-field',
  'unknown-opening',
  'wrong-owner',
  'future-capture',
  'empty',
  'oversize',
] as const)('%s witness cannot be considered closed history', (kind) => {
  const w = cashLossFixture([day, day + 500]);
  if (kind === 'missing') w.fundingTimes.pop();
  if (kind === 'duplicate') w.fundingTimes[1] = { ...w.fundingTimes[0]! };
  if (kind === 'foreign-account') w.fundingTimes[0]!.accountId = w.inventory.owner.tenantId;
  if (kind === 'wrong-ledger') w.fundingTimes[0]!.ledgerId = w.inventory.owner.tenantId;
  if (kind === 'wrong-time') w.fundingTimes[0]!.effectiveAt--;
  if (kind === 'future-time') w.fundingTimes[0]!.effectiveAt = w.inventory.asOf + 1;
  if (kind === 'unknown-field') Object.assign(w, { prices: [] });
  if (kind === 'unknown-opening') Object.assign(w, { opening: '1000000' });
  if (kind === 'wrong-owner') w.inventory.owner.mode = 'DEMO' as 'PAPER';
  if (kind === 'future-capture') w.inventory.asOf++;
  if (kind === 'empty') w.fundingTimes = [];
  if (kind === 'oversize') Object.assign(w, { ignored: 'a'.repeat(1048576) });
  expect(() => decode(w, day + 1000)).toThrow(/PAPER_RISK_LOSS_(CORRUPT|CAPACITY|STALE)/);
});
it('nonquote initial holdings cannot use current prices as a guessed historical opening', () => {
  const inventory = riskPortfolioFixture(1);
  const source = decodePaperRiskPortfolioSource(inventory, inventory.owner, inventory.asOf);
  const funding = source.accounts[0]!.origin.funding;
  const w = {
    kind: 'PAPER_RISK_LOSS_CAPTURE',
    inventory,
    fundingTimes: [
      {
        accountId: inventory.accountIds[0]!,
        ledgerId: funding.ledgerTransactionId,
        effectiveAt: funding.createdAt,
      },
    ],
  };
  expect(() => decode(w)).toThrow('PAPER_RISK_LOSS_CASH_ONLY');
});
it('cash in different configured currencies cannot be added using a stablecoin peg or guessed FX', () => {
  const w = cashLossFixture([1001, 1001], day + 1000, '1000', ['USDT', 'USD']);
  expect(() => decode(w)).toThrow('PAPER_RISK_LOSS_CASH_ONLY');
});
