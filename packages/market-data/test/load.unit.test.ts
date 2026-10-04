import { mkdir, writeFile } from 'node:fs/promises';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { cpus } from 'node:os';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { createMarketDataEngine } from '../src/engine.js';
import { createWsPool } from '../src/pool.js';
import { nativeFeed } from '../src/native-io.js';
import { registry, scope, storeFixture } from './fixtures.js';
import { wsFixture, until } from '../../exchange-binance/test/fixtures/io.js';
it('300 unique instruments / 6000 real loopback frames / three physical sockets / seven timeframes', async () => {
  const r = registry(300),
    f = storeFixture(),
    engine = createMarketDataEngine({ registry: r, store: f.store });
  const latency: number[] = [],
    lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const started = performance.now(),
    cpu = process.cpuUsage(),
    rssBefore = process.memoryUsage().rss;
  let frames = 0,
    connections = 0,
    maxQueue = 0,
    maxBytes = 0;
  const server = await wsFixture((ws) => {
    connections++;
    ws.on('message', (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString() : '';
      const command = JSON.parse(text) as { id: number; params: string[] };
      ws.send(JSON.stringify({ result: null, id: command.id }));
      for (let id = 1; id <= 20; id++)
        for (const topic of command.params) {
          const symbol = topic.split('@')[0]!.toUpperCase();
          ws.send(
            JSON.stringify({
              e: 'trade',
              s: symbol,
              t: id,
              p: '10',
              q: '0.1',
              T: Date.now(),
              m: false,
            }),
          );
        }
    });
  });
  const feed = nativeFeed({
    registry: r,
    limiter: { reserve: () => Promise.resolve(true) },
    dial: () =>
      new WebSocket(server.url, { autoPong: false, perMessageDeflate: false, maxPayload: 1048576 }),
  });
  const pool = createWsPool({
    port: feed,
    onInput: (key, input) => {
      if (input.kind === 'TRADE') {
        frames++;
        latency.push(Date.now() - input.tick.exchangeTime);
      }
      expect(engine.enqueue(key, input)).toBe(true);
      const m = engine.metrics();
      maxQueue = Math.max(maxQueue, m.queued);
      maxBytes = Math.max(maxBytes, m.queuedBytes);
    },
    onGap: () => {
      throw new Error('UNEXPECTED_LOAD_GAP');
    },
  });
  try {
    for (let i = 0; i < 300; i++) {
      const id = i === 0 ? 'BTCUSDT' : `COIN${i}USDT`;
      await engine.retain(scope, id, 0);
      pool.retain({ scope, instrumentId: id, profileId: 'binance-spot-testnet-v1' });
    }
    await pool.tick();
    await pool.settled();
    await until(() => frames === 6000, 15000);
    await engine.flush();
    expect(connections).toBe(3);
    expect(server.ws.clients.size).toBe(3);
    expect(engine.metrics().instruments).toBe(300);
    expect(engine.metrics().dropped).toBe(0);
    for (const key of f.rows.keys()) {
      const state = engine.snapshot(key);
      expect(state.bars).toHaveLength(7);
      expect(
        state.bars.every(
          (b) => b.baseVolume === '2' && b.quoteVolume === '20' && b.tradeCount === 20,
        ),
      ).toBe(true);
    }
    const durationMs = performance.now() - started,
      sorted = latency.sort((a, b) => a - b),
      percentile = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    await mkdir('test-results', { recursive: true });
    await writeFile(
      'test-results/market-data-load.json',
      JSON.stringify(
        {
          status: 'PASS',
          profile:
            'deterministic 300 Binance Spot TESTNET keys; 6000 native frames over 3 real loopback WS sockets; reference registry/store; no exchange/production soak claims',
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpuModel: cpus()[0]?.model ?? 'unknown',
          instruments: 300,
          physicalConnections: connections,
          timeframes: 7,
          trades: frames,
          durationMs,
          messagesPerSecond: frames / (durationMs / 1000),
          cpuMicros: process.cpuUsage(cpu),
          rssBefore,
          rssAfter: process.memoryUsage().rss,
          eventLoopP99Ms: lag.percentile(99) / 1e6,
          latencyP50Ms: percentile(0.5),
          latencyP95Ms: percentile(0.95),
          latencyP99Ms: percentile(0.99),
          maxQueue,
          maxQueueBytes: maxBytes,
          metrics: engine.metrics(),
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    lag.disable();
    await pool.close();
    await engine.close();
    await server.close();
  }
}, 30000);
