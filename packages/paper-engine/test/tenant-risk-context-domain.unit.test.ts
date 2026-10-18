import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { decodePaperTenantRiskContextSource } from '../src/tenant-risk-context-domain.js';
import { decodePaperRiskContextSource } from '../src/risk-context-domain.js';
import { decodePaperRiskLossSource } from '../src/risk-loss-domain.js';
import { tenantRiskContextFixture } from './tenant-risk-context-fixtures.js';
import { riskBook, uuid } from './risk-portfolio-fixtures.js';

it('binds the exact pristine target to complete tenant cash/loss and original runtime without a financial grant', () => {
  const f = tenantRiskContextFixture(),
    r = decodePaperTenantRiskContextSource(f.wire, f.request, 200000);
  expect(r.kind).toBe('PAPER_TENANT_RISK_CONTEXT_SOURCE');
  expect(r.loss.inventory.accountIds).toHaveLength(2);
  expect(r.loss.actualEquity).toBe('18014398509481986');
  expect(r.loss.inventory.accounts[0]!.hash).toBe(r.context.authority.orderRisk.book.hash);
  expect(r.validUntil).toBe(205000);
  expect(Object.isFrozen(r.loss.inventory.accounts)).toBe(true);
  expect(r.context.authority.orderRisk.target.command).toEqual(f.command);
  expect(r.loss.inventory.accounts[0]!.state.snapshotAt).toBe(2000);
  for (const key of [
    'certificate',
    'approved',
    'approve',
    'reserve',
    'permit',
    'capabilities',
    'exposure',
  ])
    expect(key in r).toBe(false);
});
it.each([
  'permissionEpoch',
  'reconciliationEpoch',
  'clientIdHighWatermark',
  'version',
  'draft',
] as const)('rejects individually valid target/inventory captures with conflicting %s', (key) => {
  const f = tenantRiskContextFixture();
  f.loss.inventory.books[0] = structuredClone(f.loss.inventory.books[0]!);
  const book = f.loss.inventory.books[0];
  if (key === 'version') book.accountState.version++;
  else if (key === 'draft') book.drafts[0]!.commandHash = '0'.repeat(64);
  else book.accountState[key] = String(BigInt(book.accountState[key]) + 1n);
  expect(() => decodePaperRiskContextSource(f.context, f.request, 200000)).not.toThrow();
  expect(() => decodePaperRiskLossSource(f.loss, f.request.owner, 200000)).not.toThrow();
  expect(() => decodePaperTenantRiskContextSource(f.wire, f.request, 200000)).toThrow(
    'PAPER_TENANT_RISK_CONTEXT_CORRUPT',
  );
});
it('applies the current stricter policy to the older inventory proof without renewing its timestamp', () => {
  const f = tenantRiskContextFixture();
  f.context.authority.policies[0]!.limits.maxEvidenceAgeMs = 100;
  f.seal();
  f.loss.inventory.asOf = 199900;
  f.loss.inventory.books = f.loss.inventory.books.map((b) => ({ ...b, asOf: 199900 }));
  expect(() => decodePaperRiskContextSource(f.context, f.request, 200000)).not.toThrow();
  expect(() => decodePaperRiskLossSource(f.loss, f.request.owner, 200000)).not.toThrow();
  expect(() => decodePaperTenantRiskContextSource(f.wire, f.request, 200000)).toThrow(
    'PAPER_TENANT_RISK_CONTEXT_STALE',
  );
});
it.each(['FAILED', 'UNKNOWN'] as const)(
  'preserves %s executor and paused controls as negative evidence',
  (status) => {
    const f = tenantRiskContextFixture();
    f.publication.observation.health.executor.status = status;
    f.controls.global[0]!.state = 'PAUSED';
    f.seal();
    const r = decodePaperTenantRiskContextSource(f.wire, f.request, 200000);
    expect(r.context.runtime.blockedBy).toEqual(['executor']);
    expect(r.context.authority.controls.pauses.global).toBe(true);
    expect(r).not.toHaveProperty('approved');
  },
);
it.each([
  'missing-loss',
  'missing-context',
  'extra',
  'owner',
  'intent',
  'future',
  'loss-after-context',
  'context-after-capture',
  'duplicate-account',
  'omitted-book',
  'funding-time',
  'hash',
])('rejects %s without leaking private evidence', (kind) => {
  const f = tenantRiskContextFixture();
  if (kind === 'missing-loss') Object.assign(f.wire, { loss: null });
  if (kind === 'missing-context') Object.assign(f.wire, { context: null });
  if (kind === 'extra') Object.assign(f.wire, { approved: true });
  if (kind === 'owner')
    f.request = { ...f.request, owner: { ...f.request.owner, accountId: randomUUID() } };
  if (kind === 'intent') f.request = { ...f.request, intentId: randomUUID() };
  if (kind === 'future') f.wire.asOf++;
  if (kind === 'loss-after-context') {
    f.loss.inventory.asOf++;
    f.loss.inventory.books.forEach((b) => b.asOf++);
  }
  if (kind === 'context-after-capture') f.wire.asOf--;
  if (kind === 'duplicate-account')
    f.loss.inventory.accountIds[1] = f.loss.inventory.accountIds[0]!;
  if (kind === 'omitted-book') f.loss.inventory.books.pop();
  if (kind === 'funding-time') f.loss.fundingTimes[0]!.effectiveAt++;
  if (kind === 'hash') f.loss.inventory.books[1]!.origin.hash = '0'.repeat(64);
  expect(() => decodePaperTenantRiskContextSource(f.wire, f.request, 200000)).toThrow(
    'PAPER_TENANT_RISK_CONTEXT_CORRUPT',
  );
});
it('does not infer zero cash loss for a noncash sibling', () => {
  const f = tenantRiskContextFixture();
  f.loss.inventory.books[1] = riskBook(uuid(2));
  expect(() => decodePaperTenantRiskContextSource(f.wire, f.request, 200000)).toThrow(
    'PAPER_TENANT_RISK_CONTEXT_CASH_ONLY',
  );
});
it('rejects over-capacity evidence wholly instead of returning a subset', () => {
  const f = tenantRiskContextFixture();
  f.context.runtime.publication.text = 'x'.repeat(4194304);
  expect(() => decodePaperTenantRiskContextSource(f.wire, f.request, 200000)).toThrow(
    'PAPER_TENANT_RISK_CONTEXT_CAPACITY',
  );
});
it('accepts the bounded complete 100-account cash inventory with exact decimal sums', () => {
  const f = tenantRiskContextFixture(100),
    r = decodePaperTenantRiskContextSource(f.wire, f.request, 200000);
  expect(r.loss.inventory.accounts).toHaveLength(100);
  expect(r.loss.actualEquity).toBe('900719925474099300');
});
it('serialized evidence retains its original exclusive deadline and cannot be renewed by the outer read', () => {
  const f = tenantRiskContextFixture();
  f.wire.asOf = 204999;
  const r = decodePaperTenantRiskContextSource(
    JSON.parse(JSON.stringify(f.wire)),
    f.request,
    204999,
  );
  expect(r.validUntil).toBe(205000);
  expect(() => decodePaperTenantRiskContextSource(f.wire, f.request, 205000)).toThrow(
    'PAPER_TENANT_RISK_CONTEXT_STALE',
  );
});
it('expires the retained UTC loss proof at midnight while all market/runtime facts are still fresh', () => {
  const f = tenantRiskContextFixture(),
    at = 86400000 - 1;
  f.wire.asOf = f.context.asOf = f.order.asOf = f.runtime.asOf = at;
  f.loss.inventory.asOf = at;
  f.loss.inventory.books.forEach((b) => (b.asOf = at));
  f.runtime.publication.publishedAt = at;
  Object.values(f.publication.observation.health).forEach((h) => (h.asOf = at));
  for (const p of [f.f.s, f.f.p]) {
    p.timestamp = at;
    p.record.rules.effectiveAt = at - 1000;
    p.record.rules.expiresAt = at + 60000;
  }
  for (const p of [f.f.s.book, f.f.s.ticker, f.f.p.trade]) p.receivedAt = p.exchangeTime = at;
  for (const [wire, p] of [
    [f.order.snapshot, f.f.s],
    [f.order.trade, f.f.p],
  ] as const) {
    wire.publicationText = JSON.stringify(p);
    wire.hash = createHash('sha256').update(wire.publicationText).digest('hex');
  }
  f.seal();
  expect(decodePaperTenantRiskContextSource(f.wire, f.request, at).validUntil).toBe(86400000);
  expect(() => decodePaperRiskContextSource(f.context, f.request, at + 1)).not.toThrow();
  expect(() => decodePaperTenantRiskContextSource(f.wire, f.request, at + 1)).toThrow(
    'PAPER_TENANT_RISK_CONTEXT_STALE',
  );
});
