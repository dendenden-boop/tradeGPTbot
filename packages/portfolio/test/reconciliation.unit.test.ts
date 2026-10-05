import { expect, it } from 'vitest';
import { createState, reducePortfolio } from '../src/accounting.js';
import { binding, snapshot, fill, context } from './fixtures.js';
import type { SnapshotEvent } from '../src/domain.js';
it('posts the initial imported native balances against external counteraccounts', () => {
  const r = reducePortfolio(createState(binding()), snapshot(), context);
  expect(r.postings.find((p) => p.asset === 'USDT' && p.bucket === 'AVAILABLE')?.amount).toBe(
    '1000',
  );
  expect(r.postings.find((p) => p.asset === 'USDT' && p.bucket === 'EXTERNAL')?.amount).toBe(
    '-1000',
  );
});
it('preserves unexplained balance differences across repeated snapshots without inventing PnL', () => {
  let s = reducePortfolio(createState(binding()), snapshot(), context).state;
  const changed = snapshot({
    id: 'snap2',
    timestamp: 1000,
    balances: s.balances.map((b) =>
      b.asset === 'USDT' ? { ...b, total: '1100', free: '1100', available: '1100' } : b,
    ),
  });
  const r = reducePortfolio(s, changed, context);
  s = r.state;
  expect(s.status).toBe('UNRECONCILED');
  expect(r.postings.find((p) => p.asset === 'USDT' && p.bucket === 'AVAILABLE')?.amount).toBe(
    '100',
  );
  s = reducePortfolio(s, { ...changed, id: 'snap3' }, context).state;
  expect(s.status).toBe('UNRECONCILED');
});
it('explicit acknowledged reconciliation rebase restores quantity while preserving unknown historical PnL', () => {
  let s = reducePortfolio(createState(binding()), snapshot(), context).state;
  s = reducePortfolio(s, fill(), context).state;
  const changed = snapshot({
    id: 'snap2',
    timestamp: 1000,
    covered: ['f1'],
    balances: [
      { asset: 'BTC', total: '2', free: '2', locked: '0', available: '2' },
      { asset: 'USDT', total: '800', free: '800', locked: '0', available: '800' },
      { asset: 'BNB', total: '1', free: '1', locked: '0', available: '1' },
    ],
    positions: [
      {
        instrumentId: 'BTCUSDT',
        positionSide: 'NET',
        bucket: 'CROSS',
        base: 'BTC',
        quote: 'USDT',
        quantity: '2',
        entryPrice: '100',
      },
    ],
  });
  s = reducePortfolio(s, changed, context).state;
  expect(s.status).toBe('UNRECONCILED');
  const repair = { ...changed, id: 'repair', covered: [], repairFrom: 'snap2' } as SnapshotEvent;
  s = reducePortfolio(s, repair, context).state;
  expect(s.status).toBe('RECONCILED');
  expect(s.positions[0]?.quantity).toBe('2');
  expect(s.positions[0]?.basis).toBe('200');
  expect(s.positions[0]?.realizedGross).toBeNull();
});
