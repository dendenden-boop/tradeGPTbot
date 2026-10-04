import { describe, expect, it } from 'vitest';
import { normalizeInstrument, normalizeBook, normalizeCandle } from '../src/public-data.js';
import { getHtxProfile } from '../src/profiles.js';
import { now, spot, swap } from './fixtures.js';
describe('HTX current native observations and conservative guards', () => {
  it('validates the entire native book before returning a requested prefix', () => {
    const r = normalizeInstrument(
      spot,
      getHtxProfile('htx-spot-live-v1').scope,
      now,
      'guard',
    ).record;
    expect(() =>
      normalizeBook(
        {
          ts: now,
          bids: [
            ['50000', '1'],
            ['50001', '2'],
          ],
          asks: [['50002', '1']],
        },
        r,
        1,
        now,
      ),
    ).toThrow();
  });
  it('derivative candle quote turnover is observed without confusing native contract vol', () => {
    const r = normalizeInstrument(
      swap,
      getHtxProfile('htx-linear-live-v1').scope,
      now,
      'guard',
    ).record;
    expect(
      normalizeCandle(
        {
          id: now / 1000,
          open: '50000',
          high: '50001',
          low: '49999',
          close: '50000',
          amount: '0.002',
          vol: '2',
          trade_turnover: '100',
          count: 1,
        },
        r,
        '1m',
        now,
      ),
    ).toMatchObject({ baseVolume: '0.002', quoteVolume: { state: 'AVAILABLE', value: '100' } });
  });
  it.each([
    { mbph: 1, mspl: 1 },
    { futureConstraint: { limit: '1' } },
    { futureConstraint: ['1'] },
  ])('new native Spot constraints never become supported automatically %j', (extra) => {
    const n = normalizeInstrument(
      { ...spot, ...extra },
      getHtxProfile('htx-spot-live-v1').scope,
      now,
      'guard',
    );
    expect(n.admission.newRiskSupported).toBe(false);
    expect(n.admission.unsupportedFields.length).toBeGreaterThan(0);
  });
  it('current derivative unproved schedule/mode fields keep admission closed', () => {
    const n = normalizeInstrument(
      {
        ...swap,
        adjust: [],
        price_estimated: [],
        open_type: 0,
        settlement_period: '8',
        enable_rpi: true,
        trade_partition: 'USDT',
      },
      getHtxProfile('htx-linear-live-v1').scope,
      now,
      'guard',
    );
    expect(n.admission.newRiskSupported).toBe(false);
    expect(n.admission.unsupportedFields).toContain('adjust');
  });
});
