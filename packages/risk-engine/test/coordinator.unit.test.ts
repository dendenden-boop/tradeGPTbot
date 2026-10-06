/* eslint-disable @typescript-eslint/require-await -- Atomic reference transaction fixtures do no network I/O. */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createRiskSnapshotCoordinator,
  prepareRiskSnapshot,
  riskEvidenceHash,
  riskSnapshotSourcesSchema,
  riskSnapshotKeySchema,
  type RiskSnapshotSources,
  type RiskSnapshotStore,
  type RiskSnapshotCertificate,
} from '../src/coordinator.js';
import { policyFingerprint } from '../src/policies.js';
import { fixture as riskFixture } from './fixtures.js';
import { evaluateRiskPolicy } from '../src/policy.js';
import { amountDecimalSchema } from '@ctp/exchange-core';
const referenceIdentity = {
  id: '44444444-4444-4444-8444-444444444444',
  revision: '9007199254740993',
};
function fixture() {
  const risk = riskFixture(),
    now = Date.now();
  risk.record.rules.effectiveAt = now - 1000;
  risk.record.rules.expiresAt = now + 60000;
  risk.capabilities.forEach((c) => {
    c.checkedAt = now - 1000;
    c.expiresAt = now + 60000;
  });
  const key = riskSnapshotKeySchema.parse({
    binding: { ...risk.binding, connectionId: randomUUID(), externalAccountId: 'exchange-owned' },
    instrumentId: risk.record.instrument.id,
    dbInstrumentId: randomUUID(),
    dbRuleId: randomUUID(),
    dbCapabilityId: randomUUID(),
  });
  const scope = { tenantId: key.binding.tenantId, mode: key.binding.mode, valuationAsset: 'USDT' };
  const values = {
    identity: { key, accountIds: [key.binding.accountId] },
    policies: [
      {
        scope: { kind: 'PLATFORM' },
        mode: key.binding.mode,
        version: '1',
        eventId: randomUUID(),
        limits: risk.platform,
        limitsHash: policyFingerprint(risk.platform),
      },
      {
        scope: { kind: 'USER', tenantId: key.binding.tenantId },
        mode: key.binding.mode,
        version: '1',
        eventId: randomUUID(),
        limits: risk.user,
        limitsHash: policyFingerprint(risk.user),
      },
    ],
    metadata: {
      record: risk.record,
      capabilities: risk.capabilities,
      adapterVersion: risk.adapterVersion,
    },
    portfolio: {
      sourceAt: now - 100,
      reconciledAt: now - 50,
      permissionEpoch: '9007199254740993',
      permissionVerifiedAt: now - 50,
      tradeAllowed: true,
      withdrawalAllowed: false,
      positionMode: 'SPOT',
      positionSide: 'NET',
      positionQuantity: '0',
      positionAsOf: now - 100,
      availableAsset: 'USDT',
      availableAmount: '1000',
      leverage: '1',
      ordersInLastMinute: 0,
    },
    exposure: {
      scope,
      now,
      maxEvidenceAgeMs: 5000,
      accountIds: [key.binding.accountId],
      complete: true,
      positions: [],
      orders: [],
      reservations: [],
      holds: [],
    },
    loss: {
      scope,
      utcDayStart: Math.floor(now / 86400000) * 86400000,
      coveredThrough: now,
      complete: true,
      opening: {
        id: 'opening',
        sequence: '1',
        at: Math.floor(now / 86400000) * 86400000,
        equity: '1000',
      },
      events: [{ id: 'current', sequence: '2', at: now, kind: 'EQUITY', amount: '1000' }],
    },
    market: { ...risk.snapshot.market, asOf: now - 20, fxAsOf: now - 20 },
    controls: { pauses: risk.snapshot.pauses, circuit: risk.snapshot.circuit },
    health: risk.snapshot.health,
  };
  const sources = structuredClone(
    riskSnapshotSourcesSchema.parse(
      Object.fromEntries(
        Object.entries(values).map(([kind, value]) => [
          kind,
          {
            value,
            reference: {
              id: 'durable-' + kind,
              revision: '1',
              hash: riskEvidenceHash(value),
              asOf: now - 100,
              complete: true,
            },
          },
        ]),
      ),
    ),
  );
  const rehash = () => {
    Object.values(sources).forEach((x) => {
      x.reference.hash = riskEvidenceHash(x.value);
    });
  };
  const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
  return { key, sources, now, risk, rehash, io };
}
it('prepares conservative sources with exact owner/profile/permission/policy bindings, without RiskGrant', () => {
  const f = fixture(),
    p = prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now);
  expect(p).toMatchObject({
    key: f.key,
    permissionEpoch: '9007199254740993',
    snapshot: {
      sourceId: referenceIdentity.id,
      revision: referenceIdentity.revision,
      userExposure: '0',
      availableAmount: '1000',
    },
  });
  expect(p.sources).toHaveLength(9);
  expect(p).not.toHaveProperty('decisionId');
  expect(
    evaluateRiskPolicy({
      now: f.now,
      binding: f.risk.binding,
      platform: p.platform.limits,
      user: p.user.limits,
      ...p.metadata,
      snapshot: p.snapshot,
      order: f.risk.order,
    }).kind,
  ).toBe('EVALUATED');
});
it.each(['tenantId', 'accountId', 'connectionId', 'externalAccountId', 'mode', 'profile'] as const)(
  'rejects a source identity with changed %s instead of treating caller scope as authority',
  (field) => {
    const f = fixture();
    if (field === 'profile')
      f.sources.identity.value.key.binding.profile = {
        ...f.sources.identity.value.key.binding.profile,
        profileVersion: 'other-profile',
      };
    else if (field === 'mode') f.sources.identity.value.key.binding.mode = 'DEMO';
    else
      f.sources.identity.value.key.binding[field] =
        field === 'externalAccountId' ? 'other' : randomUUID();
    f.rehash();
    expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow();
  },
);
it.each([
  'identity',
  'policies',
  'metadata',
  'portfolio',
  'exposure',
  'loss',
  'market',
  'controls',
  'health',
] as const)('rejects missing/stale/future/incomplete/changed %s evidence', (kind) => {
  for (const variant of ['missing', 'stale', 'future', 'incomplete', 'hash']) {
    const f = fixture();
    if (variant === 'missing') {
      const { [kind]: omitted, ...rest } = f.sources;
      void omitted;
      expect(() => prepareRiskSnapshot(rest, f.key, referenceIdentity, f.now)).toThrow();
      continue;
    }
    const r = f.sources[kind].reference;
    if (variant === 'stale') r.asOf = f.now - 5001;
    else if (variant === 'future') r.asOf = f.now + 1;
    else if (variant === 'incomplete') r.complete = false;
    else r.hash = '0'.repeat(64);
    expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow(
      'RISK_CERTIFICATE_SOURCE',
    );
  }
});
it('cannot exclude another owned account from the exposure inventory', () => {
  const f = fixture();
  f.sources.identity.value.accountIds.push(randomUUID());
  f.rehash();
  expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow(
    'RISK_CERTIFICATE_COVERAGE',
  );
});
it('rejects native HEDGE evidence without pretending that LONG/SHORT can become NET', () => {
  const f = fixture();
  f.sources.portfolio.value.positionMode = 'HEDGE';
  f.rehash();
  expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow(
    'RISK_POSITION_MODE_UNPROVED',
  );
});
it.each(['revoked', 'withdrawal', 'unreconciled', 'stale-permission'])(
  'rejects %s authority',
  (kind) => {
    const f = fixture(),
      p = f.sources.portfolio.value;
    if (kind === 'revoked') p.tradeAllowed = false;
    else if (kind === 'withdrawal') p.withdrawalAllowed = true;
    else if (kind === 'unreconciled') p.reconciledAt = p.sourceAt - 1;
    else p.permissionVerifiedAt = f.now - 5001;
    f.rehash();
    expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow(
      'RISK_CERTIFICATE_AUTHORITY',
    );
  },
);
it('rejects an expired rules head before certifying it', () => {
  const f = fixture();
  f.sources.metadata.value.record.rules.expiresAt = f.now;
  f.rehash();
  expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow(
    'RISK_CERTIFICATE_METADATA',
  );
});
it('rejects metadata from another exchange environment', () => {
  const f = fixture();
  f.sources.metadata.value.record.instrument.scope = {
    ...f.sources.metadata.value.record.instrument.scope,
    environment: 'DEMO',
  };
  f.sources.metadata.value.record.rules.scope = {
    ...f.sources.metadata.value.record.rules.scope,
    environment: 'DEMO',
  };
  f.rehash();
  expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow(
    'RISK_CERTIFICATE_METADATA',
  );
});
it('rejects a replaced/expired capability head before certifying it', () => {
  const f = fixture();
  f.sources.metadata.value.capabilities[0] = {
    ...f.sources.metadata.value.capabilities[0]!,
    expiresAt: f.now,
  };
  f.rehash();
  expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow(
    'RISK_CERTIFICATE_METADATA',
  );
});
it('rejects conflicting currency/liquidity provenance before certifying a market source', () => {
  const f = fixture();
  f.sources.market.value.liquidityAsset = 'USD';
  f.rehash();
  expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow(
    'RISK_CERTIFICATE_MARKET',
  );
});
it('requires signed NET position to agree with the captured exposure inventory', () => {
  const f = fixture();
  f.sources.portfolio.value.positionQuantity = amountDecimalSchema.parse('1');
  f.rehash();
  expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow(
    'RISK_CERTIFICATE_POSITION',
  );
});
function backend(f: ReturnType<typeof fixture>) {
  // Reference contract only. No production default, PostgreSQL locks or native acceptance.
  let durable: RiskSnapshotCertificate | null = null,
    counter = 0n;
  let uncertain = false;
  let atCommit: (() => void) | undefined;
  const calls: string[] = [];
  const store: RiskSnapshotStore = {
    async transaction(key, io, work) {
      void key;
      void io;
      calls.push('BEGIN');
      let staged = durable;
      const value = await work({
        async capture() {
          calls.push('CAPTURE');
          return structuredClone(f.sources);
        },
        async nextIdentity() {
          return { id: randomUUID(), revision: (++counter).toString() };
        },
        async insert(c) {
          calls.push('INSERT');
          staged = structuredClone(c);
        },
        async read() {
          return structuredClone(durable);
        },
      });
      durable = staged;
      calls.push('COMMIT');
      atCommit?.();
      if (uncertain) throw new Error('RISK_CERTIFICATE_COMMIT_UNKNOWN');
      return value;
    },
  };
  return {
    store,
    calls,
    uncertain: () => {
      uncertain = true;
    },
    atCommit: (fn: () => void) => {
      atCommit = fn;
    },
    corrupt: (fn: (c: RiskSnapshotCertificate) => void) => {
      if (durable) fn(durable);
    },
  };
}
it('requires explicitly injected persistence rather than manufacturing RAM authority', () => {
  expect(() =>
    createRiskSnapshotCoordinator({ now: Date.now } as Parameters<
      typeof createRiskSnapshotCoordinator
    >[0]),
  ).toThrow('RISK_COORDINATOR_OPTIONS');
});
it('certification and restart read require the durable transaction and matching current sources', async () => {
  const f = fixture(),
    b = backend(f),
    service = createRiskSnapshotCoordinator({ store: b.store, now: () => f.now });
  const c = await service.certify(f.key, f.io());
  expect(b.calls).toEqual(['BEGIN', 'CAPTURE', 'INSERT', 'COMMIT']);
  expect(c.hash).toBe(riskEvidenceHash(c.projection));
  const restarted = createRiskSnapshotCoordinator({ store: b.store, now: () => f.now + 1 });
  expect(await restarted.readCurrent(f.key, f.io())).toEqual(c);
  f.sources.controls.value.pauses.global = true;
  f.sources.controls.reference.revision = '2';
  f.rehash();
  await expect(restarted.readCurrent(f.key, f.io())).rejects.toThrow('RISK_CERTIFICATE_REPLACED');
});
it('uncertain COMMIT returns no certificate even when durable storage may have committed', async () => {
  const f = fixture(),
    b = backend(f);
  b.uncertain();
  await expect(
    createRiskSnapshotCoordinator({ store: b.store, now: () => f.now }).certify(f.key, f.io()),
  ).rejects.toThrow('RISK_CERTIFICATE_COMMIT_UNKNOWN');
});
it('abort as COMMIT settles returns no certificate', async () => {
  const f = fixture(),
    b = backend(f),
    abort = new AbortController();
  b.atCommit(() => abort.abort());
  await expect(
    createRiskSnapshotCoordinator({ store: b.store, now: () => f.now }).certify(f.key, {
      ...f.io(),
      signal: abort.signal,
    }),
  ).rejects.toThrow('RISK_CERTIFICATE_ABORTED');
});
it('does not enter persistence for expired IO', async () => {
  const f = fixture(),
    b = backend(f);
  await expect(
    createRiskSnapshotCoordinator({ store: b.store, now: () => f.now }).certify(f.key, {
      ...f.io(),
      deadline: 0,
    }),
  ).rejects.toThrow('RISK_CERTIFICATE_ABORTED');
  expect(b.calls).toEqual([]);
});
it('source content hash is independent of object property ordering', () => {
  const f = fixture(),
    s: RiskSnapshotSources = f.sources;
  expect(riskEvidenceHash({ b: s.loss, a: s.policies })).toBe(
    riskEvidenceHash({ a: s.policies, b: s.loss }),
  );
});
it('retains exact current permission epoch zero allowed by the storage/Core contract', () => {
  const f = fixture();
  f.sources.portfolio.value.permissionEpoch = '0';
  f.rehash();
  expect(prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now).permissionEpoch).toBe('0');
});
it('rejects a permission epoch outside the PostgreSQL bigint storage contract', () => {
  const f = fixture();
  for (const epoch of ['9223372036854775808', '1\n', '01', '+1']) {
    f.sources.portfolio.value.permissionEpoch = epoch;
    f.rehash();
    expect(() => prepareRiskSnapshot(f.sources, f.key, referenceIdentity, f.now)).toThrow(
      'RISK_CERTIFICATE_INPUT',
    );
  }
});
it('a stored certificate cannot extend the policy freshness window by changing expiry', async () => {
  const f = fixture(),
    b = backend(f);
  const service = createRiskSnapshotCoordinator({ store: b.store, now: () => f.now });
  await service.certify(f.key, f.io());
  b.corrupt((c) => {
    c.expiresAt = f.now + 60000;
  });
  await expect(service.readCurrent(f.key, f.io())).rejects.toThrow('RISK_CERTIFICATE_INVALID');
});

