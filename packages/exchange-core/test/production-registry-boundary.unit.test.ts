import { afterEach, expect, it } from 'vitest';
import { createBinanceAdapter } from '../../exchange-binance/src/index.js';
import { createBybitAdapter } from '../../exchange-bybit/src/index.js';
import { createOkxAdapter } from '../../exchange-okx/src/index.js';
import { createHtxAdapter } from '../../exchange-htx/src/index.js';
import { createInstrumentRegistry } from '../src/registry.js';
import type { ExchangeAdapter } from '../src/adapter.js';

const opened: ExchangeAdapter[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.disconnect()));
});
it.each([
  ['BINANCE', 'binance-spot-testnet-v1', 'BTCUSDT', createBinanceAdapter],
  ['BYBIT', 'bybit-spot-testnet-v1', 'BTCUSDT', createBybitAdapter],
  ['OKX', 'okx-spot-demo-v1', 'BTC-USDT', createOkxAdapter],
  ['HTX', 'htx-spot-live-v1', 'btcusdt', createHtxAdapter],
] as const)(
  '%s production factory rejects the finite reference registry before network allocation',
  (exchange, profileId, symbol, factory) => {
    expect(() => {
      opened.push(
        factory({
          profileId,
          symbols: [symbol],
          capabilities: [],
          limiter: { reserve: () => Promise.resolve(true), observe: async () => {} },
          registry: createInstrumentRegistry({ capacity: 300, versionCapacity: 100_000 }),
        } as never),
      );
    }).toThrow(`INVALID_${exchange}_CONFIGURATION`);
  },
);
