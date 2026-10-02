import { expect, it, vi } from 'vitest';
import { createInstrumentRegistry } from '@ctp/exchange-core';
import { createPublicTransport } from '../src/public-transport.js';
import { normalizeExchangeInfo } from '../src/public-data.js';
import { getBinanceProfile, adapterProfile } from '../src/profiles.js';
import { NOW, SPOT_SCOPE, exchangeInfo, spotSymbol } from './fixtures/public-data.js';
import type { NetworkIo } from '../src/io.js';

function harness(raw: unknown) {
  let now = NOW;
  const registry = createInstrumentRegistry({ capacity: 1 });
  const request = vi.fn(() =>
    Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(raw) }),
  );
  const io: NetworkIo = { request, openSocket: vi.fn(), close: vi.fn(async () => {}) };
  const endpoint = getBinanceProfile('binance-spot-testnet-v1');
  const transport = createPublicTransport(
    endpoint,
    ['BTCUSDT'],
    registry,
    io,
    { reserve: () => Promise.resolve(true), observe: async () => {} },
    null,
    () => now,
  );
  const context = {
    profile: adapterProfile(endpoint),
    account: null,
    signal: new AbortController().signal,
    deadline: NOW + 5000,
    correlationId: 'metadata-binding',
  };
  return {
    registry,
    transport,
    context,
    request,
    advance: () => {
      now += 1;
    },
  };
}

it('does not resurrect a removed symbol from an injected registry', async () => {
  const h = harness(exchangeInfo([{ ...spotSymbol(), status: 'BREAK' }]));
  const previous = normalizeExchangeInfo(exchangeInfo(), SPOT_SCOPE, NOW - 100)[0]!;
  expect(h.registry.put(previous, NOW - 100).ok).toBe(true);
  expect(
    await h.transport.request(
      'getSymbols',
      { limit: 1, cursor: null, queryId: 'removed' },
      h.context,
    ),
  ).toMatchObject({ items: [] });
  expect(() => h.transport.record('BTCUSDT')).toThrow('STALE_METADATA');
  expect(() => h.transport.admission('BTCUSDT')).toThrow('STALE_METADATA');
});

it('refuses a cached admission whose registry rules were replaced independently', async () => {
  const h = harness(exchangeInfo());
  await h.transport.request('getSymbols', { limit: 1, cursor: null, queryId: 'first' }, h.context);
  const changed = spotSymbol();
  changed.filters[0]!.tickSize = '0.02000000';
  const updated = normalizeExchangeInfo(exchangeInfo([changed]), SPOT_SCOPE, NOW + 1)[0]!;
  h.advance();
  expect(h.registry.put(updated, NOW + 1).ok).toBe(true);
  expect(() => h.transport.record('BTCUSDT')).toThrow('STALE_METADATA');
  expect(() => h.transport.admission('BTCUSDT')).toThrow('STALE_METADATA');
});
