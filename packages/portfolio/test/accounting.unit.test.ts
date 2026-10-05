import { describe, expect, it } from 'vitest';
import { createState, reducePortfolio, positionKey } from '../src/accounting.js';
import type { PortfolioEvent } from '../src/domain.js';
import { binding, fill, snapshot, context } from './fixtures.js';

function anchored(market: 'SPOT' | 'LINEAR_PERPETUAL' = 'SPOT') {
  const b = binding(market);
  return reducePortfolio(createState(b), snapshot(), context).state;
}
function apply(state: ReturnType<typeof anchored>, event: PortfolioEvent) {
  return reducePortfolio(state, event, context);
}
describe('portfolio decimal accounting contracts', () => {
  it('moves spot principal and conserves every posting asset', () => {
    const result = apply(anchored(), fill());
    expect(result.state.balances.find((b) => b.asset === 'USDT')?.total).toBe('900');
    expect(result.state.balances.find((b) => b.asset === 'BTC')?.total).toBe('1');
    for (const asset of new Set(result.postings.map((p) => p.asset)))
      expect(
        result.postings.filter((p) => p.asset === asset).reduce((n, p) => n + Number(p.amount), 0),
      ).toBe(0);
  });
  it('weights basis and realizes partial closes without double-counting fees', () => {
    let s = apply(anchored(), fill()).state;
    s = apply(s, fill({ id: 'f2', price: '200' })).state;
    const r = apply(
      s,
      fill({
        id: 'f3',
        side: 'SELL',
        quantity: '1',
        price: '180',
        fees: [{ asset: 'USDT', amount: '2', quoteEquivalent: '2' }],
      }),
    );
    const p = r.state.positions[0]!;
    expect(p.quantity).toBe('1');
    expect(p.basis).toBe('150');
    expect(p.realizedGross).toBe('30');
    expect(p.feesQuote).toBe('2');
  });
  it('handles signed linear shorts, partial cover and NET flips without principal cash', () => {
    let s = apply(anchored('LINEAR_PERPETUAL'), fill({ side: 'SELL' })).state;
    expect(s.balances.find((b) => b.asset === 'USDT')?.total).toBe('1000');
    s = apply(s, fill({ id: 'f2', side: 'BUY', price: '80', quantity: '2' })).state;
    expect(s.positions[0]?.quantity).toBe('1');
    expect(s.positions[0]?.basis).toBe('80');
    expect(s.positions[0]?.realizedGross).toBe('20');
    expect(s.balances.find((b) => b.asset === 'USDT')?.total).toBe('1020');
  });
  it('does not reverse hedge buckets or create short spot inventory', () => {
    expect(() => apply(anchored(), fill({ side: 'SELL' }))).toThrow('POSITION_DIRECTION');
    const s = apply(anchored('LINEAR_PERPETUAL'), fill({ positionSide: 'LONG' })).state;
    expect(() =>
      apply(s, fill({ id: 'f2', positionSide: 'LONG', side: 'SELL', quantity: '2' })),
    ).toThrow('POSITION_DIRECTION');
  });
  it('consumes all rounded remaining basis on final close', () => {
    let s = apply(anchored(), fill({ quantity: '3', price: '0.333333333333333333' })).state;
    for (let i = 0; i < 3; i++)
      s = apply(s, fill({ id: `c${i}`, side: 'SELL', quantity: '1', price: '1' })).state;
    expect(s.positions[0]?.basis).toBe('0');
    expect(s.positions[0]?.realizedGross).toBe('2.000000000000000001');
  });
  it('base fees adjust inventory basis while fee expense stays separately visible', () => {
    const s = apply(
      anchored(),
      fill({ fees: [{ asset: 'BTC', amount: '0.01', quoteEquivalent: '1' }] }),
    ).state;
    expect(s.positions[0]?.quantity).toBe('0.99');
    expect(s.positions[0]?.basis).toBe('99');
    expect(s.positions[0]?.feesQuote).toBe('1');
    expect(s.balances.find((b) => b.asset === 'BTC')?.total).toBe('0.99');
  });
  it('unknown fee conversion stays unknown and rebate is signed income', () => {
    const s = apply(
      anchored(),
      fill({ fees: [{ asset: 'BNB', amount: '0.01', quoteEquivalent: null }] }),
    ).state;
    expect(s.positions[0]?.feesQuote).toBeNull();
    const rebate = apply(
      anchored(),
      fill({ fees: [{ asset: 'USDT', amount: '-1', quoteEquivalent: '-1' }] }),
    ).state;
    expect(rebate.positions[0]?.feesQuote).toBe('-1');
  });
  it('funding is settlement cash and separately accumulated', () => {
    const s = apply(anchored('LINEAR_PERPETUAL'), fill()).state;
    const p = s.positions[0]!;
    const r = apply(s, {
      type: 'FUNDING',
      native: { fundingId: 'funding1', identityScope: 'funding-history' },
      id: 'funding1',
      timestamp: 1000,
      positionKey: positionKey(p),
      asset: 'USDT',
      amount: '-2',
    });
    expect(r.state.balances.find((b) => b.asset === 'USDT')?.total).toBe('998');
    expect(r.state.positions[0]?.fundingQuote).toBe('-2');
  });
  it('snapshot coverage reanchors balances once, preserving local basis and PnL', () => {
    const s = apply(anchored(), fill()).state;
    const r = apply(
      s,
      snapshot({
        id: 'snap2',
        timestamp: 1000,
        covered: ['f1'],
        balances: [
          { asset: 'USDT', total: '900', free: '900', locked: '0', available: '900' },
          { asset: 'BTC', total: '1', free: '1', locked: '0', available: '1' },
          { asset: 'BNB', total: '1', free: '1', locked: '0', available: '1' },
        ],
        positions: [
          {
            instrumentId: 'BTCUSDT',
            positionSide: 'NET',
            bucket: 'CROSS',
            quantity: '1',
            entryPrice: '100',
            base: 'BTC',
            quote: 'USDT',
          },
        ],
      }),
    );
    expect(r.state.balances.find((b) => b.asset === 'USDT')?.total).toBe('900');
    expect(r.state.pending).toEqual([]);
    expect(r.state.status).toBe('RECONCILED');
    expect(r.state.positions[0]?.basis).toBe('100');
  });
  it('rejects an unproven snapshot cut and records mismatches without invented profit', () => {
    const s = apply(anchored(), fill()).state;
    expect(() => apply(s, snapshot({ id: 'snap2' }))).toThrow('INCOMPLETE_COVERAGE');
    const r = apply(s, snapshot({ id: 'snap2', timestamp: 1000, covered: ['f1'] }));
    expect(r.state.status).toBe('UNRECONCILED');
    expect(r.state.positions[0]?.quantity).toBe('1');
    expect(r.state.positions[0]?.realizedGross).toBe('0');
  });
  it('retains unknown commitment across snapshots and rejects unproven release', () => {
    const s = apply(anchored(), {
      type: 'COMMITMENT',
      id: 'hold1',
      timestamp: 1000,
      hold: { id: 'intent1', asset: 'USDT', amount: '100', status: 'UNKNOWN', reflected: false },
    }).state;
    const r = apply(s, snapshot({ id: 'snap2' }));
    expect(r.state.holds[0]?.status).toBe('UNKNOWN');
    expect(() =>
      apply(s, {
        type: 'RELEASE',
        id: 'release1',
        timestamp: 1000,
        holdId: 'intent1',
        resolved: false,
      }),
    ).toThrow('UNKNOWN_COMMITMENT');
  });
  it('marks explicit gap and never freshens it with a fill', () => {
    const s = apply(anchored(), { type: 'GAP', id: 'gap1', timestamp: 1000 }).state;
    expect(apply(s, fill()).state.status).toBe('GAP');
  });
});
