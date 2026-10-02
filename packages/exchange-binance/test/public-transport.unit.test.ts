import { describe, expect, it, vi } from 'vitest';
import { createInstrumentRegistry } from '@ctp/exchange-core';
import { createPublicTransport } from '../src/public-transport.js';
import { adapterProfile, getBinanceProfile } from '../src/profiles.js';
import type { NetworkIo, HttpRequest } from '../src/io.js';
import { NOW, exchangeInfo, ticker, book, candle, futuresSymbol } from './fixtures/public-data.js';

function harness(futures = false) {
  let now = NOW;
  const endpoint = getBinanceProfile(
    futures ? 'binance-usdm-testnet-v1' : 'binance-spot-testnet-v1',
  );
  const requests: HttpRequest[] = [];
  const queue: unknown[] = [];
  const request = vi.fn((input: HttpRequest) => {
    requests.push(input);
    const data = queue.shift();
    return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(data) });
  });
  const io: NetworkIo = { request, openSocket: vi.fn(), close: vi.fn(async () => {}) };
  const limiter = { reserve: vi.fn(() => Promise.resolve(true)), observe: vi.fn(async () => {}) };
  const registry = createInstrumentRegistry({ capacity: 200 });
  const transport = createPublicTransport(
    endpoint,
    ['BTCUSDT'],
    registry,
    io,
    limiter,
    null,
    () => now,
  );
  const context = () => ({
    profile: adapterProfile(endpoint),
    account: null,
    signal: new AbortController().signal,
    deadline: now + 5000,
    correlationId: 'test-public',
  });
  const query = { limit: 1, cursor: null, queryId: 'symbols-1' };
  const load = async () => {
    queue.push(exchangeInfo(futures ? [futuresSymbol()] : undefined));
    return transport.request('getSymbols', query, context());
  };
  return {
    transport,
    queue,
    context,
    query,
    load,
    requests,
    limiter,
    registry,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('Binance public protocol transport', () => {
  it.each([false, true])(
    'loads only server-selected instruments and costs (%s)',
    async (futures) => {
      const h = harness(futures);
      const page = await h.load();
      expect(page).toMatchObject({
        items: [{ id: 'BTCUSDT' }],
        nextCursor: null,
        queryId: 'symbols-1',
      });
      expect(h.requests[0]?.url.host).toBe(
        futures ? 'demo-fapi.binance.com' : 'testnet.binance.vision',
      );
      expect(h.limiter.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ weight: futures ? 1 : 20, orders: 0 }),
        expect.anything(),
      );
      if (!futures) expect(h.requests[0]?.url.searchParams.get('symbols')).toBe('["BTCUSDT"]');
    },
  );
  it('returns cached metadata without faking a fresh lease', async () => {
    const h = harness();
    await h.load();
    const result = h.registry.get(
      getBinanceProfile('binance-spot-testnet-v1').scope,
      'BTCUSDT',
      NOW,
    );
    expect(result.ok).toBe(true);
    await h.transport.request('getSymbolInfo', { instrumentId: 'BTCUSDT' }, h.context());
    expect(h.requests).toHaveLength(1);
    h.advance(60_001);
    await expect(
      h.transport.request('getTicker', { instrumentId: 'BTCUSDT' }, h.context()),
    ).rejects.toMatchObject({ code: 'STALE_METADATA' });
    expect(h.requests).toHaveLength(1);
  });
  it('normalizes REST ticker and Spot book with no invented timestamp', async () => {
    const h = harness();
    await h.load();
    h.queue.push(ticker(), book());
    expect(
      await h.transport.request('getTicker', { instrumentId: 'BTCUSDT' }, h.context()),
    ).toMatchObject({ last: { value: '100.12' } });
    expect(
      await h.transport.request('getOrderBook', { instrumentId: 'BTCUSDT', depth: 2 }, h.context()),
    ).toMatchObject({
      exchangeTime: null,
      sourceSequence: '9223372036854775807',
      bids: [{ price: '100' }, { price: '99.9' }],
    });
    expect(h.requests[2]?.url.searchParams.get('limit')).toBe('5');
  });
  it('uses [from,to) UTC windows and exclusive inclusive-end conversion', async () => {
    const h = harness();
    await h.load();
    h.queue.push([candle(NOW - 120_000), candle(NOW - 60_000)]);
    const query = {
      instrumentId: 'BTCUSDT',
      timeframe: '1m',
      from: NOW - 120_000,
      to: NOW,
      limit: 1,
      cursor: null,
      queryId: 'history-1',
    };
    const first = await h.transport.request('getHistoricalCandles', query, h.context());
    expect(first).toMatchObject({
      items: [{ openTime: NOW - 120_000 }],
      nextCursor: String(NOW - 60_000),
    });
    expect(h.requests[1]?.url.searchParams.get('endTime')).toBe(String(NOW - 1));
    h.queue.push([candle(NOW - 60_000)]);
    expect(
      await h.transport.request(
        'getHistoricalCandles',
        { ...query, cursor: String(NOW - 60_000) },
        h.context(),
      ),
    ).toMatchObject({ items: [{ openTime: NOW - 60_000 }], nextCursor: null });
  });
  it('rejects candles outside the requested window instead of silently filtering', async () => {
    const h = harness();
    await h.load();
    h.queue.push([candle(NOW - 180_000)]);
    await expect(
      h.transport.request(
        'getHistoricalCandles',
        {
          instrumentId: 'BTCUSDT',
          timeframe: '1m',
          from: NOW - 120_000,
          to: NOW,
          limit: 1,
          cursor: null,
          queryId: 'history-1',
        },
        h.context(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('does no I/O for unsupported 30s candles or private operations', async () => {
    const h = harness();
    await h.load();
    await expect(
      h.transport.request(
        'getHistoricalCandles',
        {
          instrumentId: 'BTCUSDT',
          timeframe: '30s',
          from: NOW - 60_000,
          to: NOW,
          limit: 1,
          cursor: null,
          queryId: 'history-1',
        },
        h.context(),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(h.transport.request('getBalances', {}, h.context())).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    expect(h.requests).toHaveLength(1);
  });
  it('fails closed when rate admission denies or expires while waiting', async () => {
    const h = harness();
    h.limiter.reserve.mockResolvedValueOnce(false);
    await expect(h.load()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(h.requests).toHaveLength(0);
    h.limiter.reserve.mockImplementationOnce(() => {
      h.advance(6000);
      return Promise.resolve(true);
    });
    await expect(h.load()).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(h.requests).toHaveLength(0);
  });
  it('uses a real public time response, never local time as exchange evidence', async () => {
    const h = harness();
    h.queue.push({ serverTime: NOW - 10 });
    expect(await h.transport.request('getServerTime', {}, h.context())).toEqual({
      exchangeTime: NOW - 10,
      receivedAt: NOW,
    });
  });
});
