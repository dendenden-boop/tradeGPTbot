import { describe, it, expect, vi } from 'vitest';
import { capabilityRecordSchema } from '@ctp/exchange-core';
import { createBinanceAdapterWithIo } from '../src/adapter.js';
import { adapterProfile, getBinanceProfile } from '../src/profiles.js';
import type { HttpResponse, NetworkIo } from '../src/io.js';
import { NOW, exchangeInfo, spotSymbol } from './fixtures/public-data.js';

function harness() {
  const endpoint = getBinanceProfile('binance-spot-testnet-v1');
  const profile = adapterProfile(endpoint);
  const resolvers: Array<(value: HttpResponse) => void> = [];
  const io: NetworkIo = {
    request: () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
    openSocket: () => Promise.reject(new Error('UNUSED')),
    close: () => Promise.resolve(),
  };
  const adapter = createBinanceAdapterWithIo(
    {
      profileId: endpoint.id,
      symbols: ['BTCUSDT', 'ETHUSDT'],
      now: () => NOW,
      limiter: { reserve: () => Promise.resolve(true), observe: () => Promise.resolve() },
      capabilities: [
        capabilityRecordSchema.parse({
          profile,
          feature: 'PUBLIC_READ',
          support: 'SUPPORTED',
          implementation: 'NATIVE',
          constraints: {},
          evidenceUrl: 'https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md',
          checkedAt: NOW - 1,
          expiresAt: NOW + 60_000,
          adapterVersion: 'binance-v1',
        }),
      ],
    },
    io,
  );
  const context = {
    profile: adapter.profile,
    account: null,
    deadline: NOW + 2000,
    signal: new AbortController().signal,
    correlationId: 'metadata-concurrency',
  };
  const query = { limit: 1, cursor: null, queryId: 'same-query' };
  const respond = (index: number, symbols: unknown[]) =>
    resolvers[index]?.({ status: 200, headers: {}, body: JSON.stringify(exchangeInfo(symbols)) });
  return { adapter, context, query, resolvers, respond };
}
describe('metadata observation identity under concurrency', () => {
  it('accepts concurrent same-millisecond A -> B -> A observations without version reuse', async () => {
    const h = harness();
    try {
      const pending = [0, 1, 2].map(() => h.adapter.getSymbols(h.query, h.context));
      await vi.waitFor(() => expect(h.resolvers).toHaveLength(3));
      const a = spotSymbol(),
        b = spotSymbol();
      b.filters[0]!.tickSize = '0.02000000';
      const results = [];
      for (const [index, symbol] of [a, b, a].entries()) {
        h.respond(index, [symbol]);
        results.push(await pending[index]);
      }
      expect(results.map((result) => result?.ok)).toEqual([true, true, true]);
    } finally {
      await h.adapter.disconnect();
    }
  });
  it('never uses an earlier page cursor with another observation in the same millisecond', async () => {
    const h = harness();
    try {
      const firstPending = h.adapter.getSymbols(h.query, h.context),
        secondPending = h.adapter.getSymbols(h.query, h.context);
      await vi.waitFor(() => expect(h.resolvers).toHaveLength(2));
      const a = spotSymbol(),
        eth = { ...spotSymbol(), symbol: 'ETHUSDT', baseAsset: 'ETH' };
      h.respond(0, [a, eth]);
      const first = await firstPending;
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.nextCursor).not.toBeNull();
      const changed = {
        ...eth,
        filters: eth.filters.map((filter) =>
          filter.filterType === 'PRICE_FILTER' ? { ...filter, tickSize: '0.02000000' } : filter,
        ),
      };
      h.respond(1, [a, changed]);
      expect((await secondPending).ok).toBe(true);
      expect(
        await h.adapter.getSymbols({ ...h.query, cursor: first.value.nextCursor }, h.context),
      ).toMatchObject({ ok: false, error: { code: 'STALE_METADATA' } });
    } finally {
      await h.adapter.disconnect();
    }
  });
});
