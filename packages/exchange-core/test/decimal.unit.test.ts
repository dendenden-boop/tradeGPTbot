import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  amountDecimalSchema,
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  decimalSchema,
  decimalSubtract,
  isStepAligned,
  nonNegativeAmountSchema,
  nonNegativeDecimalSchema,
  parseDecimal,
  positiveAmountSchema,
  positiveDecimalSchema,
  quantize,
  rateDecimalSchema,
  type DecimalString,
} from '../src/decimal.js';

const minimum = '0.000000000000000001';
const maximum = '999999999999999999999999999999.999999999999999999';
const amountMaximum = '99999999999999999999.999999999999999999';
const d = parseDecimal;

describe('exchange decimal boundary', () => {
  it.each(['0', '1', '-1', minimum, `-${minimum}`, maximum, `-${maximum}`])(
    'preserves canonical input %s',
    (value) => {
      expect(parseDecimal(value)).toBe(value);
      expect(decimalSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    0,
    -0,
    0.1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    -Infinity,
    1n,
    null,
    undefined,
    false,
    {},
    [],
    new Decimal('1'),
    '',
    ' 1',
    '1 ',
    '1\n',
    '1\r',
    '1\u2028',
    '1\u2029',
    '+1',
    '01',
    '-01',
    '.1',
    '1.',
    '1.0',
    '1.010',
    '0.0',
    '-0',
    '-0.0',
    '1e2',
    '1E2',
    '1e99999999999999',
    '1e-99999999999999',
    'NaN',
    'Infinity',
    '-Infinity',
    '0x10',
    '1_000',
    '١',
    '1000000000000000000000000000000',
    '0.0000000000000000001',
    '9'.repeat(100_000),
  ])('rejects invalid unknown input %# with a sanitized error', (value) => {
    for (const schema of [
      decimalSchema,
      positiveDecimalSchema,
      nonNegativeDecimalSchema,
      amountDecimalSchema,
      positiveAmountSchema,
      nonNegativeAmountSchema,
      rateDecimalSchema,
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
    expect(() => parseDecimal(value)).toThrow(new TypeError('Invalid canonical decimal string'));
  });

  it('does not invoke coercion hooks on untrusted objects', () => {
    const input = {
      toString() {
        throw new Error('secret from input');
      },
      valueOf() {
        throw new Error('secret from input');
      },
    };
    expect(() => parseDecimal(input)).toThrow('Invalid canonical decimal string');
  });

  it('preserves integers above JS safe integer precision without interpreting IDs as numbers', () => {
    const externalId = '9223372036854775807';
    expect(d(externalId)).toBe(externalId);
    expect(decimalAdd(d('9007199254740993'), d('1'))).toBe('9007199254740994');
    expect(() => d(Number(externalId))).toThrow(TypeError);
  });

  it('enforces positivity while preserving signed rebates in general schemas', () => {
    expect(decimalSchema.parse('-0.0025')).toBe('-0.0025');
    expect(positiveDecimalSchema.safeParse('0').success).toBe(false);
    expect(positiveDecimalSchema.safeParse('-1').success).toBe(false);
    expect(positiveDecimalSchema.parse(minimum)).toBe(minimum);
    expect(nonNegativeDecimalSchema.parse('0')).toBe('0');
    expect(nonNegativeDecimalSchema.safeParse('-1').success).toBe(false);
  });

  it('narrows amount and rate bounds to match database categories', () => {
    expect(amountDecimalSchema.parse(amountMaximum)).toBe(amountMaximum);
    expect(amountDecimalSchema.parse(`-${amountMaximum}`)).toBe(`-${amountMaximum}`);
    expect(amountDecimalSchema.safeParse('100000000000000000000').success).toBe(false);
    expect(nonNegativeAmountSchema.parse('0')).toBe('0');
    expect(nonNegativeAmountSchema.safeParse('-1').success).toBe(false);
    expect(positiveAmountSchema.parse(minimum)).toBe(minimum);
    expect(positiveAmountSchema.safeParse('0').success).toBe(false);
    expect(positiveAmountSchema.safeParse(maximum).success).toBe(false);
    expect(rateDecimalSchema.parse('-99.999999999999999999')).toBe('-99.999999999999999999');
    expect(rateDecimalSchema.safeParse('100').success).toBe(false);
    expect(rateDecimalSchema.safeParse('-100').success).toBe(false);
  });
});

describe('exact exchange decimal arithmetic', () => {
  it('adds, subtracts and multiplies without binary float conversion', () => {
    expect(decimalAdd(d('0.1'), d('0.2'))).toBe('0.3');
    expect(decimalSubtract(d('0.3'), d('0.1'))).toBe('0.2');
    expect(decimalMultiply(d('0.1'), d('0.2'))).toBe('0.02');
    expect(decimalAdd(d('0.001'), d('-0.0025'))).toBe('-0.0015');
    expect(decimalMultiply(d('123456789012345.123456789'), d('0.000000001'))).toBe(
      '123456.789012345123456789',
    );
  });

  it('retains the full supported precision through cancellation and comparison', () => {
    expect(decimalAdd(d(maximum), d(`-${maximum}`))).toBe('0');
    expect(decimalSubtract(d(maximum), d('999999999999999999999999999999'))).toBe(
      '0.999999999999999999',
    );
    expect(decimalSubtract(d('0'), d('0'))).toBe('0');
    expect(decimalMultiply(d('-1'), d('0'))).toBe('0');
    expect(decimalMultiply(d(maximum), d('1'))).toBe(maximum);
    expect(decimalCompare(d('9007199254740992'), d('9007199254740993'))).toBe(-1);
    expect(decimalCompare(d('-0.1'), d('-0.2'))).toBe(1);
    expect(decimalCompare(d(maximum), d(maximum))).toBe(0);
  });

  it('rejects overflow and over-scale results instead of rounding', () => {
    expect(() => decimalAdd(d(maximum), d(minimum))).toThrow(RangeError);
    expect(() => decimalSubtract(d(`-${maximum}`), d(minimum))).toThrow(RangeError);
    expect(() => decimalMultiply(d(maximum), d(maximum))).toThrow(RangeError);
    expect(() => decimalMultiply(d(minimum), d(minimum))).toThrow(RangeError);
    expect(() => decimalMultiply(d(minimum), d('0.5'))).toThrow(RangeError);
  });

  it('keeps its configuration independent from the global Decimal constructor', () => {
    const previous = {
      precision: Decimal.precision,
      rounding: Decimal.rounding,
      modulo: Decimal.modulo,
      minE: Decimal.minE,
      maxE: Decimal.maxE,
    };
    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_UP, modulo: Decimal.ROUND_UP });
      expect(decimalSubtract(d(maximum), d('999999999999999999999999999999'))).toBe(
        '0.999999999999999999',
      );
      expect(quantize(d('-1.03'), d('0.05'), 'DOWN')).toBe('-1.05');
      expect(Decimal.precision).toBe(2);
      expect(Decimal.rounding).toBe(Decimal.ROUND_UP);
      expect(Decimal.modulo).toBe(Decimal.ROUND_UP);
    } finally {
      Decimal.set(previous);
    }
  });
});

