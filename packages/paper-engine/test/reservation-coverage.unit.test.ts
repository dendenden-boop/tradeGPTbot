import { Decimal } from 'decimal.js';
import { expect, it } from 'vitest';
import { newOrderSchema } from '@ctp/exchange-core';
import {
  calculatePaperReservationCoverage,
  evaluatePaperOrder,
  preparePaperFrame,
} from '../src/index.js';
import { fixture } from './fixtures.js';

const D = Decimal.clone({ precision: 120 });
function input(side: 'BUY' | 'SELL' = 'BUY') {
  const { execution, ...market } = fixture();
  return {
    ...market,
    order: newOrderSchema.parse({
      ...execution.order,
      side,
      limitPrice: side === 'BUY' ? '10.5' : '9.5',
    }),
    balances: [
      { asset: 'BTC', available: '1' },
      { asset: 'USDT', available: '1000' },
    ],
  };
}

it('covers BUY principal and all rounded quote fees with an exact residual', () => {
  expect(calculatePaperReservationCoverage(input())).toMatchObject({
    kind: 'PAPER_RESERVATION_COVERAGE_CALCULATION',
    version: 'spot-l2-taker-vector-v1',
    debits: [{ asset: 'USDT', amount: '5.25525', available: '1000', remaining: '994.74475' }],
  });
});
it('keeps SELL base principal and quote commission as two indivisible requirements', () => {
  expect(calculatePaperReservationCoverage(input('SELL')).debits).toEqual([
    { asset: 'BTC', amount: '0.5', available: '1', remaining: '0.5' },
    { asset: 'USDT', amount: '0.5', available: '1000', remaining: '999.5' },
  ]);
});
it.each(['BTC', 'USDT'])(
  'rejects the whole SELL vector when %s has a one-atom shortfall',
  (asset) => {
    const f = input('SELL');
    f.balances = f.balances.map((b) => ({
      ...b,
      available: b.asset === asset ? '0.499999999999999999' : '1000',
    }));
    expect(() => calculatePaperReservationCoverage(f)).toThrow('PAPER_COVERAGE_INSUFFICIENT');
  },
);
it('does not spend anticipated SELL proceeds to cover quote commission', () => {
  const f = input('SELL');
  f.balances = [{ asset: 'BTC', available: '1000' }];
  expect(() => calculatePaperReservationCoverage(f)).toThrow('PAPER_COVERAGE_INSUFFICIENT');
});
it('does not pool other assets to cover an absent BUY quote balance', () => {
  const f = input();
  f.balances = [{ asset: 'BTC', available: '99999999999999999999' }];
  expect(() => calculatePaperReservationCoverage(f)).toThrow('PAPER_COVERAGE_INSUFFICIENT');
});
it('exact vector coverage leaves zero in each affected asset', () => {
  const f = input('SELL');
  f.balances = f.balances.map((b) => ({ ...b, available: '0.5' }));
  expect(calculatePaperReservationCoverage(f).debits.map((d) => d.remaining)).toEqual(['0', '0']);
});
it('a proven zero fee creates no quote liability and requires no synthetic balance', () => {
  const f = input('SELL');
  f.model.takerFeeRate = '0';
  f.balances = [{ asset: 'BTC', available: '0.5' }];
  expect(calculatePaperReservationCoverage(f).debits).toEqual([
    { asset: 'BTC', amount: '0.5', available: '0.5', remaining: '0' },
  ]);
});
it('per-lot ceiling remains mandatory even when the aggregate fee rounds lower', () => {
  const f = input();
  f.model.takerFeeRate = '0.000000000000000001';
  f.balances = [{ asset: 'USDT', available: '5.250000000000000009' }];
  expect(() => calculatePaperReservationCoverage(f)).toThrow('PAPER_COVERAGE_INSUFFICIENT');
  f.balances[0]!.available = '5.25000000000000001';
  expect(calculatePaperReservationCoverage(f).debits[0]!.remaining).toBe('0');
});
it('preserves balances above Number precision and their final fractional atom', () => {
  const f = input();
  f.balances = [{ asset: 'USDT', available: '9007199254740993.000000000000000001' }];
  expect(calculatePaperReservationCoverage(f).debits[0]!.remaining).toBe(
    '9007199254740987.744750000000000001',
  );
});
it('preserves the full storage amount boundary without exponent or clipping', () => {
  const f = input();
  f.balances = [{ asset: 'USDT', available: '99999999999999999999.999999999999999999' }];
  expect(calculatePaperReservationCoverage(f).debits[0]!.remaining).toBe(
    '99999999999999999994.744749999999999999',
  );
});
it.each(['same', 'conflicting'])('rejects %s duplicate assets rather than summing them', (kind) => {
  const f = input();
  f.balances.push({ asset: 'USDT', available: kind === 'same' ? '1000' : '1' });
  expect(() => calculatePaperReservationCoverage(f)).toThrow('PAPER_COVERAGE_INPUT');
});
it('canonical debit ordering is independent of balance input ordering and unrelated assets', () => {
  const f = input('SELL'),
    expected = calculatePaperReservationCoverage(f);
  expect(
    calculatePaperReservationCoverage({
      ...f,
      balances: [...f.balances].reverse().concat({ asset: 'ETH', available: '123' }),
    }),
  ).toEqual(expected);
});
it('binds the original command, current rules/model and exclusive envelope deadline', () => {
  const f = input(),
    r = calculatePaperReservationCoverage(f);
  expect(r.envelope.order).toEqual(f.order);
  expect(r.envelope.record).toEqual(f.record);
  expect(r.envelope.model).toEqual(f.model);
  expect(r.computedAt).toBe(f.now);
  expect(r.validUntil).toBe(r.envelope.validUntil);
  expect(r.validUntil).toBe(f.now + 5001);
});
it('roundtrip/restart is deterministic and does not mutate balances or evidence', () => {
  const f = input(),
    before = JSON.stringify(f),
    r = calculatePaperReservationCoverage(f);
  expect(calculatePaperReservationCoverage(JSON.parse(before))).toEqual(r);
  expect(JSON.stringify(f)).toBe(before);
  expect(Object.isFrozen(r)).toBe(true);
  expect(Object.isFrozen(r.debits[0])).toBe(true);
  expect(Object.isFrozen(r.envelope.record.rules)).toBe(true);
});
it('does not grant financial authority or fabricate durable identities', () => {
  const r = calculatePaperReservationCoverage(input());
  for (const key of [
    'grant',
    'approved',
    'certificate',
    'reservationId',
    'holdId',
    'intentId',
    'permit',
  ])
    expect(r).not.toHaveProperty(key);
});

