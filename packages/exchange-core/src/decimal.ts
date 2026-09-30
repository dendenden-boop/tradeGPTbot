import { Decimal } from 'decimal.js';
import { z } from 'zod';

const INVALID_DECIMAL = 'Invalid canonical decimal string';
const MAX_INTEGER_DIGITS = 30;
const MAX_SCALE = 18;
const MAX_TEXT_LENGTH = 1 + MAX_INTEGER_DIGITS + 1 + MAX_SCALE;
const canonicalDecimal = /^-?(?:0|[1-9]\d{0,29})(?:\.\d{0,17}[1-9])?$/u;

/** The common NUMERIC envelope supports aggregate amounts: 30 integer / 18 fractional digits.
 * A canonical string has no exponent, leading zeros, trailing fractional zeros or negative zero.
 * Field schemas below enforce the narrower database amount and rate envelopes.
 */
export const decimalSchema = z
  .custom<string>(
    (value) =>
      typeof value === 'string' &&
      value.length <= MAX_TEXT_LENGTH &&
      value !== '-0' &&
      canonicalDecimal.exec(value)?.[0] === value,
    { error: INVALID_DECIMAL },
  )
  .brand<'DecimalString'>();

export type DecimalString = z.infer<typeof decimalSchema>;

export const positiveDecimalSchema = decimalSchema.refine(
  (value) => value !== '0' && !value.startsWith('-'),
  { error: 'Decimal must be positive' },
);

export const nonNegativeDecimalSchema = decimalSchema.refine((value) => !value.startsWith('-'), {
  error: 'Decimal must be nonnegative',
});

function integerDigits(value: DecimalString): number {
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const decimalPoint = unsigned.indexOf('.');
  return decimalPoint === -1 ? unsigned.length : decimalPoint;
}

export const amountDecimalSchema = decimalSchema.refine((value) => integerDigits(value) <= 20, {
  error: 'Decimal exceeds the amount range',
});

export const positiveAmountSchema = amountDecimalSchema.refine(
  (value) => value !== '0' && !value.startsWith('-'),
  { error: 'Amount must be positive' },
);

export const nonNegativeAmountSchema = amountDecimalSchema.refine(
  (value) => !value.startsWith('-'),
  { error: 'Amount must be nonnegative' },
);

export const rateDecimalSchema = decimalSchema.refine((value) => integerDigits(value) <= 2, {
  error: 'Decimal exceeds the rate range',
});

// Each checked input has at most 48 significant digits. Addition/subtraction needs <=49,
// multiplication <=96, and the integer quotient used by modulo <=48. Precision 100 therefore
// preserves every digit; bounded exponents also prevent huge toFixed allocations. This private
// constructor explicitly configures every option and never changes Decimal's global settings.
const ExactDecimal = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_EVEN,
  modulo: Decimal.ROUND_FLOOR,
  minE: -100,
  maxE: 100,
  toExpNeg: -100,
  toExpPos: 100,
  crypto: false,
});

/** Validate unknown input without coercion or disclosing the rejected input in an exception. */
export function parseDecimal(value: unknown): DecimalString {
  const result = decimalSchema.safeParse(value);
  if (!result.success) throw new TypeError(INVALID_DECIMAL);
  return result.data;
}

function checkedDecimal(value: unknown): Decimal {
  return new ExactDecimal(parseDecimal(value));
}

function checkedResult(value: Decimal): DecimalString {
  // Check before formatting: no rounding, Infinity, underflow or unbounded fixed-point output.
  if (!value.isFinite() || value.e >= MAX_INTEGER_DIGITS || value.decimalPlaces() > MAX_SCALE) {
    throw new RangeError('Decimal result exceeds supported range or scale');
  }
  return parseDecimal(value.isZero() ? '0' : value.toFixed());
}

export function decimalCompare(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const comparison = checkedDecimal(a).comparedTo(checkedDecimal(b));
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
}

export function decimalAdd(a: DecimalString, b: DecimalString): DecimalString {
  return checkedResult(checkedDecimal(a).plus(checkedDecimal(b)));
}

export function decimalSubtract(a: DecimalString, b: DecimalString): DecimalString {
  return checkedResult(checkedDecimal(a).minus(checkedDecimal(b)));
}

export function decimalMultiply(a: DecimalString, b: DecimalString): DecimalString {
  return checkedResult(checkedDecimal(a).times(checkedDecimal(b)));
}

function checkedStep(step: unknown): Decimal {
  const result = checkedDecimal(step);
  if (!result.isPositive() || result.isZero())
    throw new RangeError('Decimal step must be positive');
  return result;
}

export function isStepAligned(value: DecimalString, step: DecimalString): boolean {
  return checkedDecimal(value).modulo(checkedStep(step)).isZero();
}

/** Quantize to any positive step, including 0.05.
 * DOWN means towards negative infinity; UP means towards positive infinity. For example,
 * -1.03 at step 0.05 becomes -1.05 DOWN and -1 UP. EXACT rejects a nonzero remainder.
 * The floor remainder avoids a rounded division before deciding alignment or direction.
 */
export function quantize(
  value: DecimalString,
  step: DecimalString,
  direction: 'DOWN' | 'UP' | 'EXACT',
): DecimalString {
  if (direction !== 'DOWN' && direction !== 'UP' && direction !== 'EXACT') {
    throw new TypeError('Invalid quantization direction');
  }
  const amount = checkedDecimal(value);
  const increment = checkedStep(step);
  const remainder = amount.modulo(increment);
  if (remainder.isZero()) return checkedResult(amount);
  if (direction === 'EXACT') throw new RangeError('Decimal is not aligned to step');
  const lower = amount.minus(remainder);
  return checkedResult(direction === 'DOWN' ? lower : lower.plus(increment));
}
