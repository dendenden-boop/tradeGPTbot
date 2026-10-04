import { describe, expect, it } from 'vitest';
import { normalizeInstrument } from '../src/public-data.js';
import {
  normalizeWallet,
  normalizeOrder,
  normalizePosition,
  normalizeFill,
} from '../src/private-data.js';
import { getHtxProfile } from '../src/profiles.js';
import { now, spot, swap, account, identity, spotOrder, linearOrder } from './fixtures.js';
describe('HTX private unit and identity boundary', () => {
  const sr = normalizeInstrument(spot, getHtxProfile('htx-spot-live-v1').scope, now, 's').record;
  const dr = normalizeInstrument(swap, getHtxProfile('htx-linear-live-v1').scope, now, 'd').record;
  it('wallet joins unique trade/frozen components exactly; no missing component zero fiction', () => {
    const w = normalizeWallet(
      {
        id: '123',
        type: 'spot',
        state: 'working',
        list: [
          { currency: 'usdt', type: 'trade', balance: '0.100000000000000001' },
          { currency: 'usdt', type: 'frozen', balance: '0.2' },
        ],
      },
      account,
      sr.instrument.scope,
      now,
      now,
      '123',
    );
    expect(w.balances).toEqual([
      {
        asset: 'USDT',
        free: '0.100000000000000001',
        locked: '0.2',
        total: '0.300000000000000001',
        availableToTrade: { state: 'AVAILABLE', value: '0.100000000000000001' },
      },
    ]);
    expect(() =>
      normalizeWallet(
        {
          id: '123',
          type: 'spot',
          state: 'working',
          list: [{ currency: 'usdt', type: 'trade', balance: '1' }],
        },
        account,
        sr.instrument.scope,
        now,
        now,
        '123',
      ),
    ).toThrow();
  });
  it.each([{ id: '124' }, { type: 'margin' }, { state: 'lock' }])(
    'wallet rejects wrong native account %j',
    (fields) => {
      expect(() =>
        normalizeWallet({ ...fields, list: [] }, account, sr.instrument.scope, now, now, '123'),
      ).toThrow();
    },
  );
  it('Spot orders never reinterpret quote-budget market buy as BASE', () => {
    expect(normalizeOrder(spotOrder, sr, account, identity, now, '123')).toMatchObject({
      quantityUnit: 'BASE',
      quantity: '0.01',
      filledQuantity: '0.005',
      averageFillPrice: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      fees: [],
    });
    expect(() =>
      normalizeOrder(
        { ...spotOrder, type: 'buy-market', amount: '500' },
        sr,
        account,
        identity,
        now,
        '123',
      ),
    ).toThrow('UNSUPPORTED');
  });
  it('linear order volume remains CONTRACTS without inventing base quantities', () => {
    expect(normalizeOrder(linearOrder, dr, account, identity, now)).toMatchObject({
      quantityUnit: 'CONTRACTS',
      quantity: '2',
      filledQuantity: '1',
    });
  });
  it.each([
    { margin_mode: 'isolated' },
    { margin_account: 'BTC' },
    { offset: 'both' },
    { order_id_str: 'other' },
    { is_tpsl: 1 },
    { reduce_only: 1 },
    { contract_type: 'quarter' },
  ])('linear ordinary read refuses mismatched mode/ID/algo %j', (fields) => {
    expect(() =>
      normalizeOrder({ ...linearOrder, ...fields }, dr, account, identity, now),
    ).toThrow();
  });
  it('one-way position never silently maps to hedge side', () => {
    const p = {
      ...linearOrder,
      position_mode: 'dual_side',
      volume: '2',
      cost_open: '50000',
      lever_rate: '5',
      profit: '0',
      profit_unreal: '1',
    };
    expect(normalizePosition(p, dr, account, now)).toMatchObject({
      side: 'SHORT',
      quantity: '2',
      quantityUnit: 'CONTRACTS',
      liquidationPrice: { state: 'UNAVAILABLE' },
      marginMode: 'CROSS',
    });
    expect(() =>
      normalizePosition({ ...p, position_mode: 'single_side' }, dr, account, now),
    ).toThrow();
  });
  it('derivative match_id is not unique: include native execution id, preserve charge/rebate signs', () => {
    const f = {
      ...linearOrder,
      id: '12-order1-1',
      match_id: '12',
      trade_volume: '1',
      trade_price: '50000',
      trade_fee: '-0.1',
      fee_asset: 'USDT',
      create_date: now,
    };
    expect(normalizeFill(f, dr, account, identity, now)).toMatchObject({
      fillId: '12.12-order1-1',
      fees: [{ amount: '0.1', kind: 'TRADING' }],
    });
    expect(
      normalizeFill({ ...f, id: '12-order1-2', trade_fee: '0.1' }, dr, account, identity, now),
    ).toMatchObject({ fillId: '12.12-order1-2', fees: [{ amount: '-0.1', kind: 'REBATE' }] });
  });
});
