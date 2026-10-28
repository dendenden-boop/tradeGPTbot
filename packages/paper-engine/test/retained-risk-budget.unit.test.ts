import { beforeEach, expect, it } from 'vitest';
import { decimalMultiply, parseDecimal } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import * as pure from '../src/index.js';
import { admissionWire, wireNow } from './admission-wire-fixtures.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function calculator() {
  const f = (pure as unknown as Record<string, unknown>)['calculatePaperRetainedRiskBudget'];
  if (typeof f !== 'function') throw Error('PAPER_RETAINED_RISK_BUDGET_MISSING');
  return f as (input: unknown) => {
    kind: string;
    computedAt: number;
    validUntil: number;
    attemptId: string;
    requestHash: string;
    reservationId: string;
    retained: readonly { asset: string; amount: string; holdId: string }[];
    budget: ReturnType<typeof pure.calculatePaperRiskBudget>;
  };
}
beforeEach(() => {
  calculator();
});
function fixture(count = 1) {
  const f = admissionWire(wireNow - 10),
    p = f.packet;
  const budget = structuredClone(p.budget);
  budget.now = wireNow;
  for (const limits of [budget.platform, budget.user]) {
    limits.maxOrderNotional =
      limits.maxInstrumentExposure =
      limits.maxAssetExposure =
      limits.maxAccountExposure =
      limits.maxUserExposure =
        '1000000';
    limits.maxOpenOrders = limits.maxConcurrentPositions = 1000;
  }
  budget.evidence.balances[0]!.available = '1000000';
  const original = pure.calculatePaperRiskBudget(budget);
  const preparation = pure.preparePaperExecutionAttempt({
    attemptId: id(9000),
    preparedAt: wireNow - 1,
    admission: {
      binding: f.expected.binding,
      orderId: f.expected.orderId,
      intentId: f.expected.intentId,
      commandHash: f.expected.commandHash,
      decisionId: p.receipt.decisionId,
      reservationId: p.receipt.reservationId,
      dbInstrumentId: id(9001),
      dbRuleId: id(9002),
      command: budget.order,
      admissionSequence: p.certificate.revision,
      admittedAt: budget.now - 10,
      expiresAt: p.receipt.expiresAt,
    },
  });
  const reservation = {
    id: p.receipt.reservationId,
    decisionId: p.receipt.decisionId,
    status: 'ACTIVE',
    revision: '1',
    expiresAt: p.receipt.expiresAt,
  };
  type Budget = typeof budget;
  const current = budget as Omit<Budget, 'evidence'> & {
    evidence: Omit<Budget['evidence'], 'orders' | 'reservations' | 'holds'> & {
      orders: {
        id: string;
        intentId: string;
        accountId: string;
        instrumentId: string;
        base: string;
        quote: string;
        side: string;
        notional: string;
        status: string;
      }[];
      reservations: {
        id: string;
        orderId: string;
        intentId: string;
        accountId: string;
        instrumentId: string;
        base: string;
        quote: string;
        side: string;
        notional: string;
        unknown: boolean;
        debits: { asset: string; amount: string; holdId: string }[];
      }[];
      holds: {
        id: string;
        accountId: string;
        asset: string;
        amount: string;
        unknown: boolean;
        reflected: boolean;
      }[];
    };
  };
  for (let n = 0; n < count; n++) {
    const own = n === 0,
      orderId = own ? f.expected.orderId : id(100 + n),
      intentId = own ? f.expected.intentId : id(1000 + n),
      holdId = own ? p.debits[0]!.holdId : id(2000 + n);
    const effect = {
      intentId,
      accountId: budget.owner.accountId,
      instrumentId: budget.order.instrumentId,
      base: budget.record.instrument.baseAsset,
      quote: budget.record.instrument.quoteAsset,
      side: 'BUY',
      notional: original.notional,
    };
    current.evidence.orders.push({ ...effect, id: orderId, status: 'PENDING' });
    current.evidence.reservations.push({
      ...effect,
      id: own ? reservation.id : id(3000 + n),
      orderId,
      unknown: false,
      debits: [{ ...p.debits[0]!, holdId }],
    });
    current.evidence.holds.push({
      id: holdId,
      accountId: effect.accountId,
      asset: p.debits[0]!.asset,
      amount: p.debits[0]!.amount,
      unknown: false,
      reflected: false,
    });
  }
  return {
    now: wireNow,
    deadline: wireNow + 500,
    preparation,
    reservation,
    metadata: { instrumentId: id(9001), ruleId: id(9002) },
    budget: current,
  };
}
type Fixture = ReturnType<typeof fixture>;

