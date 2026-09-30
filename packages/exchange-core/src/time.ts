import { timestampSchema } from './scope.js';

export type ExchangeTimeUnit = 'SECONDS' | 'MILLISECONDS' | 'MICROSECONDS' | 'NANOSECONDS';
/** Explicit source unit and loss policy; never guess by the magnitude of a timestamp. */
export function normalizeExchangeTime(
  value: unknown,
  unit: ExchangeTimeUnit,
  precision: 'EXACT' | 'TRUNCATE' = 'EXACT',
) {
  if (
    !['SECONDS', 'MILLISECONDS', 'MICROSECONDS', 'NANOSECONDS'].includes(unit) ||
    (precision !== 'EXACT' && precision !== 'TRUNCATE')
  )
    throw new Error('INVALID_EXCHANGE_TIME');
  const text =
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
      ? String(value)
      : typeof value === 'string' &&
          value.length <= 22 &&
          /^(?:0|[1-9][0-9]*)$/.exec(value)?.[0] === value
        ? value
        : null;
  if (text === null) throw new Error('INVALID_EXCHANGE_TIME');
  const integer = BigInt(text);
  const divisor = unit === 'MICROSECONDS' ? 1000n : unit === 'NANOSECONDS' ? 1_000_000n : 1n;
  const scaled = unit === 'SECONDS' ? integer * 1000n : integer;
  const discardedSubMillisecond = scaled % divisor !== 0n;
  if (discardedSubMillisecond && precision === 'EXACT')
    throw new Error('EXCHANGE_TIME_PRECISION_LOSS');
  const milliseconds = Number(scaled / divisor);
  if (!timestampSchema.safeParse(milliseconds).success) throw new Error('INVALID_EXCHANGE_TIME');
  return Object.freeze({ milliseconds, discardedSubMillisecond });
}