describe('step quantization', () => {
  it.each([
    ['1.03', '0.05', 'DOWN', '1'],
    ['1.03', '0.05', 'UP', '1.05'],
    ['-1.03', '0.05', 'DOWN', '-1.05'],
    ['-1.03', '0.05', 'UP', '-1'],
    ['-0.01', '0.05', 'UP', '0'],
    ['-0.01', '0.05', 'DOWN', '-0.05'],
    ['0.31', '0.3', 'DOWN', '0.3'],
    ['0.31', '0.3', 'UP', '0.6'],
    ['1', '2.5', 'UP', '2.5'],
    ['-1', '2.5', 'DOWN', '-2.5'],
  ] as const)('quantizes %s at %s %s to %s', (value, step, direction, result) => {
    const quantized = quantize(d(value), d(step), direction);
    expect(quantized).toBe(result);
    expect(isStepAligned(quantized, d(step))).toBe(true);
  });

  it.each(['DOWN', 'UP', 'EXACT'] as const)('preserves aligned inputs with %s', (direction) => {
    expect(quantize(d('-1.05'), d('0.05'), direction)).toBe('-1.05');
    expect(quantize(d('0'), d('0.05'), direction)).toBe('0');
    expect(quantize(d(maximum), d(minimum), direction)).toBe(maximum);
  });

  it('recognizes exact alignment without floating point remainder', () => {
    expect(isStepAligned(d('0.3'), d('0.1'))).toBe(true);
    expect(isStepAligned(d('-1.05'), d('0.05'))).toBe(true);
    expect(isStepAligned(d('1.03'), d('0.05'))).toBe(false);
    expect(() => quantize(d('1.03'), d('0.05'), 'EXACT')).toThrow('not aligned');
    expect(() => quantize(d('-1.03'), d('0.05'), 'EXACT')).toThrow('not aligned');
  });

  it('retains a tiny remainder next to the aggregate limit', () => {
    expect(isStepAligned(d(maximum), d('0.05'))).toBe(false);
    expect(quantize(d(maximum), d('0.05'), 'DOWN')).toBe('999999999999999999999999999999.95');
    expect(quantize(d(`-${maximum}`), d('0.05'), 'UP')).toBe('-999999999999999999999999999999.95');
    expect(() => quantize(d(maximum), d('0.05'), 'UP')).toThrow(RangeError);
    expect(() => quantize(d(`-${maximum}`), d('0.05'), 'DOWN')).toThrow(RangeError);
  });

  it.each(['0', '-0.05'])('rejects nonpositive step %s', (step) => {
    expect(() => quantize(d('1'), d(step), 'DOWN')).toThrow('step must be positive');
    expect(() => isStepAligned(d('1'), d(step))).toThrow('step must be positive');
  });

  it('checks direction at runtime even for a value already aligned to the step', () => {
    expect(() => quantize(d('1'), d('1'), 'SIDEWAYS' as 'DOWN')).toThrow(
      'Invalid quantization direction',
    );
  });
});

describe('runtime checks despite unchecked TypeScript casts', () => {
  const binaryOperations = [
    decimalAdd,
    decimalSubtract,
    decimalMultiply,
    decimalCompare,
    isStepAligned,
  ];

  it.each([0.1, '1e1000000000', 'NaN', '1.0', '-0', {}, maximum + '9'])(
    'rejects invalid cast input %# on both sides',
    (value) => {
      const forged = value as DecimalString;
      for (const operation of binaryOperations) {
        expect(() => operation(forged, d('1'))).toThrow(TypeError);
        expect(() => operation(d('1'), forged)).toThrow(TypeError);
      }
      expect(() => quantize(forged, d('1'), 'DOWN')).toThrow(TypeError);
      expect(() => quantize(d('1'), forged, 'DOWN')).toThrow(TypeError);
    },
  );
});
