import { describe, expect, it, vi } from 'vitest';
import {
  fromStorageMarket,
  fromStorageTradingMode,
  normalizeStoredAverageFillPrice,
  toStorageTradingMode,
  tradingDestinationSchema,
  type StorageTradingMode,
  type TradingDestination,
} from '../src/storage-boundary.js';

const invalidStorage = { ok: false, error: { code: 'INVALID_RESPONSE' } };
const invalidDestination = { ok: false, error: { code: 'INVALID_REQUEST' } };
const expiryAt = Date.parse('2026-12-25T08:00:00.000Z');

describe('storage trading destination mapping', () => {
  const destinations: { stored: StorageTradingMode; destination: TradingDestination }[] = [
    { stored: 'PAPER', destination: { mode: 'PAPER' } },
    { stored: 'TESTNET', destination: { mode: 'EXCHANGE_DEMO', environment: 'TESTNET' } },
    { stored: 'DEMO', destination: { mode: 'EXCHANGE_DEMO', environment: 'DEMO' } },
    { stored: 'LIVE', destination: { mode: 'LIVE', environment: 'LIVE' } },
  ];

  it.each(destinations)(
    'maps $stored without erasing its destination and round-trips',
    ({ stored, destination }) => {
      const fromStorage = fromStorageTradingMode(stored);
      expect(fromStorage).toEqual({ ok: true, value: destination });
      if (!fromStorage.ok) throw new Error('Expected valid storage fixture');
      expect(tradingDestinationSchema.safeParse(fromStorage.value).success).toBe(true);
      expect(Object.isFrozen(fromStorage.value)).toBe(true);
      expect(toStorageTradingMode(fromStorage.value)).toEqual({ ok: true, value: stored });

      const toStorage = toStorageTradingMode(destination);
      expect(toStorage).toEqual({ ok: true, value: stored });
      if (!toStorage.ok) throw new Error('Expected valid destination fixture');
      expect(fromStorageTradingMode(toStorage.value)).toEqual({ ok: true, value: destination });
    },
  );

  it.each(['BACKTEST', 'EXCHANGE_DEMO', 'UNKNOWN', 'testnet', 'LIVE ', '', null, undefined, 0, {}])(
    'rejects unsupported storage mode %j',
    (input) => {
      expect(fromStorageTradingMode(input)).toEqual(invalidStorage);
    },
  );

  it.each([
    { mode: 'PAPER', environment: 'TESTNET' },
    { mode: 'PAPER', environment: 'DEMO' },
    { mode: 'PAPER', environment: 'LIVE' },
    { mode: 'EXCHANGE_DEMO', environment: 'LIVE' },
    { mode: 'LIVE', environment: 'TESTNET' },
    { mode: 'LIVE', environment: 'DEMO' },
    { mode: 'EXCHANGE_DEMO' },
    { mode: 'LIVE' },
    { mode: 'TESTNET', environment: 'TESTNET' },
    { mode: 'BACKTEST' },
    { mode: 'PAPER', extra: 'untrusted' },
    null,
    undefined,
    'LIVE',
  ])('rejects contradictory or malformed destinations %j', (input) => {
    expect(toStorageTradingMode(input)).toEqual(invalidDestination);
    expect(tradingDestinationSchema.safeParse(input).success).toBe(false);
  });

  it('does not coerce enum-like objects into a destination', () => {
    const toString = vi.fn(() => 'LIVE');
    expect(fromStorageTradingMode({ toString })).toEqual(invalidStorage);
    expect(toStorageTradingMode({ mode: { toString }, environment: 'LIVE' })).toEqual(
      invalidDestination,
    );
    expect(toString).not.toHaveBeenCalled();
  });
});

