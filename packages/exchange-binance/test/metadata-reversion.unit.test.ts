import { expect, it } from 'vitest';
import { createInstrumentRegistry } from '@ctp/exchange-core';
import { normalizeExchangeInfo } from '../src/public-data.js';
import { exchangeInfo, spotSymbol, SPOT_SCOPE, NOW } from './fixtures/public-data.js';

it('accepts fresh Binance metadata A -> B -> A without reusing immutable version evidence', () => {
  const registry = createInstrumentRegistry({ capacity: 1 });
  const a = spotSymbol(),
    b = spotSymbol();
  b.filters[0] = {
    filterType: 'PRICE_FILTER',
    minPrice: '0.01000000',
    maxPrice: '1000000.00000000',
    tickSize: '0.02000000',
  };
  for (const [index, symbol] of [a, b, a].entries()) {
    const observedAt = NOW + index;
    const record = normalizeExchangeInfo(exchangeInfo([symbol]), SPOT_SCOPE, observedAt)[0];
    expect(record).toBeDefined();
    if (record) expect(registry.put(record, observedAt)).toMatchObject({ ok: true });
  }
});