it('retains the issued target once at exact exposure/order/position/cash limits without a second reservation', () => {
  const f = fixture();
  const r = f.budget.evidence.reservations[0]!;
  for (const limits of [f.budget.platform, f.budget.user]) {
    limits.maxOrderNotional =
      limits.maxInstrumentExposure =
      limits.maxAssetExposure =
      limits.maxAccountExposure =
      limits.maxUserExposure =
        r.notional;
    limits.maxOpenOrders = limits.maxConcurrentPositions = 1;
  }
  const input = canonical(f),
    result = calculator()(f);
  expect(result.kind).toBe('PAPER_RETAINED_RISK_BUDGET_CALCULATION');
  expect(result.attemptId).toBe(f.preparation.request.attemptId);
  expect(result.requestHash).toBe(f.preparation.requestHash);
  expect(result.reservationId).toBe(f.reservation.id);
  expect(result.retained).toEqual(r.debits);
  expect(result.budget.current.user).toBe('0');
  expect(result.budget.projected.user).toBe(r.notional);
  expect(result.budget.orders).toEqual({ current: 0, projected: 1 });
  expect(result.budget.potentialPositions).toEqual({ current: 0, projected: 1 });
  expect(result.budget.coverage.debits[0]!.amount).toBe(r.debits[0]!.amount);
  expect(result.validUntil).toBe(f.deadline);
  expect(canonical(f)).toBe(input);
  expect(Object.isFrozen(result.retained[0])).toBe(true);
  for (const key of [
    'grant',
    'permit',
    'startedAt',
    'submittedAt',
    'certificate',
    'events',
    'release',
    'postings',
  ])
    expect(result).not.toHaveProperty(key);
  expect(() => pure.calculatePaperRiskBudget(f.budget)).toThrow('PAPER_BUDGET_REPLAY');
});
it('keeps all300 reservations and counts each other order/hold once', () => {
  const f = fixture(300),
    n = f.budget.evidence.reservations[0]!.notional;
  const result = calculator()(f);
  expect(result.budget.current.user).toBe(decimalMultiply(parseDecimal(n), parseDecimal('299')));
  expect(result.budget.projected.user).toBe(decimalMultiply(parseDecimal(n), parseDecimal('300')));
  expect(result.budget.orders).toEqual({ current: 299, projected: 300 });
  expect(f.budget.evidence.reservations).toHaveLength(300);
  expect(result.retained).toEqual(f.budget.evidence.reservations[0]!.debits);
});
it('accepts exactly funded retained principal and rounded fee without demanding a second debit', () => {
  const f = fixture(),
    amount = f.budget.evidence.reservations[0]!.debits[0]!.amount;
  f.budget.evidence.balances[0]!.available = amount;
  f.budget.platform.minAvailableBalance = f.budget.user.minAvailableBalance = '0';
  const result = calculator()(f);
  expect(result.budget.coverage.debits[0]!.remaining).toBe('0');
  expect(result.retained[0]!.amount).toBe(amount);
});
it('is independent of inventory ordering and survives content serialization without minting identities', () => {
  const f = fixture(3),
    expected = calculator()(f);
  f.budget.evidence.orders.reverse();
  f.budget.evidence.reservations.reverse();
  f.budget.evidence.holds.reverse();
  expect(calculator()(JSON.parse(JSON.stringify(f)))).toEqual(expected);
});
it('does not add back a hold which native availability already reflects', () => {
  const f = fixture();
  f.budget.evidence.holds[0]!.reflected = true;
  expect(() => calculator()(f)).toThrow(/PAPER_RETAINED_/u);
});
it('uses the original expiry even when current market metadata has a later deadline', () => {
  const f = fixture();
  f.deadline = f.reservation.expiresAt + 100;
  expect(calculator()(f).validUntil).toBe(f.reservation.expiresAt);
});
it('cannot extend original expiry through a caller replacement reservation', () => {
  const f = fixture();
  f.reservation.expiresAt++;
  expect(() => calculator()(f)).toThrow(/PAPER_RETAINED_/u);
});

