import { describe, expect, it } from 'vitest';
import { failure, sanitizeExchangeError, success } from '../src/errors.js';

describe('exchange error boundary', () => {
  it('retains only allowlisted error metadata and freezes it', () => {
    const error = sanitizeExchangeError({ code: 'RATE_LIMITED', retryAfterMs: 1000 });
    expect(error).toEqual({ code: 'RATE_LIMITED', retryAfterMs: 1000 });
    expect(Object.isFrozen(error)).toBe(true);
  });
  it.each([
    new Error('secret-password'),
    { code: 'UNAVAILABLE', message: 'raw body/credentials' },
    { code: 'MY_RAW_ERROR' },
    { code: 'RATE_LIMITED', retryAfterMs: Infinity },
    { code: 'RATE_LIMITED', retryAfterMs: -1 },
    null,
    'secret-password',
  ])('does not disclose arbitrary exception data', (value) => {
    expect(sanitizeExchangeError(value)).toEqual({ code: 'UNAVAILABLE' });
  });
  it('has explicit success/failure tags and immutable errors', () => {
    expect(success(null)).toEqual({ ok: true, value: null });
    const result = failure('INVALID_RESPONSE');
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE' } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.error)).toBe(true);
  });
  it('contains exceptions thrown while reading untrusted error properties', () => {
    const input = Object.defineProperty({}, 'code', {
      get() {
        throw new Error('secret-transport-credentials');
      },
    });
    expect(sanitizeExchangeError(input)).toEqual({ code: 'UNAVAILABLE' });
  });
});
