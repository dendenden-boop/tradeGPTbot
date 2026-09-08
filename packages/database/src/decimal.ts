const integerDigits = { price: 20, quantity: 20, amount: 20, aggregate: 30, rate: 2 } as const;
export type DecimalKind = keyof typeof integerDigits;

/** Validate decimal text before parsing: no binary floats, exponents or implicit rounding. */
export function decimalText(value: unknown, kind: DecimalKind): string {
  if (typeof kind !== 'string' || !Object.hasOwn(integerDigits, kind)) {
    throw new TypeError('Unknown decimal field category');
  }
  if (
    typeof value !== 'string' ||
    value.length > 51 ||
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.exec(value)?.[0] !== value
  ) {
    throw new TypeError('Expected bounded canonical decimal text');
  }
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [integer = '', fraction = ''] = unsigned.split('.');
  if (integer.length > integerDigits[kind] || fraction.length > 18) {
    throw new RangeError('Decimal exceeds the field range or scale');
  }
  const trimmed = fraction.replace(/0+$/u, '');
  const result = integer + (trimmed ? `.${trimmed}` : '');
  return value.startsWith('-') && result !== '0' ? `-${result}` : result;
}
