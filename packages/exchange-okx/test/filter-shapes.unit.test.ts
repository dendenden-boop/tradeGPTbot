import { describe, expect, it } from 'vitest';
import { normalizeInstrument } from '../src/public-data.js';
import { nativeInstrument, scope, now } from './fixtures.js';
describe('known OKX constraint fields cannot accept a new nested shape', () => {
  it.each(['lever', 'futureSettlement', 'category'])(
    'nested %s constraint stays unsupported',
    (key) => {
      expect(
        normalizeInstrument(
          { ...nativeInstrument(), [key]: { futureLimit: '1' } },
          scope,
          now,
          'shape',
        ).admission.unsupportedConstraints,
      ).toContain(key);
    },
  );
  it('unknown member of known currency list cannot silently pass admission', () => {
    expect(
      normalizeInstrument(
        { ...nativeInstrument(), tradeQuoteCcyList: ['USDT', { futureLimit: '1' }] },
        scope,
        now,
        'shape',
      ).admission.unsupportedConstraints,
    ).toContain('tradeQuoteCcyList');
  });
});
