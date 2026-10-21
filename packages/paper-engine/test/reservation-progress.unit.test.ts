import { Decimal } from 'decimal.js';
import { expect, it } from 'vitest';
import { newOrderSchema } from '@ctp/exchange-core';
import * as paper from '../src/index.js';
import type { PaperFillCalculation, PaperRiskEnvelopeCalculation } from '../src/index.js';
import { fixture } from './fixtures.js';

const D = Decimal.clone({ precision: 120 });
type Result = {
  kind: string;
  version: string;
  envelope: PaperRiskEnvelopeCalculation;
  filledQuantity: string;
  remainingQuantity: string;
  fillIds: readonly string[];
  debits: readonly {
    asset: string;
    original: string;
    spent: string;
    remaining: string;
    surplus: string;
  }[];
};
function calculate(raw: unknown): Result {
  const fn = (paper as unknown as Record<string, unknown>)['calculatePaperReservationProgress'];
  expect(fn, 'PAPER_RESERVATION_PROGRESS_MISSING').toBeTypeOf('function');
  return (fn as (value: unknown) => Result)(raw);
}
function input(side: 'BUY' | 'SELL' = 'BUY', fee = '0.001') {
  const { execution, ...market } = fixture();
  const original = {
    ...market,
    model: { ...market.model, participationRate: '1', takerFeeRate: fee },
    order: newOrderSchema.parse({
      ...execution.order,
      side,
      limitPrice: side === 'BUY' ? '10.5' : '9.5',
    }),
    book: {
      ...market.book,
      asks: Array.from({ length: 10 }, (_, i) => ({
        price: new D('10.05').add(new D('0.05').mul(i)).toFixed(),
        quantity: '0.05',
      })),
      bids: Array.from({ length: 10 }, (_, i) => ({
        price: new D('9.95').sub(new D('0.05').mul(i)).toFixed(),
        quantity: '0.05',
      })),
    },
    trade: { ...market.trade, quantity: '0.5' },
  };
  return { original, fills: [] as PaperFillCalculation[] };
}
function executed(x: ReturnType<typeof input>) {
  const { order, ...market } = x.original;
  const result = paper.evaluatePaperOrder({
    ...fixture().execution,
    order,
    frame: paper.preparePaperFrame(market),
  });
  expect(result.status).toBe('FILLED');
  expect(result.fills).toHaveLength(10);
  return result.fills.map((fill) => ({ ...fill }));
}
function changedFill(side: 'BUY' | 'SELL', quantity: string, price: string, feeRate = '0.001') {
  const notional = new D(quantity).mul(price),
    fee = notional.mul(feeRate).toDecimalPlaces(18, Decimal.ROUND_CEIL);
  return {
    id: 'paper-' + 'a'.repeat(64),
    quantity,
    price,
    quoteNotional: notional.toFixed(),
    quoteFee: fee.toFixed(),
    baseDelta: side === 'BUY' ? quantity : new D(quantity).neg().toFixed(),
    quoteDelta: side === 'BUY' ? notional.add(fee).neg().toFixed() : notional.sub(fee).toFixed(),
  };
}

