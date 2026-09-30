import { describe, expect, it } from 'vitest';
import { normalizeExchangeTime } from '../src/time.js';

describe('explicit exchange timestamp units', () => {
  it.each([
    ['SECONDS', '1800000000'],
    ['MILLISECONDS', '1800000000000'],
    ['MICROSECONDS', '1800000000000000'],
    ['NANOSECONDS', '1800000000000000000'],
  ] as const)('converts %s without guessing units or losing large integers', (unit, value) => {
    expect(normalizeExchangeTime(value, unit)).toEqual({
      milliseconds: 1_800_000_000_000,
      discardedSubMillisecond: false,
    });
  });
  it('rejects loss unless explicitly permitted and marks truncation', () => {
    expect(() => normalizeExchangeTime('1800000000000000001', 'NANOSECONDS')).toThrow(
      'EXCHANGE_TIME_PRECISION_LOSS',
    );
    expect(normalizeExchangeTime('1800000000000000001', 'NANOSECONDS', 'TRUNCATE')).toEqual({
      milliseconds: 1_800_000_000_000,
      discardedSubMillisecond: true,
    });
  });
  it.each([
    NaN,
    Infinity,
    -0,
    -1,
    1.5,
    1800000000000000000,
    '01',
    '-0',
    '1.0',
    '1e3',
    '1\n',
    ' 1',
    null,
    {},
    '9'.repeat(23),
  ])('rejects unsafe or malformed time input', (value) => {
    expect(() => normalizeExchangeTime(value, 'NANOSECONDS')).toThrow('INVALID_EXCHANGE_TIME');
  });
  it('checks the Date/safe integer range after scaling', () => {
    expect(normalizeExchangeTime('8640000000000000', 'MILLISECONDS').milliseconds).toBe(
      8_640_000_000_000_000,
    );
    expect(() => normalizeExchangeTime('8640000000000001', 'MILLISECONDS')).toThrow(
      'INVALID_EXCHANGE_TIME',
    );
    expect(() => normalizeExchangeTime('8640000000001', 'SECONDS')).toThrow(
      'INVALID_EXCHANGE_TIME',
    );
  });
});
