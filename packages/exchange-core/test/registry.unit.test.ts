import { describe, expect, it } from 'vitest';
import { parseDecimal } from '../src/decimal.js';
import {
  createInstrumentRegistry,
  validateOrderAgainstRules,
  type InstrumentRecord,
} from '../src/registry.js';
import type { MarketScope } from '../src/scope.js';
import {
  instrumentFixture,
  newOrderFixture,
  NOW,
  recordFixture,
  rulesFixture,
} from './fixtures/domain.js';

describe('instrument registry boundary regressions', () => {
  it.each(['', 'id\n', ' '.repeat(2), 'x'.repeat(129)])(
    'rejects malformed get instrument ID %#',
    (id) => {
      const registry = createInstrumentRegistry({ capacity: 2 });
      expect(registry.get(instrumentFixture().scope, id, NOW)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    },
  );

  it('supports a derivative whose venue quantity is expressed in base asset', () => {
    const instrument = instrumentFixture({ market: 'LINEAR_PERPETUAL' });
    const record = { instrument, rules: rulesFixture(instrument, { quantityUnit: 'BASE' }) };
    const registry = createInstrumentRegistry({ capacity: 2 });
    expect(registry.put(record, NOW).ok).toBe(true);
    const order = newOrderFixture(record);
    expect(validateOrderAgainstRules(order, record, NOW).ok).toBe(true);
  });

  it('does not apply contract multipliers to derivative base-unit orders', () => {
    const instrument = instrumentFixture({ market: 'LINEAR_PERPETUAL' });
    const record = {
      instrument,
      rules: rulesFixture(instrument, {
        quantityUnit: 'BASE',
        minNotional: parseDecimal('5'),
        maxNotional: parseDecimal('5'),
      }),
    };
    expect(validateOrderAgainstRules(newOrderFixture(record), record, NOW).ok).toBe(true);
  });

  it.each(['HALTED', 'DELISTED'] as const)(
    'replaces a TRADING entry with %s metadata and blocks subsequent reads',
    (status) => {
      const registry = createInstrumentRegistry({ capacity: 1 });
      const record = recordFixture();
      expect(registry.put(record, NOW).ok).toBe(true);
      expect(registry.get(record.instrument.scope, record.instrument.id, NOW).ok).toBe(true);
      const updated = {
        ...record,
        instrument: { ...record.instrument, status, metadataVersion: 'metadata-v2' },
      };
      expect(registry.put(updated, NOW).ok).toBe(true);
      expect(registry.size()).toBe(1);
      expect(registry.get(record.instrument.scope, record.instrument.id, NOW)).toMatchObject({
        ok: false,
        error: { code: 'STALE_METADATA' },
      });
    },
  );
});

describe('registry identity, history and availability', () => {
  it('isolates the same symbol and instrument ID across every market-scope dimension', () => {
    const variants: Partial<MarketScope>[] = [
      {},
      { exchange: 'BYBIT' },
      { region: 'eu' },
      { market: 'LINEAR_PERPETUAL' },
      { environment: 'DEMO' },
    ];
    const registry = createInstrumentRegistry({ capacity: variants.length });
    for (const scope of variants) expect(registry.put(recordFixture(scope), NOW).ok).toBe(true);
    expect(registry.size()).toBe(variants.length);
    for (const scope of variants) {
      const instrument = instrumentFixture(scope);
      const result = registry.get(instrument.scope, instrument.id, NOW);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.instrument.scope).toEqual(instrument.scope);
    }
    expect(
      registry.get(instrumentFixture({ exchange: 'HTX' }).scope, 'btc-usdt', NOW),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('rejects symbol aliases with conflicting stable IDs only inside the same scope', () => {
    const registry = createInstrumentRegistry({ capacity: 3 });
    expect(registry.put(recordFixture(), NOW).ok).toBe(true);
    const alias = instrumentFixture({}, { id: 'another-id' });
    expect(registry.put({ instrument: alias, rules: rulesFixture(alias) }, NOW)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE' },
    });
    const otherVenue = instrumentFixture({ exchange: 'OKX' }, { id: 'another-id' });
    expect(registry.put({ instrument: otherVenue, rules: rulesFixture(otherVenue) }, NOW).ok).toBe(
      true,
    );
    expect(registry.size()).toBe(2);
  });

  it('rejects instrument/rule identity and market-scope mismatches', () => {
    const registry = createInstrumentRegistry({ capacity: 2 });
    const record = recordFixture();
    for (const patch of [
      { instrumentId: 'other' },
      { scope: instrumentFixture({ environment: 'LIVE' }).scope },
    ]) {
      const bad = { ...record, rules: { ...record.rules, ...patch } };
      expect(registry.put(bad, NOW)).toMatchObject({
        ok: false,
        error: { code: 'SCOPE_MISMATCH' },
      });
      expect(validateOrderAgainstRules(newOrderFixture(), bad, NOW)).toMatchObject({
        ok: false,
        error: { code: 'SCOPE_MISMATCH' },
      });
    }
  });

  it('owns immutable snapshots independently from later caller mutations', () => {
    const registry = createInstrumentRegistry({ capacity: 1 });
    const input = recordFixture();
    const inserted = registry.put(input, NOW);
    expect(inserted.ok).toBe(true);
    input.instrument.displaySymbol = 'CHANGED';
    input.rules.orderTypes.length = 0;
    const fetched = registry.get(input.instrument.scope, input.instrument.id, NOW);
    if (!fetched.ok) throw new Error('Expected valid registry record');
    expect(fetched.value.instrument.displaySymbol).toBe('BTC/USDT');
    expect(fetched.value.rules.orderTypes).toContain('LIMIT');
    expect(Object.isFrozen(fetched)).toBe(true);
    expect(Object.isFrozen(fetched.value)).toBe(true);
    expect(Object.isFrozen(fetched.value.instrument)).toBe(true);
    expect(Object.isFrozen(fetched.value.rules.orderTypes)).toBe(true);
    expect(Reflect.set(fetched.value.instrument, 'status', 'DELISTED')).toBe(false);
    expect(() => fetched.value.rules.orderTypes.push('LIMIT')).toThrow(TypeError);
  });

  it('rejects same-version rule and metadata tampering without overwriting evidence', () => {
    const registry = createInstrumentRegistry({ capacity: 1 });
    const record = recordFixture();
    registry.put(record, NOW);
    const variants = [
      { ...record, rules: { ...record.rules, tickSize: parseDecimal('0.1') } },
      { ...record, instrument: { ...record.instrument, displaySymbol: 'XBT/USDT' } },
      { ...record, rules: { ...record.rules, version: 'rules-v2', effectiveAt: NOW - 60_001 } },
    ];
    for (const value of variants)
      expect(registry.put(value, NOW)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_RESPONSE' },
      });
    expect(registry.get(record.instrument.scope, record.instrument.id, NOW)).toMatchObject({
      ok: true,
      value: record,
    });
    expect(
      registry.put(
        { ...record, rules: { ...record.rules, version: 'rules-v2', effectiveAt: NOW } },
        NOW,
      ).ok,
    ).toBe(true);
  });

  it.each([NOW - 60_001, NOW + 60_000])(
    'fails closed when rules are unavailable at time %s',
    (now) => {
      const registry = createInstrumentRegistry({ capacity: 1 });
      const record = recordFixture();
      expect(registry.put(record, now)).toMatchObject({
        ok: false,
        error: { code: 'STALE_METADATA' },
      });
      expect(registry.size()).toBe(0);
      expect(registry.put(record, NOW).ok).toBe(true);
      expect(registry.get(record.instrument.scope, record.instrument.id, now)).toMatchObject({
        ok: false,
        error: { code: 'STALE_METADATA' },
      });
      expect(validateOrderAgainstRules(newOrderFixture(record), record, now)).toMatchObject({
        ok: false,
        error: { code: 'STALE_METADATA' },
      });
    },
  );

  it('expires dated contracts exactly at their expiry even with fresh rules', () => {
    const instrument = instrumentFixture({ market: 'INVERSE_FUTURE' }, { expiryAt: NOW });
    const record = { instrument, rules: rulesFixture(instrument) };
    const registry = createInstrumentRegistry({ capacity: 1 });
    registry.put(record, NOW - 1);
    expect(registry.get(instrument.scope, instrument.id, NOW - 1).ok).toBe(true);
    expect(registry.get(instrument.scope, instrument.id, NOW)).toMatchObject({
      ok: false,
      error: { code: 'STALE_METADATA' },
    });
    expect(validateOrderAgainstRules(newOrderFixture(record), record, NOW)).toMatchObject({
      ok: false,
      error: { code: 'STALE_METADATA' },
    });
  });

  it('applies capacity to new identities while permitting current-entry updates', () => {
    const registry = createInstrumentRegistry({ capacity: 1 });
    const record = recordFixture();
    registry.put(record, NOW);
    expect(registry.put(recordFixture({ exchange: 'HTX' }), NOW)).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    expect(
      registry.put(
        { ...record, rules: { ...record.rules, version: 'rules-v2', effectiveAt: NOW } },
        NOW,
      ).ok,
    ).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it.each([0, -1, 1.5, 10_001, NaN, Infinity])('rejects invalid capacity %#', (capacity) => {
    expect(() => createInstrumentRegistry({ capacity })).toThrow('INVALID_REGISTRY_CAPACITY');
  });

  it('sanitizes hostile accessors at unknown-input boundaries', () => {
    const hostile = Object.defineProperty({}, 'instrument', {
      get() {
        throw new Error('SECRET_IN_RAW_PAYLOAD');
      },
    });
    const hostileCommand = Object.defineProperty({}, 'instrumentId', {
      get() {
        throw new Error('SECRET_IN_RAW_COMMAND');
      },
    });
    const hostileScope = Object.defineProperty({}, 'exchange', {
      get() {
        throw new Error('SECRET_IN_RAW_SCOPE');
      },
    });
    const registry = createInstrumentRegistry({ capacity: 1 });
    expect(registry.put(hostile, NOW)).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE' } });
    expect(registry.get(hostileScope as MarketScope, 'btc-usdt', NOW)).toEqual({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(validateOrderAgainstRules(hostileCommand, recordFixture(), NOW)).toEqual({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(validateOrderAgainstRules(newOrderFixture(), hostile as InstrumentRecord, NOW)).toEqual({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });
});

describe('exact order filter validation', () => {
  it('accepts aligned non-power-of-ten prices and quantities without mutating the command', () => {
    const record = recordFixture();
    const input = newOrderFixture(record, {
      size: { kind: 'BASE_QUANTITY', value: parseDecimal('0.55'), asset: 'BTC' },
      limitPrice: parseDecimal('10.05'),
    });
    const before = structuredClone(input);
    const result = validateOrderAgainstRules(input, record, NOW);
    expect(result).toMatchObject({ ok: true, value: before });
    expect(input).toEqual(before);
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.size)).toBe(true);
    }
  });

  it.each(['0.51', '0.05', '10.05'])(
    'rejects off-step or out-of-range quantity %s without rounding',
    (value) => {
      const record = recordFixture();
      const order = newOrderFixture(record);
      expect(
        validateOrderAgainstRules({ ...order, size: { ...order.size, value } }, record, NOW),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    },
  );

  it.each(['10.01', '0.95', '100.05'])(
    'rejects off-tick or out-of-range price %s',
    (limitPrice) => {
      const instrument = instrumentFixture();
      const record = {
        instrument,
        rules: rulesFixture(instrument, {
          minPrice: parseDecimal('1'),
          maxPrice: parseDecimal('100'),
        }),
      };
      expect(
        validateOrderAgainstRules({ ...newOrderFixture(record), limitPrice }, record, NOW),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    },
  );

  it.each([
    ['0.1', '10', true],
    ['0.1', '9.95', false],
    ['10', '100', true],
    ['10', '100.05', false],
  ] as const)(
    'enforces exact inclusive quote-notional bounds for %s × %s',
    (quantity, limitPrice, accepted) => {
      const record = recordFixture();
      const order = {
        ...newOrderFixture(record),
        size: { kind: 'BASE_QUANTITY', value: quantity, asset: 'BTC' },
        limitPrice,
      };
      expect(validateOrderAgainstRules(order, record, NOW).ok).toBe(accepted);
    },
  );

  it.each([
    ['0.1', false],
    ['0.2', true],
    ['5', true],
    ['5.05', false],
  ] as const)('uses market quantity filters for %s', (value, accepted) => {
    const record = recordFixture();
    const order = {
      ...newOrderFixture(record),
      type: 'MARKET',
      limitPrice: null,
      timeInForce: null,
      size: { kind: 'BASE_QUANTITY', value, asset: 'BTC' },
    };
    expect(validateOrderAgainstRules(order, record, NOW).ok).toBe(accepted);
    expect(
      validateOrderAgainstRules(
        { ...order, type: 'STOP_MARKET', trigger: { source: 'MARK', price: '10' } },
        record,
        NOW,
      ).ok,
    ).toBe(accepted);
  });

  it.each([
    ['0.95', false],
    ['1', true],
    ['1.03', true],
    ['1000', true],
    ['1000.05', false],
  ] as const)(
    'checks quote budget %s as quote notional rather than base quantity',
    (value, accepted) => {
      const record = recordFixture();
      const order = {
        ...newOrderFixture(record),
        type: 'MARKET',
        limitPrice: null,
        timeInForce: null,
        size: { kind: 'QUOTE_BUDGET', value, asset: 'USDT' },
      };
      expect(validateOrderAgainstRules(order, record, NOW).ok).toBe(accepted);
      expect(
        validateOrderAgainstRules({ ...order, size: { ...order.size, asset: 'BTC' } }, record, NOW)
          .ok,
      ).toBe(false);
    },
  );

  it('requires base denomination for spot and rejects reduce-only or contract sizes', () => {
    const record = recordFixture();
    const order = newOrderFixture(record);
    for (const patch of [
      { reduceOnly: true },
      { size: { kind: 'BASE_QUANTITY', value: '0.5', asset: 'USDT' } },
      { size: { kind: 'CONTRACTS', value: '1', contractSpecVersion: 'contract-v1' } },
    ])
      expect(validateOrderAgainstRules({ ...order, ...patch }, record, NOW).ok).toBe(false);
  });

  it('uses linear contract size once when computing base-to-quote notional', () => {
    const instrument = instrumentFixture({ market: 'LINEAR_PERPETUAL' });
    const record = {
      instrument,
      rules: rulesFixture(instrument, {
        minNotional: parseDecimal('1'),
        maxNotional: parseDecimal('1'),
      }),
    };
    const order = newOrderFixture(record);
    expect(validateOrderAgainstRules(order, record, NOW).ok).toBe(true);
    expect(validateOrderAgainstRules({ ...order, limitPrice: '9.95' }, record, NOW).ok).toBe(false);
    expect(validateOrderAgainstRules({ ...order, limitPrice: '10.05' }, record, NOW).ok).toBe(
      false,
    );
  });

  it('uses inverse contract quote size without multiplying by the limit price', () => {
    const instrument = instrumentFixture({ market: 'INVERSE_PERPETUAL' });
    const record = {
      instrument,
      rules: rulesFixture(instrument, {
        minNotional: parseDecimal('1000'),
        maxNotional: parseDecimal('1000'),
      }),
    };
    const order = newOrderFixture(record);
    expect(validateOrderAgainstRules(order, record, NOW).ok).toBe(true);
    expect(validateOrderAgainstRules({ ...order, limitPrice: '999.95' }, record, NOW).ok).toBe(
      true,
    );
    expect(
      validateOrderAgainstRules(
        {
          ...order,
          type: 'MARKET',
          limitPrice: null,
          timeInForce: null,
          size: { ...order.size, value: '5' },
        },
        record,
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('rejects stale contract/rule versions and mismatched derivative size units', () => {
    const record = recordFixture({ market: 'LINEAR_FUTURE' });
    const order = newOrderFixture(record);
    expect(
      validateOrderAgainstRules({ ...order, ruleVersion: 'rules-old' }, record, NOW),
    ).toMatchObject({ ok: false, error: { code: 'STALE_METADATA' } });
    expect(
      validateOrderAgainstRules(
        { ...order, size: { ...order.size, contractSpecVersion: 'contract-old' } },
        record,
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      validateOrderAgainstRules(
        { ...order, size: { kind: 'BASE_QUANTITY', value: '1', asset: 'BTC' } },
        record,
        NOW,
      ).ok,
    ).toBe(false);
    const baseRecord = {
      ...record,
      rules: rulesFixture(record.instrument, { quantityUnit: 'BASE' }),
    };
    expect(validateOrderAgainstRules(order, baseRecord, NOW).ok).toBe(false);
    expect(validateOrderAgainstRules(newOrderFixture(baseRecord), baseRecord, NOW).ok).toBe(true);
  });

  it('applies trigger-price filters and rejects unsupported order features', () => {
    const record = recordFixture();
    const order = {
      ...newOrderFixture(record),
      type: 'STOP_LIMIT',
      trigger: { source: 'MARK', price: '10.01' },
    };
    expect(validateOrderAgainstRules(order, record, NOW).ok).toBe(false);
    const restricted = {
      ...record,
      rules: rulesFixture(record.instrument, { orderTypes: ['LIMIT'], timeInForce: ['GTC'] }),
    };
    expect(
      validateOrderAgainstRules(
        { ...order, trigger: { source: 'MARK', price: '10' } },
        restricted,
        NOW,
      ),
    ).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
    expect(
      validateOrderAgainstRules(
        { ...newOrderFixture(record), timeInForce: 'FOK' },
        restricted,
        NOW,
      ),
    ).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
  });

  it('rejects over-scale arithmetic as a sanitized result instead of silently rounding notional', () => {
    const instrument = instrumentFixture();
    const tiny = parseDecimal('0.000000000000000001');
    const record = {
      instrument,
      rules: rulesFixture(instrument, {
        tickSize: tiny,
        stepSize: tiny,
        minQuantity: tiny,
        minPrice: tiny,
        minNotional: parseDecimal('0'),
        maxNotional: null,
        pricePrecision: 18,
        quantityPrecision: 18,
      }),
    };
    const order = {
      ...newOrderFixture(record),
      size: { kind: 'BASE_QUANTITY', value: tiny, asset: 'BTC' },
      limitPrice: tiny,
    };
    expect(validateOrderAgainstRules(order, record, NOW)).toEqual({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });
});
