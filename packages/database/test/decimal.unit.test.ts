import { describe, expect, it } from 'vitest';
import { decimalText, type DecimalKind } from '../src/decimal.js';

describe('decimal storage boundary', () => {
  it.each(['0', '0.000000000000000001', '99999999999999999999.999999999999999999'])(
    'preserves %s exactly',
    (value) => {
      expect(decimalText(value, 'price')).toBe(value);
    },
  );
  it('normalizes without binary arithmetic or rounding', () => {
    expect(decimalText('-12.3400', 'amount')).toBe('-12.34');
    expect(decimalText('-0.000', 'amount')).toBe('0');
    expect(decimalText('999999999999999999999999999999.1', 'aggregate')).toBe(
      '999999999999999999999999999999.1',
    );
  });
  it.each([
    1.1,
    NaN,
    Infinity,
    null,
    {},
    '',
    ' 1',
    '1 ',
    '+1',
    '01',
    '.1',
    '1.',
    '1e2',
    'NaN',
    'Infinity',
    '0'.repeat(10000),
  ])('rejects noncanonical or non-string input %#', (value) => {
    expect(() => decimalText(value, 'price')).toThrow(TypeError);
  });
  it.each(['100000000000000000000', '0.0000000000000000001'])(
    'rejects overflow/rounding for %s',
    (value) => {
      expect(() => decimalText(value, 'quantity')).toThrow(RangeError);
    },
  );
  it('uses an explicit separate bound for rates', () => {
    expect(decimalText('99.999999999999999999', 'rate')).toBe('99.999999999999999999');
    expect(() => decimalText('100', 'rate')).toThrow(RangeError);
  });
  it.each(['1\n', '1\r', '1\u2028', '1\u2029'])('rejects trailing line terminators %#', (value) => {
    expect(() => decimalText(value, 'price')).toThrow(TypeError);
  });
  it.each(['unknown', '__proto__', 'constructor'])('rejects unsupported category %s', (kind) => {
    expect(() => decimalText('100000000000000000000', kind as DecimalKind)).toThrow(TypeError);
  });
});
