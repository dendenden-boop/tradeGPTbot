import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { decodePaperRiskAuthoritySource } from '../src/risk-authority-domain.js';
import { riskAuthorityFixture } from './risk-authority-fixtures.js';

it('binds current PAPER identity/policies/controls to the exact original draft and public heads', () => {
  const f = riskAuthorityFixture(),
    r = decodePaperRiskAuthoritySource(f.wire, f.request, 200000);
  expect(r).toMatchObject({
    kind: 'PAPER_RISK_AUTHORITY_SOURCE',
    asOf: 200000,
    validUntil: 205001,
    identity: { mode: 'PAPER', connectionId: null, userSessionEpoch: '2147483647' },
    policies: { platform: { version: '9007199254740993' } },
    controls: { pauses: { global: false, user: false, strategy: false }, circuit: 'CLOSED' },
    orderRisk: {
      target: { command: f.command },
      book: { state: { snapshotAt: 2000 } },
      envelope: { quoteNotionalBound: '5.25' },
    },
  });
  expect(r.controls.globalKill!.epoch).toBe('9007199254740993');
  expect(Object.isFrozen(r.controls.global)).toBe(true);
  for (const k of ['certificate', 'grant', 'reservation', 'permit', 'health', 'capabilities'])
    expect(k in r).toBe(false);
});
it('missing global kill head is explicit paused evidence, never a fabricated RUNNING epoch', () => {
  const f = riskAuthorityFixture();
  f.controls.global = [];
  f.seal();
  const r = decodePaperRiskAuthoritySource(f.wire, f.request, 200000);
  expect(r.controls.globalKill).toBe(null);
  expect(r.controls.pauses.global).toBe(true);
});
it.each(['global', 'user', 'strategy', 'legacy'])(`retains ${'%s'} pause evidence`, (kind) => {
  const f = riskAuthorityFixture();
  if (kind === 'global') f.controls.global[0]!.state = 'PAUSED';
  if (kind === 'legacy') f.controls.activePauses.push(randomUUID());
  if (kind === 'user' || kind === 'strategy')
    f.controls.tenant.push({
      scope: {
        kind: kind === 'user' ? 'USER' : 'STRATEGY',
        tenantId: f.request.owner.tenantId,
        targetId: kind === 'user' ? f.request.owner.tenantId : randomUUID(),
      },
      kind: 'KILL_SWITCH',
      key: 'kill',
      state: 'PAUSED',
      epoch: '1',
    });
  f.seal();
  const r = decodePaperRiskAuthoritySource(f.wire, f.request, 200000);
  expect(
    r.controls.pauses[kind === 'legacy' ? 'user' : (kind as 'global' | 'user' | 'strategy')],
  ).toBe(true);
});
it.each(['OPEN', 'HALF_OPEN', 'CLOSED'])(
  `retains ${'%s'} circuit state without synthesizing a connection`,
  (state) => {
    const f = riskAuthorityFixture();
    f.controls.circuits.push({ id: randomUUID(), state });
    f.seal();
    const r = decodePaperRiskAuthoritySource(f.wire, f.request, 200000);
    expect(r.controls.circuit).toBe(state);
    expect('connection' in r.controls.pauses).toBe(false);
  },
);
it('OPEN takes precedence across global, tenant and legacy circuit evidence', () => {
  const f = riskAuthorityFixture();
  f.controls.global.push({
    scope: { kind: 'GLOBAL' },
    kind: 'CIRCUIT',
    key: 'health',
    state: 'HALF_OPEN',
    epoch: '2',
  });
  f.controls.tenant.push({
    scope: { kind: 'CONNECTION', tenantId: f.request.owner.tenantId, targetId: randomUUID() },
    kind: 'CIRCUIT',
    key: 'native_health',
    state: 'OPEN',
    epoch: '3',
  });
  f.seal();
  expect(decodePaperRiskAuthoritySource(f.wire, f.request, 200000).controls.circuit).toBe('OPEN');
});
it.each([
  'mode',
  'tenant',
  'account',
  'external',
  'permission',
  'account-version',
  'connection',
  'unknown',
  'session-epoch',
])(`rejects conflicting identity ${'%s'}`, (kind) => {
  const f = riskAuthorityFixture();
  if (kind === 'mode') Object.assign(f.wire.identity, { mode: 'TESTNET' });
  if (kind === 'tenant') f.wire.identity.tenantId = randomUUID();
  if (kind === 'account') f.wire.identity.accountId = randomUUID();
  if (kind === 'external') f.wire.identity.externalAccountId = 'foreign';
  if (kind === 'permission') f.wire.identity.permissionEpoch = '1';
  if (kind === 'account-version') f.wire.identity.accountVersion++;
  if (kind === 'connection') Object.assign(f.wire.identity, { connectionId: randomUUID() });
  if (kind === 'unknown') Object.assign(f.wire.identity, { tradeAllowed: true });
  if (kind === 'session-epoch') f.wire.identity.userSessionEpoch = '2147483648';
  expect(() => decodePaperRiskAuthoritySource(f.wire, f.request, 200000)).toThrow(
    'PAPER_RISK_AUTHORITY_CORRUPT',
  );
});
it.each(['missing', 'mode', 'tenant', 'scope', 'currency', 'hash', 'limits', 'reordered'])(
  `rejects policy ${'%s'} without defaults`,
  (kind) => {
    const f = riskAuthorityFixture();
    if (kind === 'missing') f.wire.policies.pop();
    if (kind === 'mode') f.wire.policies[1]!.mode = 'DEMO';
    if (kind === 'tenant') f.wire.policies[1]!.scope.tenantId = randomUUID();
    if (kind === 'scope')
      f.wire.policies[0]!.scope = { kind: 'USER', tenantId: f.request.owner.tenantId };
    if (kind === 'currency') {
      f.wire.policies.forEach((p) => {
        p.limits.valuationAsset = 'USD';
      });
      f.seal();
    }
    if (kind === 'hash') f.wire.policies[0]!.limitsHash = 'a'.repeat(64);
    if (kind === 'limits') f.wire.policies[0]!.limits.maxEvidenceAgeMs = 0;
    if (kind === 'reordered') f.wire.policies.reverse();
    expect(() => decodePaperRiskAuthoritySource(f.wire, f.request, 200000)).toThrow(
      /PAPER_RISK_AUTHORITY_(POLICY|CORRUPT)/u,
    );
  },
);
it.each([
  'fingerprint',
  'state',
  'scope',
  'foreign',
  'duplicate',
  'pause-duplicate',
  'circuit-duplicate',
  'zero-epoch',
  'rounded-epoch',
  'newline-epoch',
  'extra-field',
])(`rejects control ${'%s'}`, (kind) => {
  const f = riskAuthorityFixture();
  if (kind === 'state') f.controls.global[0]!.state = 'HEALTHY';
  if (kind === 'scope')
    Object.assign(f.controls.global[0]!, {
      scope: {
        kind: 'USER',
        tenantId: f.request.owner.tenantId,
        targetId: f.request.owner.tenantId,
      },
    });
  if (kind === 'foreign')
    f.controls.tenant.push({
      scope: {
        kind: 'USER',
        tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        targetId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      },
      kind: 'KILL_SWITCH',
      key: 'kill',
      state: 'RUNNING',
      epoch: '1',
    });
  if (kind === 'duplicate') f.controls.global.push(structuredClone(f.controls.global[0]!));
  if (kind === 'pause-duplicate') {
    const id = randomUUID();
    f.controls.activePauses.push(id, id);
  }
  if (kind === 'circuit-duplicate') {
    const id = randomUUID();
    f.controls.circuits.push({ id, state: 'OPEN' }, { id, state: 'CLOSED' });
  }
  if (kind === 'zero-epoch') f.controls.global[0]!.epoch = '0';
  if (kind === 'rounded-epoch') f.controls.global[0]!.epoch = '9223372036854775808';
  if (kind === 'newline-epoch') f.controls.global[0]!.epoch = '1\n';
  if (kind === 'extra-field')
    Object.assign(f.controls.global[0]!, { credentials: 'not-authority' });
  f.seal();
  if (kind === 'fingerprint') f.wire.controls.hash = 'a'.repeat(64);
  expect(() => decodePaperRiskAuthoritySource(f.wire, f.request, 200000)).toThrow(
    'PAPER_RISK_AUTHORITY_CORRUPT',
  );
});
it.each([
  'book receipt',
  'book native',
  'trade receipt',
  'trade native',
  'ticker receipt',
  'ticker native',
  'snapshot publication',
  'trade publication',
])(`the tighter policy age applies to ${'%s'}`, (kind) => {
  const f = riskAuthorityFixture();
  f.wire.policies[1]!.limits.maxEvidenceAgeMs = 100;
  if (kind === 'book receipt') f.f.s.book.receivedAt = 199899;
  if (kind === 'book native') f.f.s.book.exchangeTime = 199899;
  if (kind === 'trade receipt') f.f.p.trade.receivedAt = 199899;
  if (kind === 'trade native') f.f.p.trade.exchangeTime = 199899;
  if (kind === 'ticker receipt') f.f.s.ticker.receivedAt = 199899;
  if (kind === 'ticker native') f.f.s.ticker.exchangeTime = 199899;
  if (kind === 'snapshot publication') f.f.s.timestamp = 199899;
  if (kind === 'trade publication') f.f.p.timestamp = 199899;
  f.order.snapshot = f.publication(f.f.s);
  f.order.trade = f.publication(f.f.p);
  f.seal();
  expect(() => decodePaperRiskAuthoritySource(f.wire, f.request, 200000)).toThrow(
    'PAPER_RISK_AUTHORITY_STALE',
  );
});
it('keeps the earliest exclusive deadline and original model/snapshot times', () => {
  const f = riskAuthorityFixture();
  f.wire.policies[0]!.limits.maxEvidenceAgeMs = 100;
  f.f.s.book.exchangeTime = 199900;
  f.order.snapshot = f.publication(f.f.s);
  f.seal();
  const r = decodePaperRiskAuthoritySource(f.wire, f.request, 200000);
  expect(r.validUntil).toBe(200001);
  expect(r.orderRisk.envelope.model.maxEvidenceAgeMs).toBe(5000);
  expect(r.orderRisk.book.state.snapshotAt).toBe(2000);
  expect(() => decodePaperRiskAuthoritySource(f.wire, f.request, 200001)).toThrow(
    'PAPER_RISK_AUTHORITY_STALE',
  );
});
it('JSON replay preserves original source evidence but establishes no durable certificate', () => {
  const f = riskAuthorityFixture(),
    original = JSON.stringify(f.wire),
    r = decodePaperRiskAuthoritySource(f.wire, f.request, 200000);
  expect(decodePaperRiskAuthoritySource(JSON.parse(original), f.request, 200001)).toEqual(r);
  expect(JSON.stringify(f.wire)).toBe(original);
  expect(r).not.toHaveProperty('certificateId');
});
it('rejects oversized capture rather than returning partial controls', () => {
  const f = riskAuthorityFixture();
  f.wire.controls.text += ' '.repeat(2097152);
  expect(() => decodePaperRiskAuthoritySource(f.wire, f.request, 200000)).toThrow(
    'PAPER_RISK_AUTHORITY_CAPACITY',
  );
});
