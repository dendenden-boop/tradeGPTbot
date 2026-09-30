import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'UNSUPPORTED',
  'UNVERIFIED',
  'STALE_CAPABILITY',
  'SCOPE_MISMATCH',
  'STALE_METADATA',
  'NOT_FOUND',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'ABORTED',
  'CLOSED',
  'BUSY',
  'AUTHORIZATION_REQUIRED',
  'LIVE_DISABLED',
  'UNKNOWN_OUTCOME',
]);
export type ExchangeErrorCode = z.infer<typeof errorCodeSchema>;
export const exchangeErrorSchema = z.strictObject({
  code: errorCodeSchema,
  retryAfterMs: z.number().int().min(0).max(3_600_000).optional(),
});
export type ExchangeError = z.infer<typeof exchangeErrorSchema>;
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ExchangeError };
export function failure(code: ExchangeErrorCode): {
  readonly ok: false;
  readonly error: ExchangeError;
} {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}
export function success<T>(value: T): { readonly ok: true; readonly value: T } {
  return Object.freeze({ ok: true, value });
}

/** Retain only explicitly allowlisted metadata; raw transport errors never escape. */
export function sanitizeExchangeError(input: unknown): ExchangeError {
  try {
    const parsed = exchangeErrorSchema.safeParse(input);
    return Object.freeze(parsed.success ? parsed.data : { code: 'UNAVAILABLE' as const });
  } catch {
    return Object.freeze({ code: 'UNAVAILABLE' });
  }
}
