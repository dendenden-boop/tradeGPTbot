import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { decodePaperRiskContextSource } from '../src/risk-context-domain.js';
import { decodePaperRiskAuthoritySource } from '../src/risk-authority-domain.js';
import { decodePaperRuntimeSource, paperRuntimeDependencies } from '../src/runtime-domain.js';
import { riskContextFixture } from './risk-context-fixtures.js';

it('binds original order, configuration, epochs and nine immutable runtime facts without a grant', () => {
  const f = riskContextFixture(),
    r = decodePaperRiskContextSource(f.wire, f.request, 200000);
  expect(r.kind).toBe('PAPER_RISK_CONTEXT_SOURCE');
  expect(r.validUntil).toBe(205001);
  expect(r.authority.orderRisk.target.command).toEqual(f.command);
  expect(r.runtime.configuration).toEqual(r.authority.orderRisk.book.origin.configuration);
  expect(r.runtime.reference.revision).toBe('9007199254740994');
  expect(Object.isFrozen(r.runtime.health)).toBe(true);
  for (const k of ['certificate', 'grant', 'reservation', 'permit', 'capabilities', 'approve'])
    expect(k in r).toBe(false);
});
it.each(['permissionEpoch', 'userSessionEpoch', 'accountVersion'] as const)(
  'rejects independently valid sources with conflicting %s instead of joining separate reads',
  (key) => {
    const f = riskContextFixture();
    if (key === 'accountVersion') {
      f.runtime.current.accountVersion++;
      f.publication.observation.accountVersion++;
    } else {
      f.runtime.current[key] = '1';
      f.publication.observation[key] = '1';
    }
    f.seal();
    expect(() => decodePaperRiskAuthoritySource(f.wire.authority, f.request, 200000)).not.toThrow();
    expect(() => decodePaperRuntimeSource(f.runtime, f.request.owner, 200000)).not.toThrow();
    expect(() => decodePaperRiskContextSource(f.wire, f.request, 200000)).toThrow(
      'PAPER_RISK_CONTEXT_EPOCH',
    );
  },
);
it('rejects an internally sealed replacement configuration even with matching owner and epochs', () => {
  const f = riskContextFixture(),
    c = JSON.parse(f.runtime.configuration.receiptText) as { configuration: { id: string } };
  c.configuration.id = randomUUID();
  f.runtime.configuration = { receiptText: JSON.stringify(c), hash: '' };
  f.runtime.configuration.hash = createHash('sha256')
    .update(f.runtime.configuration.receiptText)
    .digest('hex');
  f.publication.observation.configurationId = c.configuration.id;
  f.publication.observation.configurationHash = f.runtime.configuration.hash;
  f.seal();
  expect(() => decodePaperRuntimeSource(f.runtime, f.request.owner, 200000)).not.toThrow();
  expect(() => decodePaperRiskContextSource(f.wire, f.request, 200000)).toThrow(
    'PAPER_RISK_CONTEXT_CORRUPT',
  );
});
it.each(paperRuntimeDependencies)(
  'applies tighter policy age to original %s observation',
  (key) => {
    const f = riskContextFixture();
    f.wire.authority.policies[1]!.limits.maxEvidenceAgeMs = 100;
    f.publication.observation.health[key].asOf = 199899;
    f.seal();
    expect(() => decodePaperRiskContextSource(f.wire, f.request, 200000)).toThrow(
      'PAPER_RISK_CONTEXT_STALE',
    );
  },
);
it('preserves the earliest exclusive deadline across read time and serialization', () => {
  const f = riskContextFixture();
  f.wire.authority.policies[0]!.limits.maxEvidenceAgeMs = 100;
  f.publication.observation.health.executor.asOf = 199900;
  f.seal();
  const r = decodePaperRiskContextSource(f.wire, f.request, 200000);
  expect(r.validUntil).toBe(200001);
  expect(r.runtime.health.executor.asOf).toBe(199900);
  expect(() =>
    decodePaperRiskContextSource(JSON.parse(JSON.stringify(f.wire)), f.request, 200001),
  ).toThrow('PAPER_RISK_CONTEXT_STALE');
});
it.each(['FAILED', 'UNKNOWN'] as const)(
  'retains %s health and pause evidence without fabricating an approval',
  (status) => {
    const f = riskContextFixture();
    f.publication.observation.health.executor.status = status;
    f.controls.global[0]!.state = 'PAUSED';
    f.seal();
    const r = decodePaperRiskContextSource(f.wire, f.request, 200000);
    expect(r.runtime.blockedBy).toEqual(['executor']);
    expect(r.authority.controls.pauses.global).toBe(true);
    expect(r).not.toHaveProperty('approved');
  },
);
it.each([
  'future',
  'authority-after-context',
  'runtime-after-context',
  'extra',
  'owner',
  'missing-runtime',
  'hash',
  'unsafe-epoch',
])('rejects %s without leaking private content', (kind) => {
  const f = riskContextFixture();
  if (kind === 'future') f.wire.asOf++;
  if (kind === 'authority-after-context') f.wire.asOf--;
  if (kind === 'runtime-after-context') {
    f.wire.asOf--;
    f.wire.authority.orderRisk.asOf--;
  }
  if (kind === 'extra') Object.assign(f.wire, { approved: true });
  if (kind === 'owner') f.runtime.owner = { ...f.runtime.owner, accountId: randomUUID() };
  if (kind === 'missing-runtime') Object.assign(f.wire, { runtime: null });
  if (kind === 'hash') f.runtime.publication.hash = '0'.repeat(64);
  if (kind === 'unsafe-epoch') f.runtime.current.permissionEpoch = '9223372036854775808';
  expect(() => decodePaperRiskContextSource(f.wire, f.request, 200000)).toThrow(
    'PAPER_RISK_CONTEXT_CORRUPT',
  );
});
it('rejects oversized context rather than partial evidence', () => {
  const f = riskContextFixture();
  f.runtime.publication.text = 'x'.repeat(3145728);
  expect(() => decodePaperRiskContextSource(f.wire, f.request, 200000)).toThrow(
    'PAPER_RISK_CONTEXT_CAPACITY',
  );
});
