import { expect, it } from 'vitest';
import { harness } from '../../exchange-htx/test/harness.js';
import { normalizeWallet } from '../../exchange-htx/src/private-data.js';
import { account, now } from '../../exchange-htx/test/fixtures.js';
import { binding, snapshot } from './fixtures.js';
import { createState, reducePortfolio } from '../src/accounting.js';
import { valuePortfolio } from '../src/valuation.js';
const native = {
  margin_mode: 'cross',
  margin_account: 'USDT',
  margin_asset: 'USDT',
  position_mode: 'dual_side',
  margin_static: '100',
  margin_balance: '110',
  profit_unreal: '10',
};
it('imports a native snapshot position without leaking observation-only entryPrice into state', () => {
  expect(() =>
    reducePortfolio(
      createState(binding('LINEAR_PERPETUAL')),
      snapshot({
        positions: [
          {
            instrumentId: 'BTCUSDT',
            positionSide: 'LONG',
            bucket: 'CROSS',
            base: 'BTC',
            quote: 'USDT',
            quantity: '1',
            entryPrice: '100',
          },
        ],
      }),
      { now: () => now },
    ),
  ).not.toThrow();
});
it('HTX adapter → Portfolio adds derivative unrealized PnL exactly once', async () => {
  const x = harness('htx-linear-live-v1');
  try {
    await x.warm();
    x.state.route = (r) =>
      r.url.pathname.endsWith('swap_cross_account_info') ? x.response([native]) : x.native(r);
    const result = await x.adapter.getBalances({}, x.context());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    const b = { ...binding('LINEAR_PERPETUAL'), mode: 'LIVE' as const, scope: result.value.scope };
    const state = reducePortfolio(
      createState(b),
      snapshot({
        timestamp: now,
        balances: result.value.balances.map((v) => ({
          asset: v.asset,
          total: v.total,
          free: v.free,
          locked: v.locked,
          available: null,
        })),
        positions: [
          {
            instrumentId: 'BTC-USDT',
            positionSide: 'LONG',
            bucket: 'CROSS',
            base: 'BTC',
            quote: 'USDT',
            quantity: '1',
            entryPrice: '100',
          },
        ],
      }),
      { now: () => now },
    ).state;
    expect(
      valuePortfolio(
        [state],
        [
          {
            asset: 'BTC',
            quote: 'USDT',
            price: '110',
            kind: 'MARK',
            asOf: now,
            sourceId: 'htx-mark',
            fresh: true,
            scope: b.scope,
            instrumentId: 'BTC-USDT',
          },
        ],
        { quote: 'USDT', now, reconciledAfterRestart: true },
      ).total,
    ).toBe('110');
  } finally {
    await x.adapter.disconnect();
  }
});
it.each(['margin_static', 'margin_balance', 'profit_unreal'])(
  'rejects missing HTX native %s instead of guessing static cash',
  (field) => {
    const raw: Record<string, unknown> = { ...native };
    delete raw[field];
    expect(() =>
      normalizeWallet(
        [raw],
        account,
        { exchange: 'HTX', region: 'global', environment: 'LIVE', market: 'LINEAR_PERPETUAL' },
        now,
        now,
      ),
    ).toThrow();
  },
);
it('rejects inconsistent HTX equity and stale static evidence', () => {
  const scope = {
    exchange: 'HTX' as const,
    region: 'global',
    environment: 'LIVE' as const,
    market: 'LINEAR_PERPETUAL' as const,
  };
  expect(() =>
    normalizeWallet([{ ...native, margin_balance: '120' }], account, scope, now, now),
  ).toThrow();
  expect(() => normalizeWallet([native], account, scope, now - 6000, now)).toThrow();
});
