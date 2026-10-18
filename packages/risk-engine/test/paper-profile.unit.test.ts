import { describe, expect, it } from 'vitest';
import { evaluateRiskPolicy, riskEvaluationInputSchema } from '../src/policy.js';
import { fixture } from './fixtures.js';

function paper() {
  const f = riskEvaluationInputSchema.parse(fixture());
  f.binding.mode = 'PAPER';
  f.binding.profile = {
    ...f.binding.profile,
    accountMode: 'SIMULATED',
    endpointProfileId: 'paper-spot-v1',
    profileVersion: 'spot-l2-taker-v1',
  };
  f.adapterVersion = 'paper-spot-l2-taker-v1';
  f.snapshot.binding = structuredClone(f.binding);
  f.snapshot.positionEvidence.accountMode = 'SIMULATED';
  f.capabilities = f.capabilities.map((c) => ({
    ...c,
    profile: structuredClone(f.binding.profile),
    adapterVersion: f.adapterVersion,
    implementation: 'SYNTHETIC',
  }));
  return f;
}

describe('PAPER model capability isolation in pure Risk calculation', () => {
  it('evaluates the exact synthetic simulator profile without granting dispatch', () => {
    expect(evaluateRiskPolicy(paper())).toMatchObject({ kind: 'EVALUATED', effect: 'INCREASE' });
  });
  it('rejects a native capability relabelled as the simulator', () => {
    const f = paper();
    f.capabilities = f.capabilities.map((c) => ({ ...c, implementation: 'NATIVE' }));
    expect(evaluateRiskPolicy(f)).toEqual({ kind: 'REJECTED', reasons: ['RISK_CAPABILITY'] });
  });
  it('rejects a native exchange profile relabelled PAPER', () => {
    const f = fixture();
    f.binding.mode = f.snapshot.binding.mode = 'PAPER';
    expect(evaluateRiskPolicy(f)).toEqual({ kind: 'REJECTED', reasons: ['RISK_SCOPE'] });
  });
  it.each(['TESTNET', 'DEMO', 'LIVE'] as const)('keeps synthetic disabled for %s', (mode) => {
    const f = riskEvaluationInputSchema.parse(fixture());
    f.binding.mode = mode;
    f.binding.profile = { ...f.binding.profile, environment: mode };
    f.record.instrument = {
      ...f.record.instrument,
      scope: { ...f.record.instrument.scope, environment: mode },
    };
    f.record.rules = { ...f.record.rules, scope: { ...f.record.rules.scope, environment: mode } };
    f.snapshot.binding = structuredClone(f.binding);
    f.capabilities = f.capabilities.map((c) => ({
      ...c,
      profile: structuredClone(f.binding.profile),
      implementation: 'SYNTHETIC',
    }));
    expect(evaluateRiskPolicy(f)).toEqual({ kind: 'REJECTED', reasons: ['RISK_CAPABILITY'] });
  });
  it.each(['accountMode', 'endpointProfileId', 'profileVersion'] as const)(
    'rejects wrong model %s',
    (key) => {
      const f = paper();
      f.binding.profile = { ...f.binding.profile, [key]: 'OTHER' };
      f.snapshot.binding = structuredClone(f.binding);
      f.snapshot.positionEvidence.accountMode = f.binding.profile.accountMode;
      f.capabilities = f.capabilities.map((c) => ({
        ...c,
        profile: structuredClone(f.binding.profile),
      }));
      expect(evaluateRiskPolicy(f)).toEqual({ kind: 'REJECTED', reasons: ['RISK_SCOPE'] });
    },
  );
  it('rejects credentials on a simulator profile', () => {
    const f = paper();
    f.binding.profile = { ...f.binding.profile, credentialRef: 'server-ref' };
    f.snapshot.binding = structuredClone(f.binding);
    f.capabilities = f.capabilities.map((c) => ({
      ...c,
      profile: structuredClone(f.binding.profile),
    }));
    expect(evaluateRiskPolicy(f)).toEqual({ kind: 'REJECTED', reasons: ['RISK_SCOPE'] });
  });
  it.each(['BINANCE', 'BYBIT', 'OKX', 'HTX'] as const)(
    'never borrows native %s capability semantics',
    (exchange) => {
      const f = paper();
      f.binding.profile = { ...f.binding.profile, exchange };
      f.snapshot.binding = structuredClone(f.binding);
      f.record.instrument = {
        ...f.record.instrument,
        scope: { ...f.record.instrument.scope, exchange },
      };
      f.record.rules = { ...f.record.rules, scope: { ...f.record.rules.scope, exchange } };
      f.capabilities = f.capabilities.map((c) => ({
        ...c,
        profile: structuredClone(f.binding.profile),
        implementation: 'NATIVE',
      }));
      expect(evaluateRiskPolicy(f)).toEqual({ kind: 'REJECTED', reasons: ['RISK_CAPABILITY'] });
    },
  );
  it.each(['version', 'expired', 'duplicate', 'instrument'] as const)(
    'rejects %s model capability',
    (kind) => {
      const f = paper();
      if (kind === 'version') f.adapterVersion = 'other';
      if (kind === 'expired')
        f.capabilities = f.capabilities.map((c) => ({ ...c, expiresAt: f.now }));
      if (kind === 'duplicate')
        f.capabilities = [
          ...f.capabilities,
          f.capabilities.find((c) => c.feature === 'LIMIT_ORDER')!,
        ];
      if (kind === 'instrument')
        f.capabilities = f.capabilities.map((c) => ({
          ...c,
          constraints: { instrumentIds: ['OTHER'] },
        }));
      expect(evaluateRiskPolicy(f)).toEqual({
        kind: 'REJECTED',
        reasons: [kind === 'version' ? 'RISK_SCOPE' : 'RISK_CAPABILITY'],
      });
    },
  );
});
