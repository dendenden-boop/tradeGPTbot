import { expect, it } from 'vitest';
import { createState, reducePortfolio } from '../src/accounting.js';
import { valuePortfolio } from '../src/valuation.js';
import { binding, fill, snapshot, context } from './fixtures.js';
const anchor = () => reducePortfolio(createState(binding()), snapshot(), context).state;
it('compares total spot inventory across quoted cost-basis lots', () => {
  let s = reducePortfolio(anchor(), fill(), context).state;
  s = reducePortfolio(s, fill({ id: 'f2', instrumentId: 'BTCUSDC', quote: 'USDC' }), context).state;
  const positions = s.positions.map((p) => ({
    instrumentId: p.instrumentId,
    positionSide: p.positionSide,
    bucket: p.bucket,
    base: p.base,
    quote: p.quote,
    quantity: p.quantity,
    entryPrice: '100',
  }));
  const snap = snapshot({
    id: 'snap2',
    timestamp: 1000,
    covered: ['f1', 'f2'],
    balances: [
      { asset: 'BTC', total: '2', free: '2', locked: '0', available: '2' },
      { asset: 'USDT', total: '900', free: '900', locked: '0', available: '900' },
      { asset: 'USDC', total: '-100', free: null, locked: null, available: null },
      { asset: 'BNB', total: '1', free: '1', locked: '0', available: '1' },
    ],
    positions,
  });
  expect(reducePortfolio(s, snap, context).state.status).toBe('RECONCILED');
});
it('does not use a different exchange MARK as derivative valuation evidence', () => {
  const s = reducePortfolio(
    reducePortfolio(createState(binding('LINEAR_PERPETUAL')), snapshot(), context).state,
    fill(),
    context,
  ).state;
  const prices = [
    {
      asset: 'BTC',
      quote: 'USDT',
      price: '120',
      kind: 'MARK' as const,
      asOf: 1000,
      sourceId: 'wrong-mark',
      fresh: true,
      scope: { ...s.binding.scope, exchange: 'OKX' as const },
      instrumentId: 'BTCUSDT',
    },
    {
      asset: 'BNB',
      quote: 'USDT',
      price: '10',
      kind: 'LAST' as const,
      asOf: 1000,
      sourceId: 'bnb',
      fresh: true,
    },
  ];
  expect(
    valuePortfolio([s], prices, { quote: 'USDT', now: 1000, reconciledAfterRestart: true })
      .accounts[0]?.positions[0]?.unrealizedGross,
  ).toBeNull();
});
it('rejects future fee FX provenance rather than accepting unavailable historical evidence', () => {
  expect(() =>
    reducePortfolio(
      anchor(),
      fill({
        fees: [
          {
            asset: 'BNB',
            amount: '0.01',
            quoteEquivalent: '1',
            fx: { rate: '100', asOf: 2000, sourceId: 'future' },
          },
        ],
      }),
      context,
    ),
  ).toThrow('UNPROVEN_FEE_CONVERSION');
});
it('requires scoped native instrument evidence for MARK prices', () => {
  const s = reducePortfolio(
    reducePortfolio(createState(binding('LINEAR_PERPETUAL')), snapshot(), context).state,
    fill(),
    context,
  ).state;
  const prices = [
    {
      asset: 'BTC',
      quote: 'USDT',
      price: '120',
      kind: 'MARK' as const,
      asOf: 1000,
      sourceId: 'unscoped-mark',
      fresh: true,
    },
  ];
  expect(
    valuePortfolio([s], prices, { quote: 'USDT', now: 1000, reconciledAfterRestart: true })
      .accounts[0]?.positions[0]?.unrealizedGross,
  ).toBeNull();
});