it('empty progress retains the complete initial positive debit vector', () => {
  const x = input(),
    r = calculate(x);
  expect(r).toMatchObject({
    kind: 'PAPER_RESERVATION_PROGRESS_CALCULATION',
    version: 'spot-l2-taker-remaining-v1',
    filledQuantity: '0',
    remainingQuantity: '0.5',
    fillIds: [],
    debits: [
      { asset: 'USDT', original: '5.25525', spent: '0', remaining: '5.25525', surplus: '0' },
    ],
  });
  expect(r.envelope).toEqual(paper.calculatePaperRiskEnvelope(x.original));
});
it('partial BUY separates posted-cost arithmetic, future liability and mathematical surplus', () => {
  const x = input();
  x.fills = executed(x).slice(0, 4);
  expect(calculate(x)).toMatchObject({
    filledQuantity: '0.2',
    remainingQuantity: '0.3',
    debits: [
      {
        asset: 'USDT',
        original: '5.25525',
        spent: '2.027025',
        remaining: '3.15315',
        surplus: '0.075075',
      },
    ],
  });
});
it('partial SELL never nets anticipated proceeds against base principal or quote fees', () => {
  const x = input('SELL');
  x.fills = executed(x).slice(0, 4);
  expect(calculate(x).debits).toEqual([
    { asset: 'BTC', original: '0.5', spent: '0.2', remaining: '0.3', surplus: '0' },
    { asset: 'USDT', original: '0.5', spent: '0.001975', remaining: '0.3', surplus: '0.198025' },
  ]);
});
it('per-fill quote ceilings and remaining per-lot fee bounds retain the final atom', () => {
  const x = input('BUY', '0.000000000000000001');
  x.fills = executed(x).slice(0, 4);
  expect(calculate(x).debits).toEqual([
    {
      asset: 'USDT',
      original: '5.25000000000000001',
      spent: '2.025000000000000004',
      remaining: '3.150000000000000006',
      surplus: '0.075',
    },
  ]);
});
it('a remaining lot below initial minQuantity is retained without re-admitting a new order', () => {
  const x = input();
  x.fills = executed(x).slice(0, 9);
  expect(calculate(x)).toMatchObject({
    remainingQuantity: '0.05',
    debits: [{ remaining: '0.525525' }],
  });
});
it('global Decimal precision cannot alter exact fill arithmetic or bounds', () => {
  const x = input('BUY', '0.000000000000000001');
  x.fills = executed(x).slice(0, 4);
  const expected = calculate(x),
    precision = Decimal.precision,
    rounding = Decimal.rounding;
  try {
    Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN });
    expect(calculate(x)).toEqual(expected);
  } finally {
    Decimal.set({ precision, rounding });
  }
});
it.each(['BUY', 'SELL'] as const)(
  'full %s progress has zero future arithmetic liability without producing terminal authority',
  (side) => {
    const x = input(side);
    x.fills = executed(x);
    const r = calculate(x);
    expect(r.remainingQuantity).toBe('0');
    expect(r.debits.every((d) => d.remaining === '0')).toBe(true);
    for (const field of [
      'released',
      'resolved',
      'status',
      'terminal',
      'grant',
      'certificate',
      'reservationId',
      'holdId',
      'proofId',
      'permit',
    ])
      expect(r).not.toHaveProperty(field);
  },
);
it('zero-fee SELL needs no artificial quote debit', () => {
  const x = input('SELL', '0');
  x.fills = executed(x).slice(0, 4);
  expect(calculate(x).debits).toEqual([
    { asset: 'BTC', original: '0.5', spent: '0.2', remaining: '0.3', surplus: '0' },
  ]);
});
it('identical permanent fill replay is idempotent, not a second monetary debit', () => {
  const x = input();
  x.fills = executed(x).slice(0, 4);
  expect(calculate({ ...x, fills: [...x.fills, ...structuredClone(x.fills)] })).toEqual(
    calculate(x),
  );
});
it('conflicting semantics for one fill identity reject the entire calculation', () => {
  const x = input(),
    first = executed(x)[0]!;
  expect(() =>
    calculate({ ...x, fills: [first, { ...changedFill('BUY', '0.1', '10.05'), id: first.id }] }),
  ).toThrow('PAPER_PROGRESS_CONFLICT');
});
it('a set of fills has deterministic identity ordering independent of arrival order', () => {
  const x = input();
  x.fills = executed(x).slice(0, 4);
  expect(calculate({ ...x, fills: [...x.fills].reverse() })).toEqual(calculate(x));
});
it('historical JSON roundtrip neither renews original freshness nor mutates inputs', () => {
  const x = input();
  x.fills = executed(x).slice(0, 4);
  const before = JSON.stringify(x),
    r = calculate(x);
  expect(calculate(JSON.parse(before))).toEqual(r);
  expect(JSON.stringify(x)).toBe(before);
  expect(r.envelope.computedAt).toBe(x.original.now);
  expect(r.envelope.validUntil).toBe(x.original.now + 5001);
  expect(Object.isFrozen(r)).toBe(true);
  expect(Object.isFrozen(r.debits[0])).toBe(true);
  expect(Object.isFrozen(r.envelope.record.rules)).toBe(true);
});
it('large original lot count stays lossless without iteration proportional to lots', () => {
  const x = input();
  x.original.order = newOrderSchema.parse({
    ...x.original.order,
    size: { ...x.original.order.size, value: '9007199254740993.05' },
  });
  x.original.record.rules = { ...x.original.record.rules, maxQuantity: null, maxNotional: null };
  x.fills = executed(input()).slice(0, 1);
  const r = calculate(x);
  expect(r.remainingQuantity).toBe('9007199254740993');
  expect(r.envelope.maxFillCount).toBe('180143985094819861');
});
it('rejects over-capacity history before deduplication', () => {
  const x = input(),
    first = executed(x)[0]!;
  expect(() => calculate({ ...x, fills: Array.from({ length: 1001 }, () => first) })).toThrow(
    'PAPER_PROGRESS_INPUT',
  );
});
it('accepts the bounded 1000-entry history without counting replayed fills twice', () => {
  const x = input(),
    first = executed(x)[0]!;
  expect(calculate({ ...x, fills: Array.from({ length: 1000 }, () => first) }).filledQuantity).toBe(
    '0.05',
  );
});
it.each(['UNKNOWN', 'RELEASED', 'CANCELLED', 'FILLED'])(
  'caller status %s cannot supply lifecycle authority',
  (status) => {
    expect(() => calculate({ ...input(), status })).toThrow('PAPER_PROGRESS_INPUT');
  },
);
it.each([
  'resolved',
  'terminal',
  'release',
  'certificate',
  'envelope',
  'remaining',
  'balance',
  'now',
  'tenantId',
])('rejects caller authority or result override: %s', (key) => {
  expect(() => calculate({ ...input(), [key]: true })).toThrow('PAPER_PROGRESS_INPUT');
});