describe('storage market mapping', () => {
  it.each([
    { market: 'SPOT', isInverse: false, expiryAt: null, expected: 'SPOT' },
    { market: 'PERPETUAL', isInverse: false, expiryAt: null, expected: 'LINEAR_PERPETUAL' },
    { market: 'PERPETUAL', isInverse: true, expiryAt: null, expected: 'INVERSE_PERPETUAL' },
    { market: 'FUTURES', isInverse: false, expiryAt, expected: 'LINEAR_FUTURE' },
    { market: 'FUTURES', isInverse: true, expiryAt, expected: 'INVERSE_FUTURE' },
  ])('preserves $market inverse=$isInverse', ({ expected, ...input }) => {
    expect(fromStorageMarket(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    { market: 'SPOT', isInverse: true, expiryAt: null },
    { market: 'SPOT', isInverse: false, expiryAt },
    { market: 'PERPETUAL', isInverse: false, expiryAt },
    { market: 'PERPETUAL', isInverse: true, expiryAt },
    { market: 'FUTURES', isInverse: false, expiryAt: null },
    { market: 'FUTURES', isInverse: true, expiryAt: null },
    { market: 'MARGIN', isInverse: false, expiryAt: null },
    { market: 'OPTION', isInverse: false, expiryAt },
    { market: 'UNKNOWN', isInverse: false, expiryAt: null },
    { market: 'LINEAR_PERPETUAL', isInverse: false, expiryAt: null },
    { market: 'FUTURES', isInverse: 'false', expiryAt },
    { market: 'SPOT', expiryAt: null },
    { market: 'PERPETUAL', isInverse: false },
    { market: 'SPOT', isInverse: false, expiryAt: null, extra: true },
    null,
    [],
  ])('rejects unsupported or contradictory storage fields %j', (input) => {
    expect(fromStorageMarket(input)).toEqual(invalidStorage);
  });

  it.each([-1, 0.5, Infinity, NaN, 8_640_000_000_000_001, '1000', new Date(expiryAt)])(
    'rejects invalid expiry %s without time coercion',
    (expiryAt) => {
      expect(fromStorageMarket({ market: 'FUTURES', isInverse: false, expiryAt })).toEqual(
        invalidStorage,
      );
    },
  );

  it('accepts an explicit zero expiry as timestamp evidence without deciding freshness', () => {
    expect(fromStorageMarket({ market: 'FUTURES', isInverse: true, expiryAt: 0 })).toEqual({
      ok: true,
      value: 'INVERSE_FUTURE',
    });
  });
});

describe('stored average fill price marker', () => {
  it('translates only an unexecuted order with stored zero to NO_EXECUTIONS', () => {
    const result = normalizeStoredAverageFillPrice('0', '0');
    expect(result).toEqual({ ok: true, value: { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' } });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each([
    ['0.001', '30000.05'],
    ['0.000000000000000001', '0.000000000000000001'],
    ['99999999999999999999', '99999999999999999999.999999999999999999'],
  ])('preserves exact positive quantity %s and price %s', (filledQuantity, averageFillPrice) => {
    expect(normalizeStoredAverageFillPrice(filledQuantity, averageFillPrice)).toEqual({
      ok: true,
      value: { state: 'AVAILABLE', value: averageFillPrice },
    });
  });

  it.each([
    ['0.001', '0'],
    ['0', '1'],
    ['0', '0.000000000000000001'],
    ['-1', '100'],
    ['1', '-100'],
    ['1', { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' }],
    ['1', null],
    [null, '0'],
  ])('rejects missing or contradictory execution evidence', (filledQuantity, averageFillPrice) => {
    expect(normalizeStoredAverageFillPrice(filledQuantity, averageFillPrice)).toEqual(
      invalidStorage,
    );
  });

  it.each([
    '0.0',
    '1.00',
    '01',
    '1e2',
    '+1',
    '-0',
    ' 1',
    '1 ',
    '1\n',
    '0.0000000000000000001',
    '100000000000000000000',
  ])('requires canonical bounded storage decimal text %j on both inputs', (input) => {
    expect(normalizeStoredAverageFillPrice(input, '1')).toEqual(invalidStorage);
    expect(normalizeStoredAverageFillPrice('1', input)).toEqual(invalidStorage);
  });

  it.each([0, 1, 0.1, NaN, Infinity, 1n])('rejects numeric money %s on both inputs', (input) => {
    expect(normalizeStoredAverageFillPrice(input, '1')).toEqual(invalidStorage);
    expect(normalizeStoredAverageFillPrice('1', input)).toEqual(invalidStorage);
  });

  it('does not invoke SQL Decimal serializers or object coercion', () => {
    const toString = vi.fn(() => '1');
    const toFixed = vi.fn(() => '1');
    const input = { toString, toFixed };
    expect(normalizeStoredAverageFillPrice(input, '1')).toEqual(invalidStorage);
    expect(normalizeStoredAverageFillPrice('1', input)).toEqual(invalidStorage);
    expect(toString).not.toHaveBeenCalled();
    expect(toFixed).not.toHaveBeenCalled();
  });
});

describe('storage boundary hostile object handling', () => {
  it('sanitizes throwing destination and market getters to stable Result errors', () => {
    const rawError = new Error('private database diagnostic');
    const destination = Object.defineProperty({}, 'mode', {
      get: () => {
        throw rawError;
      },
    });
    const market = Object.defineProperty({}, 'market', {
      get: () => {
        throw rawError;
      },
    });
    expect(toStorageTradingMode(destination)).toEqual(invalidDestination);
    expect(fromStorageMarket(market)).toEqual(invalidStorage);
    expect(fromStorageTradingMode(destination)).toEqual(invalidStorage);
    expect(normalizeStoredAverageFillPrice(destination, market)).toEqual(invalidStorage);
  });

  it('contains throwing proxy traps without revealing raw storage errors', () => {
    const input = new Proxy(
      {},
      {
        get() {
          throw new Error('private getter diagnostic');
        },
        ownKeys() {
          throw new Error('private keys diagnostic');
        },
      },
    );
    expect(toStorageTradingMode(input)).toEqual(invalidDestination);
    expect(fromStorageMarket(input)).toEqual(invalidStorage);
    expect(fromStorageTradingMode(input)).toEqual(invalidStorage);
    expect(normalizeStoredAverageFillPrice(input, input)).toEqual(invalidStorage);
  });
});
