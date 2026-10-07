import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstrumentRecord, RequestContext, StreamOperation } from '@ctp/exchange-core';
import type { NetworkIo, NetworkSocket } from '../src/io.js';
import type { BinanceRateLimitPort } from '../src/ports.js';
import { adapterProfile, getBinanceProfile } from '../src/profiles.js';
import { normalizeExchangeInfo } from '../src/public-data.js';
import { createPublicStreams } from '../src/public-streams.js';
import {
  NOW,
  book,
  exchangeInfo,
  futuresSymbol,
  kline,
  spotSymbol,
} from './fixtures/public-data.js';

afterEach(() => vi.useRealTimers());
function setup(futures = false) {
  const endpoint = getBinanceProfile(
    futures ? 'binance-usdm-testnet-v1' : 'binance-spot-testnet-v1',
  );
  const record = normalizeExchangeInfo(
    exchangeInfo([futures ? futuresSymbol() : spotSymbol()]),
    endpoint.scope,
    NOW,
  )[0] as InstrumentRecord;
  const controller = new AbortController();
  const context: RequestContext = {
    profile: adapterProfile(endpoint),
    account: null,
    deadline: NOW + 20_000,
    signal: controller.signal,
    correlationId: 'fixture',
  };
  let message: ((text: string) => void) | undefined;
  let end: (() => void) | undefined;
  const close = vi.fn(() => Promise.resolve());
  const send = vi.fn(() => Promise.resolve());
  const socket: NetworkSocket = { close, send };
  const open = vi.fn<NetworkIo['openSocket']>((_url, _context, onMessage, onEnd) => {
    message = onMessage;
    end = onEnd;
    return Promise.resolve(socket);
  });
  const networkClose = vi.fn(() => Promise.resolve());
  const io: NetworkIo = {
    request: vi.fn(() => Promise.resolve({ status: 200, headers: {}, body: '{}' })),
    openSocket: open,
    close: networkClose,
  };
  const reserve = vi.fn<BinanceRateLimitPort['reserve']>(() => Promise.resolve(true));
  const limiter: BinanceRateLimitPort = { reserve, observe: () => Promise.resolve() };
  const events: unknown[] = [];
  const gap = vi.fn();
  let clock = NOW;
  const streams = createPublicStreams(endpoint, io, limiter, () => clock);
  const subscribe = (operation: StreamOperation, input: unknown = { instrumentId: 'BTCUSDT' }) =>
    streams.subscribe(operation, input, record, context, (event) => events.push(event), gap);
  const push = (payload: unknown, stream = 'btcusdt@ticker') => {
    message?.(JSON.stringify(futures ? payload : { stream, data: payload }));
  };
  return {
    endpoint,
    record,
    context,
    controller,
    io,
    open,
    close,
    send,
    limiter,
    reserve,
    networkClose,
    events,
    gap,
    streams,
    subscribe,
    push,
    raw: (text: string) => message?.(text),
    end: () => end?.(),
    clock: (value: number) => (clock = value),
  };
}
function tickerEvent() {
  return {
    e: '24hrTicker',
    E: String(NOW - 1),
    s: 'BTCUSDT',
    c: '100.12000000',
    b: '100.11000000',
    a: '100.13000000',
    v: '12.34000000',
    q: '1234.56000000',
    p: '-0.01000000',
  };
}
function aggregate(id = '9223372036854775807') {
  return {
    e: 'aggTrade',
    E: String(NOW),
    s: 'BTCUSDT',
    a: id,
    p: '100.12000000',
    q: '0.00001000',
    T: String(NOW - 1),
    m: true,
  };
}
function futuresBook(u = '9223372036854775807', pu = '9223372036854775806') {
  return {
    e: 'depthUpdate',
    E: String(NOW),
    T: String(NOW - 1),
    s: 'BTCUSDT',
    U: pu,
    u,
    pu,
    b: book().bids,
    a: book().asks,
    st: 1,
    ps: 'BTCUSDT',
  };
}

