import { z } from 'zod';
import { nonNegativeAmountSchema } from './decimal.js';
import { observedPriceSchema } from './domain.js';
import { failure, success, type Result } from './errors.js';
import { timestampSchema, type MarketType } from './scope.js';

/** EXCHANGE_DEMO groups two destinations without erasing their exact environment. */
export const tradingDestinationSchema = z
  .discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('PAPER') }),
    z.strictObject({ mode: z.literal('EXCHANGE_DEMO'), environment: z.enum(['TESTNET', 'DEMO']) }),
    z.strictObject({ mode: z.literal('LIVE'), environment: z.literal('LIVE') }),
  ])
  .readonly();
export type TradingDestination = z.infer<typeof tradingDestinationSchema>;
export type StorageTradingMode = 'PAPER' | 'TESTNET' | 'DEMO' | 'LIVE';

/** Storage enums are validated explicitly; BACKTEST is never an account destination. */
export function fromStorageTradingMode(input: unknown): Result<TradingDestination> {
  switch (input) {
    case 'PAPER':
      return success(Object.freeze({ mode: 'PAPER' }));
    case 'TESTNET':
    case 'DEMO':
      return success(Object.freeze({ mode: 'EXCHANGE_DEMO', environment: input }));
    case 'LIVE':
      return success(Object.freeze({ mode: 'LIVE', environment: 'LIVE' }));
    default:
      return failure('INVALID_RESPONSE');
  }
}

/** Reverse mapping rejects contradictory mode/environment pairs rather than guessing. */
export function toStorageTradingMode(input: unknown): Result<StorageTradingMode> {
  try {
    const parsed = tradingDestinationSchema.safeParse(input);
    if (!parsed.success) return failure('INVALID_REQUEST');
    switch (parsed.data.mode) {
      case 'PAPER':
        return success('PAPER');
      case 'EXCHANGE_DEMO':
        return success(parsed.data.environment);
      case 'LIVE':
        return success('LIVE');
    }
  } catch {
    return failure('INVALID_REQUEST');
  }
}

const storedMarketSchema = z.strictObject({
  market: z.enum(['SPOT', 'PERPETUAL', 'FUTURES']),
  isInverse: z.boolean(),
  expiryAt: timestampSchema.nullable(),
});

/**
 * Map only the supplied storage fields, with no Prisma objects or database access.
 * Expiry is required evidence for FUTURES and forbidden for SPOT/PERPETUAL.
 * Instrument expiry freshness remains a separate registry validation.
 */
export function fromStorageMarket(input: unknown): Result<MarketType> {
  try {
    const parsed = storedMarketSchema.safeParse(input);
    if (!parsed.success) return failure('INVALID_RESPONSE');
    const { market, isInverse, expiryAt } = parsed.data;
    switch (market) {
      case 'SPOT':
        return isInverse || expiryAt !== null ? failure('INVALID_RESPONSE') : success('SPOT');
      case 'PERPETUAL':
        return expiryAt !== null
          ? failure('INVALID_RESPONSE')
          : success(isInverse ? 'INVERSE_PERPETUAL' : 'LINEAR_PERPETUAL');
      case 'FUTURES':
        return expiryAt === null
          ? failure('INVALID_RESPONSE')
          : success(isInverse ? 'INVERSE_FUTURE' : 'LINEAR_FUTURE');
    }
  } catch {
    return failure('INVALID_RESPONSE');
  }
}

/**
 * Accept canonical decimal strings from the storage serializer only: no JavaScript
 * numbers, SQL Decimal objects, exponents, or trailing fractional zeros. This
 * mapper does not coerce or round money. A stored zero price is solely the initial
 * NO_EXECUTIONS marker; an execution without a positive price needs other evidence.
 */
export function normalizeStoredAverageFillPrice(
  filledQuantity: unknown,
  averageFillPrice: unknown,
): Result<z.infer<typeof observedPriceSchema>> {
  try {
    const filled = nonNegativeAmountSchema.safeParse(filledQuantity);
    const average = nonNegativeAmountSchema.safeParse(averageFillPrice);
    if (!filled.success || !average.success) return failure('INVALID_RESPONSE');
    if (filled.data === '0') {
      return average.data === '0'
        ? success(
            Object.freeze(
              observedPriceSchema.parse({ state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' }),
            ),
          )
        : failure('INVALID_RESPONSE');
    }
    if (average.data === '0') return failure('INVALID_RESPONSE');
    return success(
      Object.freeze(observedPriceSchema.parse({ state: 'AVAILABLE', value: average.data })),
    );
  } catch {
    return failure('INVALID_RESPONSE');
  }
}
