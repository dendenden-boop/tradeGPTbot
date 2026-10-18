import { randomUUID } from 'node:crypto';
import { parseDecimal } from '@ctp/exchange-core';
import { expect, it } from 'vitest';
import * as candidate from '../src/index.js';
import { tenantRiskContextFixture } from './tenant-risk-context-fixtures.js';
import { riskEvaluationFixture } from './risk-evaluation-fixtures.js';
import { calculatePaperRiskEvaluation as calculate } from '../src/risk-evaluation.js';
import { paperRuntimeDependencies } from '../src/runtime-domain.js';

it('exports a bounded PAPER Risk evaluation, not an approval port', () => {
  const calculate = (candidate as Record<string, unknown>).calculatePaperRiskEvaluation;
  expect(calculate).toBeTypeOf('function');
  const f = tenantRiskContextFixture();
  expect(
    (calculate as (v: unknown) => unknown)({ now: 200000, request: f.request, capture: f.wire }),
  ).toMatchObject({
    kind: 'PAPER_RISK_EVALUATION_CALCULATION',
    result: { kind: 'REJECTED' },
  });
});

it('composes original tenant evidence, common policy and the full fee ceiling vector without mutation', () => {
  const f = riskEvaluationFixture(),
    before = JSON.stringify(f.input);
  const r = calculate(f.input);
  expect(r.result).toEqual({
    kind: 'EVALUATED',
    effect: 'INCREASE',
    notional: '5.25',
    debits: [
      {
        asset: 'USDT',
        amount: '5.25525',
        available: '9007199254740993',
        remaining: '9007199254740987.74475',
      },
    ],
  });
  expect(r.validUntil).toBe(f.now + 5000);
  expect(r.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(Object.isFrozen(r.result)).toBe(true);
  expect(JSON.stringify(f.input)).toBe(before);
  for (const key of ['approve', 'grant', 'certificate', 'reservation', 'permit', 'proposal'])
    expect(r).not.toHaveProperty(key);
  expect(calculate(JSON.parse(JSON.stringify(f.input)))).toEqual(r);
});
it.each(paperRuntimeDependencies)(
  'applies observed %s negative health through common Risk policy',
  (key) => {
    const f = riskEvaluationFixture();
    f.publication.observation.health[key].status = 'UNKNOWN';
    f.seal();
    expect(calculate(f.input).result).toEqual({ kind: 'REJECTED', reasons: ['RISK_HEALTH'] });
  },
);
it('does not invent a positive UTC opening from today external funding', () => {
  const f = riskEvaluationFixture(2, 200000);
  expect(calculate(f.input).result).toEqual({ kind: 'REJECTED', reasons: ['RISK_LOSS_BASELINE'] });
});
it.each(['kill', 'pause', 'circuit', 'liquidity', 'deviation', 'spread', 'frequency'] as const)(
  'rejects %s using current original evidence',
  (kind) => {
    const f = riskEvaluationFixture();
    const expected = {
      kill: 'RISK_PAUSED',
      pause: 'RISK_PAUSED',
      circuit: 'RISK_CIRCUIT_OPEN',
      liquidity: 'RISK_LIQUIDITY',
      deviation: 'RISK_PRICE_DEVIATION',
      spread: 'RISK_SPREAD',
      frequency: 'RISK_ORDER_FREQUENCY',
    };
    if (kind === 'kill') f.controls.global[0]!.state = 'PAUSED';
    if (kind === 'pause') f.controls.activePauses.push(randomUUID());
    if (kind === 'circuit') f.controls.circuits.push({ id: randomUUID(), state: 'HALF_OPEN' });
    if (kind === 'liquidity') f.f.p.trade.quantity = parseDecimal('0.01');
    if (kind === 'deviation')
      f.context.authority.policies[0]!.limits.maxPriceDeviationRate = '0.001';
    if (kind === 'spread') f.context.authority.policies[0]!.limits.maxSpreadRate = '0.001';
    if (kind === 'frequency') f.context.authority.policies[0]!.limits.maxOrdersPerMinute = 0;
    f.seal();
    expect(calculate(f.input).result).toEqual({ kind: 'REJECTED', reasons: [expected[kind]] });
  },
);
it.each([
  'maxOrderNotional',
  'maxInstrumentExposure',
  'maxAssetExposure',
  'maxAccountExposure',
  'maxUserExposure',
] as const)('enforces recomputed vector budget %s', (key) => {
  const f = riskEvaluationFixture();
  f.context.authority.policies[0]!.limits[key] = '5';
  f.seal();
  expect(calculate(f.input).result.kind).toBe('REJECTED');
});
it('rechecks remaining cash after the complete per-lot fee ceiling', () => {
  const f = riskEvaluationFixture();
  for (const p of [f.f.s, f.f.p]) {
    p.record.rules = {
      ...p.record.rules,
      stepSize: parseDecimal('0.000000000000000001'),
      quantityPrecision: 18,
    };
  }
  // 5.25 principal + .5 worst-case fee; the scalar .00525 fee would pass.
  f.context.authority.policies[0]!.limits.minAvailableBalance = '9007199254740987.4';
  f.seal();
  expect(calculate(f.input).result).toEqual({
    kind: 'REJECTED',
    reasons: ['RISK_AVAILABLE_BALANCE'],
  });
});
it('retains the exclusive original deadline after JSON replay and an outer refresh', () => {
  const f = riskEvaluationFixture();
  expect(calculate({ ...f.input, now: f.now + 4999 }).result.kind).toBe('EVALUATED');
  f.wire.asOf = f.now + 5000;
  const r = calculate({ ...f.input, now: f.now + 5000 });
  expect(r.result).toEqual({ kind: 'REJECTED', reasons: ['PAPER_TENANT_RISK_CONTEXT_STALE'] });
});
it.each(['missing', 'owner', 'intent', 'hash', 'future', 'extra', 'conflict', 'noncash'] as const)(
  'fails closed on %s evidence',
  (kind) => {
    const f = riskEvaluationFixture();
    if (kind === 'missing') Object.assign(f.wire, { loss: null });
    if (kind === 'owner')
      f.input.request = { ...f.request, owner: { ...f.request.owner, accountId: randomUUID() } };
    if (kind === 'intent') f.input.request = { ...f.request, intentId: randomUUID() };
    if (kind === 'hash') f.order.snapshot.hash = '0'.repeat(64);
    if (kind === 'future') f.wire.asOf++;
    if (kind === 'extra') Object.assign(f.wire, { approved: true });
    if (kind === 'conflict') {
      f.loss.inventory.books[0] = structuredClone(f.loss.inventory.books[0]!);
      f.loss.inventory.books[0].accountState.version++;
    }
    if (kind === 'noncash') f.loss.fundingTimes.pop();
    expect(calculate(f.input).result.kind).toBe('REJECTED');
  },
);
it.each(['proposal', 'exposure', 'fx', 'capabilities', 'approved'] as const)(
  'does not accept caller %s',
  (key) => {
    const f = riskEvaluationFixture();
    expect(() => calculate({ ...f.input, [key]: true })).toThrow('PAPER_EVALUATION_INPUT');
  },
);
it('accepts a complete 100-account cash capture without rounding balances to Number', () => {
  const f = riskEvaluationFixture(100);
  expect(calculate(f.input).result.kind).toBe('EVALUATED');
});
it('expires at UTC midnight even when every other original witness remains fresh', () => {
  const f = riskEvaluationFixture(2, 3 * 86400000 - 1000);
  expect(calculate(f.input).result.kind).toBe('EVALUATED');
  expect(calculate(f.input).validUntil).toBe(3 * 86400000);
  expect(calculate({ ...f.input, now: 3 * 86400000 }).result.kind).toBe('REJECTED');
});
it('rejects a replacement rule that no longer matches the immutable draft', () => {
  const f = riskEvaluationFixture();
  for (const p of [f.f.s, f.f.p]) p.record.rules = { ...p.record.rules, version: 'replacement' };
  f.seal();
  expect(calculate(f.input).result.kind).toBe('REJECTED');
});