const invalid: [string, (f: Fixture) => void][] = [
  [
    'missing target order',
    (f) => {
      f.budget.evidence.orders.shift();
    },
  ],
  [
    'missing target reservation',
    (f) => {
      f.budget.evidence.reservations.shift();
    },
  ],
  [
    'missing target hold',
    (f) => {
      f.budget.evidence.holds.shift();
    },
  ],
  [
    'duplicate target order',
    (f) => {
      f.budget.evidence.orders.push({ ...f.budget.evidence.orders[0]! });
    },
  ],
  [
    'duplicate target reservation',
    (f) => {
      f.budget.evidence.reservations.push({ ...f.budget.evidence.reservations[0]! });
    },
  ],
  [
    'duplicate target hold',
    (f) => {
      f.budget.evidence.holds.push({ ...f.budget.evidence.holds[0]! });
    },
  ],
  [
    'different target order intent',
    (f) => {
      f.budget.evidence.orders[0]!.intentId = id(4000);
    },
  ],
  [
    'different reservation order',
    (f) => {
      f.budget.evidence.reservations[0]!.orderId = id(4000);
    },
  ],
  [
    'different reservation intent',
    (f) => {
      f.budget.evidence.reservations[0]!.intentId = id(4000);
    },
  ],
  [
    'different reservation id',
    (f) => {
      f.budget.evidence.reservations[0]!.id = id(4000);
    },
  ],
  [
    'different decision',
    (f) => {
      f.reservation.decisionId = id(4000);
    },
  ],
  [
    'different metadata instrument',
    (f) => {
      f.metadata.instrumentId = id(4000);
    },
  ],
  [
    'different metadata rules',
    (f) => {
      f.metadata.ruleId = id(4000);
    },
  ],
  [
    'different budget target',
    (f) => {
      f.budget.target.orderId = id(4000);
    },
  ],
  [
    'different tenant',
    (f) => {
      f.budget.owner.tenantId = id(4000);
    },
  ],
  [
    'different account',
    (f) => {
      f.budget.owner.accountId = id(4000);
    },
  ],
  [
    'different command',
    (f) => {
      f.budget.order.clientOrderId = 'another-command';
    },
  ],
  [
    'new rule version',
    (f) => {
      f.budget.record.rules.version = 'changed';
    },
  ],
  [
    'different target order notional',
    (f) => {
      f.budget.evidence.orders[0]!.notional = '1';
    },
  ],
  [
    'different target reservation notional',
    (f) => {
      f.budget.evidence.reservations[0]!.notional = '1';
    },
  ],
  [
    'smaller retained debit',
    (f) => {
      f.budget.evidence.reservations[0]!.debits[0]!.amount = '1';
      f.budget.evidence.holds[0]!.amount = '1';
    },
  ],
  [
    'larger retained debit',
    (f) => {
      f.budget.evidence.reservations[0]!.debits[0]!.amount = '999';
      f.budget.evidence.holds[0]!.amount = '999';
    },
  ],
  [
    'different hold account',
    (f) => {
      f.budget.evidence.holds[0]!.accountId = id(4000);
    },
  ],
  [
    'different hold amount',
    (f) => {
      f.budget.evidence.holds[0]!.amount = '1';
    },
  ],
  [
    'different hold asset',
    (f) => {
      f.budget.evidence.holds[0]!.asset = 'BTC';
    },
  ],
  [
    'different debit asset',
    (f) => {
      f.budget.evidence.reservations[0]!.debits[0]!.asset = 'BTC';
    },
  ],
  [
    'different target account',
    (f) => {
      f.budget.evidence.reservations[0]!.accountId = id(4000);
    },
  ],
  [
    'different target base',
    (f) => {
      f.budget.evidence.reservations[0]!.base = 'OTHER';
    },
  ],
  [
    'different target instrument',
    (f) => {
      f.budget.evidence.orders[0]!.instrumentId = 'OTHER';
    },
  ],
  [
    'target UNKNOWN reservation',
    (f) => {
      f.budget.evidence.reservations[0]!.unknown = true;
    },
  ],
  [
    'target UNKNOWN order',
    (f) => {
      f.budget.evidence.orders[0]!.status = 'UNKNOWN';
    },
  ],
  [
    'target OPEN order',
    (f) => {
      f.budget.evidence.orders[0]!.status = 'OPEN';
    },
  ],
  [
    'target UNKNOWN hold',
    (f) => {
      f.budget.evidence.holds[0]!.unknown = true;
    },
  ],
  [
    'another UNKNOWN reservation',
    (f) => {
      f.budget.evidence.reservations[1]!.unknown = true;
    },
  ],
  [
    'another UNKNOWN order',
    (f) => {
      f.budget.evidence.orders[1]!.status = 'UNKNOWN';
    },
  ],
  [
    'another UNKNOWN hold',
    (f) => {
      f.budget.evidence.holds[1]!.unknown = true;
    },
  ],
  [
    'another missing hold',
    (f) => {
      f.budget.evidence.holds.pop();
    },
  ],
  [
    'another reused target hold',
    (f) => {
      f.budget.evidence.reservations[1]!.debits[0]!.holdId = f.budget.evidence.holds[0]!.id;
    },
  ],
  [
    'overdrawn current balance',
    (f) => {
      f.budget.evidence.balances[0]!.available = '0';
    },
  ],
  [
    'incomplete inventory',
    (f) => {
      f.budget.evidence.complete = false;
    },
  ],
  [
    'future inventory',
    (f) => {
      f.budget.evidence.asOf = wireNow + 1;
    },
  ],
  [
    'stale inventory',
    (f) => {
      f.budget.evidence.asOf = wireNow - 5001;
    },
  ],
  [
    'stale market',
    (f) => {
      f.budget.trade.receivedAt = wireNow - 5001;
    },
  ],
  [
    'future market',
    (f) => {
      f.budget.book.exchangeTime = wireNow + 1;
    },
  ],
  [
    'stale rules',
    (f) => {
      f.budget.record.rules.expiresAt = wireNow;
    },
  ],
  [
    'different evaluation time',
    (f) => {
      f.budget.now++;
    },
  ],
  [
    'caller deadline expired',
    (f) => {
      f.deadline = wireNow;
    },
  ],
  [
    'original grant expired',
    (f) => {
      f.now = f.preparation.request.admission.expiresAt;
      f.budget.now = f.now;
    },
  ],
  [
    'caller minimum balance tightened',
    (f) => {
      f.budget.user.minAvailableBalance = '1000000';
    },
  ],
  [
    'caller order policy tightened',
    (f) => {
      f.budget.user.maxOrderNotional = '0';
    },
  ],
  [
    'caller aggregate policy tightened',
    (f) => {
      f.budget.platform.maxUserExposure = '0';
    },
  ],
  [
    'caller open count tightened',
    (f) => {
      f.budget.user.maxOpenOrders = 1;
    },
  ],
  [
    'future preparation',
    (f) => {
      f.now = wireNow - 2;
      f.budget.now = f.now;
    },
  ],
  [
    'different budget instrument',
    (f) => {
      f.budget.record.instrument.id = 'another-instrument';
    },
  ],
  [
    'mismatched policy valuation currency',
    (f) => {
      f.budget.user.valuationAsset = 'BTC';
    },
  ],
  [
    'different public scope',
    (f) => {
      f.budget.record = {
        ...f.budget.record,
        instrument: {
          ...f.budget.record.instrument,
          scope: { ...f.budget.record.instrument.scope, environment: 'LIVE' },
        },
      };
    },
  ],
];
it.each(invalid)('fails closed for %s', (name, mutate) => {
  void name;
  const f = fixture(2);
  mutate(f);
  expect(() => calculator()(f)).toThrow(/PAPER_RETAINED_/u);
});
it.each(['UNKNOWN', 'RELEASED', 'CONSUMED'])(
  'rejects %s lifecycle state without trusted resolution',
  (status) => {
    const f = fixture();
    expect(() => calculator()({ ...f, reservation: { ...f.reservation, status } })).toThrow(
      /PAPER_RETAINED_/u,
    );
  },
);
it.each(['grant', 'permit', 'source', 'callback', 'tenantId', 'retained'])(
  'rejects caller-added %s',
  (key) => {
    expect(() => calculator()({ ...fixture(), [key]: true })).toThrow(/PAPER_RETAINED_/u);
  },
);
it.each(['START', 'UNKNOWN', 'NOT_SENT'])(
  'does not treat %s content as a pristine PREPARED head',
  (kind) => {
    const f = fixture();
    const event =
      kind === 'START'
        ? { kind, id: id(9200), at: wireNow, expectedRevision: '1' }
        : {
            kind,
            id: id(9200),
            at: wireNow,
            expectedRevision: '1',
            reason: kind === 'UNKNOWN' ? 'AMBIGUOUS_START_COMMIT' : 'CONTROL',
          };
    const { state } = pure.reducePaperExecutionAttempt({ state: f.preparation, event });
    expect(() => calculator()({ ...f, preparation: state })).toThrow(/PAPER_RETAINED_/u);
  },
);
it('bounds oversized inventory before touching any poisoned member', () => {
  const f = fixture(),
    orders = Array(1001).fill(null);
  Object.defineProperty(orders, 0, {
    get() {
      throw Error('POISON_VISITED');
    },
  });
  expect(() =>
    calculator()({ ...f, budget: { ...f.budget, evidence: { ...f.budget.evidence, orders } } }),
  ).toThrow(/PAPER_RETAINED_INPUT/u);
});
it('rejects accessors without invoking them', () => {
  const f = fixture();
  Object.defineProperty(f, 'permit', {
    enumerable: true,
    get() {
      throw Error('POISON_VISITED');
    },
  });
  expect(() => calculator()(f)).toThrow(/PAPER_RETAINED_INPUT/u);
});
it('rejects cycles without unbounded traversal or disclosing payloads', () => {
  const f = fixture(),
    input = { ...f, secret: 'private-payload' } as Record<string, unknown>;
  input.self = input;
  let error: unknown;
  try {
    calculator()(input);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toBe('Error: PAPER_RETAINED_INPUT');
  expect(String((error as Error).cause)).not.toContain('private-payload');
});
it('rejects a tampered PREPARED hash even when its reservation is present', () => {
  const f = fixture();
  expect(() =>
    calculator()({ ...f, preparation: { ...f.preparation, requestHash: 'a'.repeat(64) } }),
  ).toThrow(/PAPER_RETAINED_/u);
});
it('rejects a reservation revision replacement', () => {
  const f = fixture();
  expect(() => calculator()({ ...f, reservation: { ...f.reservation, revision: '2' } })).toThrow(
    /PAPER_RETAINED_/u,
  );
});
it('cannot reclaim collateral by reducing the target quantity', () => {
  const f = fixture();
  expect(() =>
    calculator()({
      ...f,
      budget: {
        ...f.budget,
        order: { ...f.budget.order, size: { ...f.budget.order.size, value: '0.1' } },
      },
    }),
  ).toThrow(/PAPER_RETAINED_/u);
});
it('does not claim complete current Risk/permission/health or a durable START', () => {
  const value = calculator()(fixture());
  for (const key of [
    'approved',
    'dispatchAllowed',
    'permissionEpoch',
    'certificateId',
    'riskDecisionId',
    'startedAt',
  ])
    expect(value).not.toHaveProperty(key);
  expect(pure).not.toHaveProperty('createPostgresPaperRetainedRiskBudget');
});
it('does not broaden the initial quote-cash scope through coherent foreign valuation input', () => {
  const f = fixture();
  f.budget.platform.valuationAsset = f.budget.user.valuationAsset = 'EUR';
  f.budget.evidence.scope.valuationAsset = 'EUR';
  const foreign = { ...f, budget: { ...f.budget, fx: { ...f.budget.fx, to: 'EUR', kind: 'OBSERVED', rate: '1' } } };
  expect(() => calculator()(foreign)).toThrow(/PAPER_RETAINED_/u);
});