const badFill: readonly [string, (fill: PaperFillCalculation) => unknown][] = [
  ['numeric quantity', (f) => ({ ...f, quantity: 0.05 })],
  ['exponent', (f) => ({ ...f, quantity: '5e-2' })],
  ['noncanonical', (f) => ({ ...f, quantity: '0.050' })],
  ['negative zero', (f) => ({ ...f, quoteFee: '-0' })],
  ['zero quantity', (f) => ({ ...f, quantity: '0' })],
  ['zero price', (f) => ({ ...f, price: '0' })],
  ['non-model identity', (f) => ({ ...f, id: 'fill-1' })],
  ['additional field', (f) => ({ ...f, resolved: true })],
  ['wrong notional', (f) => ({ ...f, quoteNotional: '0.5' })],
  ['underpaid commission', (f) => ({ ...f, quoteFee: '0' })],
  ['overpaid commission', (f) => ({ ...f, quoteFee: '1' })],
  ['wrong base sign', (f) => ({ ...f, baseDelta: '-0.05' })],
  ['wrong quote sign', (f) => ({ ...f, quoteDelta: '0.5030025' })],
];
it.each(badFill)('rejects inconsistent fill economics: %s', (_name, change) => {
  const x = input();
  expect(() => calculate({ ...x, fills: [change(executed(x)[0]!)] })).toThrow(
    /PAPER_PROGRESS_(?:INPUT|FILL)/,
  );
});
it.each([
  ['BUY', '0.05', '11'],
  ['SELL', '0.05', '9'],
  ['BUY', '0.01', '10'],
  ['BUY', '0.05', '10.01'],
  ['BUY', '0.55', '10'],
] as const)('rejects out-of-envelope or excessive progress %s q=%s price=%s', (side, q, p) => {
  expect(() => calculate({ ...input(side), fills: [changedFill(side, q, p)] })).toThrow(
    'PAPER_PROGRESS_FILL',
  );
});
it('rejects stale original evidence rather than creating a replacement bound', () => {
  const x = input();
  x.original.book.receivedAt -= 5001;
  expect(() => calculate(x)).toThrow('PAPER_PROGRESS_EVIDENCE');
});
it('rejects replaced original command rules rather than validating against a new envelope', () => {
  const x = input();
  x.original.record.rules = { ...x.original.record.rules, version: 'rules-v2' };
  expect(() => calculate(x)).toThrow('PAPER_PROGRESS_EVIDENCE');
});

const scenarios = (['BUY', 'SELL'] as const).flatMap((side) =>
  (['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT'] as const).flatMap((type) =>
    ['0', '0.001', '0.000000000000000001', '0.1'].map((fee) => ({ side, type, fee })),
  ),
);
it.each(scenarios)(
  'conserves the original vector across every actual fill prefix: $side $type $fee',
  ({ side, type, fee }) => {
    const x = input(side, fee);
    x.original.order = newOrderSchema.parse({
      ...x.original.order,
      type,
      limitPrice: type.endsWith('LIMIT') ? (side === 'BUY' ? '10.5' : '9.5') : null,
      timeInForce: type.endsWith('LIMIT') ? 'GTC' : null,
      trigger: type.startsWith('STOP_') ? { source: 'LAST', price: '10' } : null,
    });
    const fills = executed(x);
    let previous = calculate(x);
    for (let i = 1; i <= fills.length; i++) {
      const r = calculate({ ...x, fills: fills.slice(0, i) });
      for (const d of r.debits) {
        expect(new D(d.spent).add(d.remaining).add(d.surplus).eq(d.original)).toBe(true);
        const p = previous.debits.find((v) => v.asset === d.asset)!;
        expect(new D(d.spent).gte(p.spent)).toBe(true);
        expect(new D(d.remaining).lte(p.remaining)).toBe(true);
        expect(new D(d.surplus).gte(p.surplus)).toBe(true);
        const future = fills
          .slice(i)
          .reduce(
            (sum, f) =>
              sum.add(
                d.asset === x.original.record.instrument.baseAsset
                  ? f.quantity
                  : side === 'BUY'
                    ? new D(f.quoteNotional).add(f.quoteFee)
                    : f.quoteFee,
              ),
            new D(0),
          );
        expect(future.lte(d.remaining)).toBe(true);
      }
      previous = r;
    }
    expect(previous.remainingQuantity).toBe('0');
  },
);
