import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createNativeTradeFeed } from '../src/native-feed.js';
import { nativeFeed } from '../src/native-io.js';
import { wsFixture, httpFixture, until } from '../../exchange-binance/test/fixtures/io.js';
import { gzipSync } from 'node:zlib';
import { createInstrumentRegistry, type MarketScope } from '@ctp/exchange-core';
import { recordFixture } from '../../exchange-core/test/fixtures/domain.js';
import { scope, registry } from './fixtures.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const limiter = {
  reserve() {
    return Promise.resolve(true);
  },
};
const intents = [{ scope, instrumentId: 'BTCUSDT', profileId: 'binance-spot-testnet-v1' }];
it('sends a correctly masked client PONG on a real server PING', async () => {
  const pongs: Buffer[] = [];
  const server = await wsFixture((ws) => {
    ws.on('pong', (payload) => pongs.push(Buffer.from(payload)));
    ws.on('message', (raw) => {
      const x = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : '') as { id: number };
      ws.send(JSON.stringify({ id: x.id, result: null }));
      ws.ping(Buffer.from('heartbeat'));
    });
  });
  cleanup.push(() => server.close());
  const feed = nativeFeed({
    registry: registry(1),
    limiter,
    dial: () => new WebSocket(server.url, { autoPong: false }),
  });
  const conn = await feed.open(
    intents,
    { signal: new AbortController().signal, deadline: Date.now() + 2000 },
    () => {},
    () => {},
  );
  cleanup.push(() => conn.close());
  await until(() => pongs.length === 1);
  expect(pongs[0]?.toString()).toBe('heartbeat');
  expect(server.ws.clients.size).toBe(1);
});
it.each([
  ['BYBIT', 'SPOT', 'TESTNET', 'bybit-spot-testnet-v1', 'BTCUSDT'],
  ['BYBIT', 'LINEAR_PERPETUAL', 'TESTNET', 'bybit-linear-testnet-v1', 'BTCUSDT'],
  ['OKX', 'SPOT', 'DEMO', 'okx-spot-demo-v1', 'BTC-USDT'],
  ['OKX', 'LINEAR_PERPETUAL', 'DEMO', 'okx-swap-demo-v1', 'BTC-USDT-SWAP'],
  ['HTX', 'SPOT', 'LIVE', 'htx-spot-live-v1', 'btcusdt'],
  ['HTX', 'LINEAR_PERPETUAL', 'LIVE', 'htx-linear-live-v1', 'BTC-USDT'],
  ['BINANCE', 'LINEAR_PERPETUAL', 'TESTNET', 'binance-usdm-testnet-v1', 'BTCUSDT'],
] as const)(
  'native read-only batch ACK and normalization %s/%s',
  async (exchange, market, environment, profileId, symbol) => {
    const marketScope: MarketScope = { exchange, market, environment, region: 'global' },
      r = createInstrumentRegistry({ capacity: 1 });
    const fixtureRecord = recordFixture(marketScope),
      record = {
        instrument: { ...fixtureRecord.instrument, id: symbol, exchangeSymbol: symbol },
        rules: {
          ...fixtureRecord.rules,
          instrumentId: symbol,
          effectiveAt: 0,
          expiresAt: 8640000000000,
        },
      };
    expect(r.put(record, Date.now()).ok).toBe(true);
    const received: unknown[] = [];
    const server = await wsFixture((ws) =>
      ws.on('message', (bytes) => {
        const command = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString() : '') as Record<
          string,
          unknown
        >;
        const time = Date.now();
        if (exchange === 'BINANCE') {
          ws.send(JSON.stringify({ id: command.id, result: null }));
          ws.send(
            JSON.stringify({
              e: 'aggTrade',
              s: symbol,
              a: '90071992547409931234',
              p: '10',
              q: '2',
              T: time,
              m: false,
            }),
          );
        } else if (exchange === 'BYBIT') {
          ws.send(JSON.stringify({ op: 'subscribe', req_id: command.req_id, success: true }));
          ws.send(
            JSON.stringify({
              topic: `publicTrade.${symbol}`,
              data: [{ s: symbol, i: 'opaque-trade', T: time, S: 'Buy', p: '10', v: '2' }],
            }),
          );
        } else if (exchange === 'OKX') {
          ws.send(
            JSON.stringify({ event: 'subscribe', arg: { channel: 'trades', instId: symbol } }),
          );
          ws.send(
            JSON.stringify({
              arg: { channel: 'trades', instId: symbol },
              data: [
                {
                  tradeId: '90071992547409931234',
                  ts: String(time),
                  side: 'buy',
                  px: '10',
                  sz: '2',
                },
              ],
            }),
          );
        } else {
          ws.send(gzipSync(JSON.stringify({ status: 'ok', subbed: command.sub, id: command.id })));
          ws.send(
            gzipSync(
              JSON.stringify({
                ch: command.sub,
                ts: time,
                tick: {
                  data: [
                    {
                      tradeId: '90071992547409931234',
                      ts: time,
                      direction: 'buy',
                      price: '10',
                      amount: '2',
                    },
                  ],
                },
              }),
            ),
          );
        }
      }),
    );
    cleanup.push(() => server.close());
    const feed = nativeFeed({
      registry: r,
      limiter,
      dial: () => new WebSocket(server.url, { autoPong: false }),
    });
    const connection = await feed.open(
      [{ scope: marketScope, instrumentId: symbol, profileId }],
      { signal: new AbortController().signal, deadline: Date.now() + 2000 },
      (_key, input) => received.push(input),
      () => {},
    );
    cleanup.push(() => connection.close());
    await until(() => received.length > 0);
    expect(received[0]).toMatchObject({
      kind: 'TRADE',
      tick: {
        quantityUnit: 'BASE',
        quantity: (exchange === 'HTX' || exchange === 'OKX') && market !== 'SPOT' ? '0.02' : '2',
      },
      executionCount: exchange === 'OKX' || exchange === 'BINANCE' ? null : 1,
    });
  },
);
it('quiet source watchdog closes real sockets; heartbeat cannot mark market data fresh', async () => {
  const server = await wsFixture((ws) =>
    ws.on('message', (raw) => {
      const x = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : '') as { id: number };
      ws.send(JSON.stringify({ id: x.id, result: null }));
    }),
  );
  cleanup.push(() => server.close());
  let now = Date.now();
  const gaps: string[] = [];
  const feed = nativeFeed({
    registry: registry(1),
    limiter,
    now: () => now,
    dial: () => new WebSocket(server.url, { autoPong: false }),
  });
  const conn = await feed.open(
    intents,
    { signal: new AbortController().signal, deadline: now + 2000 },
    () => {},
    (reason) => gaps.push(reason),
  );
  cleanup.push(() => conn.close());
  now += 60000;
  await until(() => gaps.length > 0, 2000);
  expect(gaps).toEqual(['STALE_SOURCE']);
  await until(() => server.ws.clients.size === 0);
});
it('production accepts only server ports and refuses raw URL/credential overrides', () => {
  expect(() =>
    createNativeTradeFeed({ registry: registry(1), limiter, url: 'wss://evil.invalid' } as never),
  ).toThrow();
  expect(() =>
    createNativeTradeFeed({ registry: registry(1), limiter, credentials: 'secret' } as never),
  ).toThrow();
});
it('USDM aggregated trades select the existing market endpoint rather than the depth endpoint', async () => {
  const s: MarketScope = { ...scope, market: 'LINEAR_PERPETUAL' },
    r = createInstrumentRegistry({ capacity: 1 }),
    base = recordFixture(s);
  const record = {
    instrument: { ...base.instrument, id: 'BTCUSDT' },
    rules: { ...base.rules, instrumentId: 'BTCUSDT', effectiveAt: 0, expiresAt: 8640000000000 },
  };
  expect(r.put(record, Date.now()).ok).toBe(true);
  let routed = '';
  const feed = nativeFeed({
    registry: r,
    limiter,
    dial: (url) => {
      routed = url.pathname;
      throw new Error('TEST_NO_NETWORK');
    },
  });
  await expect(
    feed.open(
      [{ scope: s, instrumentId: 'BTCUSDT', profileId: 'binance-usdm-testnet-v1' }],
      { signal: new AbortController().signal, deadline: Date.now() + 2000 },
      () => {},
      () => {},
    ),
  ).rejects.toThrow();
  expect(routed).toBe('/market/ws');
});
it.each(['abort', 'deadline'] as const)(
  'destroys a hung real ACK socket on %s and settles establishment',
  async (mode) => {
    const fixture = await wsFixture();
    cleanup.push(() => fixture.close());
    const feed = nativeFeed({
      registry: registry(1),
      limiter,
      dial: () => new WebSocket(fixture.url, { autoPong: false }),
    });
    const controller = new AbortController();
    const operation = feed.open(
      intents,
      { signal: controller.signal, deadline: Date.now() + 150 },
      () => {},
      () => {},
    );
    await until(() => fixture.ws.clients.size === 1);
    if (mode === 'abort') controller.abort();
    await expect(operation).rejects.toThrow();
    await until(() => fixture.ws.clients.size === 0);
  },
);
it('destroys the underlying TCP socket during a hung HTTP upgrade', async () => {
  const fixture = await httpFixture(() => {});
  cleanup.push(() => fixture.close());
  const feed = nativeFeed({
    registry: registry(1),
    limiter,
    dial: () => new WebSocket(fixture.url.href.replace('http:', 'ws:'), { autoPong: false }),
  });
  await expect(
    feed.open(
      intents,
      { signal: new AbortController().signal, deadline: Date.now() + 150 },
      () => {},
      () => {},
    ),
  ).rejects.toThrow();
  await until(() => fixture.sockets.size === 0);
});
it('multiplexes real normalized Spot trades and preserves oversized numeric identities', async () => {
  const fixture = await wsFixture((ws) => {
    ws.on('message', (data) => {
      const input = JSON.parse(
        Buffer.isBuffer(data) ? data.toString() : Buffer.from(data as ArrayBuffer).toString(),
      ) as { id: number; params: string[] };
      expect(input.params).toEqual(['btcusdt@trade']);
      ws.send(JSON.stringify({ result: null, id: input.id }));
      ws.send(
        '{"e":"trade","s":"BTCUSDT","t":90071992547409931234,"p":"10.1","q":"0.1","T":' +
          Date.now() +
          ',"m":false}',
      );
    });
  });
  cleanup.push(() => fixture.close());
  const inputs: unknown[] = [];
  const feed = nativeFeed({
    registry: registry(1),
    limiter,
    dial: () => new WebSocket(fixture.url, { autoPong: false }),
  });
  const conn = await feed.open(
    intents,
    { signal: new AbortController().signal, deadline: Date.now() + 2000 },
    (_k, input) => inputs.push(input),
    () => {},
  );
  cleanup.push(() => conn.close());
  await until(() => inputs.length === 1);
  expect(inputs[0]).toMatchObject({
    kind: 'TRADE',
    tick: { tradeId: '90071992547409931234', price: '10.1' },
    executionCount: 1,
  });
  await conn.close();
  await until(() => fixture.ws.clients.size === 0);
});
