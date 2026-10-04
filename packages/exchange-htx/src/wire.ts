import { idSchema, parseDecimal, type DecimalString } from '@ctp/exchange-core';

const invalid = (): never => {
  throw new Error('INVALID_HTX_RESPONSE');
};

/** Preserve JSON number source bytes before IEEE-754 rounding can affect financial IDs. */
export function parseWireJson(text: string): unknown {
  try {
    if (Buffer.byteLength(text, 'utf8') > 2_097_152) return invalid();
    return JSON.parse(
      text,
      (key: string, value: unknown, context?: { source?: string }): unknown => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return invalid();
        if (typeof value !== 'number') return value;
        if (typeof context?.source !== 'string') return invalid();
        return context.source;
      },
    ) as unknown;
  } catch {
    return invalid();
  }
}

/** Expand bounded native exponent notation using source digits, never IEEE-754 money. */
export function canonicalDecimal(raw: unknown): DecimalString {
  try {
    const value =
      typeof raw === 'number' && Number.isSafeInteger(raw) && !Object.is(raw, -0)
        ? String(raw)
        : raw;
    let expanded = value;
    if (typeof value === 'string' && value.length <= 80 && /[eE]/.test(value)) {
      const m = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?[eE]([+-]?\d{1,2})$/.exec(value);
      if (!m) return invalid();
      const exponent = Number(m[4]);
      if (Math.abs(exponent) > 36) return invalid();
      const digits = m[2]! + (m[3] ?? '');
      const point = m[2]!.length + exponent;
      expanded =
        m[1]! +
        (point <= 0
          ? '0.' + '0'.repeat(-point) + digits
          : point >= digits.length
            ? digits + '0'.repeat(point - digits.length)
            : digits.slice(0, point) + '.' + digits.slice(point));
      expanded = (expanded as string).replace(/^(-?)0+(?=\d)/, '$1');
    }
    if (
      typeof expanded !== 'string' ||
      expanded.length > 80 ||
      !/^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,36})?$/.test(expanded)
    )
      return invalid();
    let canonical = expanded.includes('.')
      ? expanded.replace(/0+$/, '').replace(/\.$/, '')
      : expanded;
    if (canonical === '-0') canonical = '0';
    return parseDecimal(canonical);
  } catch {
    return invalid();
  }
}

export function wireInteger(raw: unknown): number {
  const value =
    typeof raw === 'number' && Number.isSafeInteger(raw) && !Object.is(raw, -0) ? String(raw) : raw;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,15})$/.test(value)) return invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return invalid();
  return number;
}

export function wireId(raw: unknown): string {
  try {
    if (typeof raw === 'number') {
      if (!Number.isSafeInteger(raw) || Object.is(raw, -0) || raw < 0) return invalid();
      return idSchema.parse(String(raw));
    }
    return idSchema.parse(raw);
  } catch {
    return invalid();
  }
}

export function wireObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  return raw as Record<string, unknown>;
}

export function wireArray(raw: unknown, maximum = 2000): readonly unknown[] {
  if (!Array.isArray(raw) || raw.length > maximum) return invalid();
  return raw as readonly unknown[];
}
