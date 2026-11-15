import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { policyFingerprint } from '@ctp/risk-engine';
import { canonical } from '@ctp/portfolio';
import { parseDecimal } from '@ctp/exchange-core';
import * as paper from '../src/index.js';
import * as server from '../src/risk.js';
import { currentRiskEvaluationFixture } from './current-risk-evaluation-fixtures.js';
import { projectPaperCurrentLoss } from '../src/current-loss-domain.js';

function calculate(input: unknown) {
  const fn = (paper as unknown as Record<string, unknown>)['calculatePaperCurrentRiskEvaluation'];
  if (typeof fn !== 'function') throw Error('PAPER_CURRENT_EVALUATION_MISSING');
  return (
    fn as (input: unknown) => {
      kind: string;
      validUntil: number;
      source: { id: string; revision: string; hash: string } | null;
      result: { kind: string; reasons?: string[]; notional?: string; budget?: unknown };
    }
  )(input);
}
it('evaluates another BUY against the executed position rather than empty pristine inventory', () => {
  const f = currentRiskEvaluationFixture(),
    input = f.reseal(),
    before = canonical(input);
  const value = calculate(input);
  expect(value).toMatchObject({
    kind: 'PAPER_CURRENT_RISK_EVALUATION_CALCULATION',
    source: {
      id: f.certificate.id,
      revision: f.certificate.revision,
      hash: input.certificate.hash,
    },
    result: {
      kind: 'EVALUATED',
      notional: '2.1',
      budget: {
        current: { instrument: '6.025', user: '6.025' },
        projected: { instrument: '8.125', user: '8.125' },
      },
    },
  });
  expect(value).not.toHaveProperty('grant');
  expect(value).not.toHaveProperty('permit');
  expect(value).not.toHaveProperty('reservationId');
  expect(value.result).toMatchObject({ debits: [{ asset: 'USDT', amount: '2.1021' }] });
  expect(canonical(input)).toBe(before);
  expect(Object.isFrozen(value)).toBe(true);
  expect(calculate(input)).toEqual(value);
});
it.each([
  'maxInstrumentExposure',
  'maxAssetExposure',
  'maxAccountExposure',
  'maxUserExposure',
] as const)(
  'enforces current %s with existing exposure and the new order counted once',
  (field) => {
    const f = currentRiskEvaluationFixture();
    for (const p of f.source.policies) {
      p.limits[field] = parseDecimal('8');
      p.limitsHash = policyFingerprint(p.limits);
    }
    expect(calculate(f.reseal()).result).toMatchObject({ kind: 'REJECTED' });
  },
);
it('rejects a current pause even when every content hash is consistent', () => {
  const f = currentRiskEvaluationFixture();
  f.source.controls = f.seal({
    global: [
      { scope: { kind: 'GLOBAL' }, kind: 'KILL_SWITCH', key: 'kill', state: 'PAUSED', epoch: '2' },
    ],
    tenant: [],
    activePauses: [],
    circuits: [],
  });
  expect(calculate(f.reseal()).result).toMatchObject({
    kind: 'REJECTED',
    reasons: ['RISK_PAUSED'],
  });
});
it('preserves the certified actual loss rather than inventing a drawdown from a profitable mark', () => {
  const f = currentRiskEvaluationFixture();
  for (const p of f.source.policies) {
    p.limits.maxDrawdownRate = parseDecimal('0');
    p.limitsHash = policyFingerprint(p.limits);
  }
  const v = calculate(f.reseal());
  // Positive marked profit does not invent a drawdown. The evidence is preserved
  // and loss thresholds remain the common policy's responsibility.
  expect(v.source?.id).toBe(f.certificate.id);
  expect(v.result.kind).toBe('EVALUATED');
});
it.each(['orderId', 'intentId'] as const)('rejects reuse of the original execution %s', (field) => {
  const f = currentRiskEvaluationFixture();
  f.target[field] = f.request.admission[field];
  expect(calculate(f.reseal()).result.kind).toBe('REJECTED');
});
it.each(['tenantId', 'accountId'] as const)('rejects a mismatched %s', (field) => {
  const f = currentRiskEvaluationFixture();
  f.target.owner[field] = randomUUID();
  expect(calculate(f.reseal()).result.kind).toBe('REJECTED');
});
it.each(['dbInstrumentId', 'dbRuleId'] as const)('rejects a substituted %s', (field) => {
  const f = currentRiskEvaluationFixture();
  f.target[field] = randomUUID();
  expect(calculate(f.reseal()).result.kind).toBe('REJECTED');
});
it('does not bypass current ruleVersion validation for a new order', () => {
  const f = currentRiskEvaluationFixture();
  f.target.command.ruleVersion = 'replaced-v0';
  expect(calculate(f.reseal()).result.kind).toBe('REJECTED');
});
it('does not renew the certificate lease by changing the evaluation clock', () => {
  const f = currentRiskEvaluationFixture(),
    input = f.reseal();
  expect(calculate({ ...input, now: f.certificate.expiresAt }).result.kind).toBe('REJECTED');
  expect(calculate({ ...input, now: f.now - 1 }).result.kind).toBe('REJECTED');
});
it('rejects tampered source content without accepting a correct outer hash as authority', () => {
  const f = currentRiskEvaluationFixture();
  f.source.inventory.hash = '0'.repeat(64);
  expect(calculate(f.reseal()).result.kind).toBe('REJECTED');
});
it('keeps server authority absent from the pure calculation export', () => {
  expect(
    (paper as unknown as Record<string, unknown>)['calculatePaperCurrentRiskEvaluation'],
  ).toBeTypeOf('function');
  expect(server).not.toHaveProperty('calculatePaperCurrentRiskEvaluation');
  expect(paper).not.toHaveProperty('decodePaperCurrentRiskContents');
  expect(paper).not.toHaveProperty('createPostgresPaperCurrentRiskCoordinator');
});
it('rejects accessor-bearing input without reading its getter', () => {
  let reads = 0;
  const input = Object.defineProperty({}, 'now', {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  expect(() => calculate(input)).toThrow(/^PAPER_CURRENT_EVALUATION_/u);
  expect(reads).toBe(0);
});
it('keeps the existing position slot instead of charging it a second time', () => {
  const f = currentRiskEvaluationFixture();
  for (const p of f.source.policies) {
    p.limits.maxConcurrentPositions = 1;
    p.limitsHash = policyFingerprint(p.limits);
  }
  expect(calculate(f.reseal()).result).toMatchObject({
    kind: 'EVALUATED',
    budget: { potentialPositions: { current: 1, projected: 1 } },
  });
});
it('charges a new submission against the actual current order-frequency count', () => {
  const f = currentRiskEvaluationFixture();
  for (const p of f.source.policies) {
    p.limits.maxOrdersPerMinute = 1;
    p.limitsHash = policyFingerprint(p.limits);
  }
  expect(calculate(f.reseal()).result).toMatchObject({
    kind: 'REJECTED',
    reasons: ['RISK_ORDER_FREQUENCY'],
  });
});
it('enforces the full new per-lot fee vector against the minimum available balance', () => {
  const f = currentRiskEvaluationFixture();
  const available = f.inventory.valuation.accounts[0]!.balances.find(
    (b) => b.asset === 'USDT',
  )!.available!;
  for (const p of f.source.policies) {
    p.limits.minAvailableBalance = parseDecimal(available);
    p.limitsHash = policyFingerprint(p.limits);
  }
  expect(calculate(f.reseal()).result.kind).toBe('REJECTED');
});
it('enforces certified high-watermark drawdown before a new order', () => {
  const f = currentRiskEvaluationFixture(),
    s = f.source;
  const lossInput = {
    ...s.lossInput,
    points: [
      {
        id: randomUUID(),
        sourceHash: 'a'.repeat(64),
        at: f.now - 1,
        equity: '2000000',
        revision: '9007199254740995',
        status: 'APPLIED',
      },
    ],
  };
  const loss = f.seal(projectPaperCurrentLoss(lossInput, f.now));
  Object.assign(s, { lossInput, loss });
  s.lossReference.hash = loss.hash;
  expect(calculate(f.reseal()).result).toMatchObject({
    kind: 'REJECTED',
    reasons: ['RISK_DRAWDOWN'],
  });
});
it('does not treat an unsupported current model capability as native exchange evidence', () => {
  const f = currentRiskEvaluationFixture();
  Object.assign(f.source.capability, { adapterVersion: 'native-binance-v1' });
  expect(calculate(f.reseal()).result.kind).toBe('REJECTED');
});
it('rejects a changed permission epoch even if the target owner still matches', () => {
  const f = currentRiskEvaluationFixture(),
    input = f.reseal();
  input.sourceRequest.authorization.permissionEpoch = '999';
  expect(calculate(input).result.kind).toBe('REJECTED');
});
it('does not use the current raw best ask as an unproved MARKET execution cap', () => {
  const f = currentRiskEvaluationFixture();
  f.target.command.type = 'MARKET';
  f.target.command.limitPrice = null;
  f.target.command.timeInForce = null;
  expect(calculate(f.reseal()).result.kind).toBe('REJECTED');
});
it('rejects SELL rather than guessing spendable base availability from its marked value', () => {
  const f = currentRiskEvaluationFixture();
  f.target.command.side = 'SELL';
  expect(calculate(f.reseal()).result).toMatchObject({
    kind: 'REJECTED',
    reasons: ['PAPER_CURRENT_EVALUATION_UNSUPPORTED'],
  });
});
it('rejects contradictory non-PAPER target storage mode', () => {
  const f = currentRiskEvaluationFixture(),
    input = f.reseal();
  expect(() =>
    calculate({
      ...input,
      target: { ...input.target, owner: { ...input.target.owner, mode: 'DEMO' } },
    }),
  ).toThrow('PAPER_CURRENT_EVALUATION_INPUT');
});
it.each(['grant', 'permit', 'backend', 'policies', 'snapshot', 'credentials', 'tenantId'])(
  'rejects caller-supplied %s authority at the input boundary',
  (field) => {
    const f = currentRiskEvaluationFixture();
    expect(() => calculate({ ...f.reseal(), [field]: { trusted: true } })).toThrow(
      'PAPER_CURRENT_EVALUATION_INPUT',
    );
  },
);
it('rejects cyclic input and does not recurse without bounds', () => {
  const f: Record<string, unknown> = {};
  f['self'] = f;
  expect(() => calculate(f)).toThrow('PAPER_CURRENT_EVALUATION_EVIDENCE');
});
it('rejects oversized arrays before element getters can execute', () => {
  let reads = 0;
  const array = new Array<unknown>(10001);
  Object.defineProperty(array, '0', {
    enumerable: true,
    get() {
      reads++;
      return null;
    },
  });
  expect(() => calculate({ array })).toThrow('PAPER_CURRENT_EVALUATION_EVIDENCE');
  expect(reads).toBe(0);
});
