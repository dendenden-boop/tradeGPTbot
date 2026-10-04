import { describe, expect, it, vi } from 'vitest';
import { createInstrumentRegistry } from '@ctp/exchange-core';
import { createPublicTransport } from '../src/public-transport.js';
import { getOkxProfile, adapterProfile } from '../src/profiles.js';
import type { HttpRequest, NetworkIo } from '../src/io.js';
import { nativeInstrument, now } from './fixtures.js';
const context = () => ({
  signal: new AbortController().signal,
  deadline: now + 5000,
  profile: adapterProfile(getOkxProfile('okx-spot-demo-v1')),
  account: null,
  correlationId: 'test',
});
function fixture(rows: unknown[] = [nativeInstrument()]) {
  let time = now;
  const requests: HttpRequest[] = [];
  const io: NetworkIo = {
    request: vi.fn<NetworkIo['request']>((input) => {
      requests.push(input);
      const data = input.url.pathname.endsWith('/instruments')
        ? rows
        : input.url.pathname.endsWith('/time')
          ? [{ ts: String(time) }]
          : input.url.pathname.endsWith('/ticker')
            ? [
                {
                  instId: 'BTC-USDT',
                  instType: 'SPOT',
                  last: '50000',
                  bidPx: '49999',
                  askPx: '50001',
                  ts: String(time),
                },
              ]
            : input.url.pathname.endsWith('/books')
              ? [
                  {
                    ts: String(time),
                    seqId: '10',
                    asks: [['50001', '1', '0', '1']],
                    bids: [['49999', '2', '0', '1']],
                  },
                ]
              : [];
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ code: '0', data }),
      });
    }),
    openSocket: () => Promise.reject(new Error('NO_WS')),
    close: async () => {},
  };
  const registry = createInstrumentRegistry({ capacity: 2 });
  const transport = createPublicTransport(
    getOkxProfile('okx-spot-demo-v1'),
    ['BTC-USDT'],
    registry,
    io,
    { reserve: () => Promise.resolve(true), observe: async () => {} },
    null,
    () => time,
  );
  return {
    transport,
    requests,
    registry,
    advance: (n: number) => {
      time += n;
    },
  };
}
describe('OKX public REST scope, metadata leases and half-open history', () => {
  it('public time preserves native exchange timestamp', async () => {
    const f = fixture();
    expect(await f.transport.request('getServerTime', {}, context())).toEqual({
      exchangeTime: now,
      receivedAt: now,
    });
  });
  it('selected instruments retain fresh registry/rules and scoped snapshot', async () => {
    const f = fixture();
    const p = await f.transport.request(
      'getSymbols',
      { cursor: null, limit: 1, queryId: 'q' },
      context(),
    );
    expect(p).toMatchObject({ items: [{ id: 'BTC-USDT' }], nextCursor: null });
    expect(f.transport.record('BTC-USDT').rules.quantityUnit).toBe('BASE');
    expect(() => f.transport.record('ETH-USDT')).toThrow();
  });
  it('public ticker and book decode native array envelopes', async () => {
    const f = fixture();
    expect(
      await f.transport.request('getTicker', { instrumentId: 'BTC-USDT' }, context()),
    ).toMatchObject({ last: { value: '50000' } });
    expect(
      await f.transport.request('getOrderBook', { instrumentId: 'BTC-USDT', depth: 10 }, context()),
    ).toMatchObject({ bids: [{ quantity: '2' }], sourceSequence: '10' });
  });
  it('cannot extend upcoming-change metadata TTL or use old metadata for admission', async () => {
    const f = fixture([
      {
        ...nativeInstrument(),
        upcChg: [{ param: 'tickSz', newValue: '1', effTime: String(now + 2000) }],
      },
    ]);
    await f.transport.refresh(context());
    f.advance(2000);
    expect(() => f.transport.record('BTC-USDT')).toThrow();
  });
  it('duplicate selected metadata cannot enter registry', async () => {
    const f = fixture([nativeInstrument(), nativeInstrument()]);
    await expect(f.transport.refresh(context())).rejects.toThrow();
    expect(f.registry.size()).toBe(0);
  });
  it('empty history interval dispatches no candle call', async () => {
    const f = fixture();
    expect(
      await f.transport.request(
        'getHistoricalCandles',
        {
          instrumentId: 'BTC-USDT',
          cursor: null,
          from: now,
          to: now,
          timeframe: '1m',
          limit: 100,
          queryId: 'q',
        },
        context(),
      ),
    ).toMatchObject({ items: [], nextCursor: null });
    expect(f.requests.some((r) => r.url.pathname.endsWith('/history-candles'))).toBe(false);
  });
  it('history uses exclusive native after/before bounds and UTC daily bar', async () => {
    const f = fixture(),
      start = Math.floor(now / 86400000) * 86400000 - 86400000;
    await f.transport.request(
      'getHistoricalCandles',
      {
        instrumentId: 'BTC-USDT',
        cursor: null,
        from: start,
        to: start + 86400000,
        timeframe: '1d',
        limit: 100,
        queryId: 'q',
      },
      context(),
    );
    const request = f.requests.at(-1)!;
    expect(Object.fromEntries(request.url.searchParams)).toMatchObject({
      bar: '1Dutc',
      after: String(start + 86400000),
      before: String(start - 1),
    });
  });
});