const scenarios = (['BUY', 'SELL'] as const).flatMap((side) =>
  (['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT'] as const).flatMap((type) =>
    ['0', '0.001', '0.000000000000000001', '0.1'].map((fee) => ({ side, type, fee })),
  ),
);
it.each(scenarios)(
  'covers ten real fragmented fills and their fees: $side $type rate=$fee',
  ({ side, type, fee }) => {
    const f = input(side);
    const order = newOrderSchema.parse({
      ...f.order,
      type,
      limitPrice: type.endsWith('LIMIT') ? (side === 'BUY' ? '10.5' : '9.5') : null,
      timeInForce: type.endsWith('LIMIT') ? 'GTC' : null,
      trigger: type.startsWith('STOP_') ? { source: 'LAST', price: '10' } : null,
    });
    const market = {
      now: f.now,
      model: { ...f.model, takerFeeRate: fee, participationRate: '1' },
      record: f.record,
      book: {
        ...f.book,
        asks: Array.from({ length: 10 }, (_, i) => ({
          price: new D('10.05').add(new D('0.05').mul(i)).toFixed(),
          quantity: '0.05',
        })),
        bids: Array.from({ length: 10 }, (_, i) => ({
          price: new D('9.95').sub(new D('0.05').mul(i)).toFixed(),
          quantity: '0.05',
        })),
      },
      trade: { ...f.trade, quantity: '0.5' },
    };
    const r = calculatePaperReservationCoverage({ ...market, order, balances: f.balances });
    const result = evaluatePaperOrder({
      ...fixture().execution,
      order,
      frame: preparePaperFrame(market),
    });
    expect(result.status).toBe('FILLED');
    expect(result.fills).toHaveLength(10);
    const feeSpent = result.fills.reduce((n, fill) => n.add(fill.quoteFee), new D(0)),
      principalSpent = result.fills.reduce((n, fill) => n.add(fill.quoteNotional), new D(0));
    const actual =
      side === 'BUY'
        ? [{ asset: 'USDT', amount: principalSpent.add(feeSpent) }]
        : [
            { asset: 'BTC', amount: new D('0.5') },
            { asset: 'USDT', amount: feeSpent },
          ];
    for (const a of actual) {
      const debit = r.debits.find((d) => d.asset === a.asset);
      if (a.amount.isZero()) expect(debit).toBeUndefined();
      else {
        expect(debit).toBeDefined();
        expect(a.amount.lte(debit!.amount)).toBe(true);
        expect(new D(debit!.available).sub(a.amount).gte(debit!.remaining)).toBe(true);
      }
    }
  },
);

