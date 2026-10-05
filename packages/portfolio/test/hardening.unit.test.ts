import { expect, it } from 'vitest';
import { createState, reducePortfolio, restorePortfolio } from '../src/accounting.js';
import { binding, snapshot, fill, context } from './fixtures.js';
const fresh = () => reducePortfolio(createState(binding()), snapshot(), context).state;
it('rejects older economic input before order-dependent cost basis can change', () => {
  const s = reducePortfolio(fresh(), fill(), context).state;
  expect(() =>
    reducePortfolio(s, fill({ id: 'late', timestamp: 999, price: '200' }), context),
  ).toThrow('OUT_OF_ORDER_ECONOMIC');
});
it('rejects inconsistent free+locked snapshots and invalid available components', () => {
  expect(() =>
    reducePortfolio(
      createState(binding()),
      snapshot({
        balances: [{ asset: 'USDT', total: '1000', free: '900', locked: '0', available: '900' }],
      }),
      context,
    ),
  ).toThrow('BALANCE_COMPONENTS');
});
it('does not weaken UNKNOWN by an unproven commitment replacement', () => {
  const initial = reducePortfolio(
    fresh(),
    {
      type: 'COMMITMENT',
      id: 'h1',
      timestamp: 1000,
      hold: { id: 'intent', asset: 'USDT', amount: '10', status: 'UNKNOWN', reflected: false },
    },
    { ...context, holdWatermark: null },
  );
  expect(() =>
    reducePortfolio(
      initial.state,
      {
        type: 'COMMITMENT',
        id: 'h2',
        timestamp: 1001,
        hold: { id: 'intent', asset: 'USDT', amount: '0', status: 'RESERVED', reflected: true },
      },
      { now: () => 1001, holdWatermark: initial.holdWatermark! },
    ),
  ).toThrow('UNKNOWN_COMMITMENT');
});
it('bounds pending identities and rejects impossible checkpoint structure', () => {
  const s = fresh();
  s.pending = Array.from({ length: 2000 }, (_, i) => `e${i}`);
  expect(() => reducePortfolio(s, fill(), context)).toThrow();
  const corrupt = reducePortfolio(fresh(), fill(), context).state;
  corrupt.positions[0]!.quantity = '0';
  expect(() => restorePortfolio(corrupt)).toThrow('CORRUPT_POSITION');
});
