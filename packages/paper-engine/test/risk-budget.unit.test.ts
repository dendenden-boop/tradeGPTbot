import { expect, it } from 'vitest';
import { newOrderSchema } from '@ctp/exchange-core';
import { calculatePaperRiskBudget } from '../src/index.js';
import { fixture } from './fixtures.js';
import { fixture as riskFixture } from '../../risk-engine/test/fixtures.js';

const account = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const intent = '44444444-4444-4444-8444-444444444444';
function input() {
  const { execution, ...market } = fixture();
  const owner = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    accountId: account,
    mode: 'PAPER' as const,
  };
  const scope = { tenantId: owner.tenantId, mode: 'PAPER' as const, valuationAsset: 'USDT' };
  const effect = {
    intentId: intent,
    accountId: account,
    instrumentId: market.record.instrument.id,
    base: 'BTC',
    quote: 'USDT',
    side: 'SELL' as 'BUY' | 'SELL',
    notional: '8',
  };
  const platform = {
    ...riskFixture().platform,
    maxOrderNotional: '10000',
    maxInstrumentExposure: '10000',
    maxAssetExposure: '10000',
    maxAccountExposure: '10000',
    maxUserExposure: '10000',
  };
  return {
    ...market,
    order: execution.order,
    owner,
    target: {
      orderId: '55555555-5555-4555-8555-555555555555',
      intentId: '66666666-6666-4666-8666-666666666666',
    },
    platform,
    user: { ...platform },
    fx: {
      from: 'USDT',
      to: 'USDT',
      rate: '1',
      kind: 'IDENTITY' as 'IDENTITY' | 'OBSERVED',
      sourceId: 'identity',
      asOf: market.now,
    },
    evidence: {
      scope,
      asOf: market.now,
      complete: true,
      accountIds: [account],
      positions: [
        {
          id: 'position',
          accountId: account,
          instrumentId: effect.instrumentId,
          base: 'BTC',
          quantity: '1',
          price: '10',
          priceAsset: 'USDT',
          at: market.now,
          fx: {
            from: 'USDT',
            to: 'USDT',
            rate: '1',
            kind: 'IDENTITY' as 'IDENTITY' | 'OBSERVED',
            sourceId: 'identity',
            at: market.now,
          },
        },
      ],
      orders: [
        {
          id: 'old-order',
          ...effect,
          notional: '9',
          status: 'UNKNOWN' as 'UNKNOWN' | 'OPEN' | 'PENDING',
        },
      ],
      reservations: [
        {
          id: 'reservation',
          orderId: 'old-order',
          ...effect,
          unknown: true,
          debits: [
            { asset: 'BTC', amount: '0.5', holdId: 'base-hold' },
            { asset: 'USDT', amount: '0.5', holdId: 'quote-hold' },
          ],
        },
      ],
      holds: [
        {
          id: 'base-hold',
          accountId: account,
          asset: 'BTC',
          amount: '0.5',
          unknown: true,
          reflected: false,
        },
        {
          id: 'quote-hold',
          accountId: account,
          asset: 'USDT',
          amount: '0.5',
          unknown: true,
          reflected: false,
        },
      ],
      balances: [
        { accountId: account, asset: 'BTC', available: '2' },
        { accountId: account, asset: 'USDT', available: '1000' },
      ],
    },
  };
}
it('counts one position plus max(order,reservation) once, with two separate monetary holds', () => {
  const r = calculatePaperRiskBudget(input());
  expect(r).toMatchObject({
    kind: 'PAPER_RISK_BUDGET_CALCULATION',
    version: 'spot-l2-taker-budget-v1',
    notional: '5.25',
    current: { instrument: '19', asset: '19', account: '19', user: '19' },
    projected: { instrument: '24.25', asset: '24.25', account: '24.25', user: '24.25' },
    orders: { current: 1, projected: 2 },
    potentialPositions: { current: 1, projected: 1 },
    coverage: {
      debits: [{ asset: 'USDT', amount: '5.25525', available: '999.5', remaining: '994.24475' }],
    },
  });
});
it.each(['PENDING', 'OPEN', 'UNKNOWN'] as const)(
  'counts %s once without adding its Portfolio holds as exposure',
  (status) => {
    const f = input();
    f.evidence.orders[0]!.status = status;
    expect(calculatePaperRiskBudget(f).current.user).toBe('19');
  },
);
it('retains an undispatched reservation without requiring a dispatched order', () => {
  const f = input();
  f.evidence.orders = [];
  expect(calculatePaperRiskBudget(f)).toMatchObject({
    current: { user: '18' },
    orders: { current: 1 },
  });
});
it('takes a larger reservation bound instead of summing correlated bounds', () => {
  const f = input();
  f.evidence.reservations[0]!.notional = '12';
  expect(calculatePaperRiskBudget(f).current.user).toBe('22');
});
it('does not deduct already reflected holds twice', () => {
  const f = input();
  f.evidence.holds.forEach((h) => {
    h.reflected = true;
  });
  f.evidence.balances[0]!.available = '1.5';
  f.evidence.balances[1]!.available = '999.5';
  expect(calculatePaperRiskBudget(f)).toEqual(calculatePaperRiskBudget(input()));
});
it('subtracts only the unreflected part of a mixed vector', () => {
  const f = input();
  f.evidence.holds[1]!.reflected = true;
  f.evidence.balances[1]!.available = '999.5';
  expect(calculatePaperRiskBudget(f)).toEqual(calculatePaperRiskBudget(input()));
});
it('a SELL never nets down current position exposure or spends anticipated proceeds', () => {
  const f = input();
  f.order = newOrderSchema.parse({ ...f.order, side: 'SELL', limitPrice: '9.5' });
  const r = calculatePaperRiskBudget(f);
  expect(r.projected.user).toBe('519');
  expect(r.coverage.debits).toEqual([
    { asset: 'BTC', amount: '0.5', available: '1.5', remaining: '1' },
    { asset: 'USDT', amount: '0.5', available: '999.5', remaining: '999' },
  ]);
});
it.each(['BTC', 'USDT'])(
  'rejects the entire SELL after existing holds leave %s one atom short',
  (asset) => {
    const f = input();
    f.order = newOrderSchema.parse({ ...f.order, side: 'SELL', limitPrice: '9.5' });
    f.evidence.balances.find((b) => b.asset === asset)!.available = '0.999999999999999999';
    expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_EVIDENCE');
  },
);
it('still requires per-lot fee ceilings after existing holds', () => {
  const f = input();
  f.model.takerFeeRate = '0.000000000000000001';
  f.evidence.balances[1]!.available = '5.750000000000000009';
  expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_EVIDENCE');
  f.evidence.balances[1]!.available = '5.75000000000000001';
  expect(calculatePaperRiskBudget(f).coverage.debits[0]!.remaining).toBe('0');
});
it('counts other pending instruments as potential positions even before any fill', () => {
  const f = input();
  f.evidence.positions = [];
  f.evidence.orders[0]!.instrumentId = 'eth-usdt';
  f.evidence.orders[0]!.base = 'ETH';
  f.evidence.reservations[0]!.instrumentId = 'eth-usdt';
  f.evidence.reservations[0]!.base = 'ETH';
  f.evidence.reservations[0]!.debits[0]!.asset = 'ETH';
  f.evidence.holds[0]!.asset = 'ETH';
  f.evidence.balances.push({ accountId: account, asset: 'ETH', available: '2' });
  expect(calculatePaperRiskBudget(f).potentialPositions).toEqual({ current: 1, projected: 2 });
  f.platform.maxConcurrentPositions = 1;
  expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_MAX_POSITIONS');
});
it('does not double count a pending instrument and its filled position', () => {
  const f = input();
  f.platform.maxConcurrentPositions = 1;
  f.user.maxConcurrentPositions = 1;
  expect(calculatePaperRiskBudget(f).potentialPositions).toEqual({ current: 1, projected: 1 });
});
it('includes another account only in the tenant user budget without pooling balances', () => {
  const f = input();
  f.evidence.accountIds.push(other);
  f.evidence.reservations[0]!.accountId = other;
  f.evidence.orders[0]!.accountId = other;
  f.evidence.holds.forEach((h) => {
    h.accountId = other;
  });
  f.evidence.balances.push(
    { accountId: other, asset: 'BTC', available: '1' },
    { accountId: other, asset: 'USDT', available: '1' },
  );
  expect(calculatePaperRiskBudget(f)).toMatchObject({
    current: { instrument: '10', asset: '10', account: '10', user: '19' },
    orders: { current: 0 },
  });
  f.user.maxUserExposure = '24.249999999999999999';
  expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_MAX_USER');
  f.user.maxUserExposure = '10000';
  f.evidence.balances[1]!.available = '0';
  expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_EVIDENCE');
});
for (const [field, code, below] of [
  ['maxOrderNotional', 'ORDER', '5.249999999999999999'],
  ['maxInstrumentExposure', 'INSTRUMENT', '24.249999999999999999'],
  ['maxAssetExposure', 'ASSET', '24.249999999999999999'],
  ['maxAccountExposure', 'ACCOUNT', '24.249999999999999999'],
  ['maxUserExposure', 'USER', '24.249999999999999999'],
] as const) {
  it.each(['platform', 'user'] as const)(
    `uses the stricter %s ${field} without one-atom tolerance`,
    (side) => {
      const f = input();
      f[side][field] = below;
      expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_MAX_' + code);
      f[side][field] = field === 'maxOrderNotional' ? '5.25' : '24.25';
      expect(calculatePaperRiskBudget(f).notional).toBe('5.25');
    },
  );
}
it.each(['platform', 'user'] as const)(
  'enforces %s open-order budget before adding one new intent',
  (side) => {
    const f = input();
    f[side].maxOpenOrders = 1;
    expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_MAX_ORDERS');
    f[side].maxOpenOrders = 2;
    expect(calculatePaperRiskBudget(f).orders.projected).toBe(2);
  },
);
it('distinguishes instrument, base-asset, account and user exposure', () => {
  const f = input();
  const p = f.evidence.positions[0]!;
  f.evidence.positions.push(
    { ...p, id: 'eth-position', instrumentId: 'eth-usdt', base: 'ETH', quantity: '2' },
    { ...p, id: 'other-position', accountId: other, quantity: '3' },
  );
  f.evidence.accountIds.push(other);
  f.evidence.balances.push({ accountId: other, asset: 'USDT', available: '1' });
  expect(calculatePaperRiskBudget(f).current).toEqual({
    instrument: '19',
    asset: '19',
    account: '39',
    user: '69',
  });
});
it.each(['orders', 'reservations', 'holds', 'positions', 'balances', 'accountIds'] as const)(
  'rejects duplicate %s',
  (field) => {
    const f = input();
    const rows = f.evidence[field];
    rows.push(structuredClone(rows[0]) as never);
    expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_DUPLICATE');
  },
);
it('rejects the same spot asset represented by two pairs or position IDs', () => {
  const f = input();
  f.evidence.positions.push({
    ...f.evidence.positions[0]!,
    id: 'duplicate',
    instrumentId: 'btc-other',
  });
  expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_DUPLICATE');
});
it.each(['accountId', 'instrumentId', 'base', 'quote', 'side', 'intentId'] as const)(
  'rejects conflicting order/reservation %s',
  (field) => {
    const f = input();
    const o = f.evidence.orders[0]!;
    const mutation = {
      accountId: other,
      instrumentId: 'other',
      base: 'ETH',
      quote: 'USD',
      side: 'BUY',
      intentId: f.target.intentId,
    };
    const raw = { ...f, evidence: { ...f.evidence, orders: [{ ...o, [field]: mutation[field] }] } };
    expect(() => calculatePaperRiskBudget(raw)).toThrow(/^PAPER_BUDGET_(SCOPE|ORDER|REPLAY)$/u);
  },
);
it.each(['reservation', 'hold'] as const)('cannot weaken UNKNOWN at the %s boundary', (kind) => {
  const f = input();
  if (kind === 'reservation') f.evidence.reservations[0]!.unknown = false;
  else f.evidence.holds[1]!.unknown = false;
  expect(() => calculatePaperRiskBudget(f)).toThrow(
    kind === 'reservation' ? 'PAPER_BUDGET_ORDER' : 'PAPER_BUDGET_HOLD',
  );
});
it.each(['missing reservation', 'missing hold', 'orphan hold', 'shared hold', 'wrong hold amount'])(
  `rejects ${'%s'} without releasing collateral`,
  (kind) => {
    const f = input();
    if (kind === 'missing reservation') f.evidence.reservations = [];
    if (kind === 'missing hold') f.evidence.holds.pop();
    if (kind === 'orphan hold') f.evidence.holds.push({ ...f.evidence.holds[0]!, id: 'orphan' });
    if (kind === 'shared hold') f.evidence.reservations[0]!.debits[1]!.holdId = 'base-hold';
    if (kind === 'wrong hold amount') f.evidence.holds[0]!.amount = '0.499999999999999999';
    expect(() => calculatePaperRiskBudget(f)).toThrow(/^PAPER_BUDGET_(ORDER|HOLD)$/u);
  },
);
it.each(['same asset', 'third asset', 'no base', 'BUY base', 'empty', 'zero'])(
  `rejects ${'%s'} in a retained debit vector`,
  (kind) => {
    const f = input(),
      r = f.evidence.reservations[0]!;
    if (kind === 'same asset') r.debits[1]!.asset = 'BTC';
    if (kind === 'third asset') r.debits[1]!.asset = 'ETH';
    if (kind === 'no base') r.debits.shift();
    if (kind === 'BUY base') {
      r.side = 'BUY';
      f.evidence.orders[0]!.side = 'BUY';
    }
    if (kind === 'empty') r.debits = [];
    if (kind === 'zero') r.debits[0]!.amount = '0';
    expect(() => calculatePaperRiskBudget(f)).toThrow(/^PAPER_BUDGET_(DUPLICATE|VECTOR|INPUT)$/u);
  },
);
it.each(['order', 'intent'] as const)(
  'cannot treat an already represented %s as a new budget increase',
  (kind) => {
    const f = input();
    const oldOrderId = '77777777-7777-4777-8777-777777777777';
    f.evidence.orders[0]!.id = oldOrderId;
    f.evidence.reservations[0]!.orderId = oldOrderId;
    if (kind === 'order') f.target.orderId = oldOrderId;
    else f.target.intentId = f.evidence.reservations[0]!.intentId;
    expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_REPLAY');
  },
);
it.each(['asOf', 'fx', 'position', 'position FX'])(`rejects stale ${'%s'} evidence`, (kind) => {
  const f = input();
  if (kind === 'asOf') f.evidence.asOf -= 5001;
  if (kind === 'fx') f.fx.asOf -= 5001;
  if (kind === 'position') f.evidence.positions[0]!.at -= 5001;
  if (kind === 'position FX') f.evidence.positions[0]!.fx.at -= 5001;
  expect(() => calculatePaperRiskBudget(f)).toThrow(/^PAPER_BUDGET_(STALE|EVIDENCE)$/u);
});
it('uses the strictest policy/model age and an exclusive deadline', () => {
  const f = input();
  f.user.maxEvidenceAgeMs = 100;
  f.evidence.asOf -= 100;
  expect(calculatePaperRiskBudget(f).validUntil).toBe(f.now + 1);
  f.now++;
  expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_STALE');
});
it.each(['book receipt', 'book exchange', 'trade receipt', 'trade exchange'])(
  'does not let the model age override a tighter policy for %s',
  (kind) => {
    const f = input();
    f.user.maxEvidenceAgeMs = 100;
    if (kind === 'book receipt') f.book.receivedAt -= 101;
    if (kind === 'book exchange') f.book.exchangeTime = f.now - 101;
    if (kind === 'trade receipt') f.trade.receivedAt -= 101;
    if (kind === 'trade exchange') f.trade.exchangeTime -= 101;
    expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_STALE');
  },
);
it('retains the earliest market/policy expiry without changing the original model', () => {
  const f = input();
  f.platform.maxEvidenceAgeMs = 100;
  f.book.exchangeTime = f.now - 100;
  const r = calculatePaperRiskBudget(f);
  expect(r.validUntil).toBe(f.now + 1);
  expect(r.coverage.envelope.model).toEqual(f.model);
});
it.each([
  'future state',
  'future FX',
  'incomplete',
  'foreign tenant',
  'other mode',
  'other currency',
  'negative spot',
])(`fails closed for ${'%s'}`, (kind) => {
  const f = input();
  const raw = structuredClone(f) as unknown as Record<string, unknown>;
  if (kind === 'future state') f.evidence.asOf++;
  if (kind === 'future FX') f.fx.asOf++;
  if (kind === 'incomplete') f.evidence.complete = false;
  if (kind === 'foreign tenant') f.evidence.scope.tenantId = other;
  if (kind === 'other mode')
    raw.evidence = { ...f.evidence, scope: { ...f.evidence.scope, mode: 'TESTNET' } };
  if (kind === 'other currency') f.evidence.scope.valuationAsset = 'USD';
  if (kind === 'negative spot') f.evidence.positions[0]!.quantity = '-1';
  expect(() => calculatePaperRiskBudget(kind === 'other mode' ? raw : f)).toThrow(
    /^PAPER_BUDGET_/u,
  );
});
it.each(['wrong from', 'wrong to', 'false observed', 'wrong identity rate'])(
  `rejects ${'%s'} FX`,
  (kind) => {
    const f = input();
    if (kind === 'wrong from') f.fx.from = 'BTC';
    if (kind === 'wrong to') f.fx.to = 'USD';
    if (kind === 'false observed') f.fx.kind = 'OBSERVED';
    if (kind === 'wrong identity rate') f.fx.rate = '2';
    expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_FX');
  },
);
it('converts quote notionals using observed FX without converting collateral availability', () => {
  const f = input();
  f.platform.valuationAsset = 'USD';
  f.user.valuationAsset = 'USD';
  f.evidence.scope.valuationAsset = 'USD';
  f.fx = { ...f.fx, to: 'USD', kind: 'OBSERVED', rate: '2' };
  f.evidence.positions[0]!.fx = {
    ...f.evidence.positions[0]!.fx,
    to: 'USD',
    kind: 'OBSERVED',
    rate: '2',
  };
  const r = calculatePaperRiskBudget(f);
  expect(r.notional).toBe('10.5');
  expect(r.coverage.debits[0]!.asset).toBe('USDT');
  expect(r.current.user).toBe('29');
});
it('rejects conflicting observed FX for the same currency pair in one budget', () => {
  const f = input();
  f.platform.valuationAsset = 'USD';
  f.user.valuationAsset = 'USD';
  f.evidence.scope.valuationAsset = 'USD';
  f.fx = { ...f.fx, to: 'USD', kind: 'OBSERVED', rate: '2' };
  f.evidence.positions[0]!.fx = {
    ...f.evidence.positions[0]!.fx,
    to: 'USD',
    kind: 'OBSERVED',
    rate: '1',
  };
  expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_FX');
});
it('handles 300 spot instruments across ten complete account inventories deterministically', () => {
  const f = input(),
    prototype = f.evidence.positions[0]!;
  const ids = Array.from(
    { length: 10 },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  );
  f.owner.accountId = ids[0]!;
  f.evidence.accountIds = ids;
  f.platform.maxConcurrentPositions = 1000;
  f.user.maxConcurrentPositions = 1000;
  f.evidence.orders = [];
  f.evidence.reservations = [];
  f.evidence.holds = [];
  f.evidence.positions = Array.from({ length: 300 }, (_, i) => ({
    ...structuredClone(prototype),
    id: 'position-' + i,
    accountId: ids[Math.floor(i / 30)]!,
    instrumentId: 'asset-' + i + '-usdt',
    base: 'ASSET' + i,
    price: '1',
  }));
  f.evidence.balances = [
    ...ids.map((accountId) => ({ accountId, asset: 'USDT', available: '1000' })),
    ...f.evidence.positions.map((p) => ({ accountId: p.accountId, asset: p.base, available: '1' })),
  ];
  const r = calculatePaperRiskBudget(f);
  expect(r).toMatchObject({
    current: { instrument: '0', asset: '0', account: '30', user: '300' },
    projected: { account: '35.25', user: '305.25' },
    potentialPositions: { current: 30, projected: 31 },
  });
  f.evidence.positions.reverse();
  f.evidence.balances.reverse();
  f.evidence.accountIds.reverse();
  expect(calculatePaperRiskBudget(JSON.parse(JSON.stringify(f)))).toEqual(r);
});
it.each(['account count', 'per-account assets', 'missing account balances'])(
  'rejects an incomplete or over-capacity inventory: %s',
  (kind) => {
    const f = input();
    if (kind === 'account count')
      f.evidence.accountIds = Array.from({ length: 101 }, () => account);
    if (kind === 'per-account assets')
      f.evidence.balances.push(
        ...Array.from({ length: 31 }, (_, i) => ({
          accountId: account,
          asset: 'ASSET' + i,
          available: '1',
        })),
      );
    if (kind === 'missing account balances') f.evidence.accountIds.push(other);
    expect(() => calculatePaperRiskBudget(f)).toThrow(/^PAPER_BUDGET_(INPUT|SCOPE)$/u);
  },
);
it.each(['order', 'reservation'] as const)('rejects an unbounded UNKNOWN %s', (kind) => {
  const f = input();
  if (kind === 'order') f.evidence.orders[0]!.notional = '0';
  else f.evidence.reservations[0]!.notional = '0';
  expect(() => calculatePaperRiskBudget(f)).toThrow('PAPER_BUDGET_INPUT');
});
it('preserves amounts above Number precision and one final fractional atom', () => {
  const f = input();
  f.evidence.balances[1]!.available = '9007199254740993.000000000000000001';
  expect(calculatePaperRiskBudget(f).coverage.debits[0]!.remaining).toBe(
    '9007199254740987.244750000000000001',
  );
});
it.each(['root', 'evidence', 'balance', 'hold'] as const)(
  'rejects unknown authority/override fields at %s',
  (where) => {
    const f = input();
    const raw =
      where === 'root'
        ? { ...f, grantId: 'fake' }
        : where === 'evidence'
          ? { ...f, evidence: { ...f.evidence, certificateId: 'fake' } }
          : where === 'balance'
            ? {
                ...f,
                evidence: {
                  ...f.evidence,
                  balances: [{ ...f.evidence.balances[0], free: '9999' }],
                },
              }
            : {
                ...f,
                evidence: { ...f.evidence, holds: [{ ...f.evidence.holds[0], tenantId: other }] },
              };
    expect(() => calculatePaperRiskBudget(raw)).toThrow('PAPER_BUDGET_INPUT');
  },
);
it('keeps arithmetic deterministic across JSON/reordering with no grant or monetary effect', () => {
  const f = input(),
    before = JSON.stringify(f),
    r = calculatePaperRiskBudget(f);
  const replay = JSON.parse(before) as ReturnType<typeof input>;
  replay.evidence.holds.reverse();
  replay.evidence.balances.reverse();
  replay.evidence.reservations[0]!.debits.reverse();
  expect(calculatePaperRiskBudget(replay)).toEqual(r);
  expect(JSON.stringify(f)).toBe(before);
  expect(Object.isFrozen(r)).toBe(true);
  expect(Object.isFrozen(r.coverage.debits)).toBe(true);
  for (const k of ['certificateId', 'decisionId', 'reservationId', 'grantId', 'permit', 'approve'])
    expect(k in r).toBe(false);
});