describe('public streams protocol contracts', () => {
  it.each([false, true])(
    'equal sequence with changed book requires resync (USD-M=%s)',
    async (futures) => {
      const f = setup(futures);
      const unsubscribe = await f.subscribe('subscribeOrderBook', {
        instrumentId: 'BTCUSDT',
        depth: 20,
      });
      const payload = futures ? futuresBook() : book();
      f.push(payload, 'btcusdt@depth20@100ms');
      f.push(
        futures ? { ...payload, b: [['99', '3']] } : { ...payload, bids: [['99', '3']] },
        'btcusdt@depth20@100ms',
      );
      expect(f.gap).toHaveBeenCalledTimes(1);
      expect(f.events).toHaveLength(1);
      await unsubscribe();
    },
  );
  it.each([false, true])(
    'normalizes exact ticker values and scoped URL (USD-M=%s)',
    async (futures) => {
      const f = setup(futures);
      const unsubscribe = await f.subscribe('subscribeTicker');
      f.push(tickerEvent());
      expect(f.events).toMatchObject([
        {
          instrumentId: 'BTCUSDT',
          last: { state: 'AVAILABLE', value: '100.12' },
          change: { state: 'AVAILABLE', value: '-0.01' },
        },
      ]);
      expect(f.open.mock.calls[0]?.[0].href).toBe(
        futures
          ? 'wss://demo-fstream.binance.com/market/ws/btcusdt@ticker'
          : 'wss://stream.testnet.binance.vision/stream?streams=btcusdt@ticker',
      );
      expect(f.reserve).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: f.endpoint.id,
          accountId: null,
          symbol: 'BTCUSDT',
          method: 'WS',
          weight: 0,
          orders: 0,
          connectionAttempts: 1,
          controlMessages: futures ? 1 : 2,
        }),
        expect.anything(),
      );
      expect(f.send).not.toHaveBeenCalled();
      await unsubscribe();
    },
  );
  it.each([false, true])(
    'uses aggregate identity without rounding numeric JSON tokens (USD-M=%s)',
    async (futures) => {
      const f = setup(futures);
      const unsubscribe = await f.subscribe('subscribeTrades');
      const payload = JSON.stringify(aggregate()).replace(
        '"9223372036854775807"',
        '9223372036854775807',
      );
      f.raw(futures ? payload : `{"stream":"btcusdt@aggTrade","data":${payload}}`);
      expect(f.events).toMatchObject([
        {
          tradeId: '9223372036854775807',
          sourceSequence: '9223372036854775807',
          identityScope: 'BINANCE:AGGREGATE_TRADES',
          price: '100.12',
          quantity: '0.00001',
          side: 'SELL',
        },
      ]);
      await unsubscribe();
    },
  );
  it.each([false, true])(
    'preserves candle completion and half-open close time (USD-M=%s)',
    async (futures) => {
      const f = setup(futures);
      const unsubscribe = await f.subscribe('subscribeCandles', {
        instrumentId: 'BTCUSDT',
        timeframe: '1m',
      });
      f.push(kline(), 'btcusdt@kline_1m');
      expect(f.events).toMatchObject([
        { timeframe: '1m', closeTime: NOW, complete: true, quality: 'COMPLETE', revision: NOW },
      ]);
      await unsubscribe();
    },
  );
  it.each([1, 5, 6, 10, 11, 20])(
    'uses the next native partial depth and trims requested depth %s',
    async (depth) => {
      const f = setup();
      const native = depth <= 5 ? 5 : depth <= 10 ? 10 : 20;
      const unsubscribe = await f.subscribe('subscribeOrderBook', {
        instrumentId: 'BTCUSDT',
        depth,
      });
      f.push(book(), `btcusdt@depth${native}@100ms`);
      expect(f.open.mock.calls[0]?.[0].href).toContain(`btcusdt@depth${native}@100ms`);
      expect(f.events).toMatchObject([
        {
          kind: 'SNAPSHOT',
          exchangeTime: null,
          sourceSequence: '9223372036854775807',
          previousSequence: null,
        },
      ]);
      expect((f.events[0] as { bids: unknown[] }).bids.length).toBe(Math.min(depth, 2));
      await unsubscribe();
    },
  );
  it('accepts nonconsecutive Spot snapshot IDs without inventing a diff gap', async () => {
    const f = setup();
    const unsubscribe = await f.subscribe('subscribeOrderBook', {
      instrumentId: 'BTCUSDT',
      depth: 20,
    });
    f.push({ ...book(), lastUpdateId: '100' }, 'btcusdt@depth20@100ms');
    f.push({ ...book(), lastUpdateId: '9000' }, 'btcusdt@depth20@100ms');
    expect(f.events).toHaveLength(2);
    expect(f.gap).not.toHaveBeenCalled();
    await unsubscribe();
  });
  it('validates USD-M partial stream pu without requiring u to increment by one', async () => {
    const f = setup(true);
    const unsubscribe = await f.subscribe('subscribeOrderBook', {
      instrumentId: 'BTCUSDT',
      depth: 20,
    });
    f.push(futuresBook('100', '80'));
    f.push(futuresBook('9000', '100'));
    expect(f.open.mock.calls[0]?.[0].href).toBe(
      'wss://demo-fstream.binance.com/public/ws/btcusdt@depth20@100ms',
    );
    expect(f.events).toMatchObject([
      { kind: 'SNAPSHOT', exchangeTime: NOW - 1, sourceSequence: '100' },
      { kind: 'SNAPSHOT', sourceSequence: '9000' },
    ]);
    expect(f.gap).not.toHaveBeenCalled();
    await unsubscribe();
  });
  it.each([false, true])('does not emit a duplicate snapshot (USD-M=%s)', async (futures) => {
    const f = setup(futures);
    const unsubscribe = await f.subscribe('subscribeOrderBook', {
      instrumentId: 'BTCUSDT',
      depth: 20,
    });
    const payload = futures ? futuresBook('100', '80') : { ...book(), lastUpdateId: '100' };
    f.push(payload, 'btcusdt@depth20@100ms');
    f.push(payload, 'btcusdt@depth20@100ms');
    expect(f.events).toHaveLength(1);
    expect(f.gap).not.toHaveBeenCalled();
    await unsubscribe();
  });
  it.each([false, true])('terminates on a regressing snapshot ID (USD-M=%s)', async (futures) => {
    const f = setup(futures);
    await f.subscribe('subscribeOrderBook', { instrumentId: 'BTCUSDT', depth: 20 });
    f.push(
      futures ? futuresBook('100', '80') : { ...book(), lastUpdateId: '100' },
      'btcusdt@depth20@100ms',
    );
    f.push(
      futures ? futuresBook('99', '80') : { ...book(), lastUpdateId: '99' },
      'btcusdt@depth20@100ms',
    );
    expect(f.events).toHaveLength(1);
    expect(f.gap).toHaveBeenCalledOnce();
  });
  it('terminates on a documented USD-M pu gap and does not reconnect', async () => {
    const f = setup(true);
    await f.subscribe('subscribeOrderBook', { instrumentId: 'BTCUSDT', depth: 20 });
    f.push(futuresBook('100', '80'));
    f.push(futuresBook('200', '150'));
    f.push(futuresBook('300', '200'));
    expect(f.events).toHaveLength(1);
    expect(f.gap).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
  });
  it.each([
    ['subscribeOrderBook', { instrumentId: 'BTCUSDT', depth: 21 }],
    ['subscribeOrderBook', { instrumentId: 'BTCUSDT', depth: 1000 }],
    ['subscribeCandles', { instrumentId: 'BTCUSDT', timeframe: '30s' }],
    ['subscribePrivateOrders', { instrumentId: 'BTCUSDT' }],
  ] as const)('rejects unsupported %s before limiter or network', async (operation, input) => {
    const f = setup();
    await expect(f.subscribe(operation, input)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it.each([
    'btcusdt@aggTrade',
    'ethusdt@ticker',
    'BTCUSDT@ticker',
    'btcusdt@ticker/ethusdt@ticker',
  ])('terminates on unexpected combined stream %s', async (stream) => {
    const f = setup();
    await f.subscribe('subscribeTicker');
    f.push(tickerEvent(), stream);
    f.push(tickerEvent());
    expect(f.events).toEqual([]);
    expect(f.gap).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each([
    '{"stream":"btcusdt@ticker"}',
    '{',
    '[]',
    'null',
    '{"e":"24hrTicker"}',
    '{"stream":"btcusdt@ticker","data":{},"unexpected":1}',
  ])('terminates on malformed envelope %s', async (raw) => {
    const f = setup();
    await f.subscribe('subscribeTicker');
    f.raw(raw);
    expect(f.events).toEqual([]);
    expect(f.gap).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each([false, true])('terminates on payload symbol mismatch (USD-M=%s)', async (futures) => {
    const f = setup(futures);
    await f.subscribe('subscribeTicker');
    f.push({ ...tickerEvent(), s: 'ETHUSDT' });
    expect(f.events).toEqual([]);
    expect(f.gap).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    'does not accept a raw trade event on an aggregate subscription (USD-M=%s)',
    async (futures) => {
      const f = setup(futures);
      await f.subscribe('subscribeTrades');
      f.push({ ...aggregate(), e: 'trade', t: '123' }, 'btcusdt@aggTrade');
      expect(f.events).toEqual([]);
      expect(f.gap).toHaveBeenCalledOnce();
    },
  );
  it('never passes a Spot diff update to the snapshot normalizer', async () => {
    const f = setup();
    await f.subscribe('subscribeOrderBook', { instrumentId: 'BTCUSDT', depth: 20 });
    f.push(
      { ...book(), e: 'depthUpdate', U: '10', u: '20', b: book().bids, a: book().asks },
      'btcusdt@depth20@100ms',
    );
    expect(f.events).toEqual([]);
    expect(f.gap).toHaveBeenCalledOnce();
  });
  it('rejects a snapshot exceeding the selected native depth', async () => {
    const f = setup();
    await f.subscribe('subscribeOrderBook', { instrumentId: 'BTCUSDT', depth: 1 });
    const bids = Array.from({ length: 6 }, (_, index) => [String(100 - index), '1']);
    f.push({ ...book(), bids }, 'btcusdt@depth5@100ms');
    expect(f.events).toEqual([]);
    expect(f.gap).toHaveBeenCalledOnce();
  });
  it.each(['0', '2', 'evil'])('rejects a non USD-M market discriminator %s', async (st) => {
    const f = setup(true);
    await f.subscribe('subscribeOrderBook', { instrumentId: 'BTCUSDT', depth: 20 });
    f.push({ ...futuresBook(), st });
    expect(f.events).toEqual([]);
    expect(f.gap).toHaveBeenCalledOnce();
  });
  it('reports source close once, closes the resource, and ignores late callbacks', async () => {
    const f = setup();
    await f.subscribe('subscribeTicker');
    f.end();
    f.end();
    f.push(tickerEvent());
    expect(f.gap).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.events).toEqual([]);
    await f.streams.disconnect();
  });
  it('unsubscribe is idempotent and suppresses close callbacks and late events', async () => {
    const f = setup();
    const unsubscribe = await f.subscribe('subscribeTicker');
    await Promise.all([unsubscribe(), unsubscribe()]);
    f.end();
    f.push(tickerEvent());
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.gap).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });
  it('abort closes the actual socket without a source-gap notification', async () => {
    const f = setup();
    await f.subscribe('subscribeTicker');
    const internalSignal = f.open.mock.calls[0]?.[1].signal;
    f.controller.abort();
    f.push(tickerEvent());
    await f.streams.disconnect();
    expect(internalSignal?.aborted).toBe(true);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.gap).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });
  it('deadline closes the socket and suppresses post-deadline callbacks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = setup();
    await f.subscribe('subscribeTicker');
    await vi.advanceTimersByTimeAsync(20_000);
    f.push(tickerEvent());
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.gap).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('checks the absolute deadline before receiving even if its timer has not fired', async () => {
    const f = setup();
    await f.subscribe('subscribeTicker');
    f.clock(f.context.deadline);
    f.push(tickerEvent());
    await f.streams.disconnect();
    expect(f.events).toEqual([]);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.gap).not.toHaveBeenCalled();
  });
  it('rejects an already aborted call before reserving rate budget', async () => {
    const f = setup();
    f.controller.abort();
    await expect(f.subscribe('subscribeTicker')).rejects.toMatchObject({ code: 'ABORTED' });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('rejects an elapsed deadline before rate reservation', async () => {
    const f = setup();
    f.clock(f.context.deadline);
    await expect(f.subscribe('subscribeTicker')).rejects.toMatchObject({
      code: 'DEADLINE_EXCEEDED',
    });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('respects limiter refusal without opening a socket', async () => {
    const f = setup();
    f.reserve.mockResolvedValue(false);
    await expect(f.subscribe('subscribeTicker')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(f.open).not.toHaveBeenCalled();
  });
  it('checks abort again after asynchronous rate admission', async () => {
    const f = setup();
    f.reserve.mockImplementation(() => {
      f.controller.abort();
      return Promise.resolve(true);
    });
    await expect(f.subscribe('subscribeTicker')).rejects.toMatchObject({ code: 'ABORTED' });
    expect(f.open).not.toHaveBeenCalled();
  });
  it('settles abort while a rate coordinator is hung, and ignores late admission', async () => {
    const f = setup();
    let admit!: (value: boolean) => void;
    f.reserve.mockReturnValue(new Promise<boolean>((resolve) => (admit = resolve)));
    const pending = f.subscribe('subscribeTicker');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    f.controller.abort();
    await rejected;
    admit(true);
    await f.streams.disconnect();
    expect(f.open).not.toHaveBeenCalled();
  });
  it('settles a deadline while a rate coordinator is hung', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = setup();
    f.reserve.mockReturnValue(new Promise<boolean>(() => undefined));
    const pending = f.subscribe('subscribeTicker');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    await f.streams.disconnect();
    expect(f.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases a failed handshake and leaves no stale deadline or source entry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = setup();
    f.open.mockRejectedValue(new Error('fixture failed handshake'));
    await expect(f.subscribe('subscribeTicker')).rejects.toThrow('fixture failed handshake');
    await f.streams.disconnect();
    expect(f.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes a late handshake success after abort and waits for underlying settlement', async () => {
    const f = setup();
    let opened!: (socket: NetworkSocket) => void;
    f.open.mockImplementation(() => new Promise<NetworkSocket>((resolve) => (opened = resolve)));
    const pending = f.subscribe('subscribeTicker');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    f.controller.abort();
    let disconnected = false;
    const closing = f.streams.disconnect().then(() => (disconnected = true));
    await Promise.resolve();
    expect(disconnected).toBe(false);
    opened({ close: f.close, send: f.send });
    await rejected;
    await closing;
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.events).toEqual([]);
    expect(f.gap).not.toHaveBeenCalled();
  });
  it('rejects input/record/profile mismatches before budget or network', async () => {
    const f = setup();
    await expect(f.subscribe('subscribeTicker', { instrumentId: 'ETHUSDT' })).rejects.toMatchObject(
      { code: 'SCOPE_MISMATCH' },
    );
    await expect(
      f.streams.subscribe(
        'subscribeTicker',
        { instrumentId: 'BTCUSDT' },
        f.record,
        { ...f.context, profile: adapterProfile(getBinanceProfile('binance-spot-live-v1')) },
        () => undefined,
        f.gap,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
  it('disconnect closes all active streams and prevents reopening', async () => {
    const f = setup();
    await f.subscribe('subscribeTicker');
    await f.subscribe('subscribeTrades');
    await Promise.all([f.streams.disconnect(), f.streams.disconnect()]);
    expect(f.close).toHaveBeenCalledTimes(2);
    await expect(f.subscribe('subscribeTicker')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.networkClose).not.toHaveBeenCalled();
  });
});
