import { describe, expect, it, vi } from 'vitest';
import {
  createInstrumentRegistry,
  capabilityRecordSchema,
  featureSchema,
  type RequestContext,
} from '@ctp/exchange-core';
import { createBinanceAdapterWithIo } from '../src/adapter.js';
import type { BinanceAdapterOptions } from '../src/ports.js';
import type { NetworkIo } from '../src/io.js';
import { adapterProfile, getBinanceProfile } from '../src/profiles.js';
import { NOW, exchangeInfo, spotSymbol, ticker } from './fixtures/public-data.js';

function options(): BinanceAdapterOptions {
  const profileId = 'binance-spot-testnet-v1';
  const profile = adapterProfile(getBinanceProfile(profileId));
  return {
    profileId,
    registry: createInstrumentRegistry({ capacity: 2, versionCapacity: 100_000 }),
    symbols: ['BTCUSDT', 'ETHUSDT'],
    now: () => NOW,
    capabilities: featureSchema.options.map((feature) =>
      capabilityRecordSchema.parse({
        profile,
        feature,
        support: 'SUPPORTED',
        implementation: 'NATIVE',
        constraints: {},
        evidenceUrl: 'https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md',
        checkedAt: NOW - 1,
        expiresAt: NOW + 60_000,
        adapterVersion: 'binance-v1',
      }),
    ),
    limiter: { reserve: vi.fn(() => Promise.resolve(true)), observe: vi.fn(async () => {}) },
  };
}
function fixture(input: BinanceAdapterOptions = options()) {
  const queue: unknown[] = [];
  const requests = vi.fn(() =>
    Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify(queue.shift()),
    }),
  );
  const close = vi.fn(async () => {});
  const io: NetworkIo = { request: requests, openSocket: vi.fn(), close };
  const adapter = createBinanceAdapterWithIo(input, io);
  const controller = new AbortController();
  const context: RequestContext = {
    profile: adapter.profile,
    account: adapter.account,
    signal: controller.signal,
    deadline: NOW + 5000,
    correlationId: 'factory-contract',
  };
  return { adapter, io, close, queue, requests, context, controller };
}
describe('Binance server composition and Exchange Core agreement', () => {
  it('intersects supplied capability evidence with implemented protocol support', () => {
    const h = fixture();
    for (const feature of [
      'ALGO_ORDERS',
      'QUOTE_BUDGET_MARKET_BUY',
      'AMEND_ORDER',
      'CHANGE_POSITION_MODE',
      'SET_LEVERAGE',
      'REDUCE_ONLY',
    ]) {
      expect(h.adapter.capabilities.find((value) => value.feature === feature)?.support).toBe(
        'UNSUPPORTED',
      );
    }
    expect(h.adapter.capabilities.find((value) => value.feature === 'PUBLIC_READ')?.support).toBe(
      'SUPPORTED',
    );
    expect(
      h.adapter.capabilities.find((value) => value.feature === 'HISTORICAL_CANDLES')?.constraints
        .timeframes,
    ).not.toContain('30s');
  });
  it('exports all generic methods while retaining strict Core context checks', async () => {
    const h = fixture();
    h.queue.push(exchangeInfo());
    const result = await h.adapter.getSymbols(
      { limit: 20, cursor: null, queryId: 'first' },
      h.context,
    );
    expect(result).toMatchObject({ ok: true, value: { items: [{ id: 'BTCUSDT' }] } });
    h.queue.push(ticker());
    expect(await h.adapter.getTicker({ instrumentId: 'BTCUSDT' }, h.context)).toMatchObject({
      ok: true,
      value: { last: { value: '100.12' } },
    });
    expect(
      await h.adapter.getTicker(
        { instrumentId: 'BTCUSDT' },
        { ...h.context, profile: { ...h.context.profile, environment: 'LIVE' } },
      ),
    ).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    expect(h.requests).toHaveBeenCalledTimes(2);
  });
  it('uses opaque Core cursors and rejects changing page query scope', async () => {
    const h = fixture();
    h.queue.push(
      exchangeInfo([spotSymbol(), { ...spotSymbol(), symbol: 'ETHUSDT', baseAsset: 'ETH' }]),
    );
    const query = { limit: 1, cursor: null, queryId: 'symbols-paged' };
    const first = await h.adapter.getSymbols(query, h.context);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.nextCursor).not.toBe(`${NOW}.1`);
    expect(
      await h.adapter.getSymbols({ ...query, cursor: first.value.nextCursor }, h.context),
    ).toMatchObject({ ok: true, value: { items: [{ id: 'ETHUSDT' }], nextCursor: null } });
    expect(
      await h.adapter.getSymbols(
        { ...query, queryId: 'changed', cursor: first.value.nextCursor },
        h.context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(h.requests).toHaveBeenCalledOnce();
  });
  it('defaults private operations to denied without a server connection', async () => {
    const h = fixture();
    expect(await h.adapter.getBalances({}, h.context)).toMatchObject({
      ok: false,
      error: { code: 'AUTHORIZATION_REQUIRED' },
    });
    expect(h.requests).not.toHaveBeenCalled();
  });
  it.each([
    { rest: 'https://user.example' },
    { apiKey: 'raw-secret' },
    { tenantId: 'hint' },
    { url: 'http://localhost' },
  ])('rejects unknown authority options %j', (extra) => {
    expect(() => fixture({ ...options(), ...extra })).toThrow('INVALID_BINANCE_CONFIGURATION');
  });
  it.each(
    [[], ['BTCUSDT', 'BTCUSDT'], ['BTCUSDT?signature=x'], ['btcusdt']].map((symbols) => ({
      symbols,
    })),
  )('rejects invalid configured symbol universe %j', ({ symbols }) => {
    expect(() => fixture({ ...options(), symbols })).toThrow('INVALID_BINANCE_CONFIGURATION');
  });
  it('rejects stale evidence before any exchange request', async () => {
    const input = options();
    const h = fixture({
      ...input,
      capabilities: input.capabilities.map((value) => ({
        ...value,
        checkedAt: NOW - 1000,
        expiresAt: NOW,
      })),
    });
    expect(
      await h.adapter.getSymbols({ limit: 1, cursor: null, queryId: 'stale' }, h.context),
    ).toMatchObject({ ok: false, error: { code: 'STALE_CAPABILITY' } });
    expect(h.requests).not.toHaveBeenCalled();
  });
  it('disconnect releases real IO assembly once and forbids further requests', async () => {
    const h = fixture();
    await Promise.all([h.adapter.disconnect(), h.adapter.disconnect()]);
    expect(h.close).toHaveBeenCalledOnce();
    expect(await h.adapter.connect({}, h.context)).toMatchObject({
      ok: false,
      error: { code: 'CLOSED' },
    });
    expect(h.requests).not.toHaveBeenCalled();
  });
});
