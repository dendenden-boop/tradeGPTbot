import { describe, expect, it } from 'vitest';
import { parseDecimal } from '../src/decimal.js';
import { createInstrumentRegistry } from '../src/registry.js';
import { instrumentFixture, recordFixture, rulesFixture, NOW } from './fixtures/domain.js';

describe('registry capacity and immutable version history', () => {
  it('snapshots capacity instead of retaining mutable caller options', () => {
    const options = { capacity: 1 };
    const registry = createInstrumentRegistry(options);
    const first = recordFixture();
    expect(registry.put(first, NOW).ok).toBe(true);
    options.capacity = 100;
    const other = instrumentFixture(
      {},
      { id: 'eth-usdt', exchangeSymbol: 'ETHUSDT', displaySymbol: 'ETH/USDT', baseAsset: 'ETH' },
    );
    expect(registry.put({ instrument: other, rules: rulesFixture(other) }, NOW)).toEqual({
      ok: false,
      error: { code: 'BUSY' },
    });
    expect(registry.size()).toBe(1);
  });
  it('rejects reuse of a previous rule version with different content after an intervening update', () => {
    const registry = createInstrumentRegistry({ capacity: 1 });
    const first = recordFixture();
    expect(registry.put(first, NOW).ok).toBe(true);
    const second = {
      ...first,
      rules: rulesFixture(first.instrument, { version: 'rules-v2', effectiveAt: NOW - 10 }),
    };
    expect(registry.put(second, NOW).ok).toBe(true);
    expect(
      registry.put(
        {
          ...first,
          rules: rulesFixture(first.instrument, {
            version: 'rules-v1',
            effectiveAt: NOW - 5,
            tickSize: parseDecimal('0.1'),
          }),
        },
        NOW,
      ),
    ).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE' } });
    expect(registry.get(first.instrument.scope, first.instrument.id, NOW)).toMatchObject({
      ok: true,
      value: { rules: { version: 'rules-v2' } },
    });
  });
  it('does not resurrect an old metadata version with changed instrument fields', () => {
    const registry = createInstrumentRegistry({ capacity: 1 });
    const first = recordFixture();
    expect(registry.put(first, NOW).ok).toBe(true);
    const second = instrumentFixture(
      {},
      { metadataVersion: 'metadata-v2', displaySymbol: 'BTC-USDT' },
    );
    expect(
      registry.put(
        {
          instrument: second,
          rules: rulesFixture(second, { version: 'rules-v2', effectiveAt: NOW - 10 }),
        },
        NOW,
      ).ok,
    ).toBe(true);
    const reused = instrumentFixture(
      {},
      { metadataVersion: 'metadata-v1', displaySymbol: 'BTC:USDT' },
    );
    expect(
      registry.put(
        {
          instrument: reused,
          rules: rulesFixture(reused, { version: 'rules-v3', effectiveAt: NOW - 5 }),
        },
        NOW,
      ),
    ).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE' } });
  });
  it('bounds historical evidence without evicting it or partially applying an update', () => {
    const options = { capacity: 1, versionCapacity: 3 };
    const registry = createInstrumentRegistry(options);
    const first = recordFixture();
    expect(registry.put(first, NOW).ok).toBe(true);
    const second = {
      ...first,
      rules: rulesFixture(first.instrument, { version: 'rules-v2', effectiveAt: NOW - 10 }),
    };
    expect(registry.put(second, NOW).ok).toBe(true);
    options.versionCapacity = 1000;
    expect(
      registry.put(
        {
          ...first,
          rules: rulesFixture(first.instrument, { version: 'rules-v3', effectiveAt: NOW - 5 }),
        },
        NOW,
      ),
    ).toEqual({ ok: false, error: { code: 'BUSY' } });
    expect(registry.put(second, NOW).ok).toBe(true);
    expect(registry.get(first.instrument.scope, first.instrument.id, NOW)).toMatchObject({
      ok: true,
      value: { rules: { version: 'rules-v2' } },
    });
  });
});