function checkpointSources(f: ReturnType<typeof fixture>) {
  const value = {
    scope: f.sources.exposure.value.scope,
    dayStart: Math.floor(f.now / 86400000) * 86400000,
    sequence: '9007199254740993',
    batchId: randomUUID(),
    coveredThrough: f.now,
    openingEquity: '1000',
    externalFlows: '50',
    netRealized: '-10',
    adjustedCurrentEquity: '990',
    adjustedPeakEquity: '1010',
    hash: 'a'.repeat(64),
  };
  return {
    ...f.sources,
    loss: {
      ...f.sources.loss,
      value,
      reference: {
        ...f.sources.loss.reference,
        id: value.batchId,
        revision: value.sequence,
        asOf: value.coveredThrough,
        hash: riskEvidenceHash(value),
      },
    },
  };
}
it('consumes the bounded durable UTC checkpoint without reconstructing an unbounded event array', () => {
  const f = fixture(),
    sources = checkpointSources(f);
  const projection = prepareRiskSnapshot(sources, f.key, referenceIdentity, f.now);
  expect(projection.snapshot).toMatchObject({
    adjustedOpeningEquity: '1000',
    adjustedCurrentEquity: '990',
    adjustedPeakEquity: '1010',
    dailyNetRealizedPnl: '-10',
  });
  expect(projection.sources.find((s) => s.kind === 'loss')?.reference).toEqual(
    sources.loss.reference,
  );
});
it('checkpoint consumption keeps 18-place equity precision and does not subtract external flows twice', () => {
  const f = fixture(),
    sources = checkpointSources(f);
  sources.loss.value.adjustedCurrentEquity = '9007199254740993.000000000000000001';
  sources.loss.value.adjustedPeakEquity = sources.loss.value.adjustedCurrentEquity;
  sources.loss.reference.hash = riskEvidenceHash(sources.loss.value);
  expect(
    prepareRiskSnapshot(sources, f.key, referenceIdentity, f.now).snapshot.adjustedCurrentEquity,
  ).toBe(sources.loss.value.adjustedCurrentEquity);
});
it('a checkpoint certificate survives coordinator restart and rejects a replacement durable loss head', async () => {
  const f = fixture();
  f.sources = riskSnapshotSourcesSchema.parse(checkpointSources(f));
  const b = backend(f),
    service = createRiskSnapshotCoordinator({ store: b.store, now: () => f.now });
  const certified = await service.certify(f.key, f.io());
  const restarted = createRiskSnapshotCoordinator({ store: b.store, now: () => f.now + 1 });
  expect(await restarted.readCurrent(f.key, f.io())).toEqual(certified);
  const next = checkpointSources(f);
  next.loss.value.sequence = '9007199254740994';
  next.loss.reference.revision = next.loss.value.sequence;
  next.loss.reference.hash = riskEvidenceHash(next.loss.value);
  f.sources = riskSnapshotSourcesSchema.parse(next);
  await expect(restarted.readCurrent(f.key, f.io())).rejects.toThrow('RISK_CERTIFICATE_REPLACED');
});
it.each([
  'tenant',
  'mode',
  'asset',
  'day',
  'future',
  'stale',
  'openingPeak',
  'currentPeak',
  'sequenceProof',
  'batchProof',
  'timeProof',
])('rejects a bounded checkpoint with conflicting %s evidence', (defect) => {
  const f = fixture(),
    sources = checkpointSources(f),
    c = sources.loss.value;
  if (defect === 'tenant') c.scope = { ...c.scope, tenantId: randomUUID() };
  if (defect === 'mode') c.scope = { ...c.scope, mode: 'DEMO' };
  if (defect === 'asset') c.scope = { ...c.scope, valuationAsset: 'USD' };
  if (defect === 'day') c.dayStart -= 86400000;
  if (defect === 'future') c.coveredThrough = f.now + 1;
  if (defect === 'stale') c.coveredThrough = f.now - 5001;
  if (defect === 'openingPeak') c.adjustedPeakEquity = '999';
  if (defect === 'currentPeak') c.adjustedCurrentEquity = '1011';
  if (defect === 'sequenceProof') sources.loss.reference.revision = '1';
  if (defect === 'batchProof') sources.loss.reference.id = randomUUID();
  if (defect === 'timeProof') sources.loss.reference.asOf--;
  sources.loss.reference.hash = riskEvidenceHash(c);
  expect(() => prepareRiskSnapshot(sources, f.key, referenceIdentity, f.now)).toThrow();
});