const invalid: readonly [string, (f: ReturnType<typeof input>) => unknown][] = [
  ['empty inventory', (f) => ({ ...f, balances: [] })],
  [
    'too many assets',
    (f) => ({
      ...f,
      balances: Array.from({ length: 33 }, (_, i) => ({ asset: `A${i}`, available: '1' })),
    }),
  ],
  ['missing balances', (f) => ({ ...f, balances: undefined })],
  ['numeric amount', (f) => ({ ...f, balances: [{ asset: 'USDT', available: 1000 }] })],
  ['negative amount', (f) => ({ ...f, balances: [{ asset: 'USDT', available: '-1' }] })],
  ['negative zero', (f) => ({ ...f, balances: [{ asset: 'USDT', available: '-0' }] })],
  ['exponent', (f) => ({ ...f, balances: [{ asset: 'USDT', available: '1e3' }] })],
  ['noncanonical amount', (f) => ({ ...f, balances: [{ asset: 'USDT', available: '1000.0' }] })],
  [
    'over-scale amount',
    (f) => ({ ...f, balances: [{ asset: 'USDT', available: '1.0000000000000000001' }] }),
  ],
  [
    'over-range amount',
    (f) => ({ ...f, balances: [{ asset: 'USDT', available: '100000000000000000000' }] }),
  ],
  ['total instead of available', (f) => ({ ...f, balances: [{ asset: 'USDT', total: '1000' }] })],
  [
    'free balance override',
    (f) => ({ ...f, balances: [{ asset: 'USDT', available: '1000', free: '1000' }] }),
  ],
  ['precomputed debits', (f) => ({ ...f, debits: [{ asset: 'USDT', amount: '0' }] })],
  ['caller envelope', (f) => ({ ...f, envelope: {} })],
];
it.each(invalid)('rejects invalid or ambiguous balance input: %s', (_name, change) => {
  expect(() => calculatePaperReservationCoverage(change(input()))).toThrow('PAPER_COVERAGE_INPUT');
});
it('accepts the bounded 32-asset inventory without merging assets', () => {
  const f = input();
  f.balances = [
    { asset: 'USDT', available: '1000' },
    ...Array.from({ length: 31 }, (_, i) => ({ asset: `A${i}`, available: '0' })),
  ];
  expect(calculatePaperReservationCoverage(f).debits).toHaveLength(1);
});
it.each(['stale book', 'rule replacement', 'unsupported order', 'unbounded MARKET'])(
  'recomputes and rejects invalid execution evidence: %s',
  (kind) => {
    const f = input();
    const raw =
      kind === 'stale book'
        ? { ...f, book: { ...f.book, receivedAt: f.now - 5001 } }
        : kind === 'rule replacement'
          ? { ...f, order: { ...f.order, ruleVersion: 'replaced-rules' } }
          : kind === 'unsupported order'
            ? { ...f, order: { ...f.order, reduceOnly: true } }
            : {
                ...f,
                order: { ...f.order, type: 'MARKET', limitPrice: null, timeInForce: null },
                record: { ...f.record, rules: { ...f.record.rules, maxPrice: null } },
              };
    expect(() => calculatePaperReservationCoverage(raw)).toThrow('PAPER_COVERAGE_EVIDENCE');
  },
);
it.each(['tenantId', 'accountId', 'credentials', 'endpointUrl', 'grant', 'reservationId', 'mode'])(
  'rejects untrusted %s without disclosure',
  (key) => {
    try {
      calculatePaperReservationCoverage({ ...input(), [key]: 'private-material' });
      expect.fail('must reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('PAPER_COVERAGE_INPUT');
      expect(JSON.stringify(error)).not.toContain('private-material');
      expect((error as Error).cause).toBeUndefined();
    }
  },
);
