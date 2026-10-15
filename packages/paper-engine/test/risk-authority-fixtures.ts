import { randomUUID, createHash } from 'node:crypto';
import { policyFingerprint } from '@ctp/risk-engine';
import { fixture as riskFixture } from '../../risk-engine/test/fixtures.js';
import { orderRiskFixture } from './order-risk-fixtures.js';

export function riskAuthorityFixture() {
  const f = orderRiskFixture(),
    limits = riskFixture().platform;
  const policy = (kind: 'PLATFORM' | 'USER') => ({
    scope:
      kind === 'PLATFORM'
        ? { kind: 'PLATFORM' }
        : { kind: 'USER', tenantId: f.request.owner.tenantId },
    mode: 'PAPER',
    version: '9007199254740993',
    eventId: randomUUID(),
    limits: { ...limits },
    limitsHash: policyFingerprint(limits),
  });
  const controls = {
    global: [
      {
        scope: { kind: 'GLOBAL' },
        kind: 'KILL_SWITCH',
        key: 'kill',
        state: 'RUNNING',
        epoch: '9007199254740993',
      },
    ],
    tenant: [] as {
      scope: { kind: string; tenantId: string; targetId: string };
      kind: string;
      key: string;
      state: string;
      epoch: string;
    }[],
    activePauses: [] as string[],
    circuits: [] as { id: string; state: string }[],
  };
  const pack = () => {
    const text = JSON.stringify(controls);
    return { text, hash: createHash('sha256').update(text).digest('hex') };
  };
  const wire = {
    kind: 'PAPER_RISK_AUTHORITY_CAPTURE',
    orderRisk: f.wire,
    identity: {
      ...f.request.owner,
      connectionId: null,
      externalAccountId: f.binding.externalAccountId,
      userSessionEpoch: '2147483647',
      permissionEpoch: f.wire.book.accountState.permissionEpoch,
      accountVersion: f.wire.book.accountState.version,
    },
    policies: [policy('PLATFORM'), policy('USER')],
    controls: pack(),
  };
  const seal = () => {
    wire.controls = pack();
    wire.policies.forEach((p) => {
      p.limitsHash = policyFingerprint(p.limits);
    });
  };
  return { ...f, order: f.wire, wire, controls, seal };
}
