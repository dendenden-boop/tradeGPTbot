import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import WebSocket, { type RawData } from 'ws';
import {
  decimalMultiply,
  type InstrumentRecord,
  type InstrumentRegistry,
  type TradeTick,
} from '@ctp/exchange-core';
import {
  publicMarketProfile as binanceProfile,
  normalizeTrade as binanceTrade,
} from '@ctp/exchange-binance/market-data';
import {
  publicMarketProfile as bybitProfile,
  normalizeTrade as bybitTrade,
} from '@ctp/exchange-bybit/market-data';
import {
  publicMarketProfile as okxProfile,
  normalizeTrade as okxTrade,
} from '@ctp/exchange-okx/market-data';
import {
  publicMarketProfile as htxProfile,
  normalizeTrade as htxTrade,
} from '@ctp/exchange-htx/market-data';
import { feedKey } from './candles.js';
import type {
  FeedConnection,
  FeedIntent,
  IoContext,
  PublicFeedPort,
  PublicRatePort,
} from './ports.js';

function object(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('WIRE_OBJECT');
  return x as Record<string, unknown>;
}
function rows(x: unknown): unknown[] {
  if (!Array.isArray(x) || x.length > 512) throw new Error('WIRE_ARRAY');
  return x as unknown[];
}
function text(x: unknown): string {
  if (typeof x !== 'string' || x.length === 0 || x.length > 256) throw new Error('WIRE_STRING');
  return x;
}
function decode(data: RawData, binary: boolean, htx: boolean): unknown {
  let bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  if (bytes.length > 1048576) throw new Error('FRAME_CAPACITY');
  if (binary) {
    if (!htx) throw new Error('BINARY_FRAME');
    bytes = gunzipSync(bytes, { maxOutputLength: 1048576 });
  }
  const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const c of s) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') {
      if (++depth > 32) throw new Error('FRAME_DEPTH');
    } else if (c === '}' || c === ']') depth--;
  }
  return JSON.parse(s, (key: string, value: unknown, context?: { source?: string }): unknown => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('WIRE_KEY');
    if (typeof value === 'number') {
      if (!context?.source) throw new Error('WIRE_NUMBER');
      return context.source;
    }
    return value;
  }) as unknown;
}
function profile(id: string) {
  if (id.startsWith('binance-')) return binanceProfile(id);
  if (id.startsWith('bybit-')) return bybitProfile(id);
  if (id.startsWith('okx-')) return okxProfile(id);
  if (id.startsWith('htx-')) return htxProfile(id);
  throw new Error('PROFILE_NOT_SUPPORTED');
}
/** Internal dial seam is available only to source tests, never through package exports. */
export function nativeFeed(options: {
  registry: InstrumentRegistry;
  limiter: PublicRatePort;
  now?: () => number;
  dial?: (url: URL) => WebSocket;
}): PublicFeedPort {
  const now = options.now ?? Date.now;
  return Object.freeze({
    maxTopics: 100,
    maxConnections: 32,
    async open(
      intents: readonly FeedIntent[],
      context: IoContext,
      onInput: Parameters<PublicFeedPort['open']>[2],
      onGap: Parameters<PublicFeedPort['open']>[3],
    ): Promise<FeedConnection> {
      if (
        intents.length < 1 ||
        intents.length > 100 ||
        context.signal.aborted ||
        context.deadline <= now()
      )
        throw new Error('INVALID_OPEN');
      const endpoint = profile(intents[0]!.profileId),
        exchange = endpoint.scope.exchange;
      const records = new Map<
        string,
        { record: InstrumentRecord; intent: FeedIntent; topic: string }
      >();
      for (const intent of intents) {
        if (
          intent.profileId !== endpoint.id ||
          feedKey(intent.scope, intent.instrumentId) !==
            feedKey(endpoint.scope, intent.instrumentId)
        )
          throw new Error('PROFILE_SCOPE');
        const result = options.registry.get(endpoint.scope, intent.instrumentId, now());
        if (!result.ok) throw new Error('STALE_METADATA');
        const symbol = result.value.instrument.exchangeSymbol;
        if (!/^[a-zA-Z0-9-]{2,48}$/.test(symbol)) throw new Error('INVALID_SYMBOL');
        const topic =
          exchange === 'BINANCE'
            ? `${symbol.toLowerCase()}@${endpoint.scope.market === 'SPOT' ? 'trade' : 'aggTrade'}`
            : exchange === 'BYBIT'
              ? `publicTrade.${symbol}`
              : exchange === 'OKX'
                ? `trades:${symbol}`
                : `market.${symbol}.trade.detail`;
        if (records.has(topic)) throw new Error('DUPLICATE_TOPIC');
        records.set(topic, { record: result.value, intent, topic });
      }
      const controller = new AbortController();
      let socket: WebSocket | undefined,
        active = true,
        ready = false,
        failed = false,
        controlCount = 0;
      const pending = new Set<string>(),
        buffer: { raw: unknown; bytes: number }[] = [],
        sequence = new Map<string, { id: bigint; time: number; covered: number }>();
      let bufferBytes = 0;
      let resolve!: (connection: FeedConnection) => void,
        reject!: (error: Error) => void,
        heartbeat: ReturnType<typeof setInterval> | undefined,
        watchdog: ReturnType<typeof setInterval> | undefined,
        pongTimer: ReturnType<typeof setTimeout> | undefined;
      let lastFrame = now();
      const established = new Promise<FeedConnection>((r, j) => {
        resolve = r;
        reject = j;
      });
      void established.catch(() => {});
      let finish!: () => void;
      const physicalClosed = new Promise<void>((r) => {
        finish = r;
      });
      const timer = setTimeout(
        () => fail('DEADLINE'),
        Math.max(1, Math.min(context.deadline - now(), 5000)),
      );
      const abort = () => fail('ABORTED');
      context.signal.addEventListener('abort', abort, { once: true });
      function cleanup() {
        active = false;
        clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        if (watchdog) clearInterval(watchdog);
        clearTimeout(pongTimer);
        context.signal.removeEventListener('abort', abort);
        controller.abort();
        buffer.length = 0;
        bufferBytes = 0;
      }
      function fail(reason: string) {
        if (!active || failed) return;
        failed = true;
        cleanup();
        if (socket) socket.terminate();
        else finish();
        if (ready) {
          try {
            onGap(reason);
          } catch {
            /* A failing consumer cannot retain an underlying socket. */
          }
        } else reject(new Error(reason));
      }
      const connection: FeedConnection = {
        async close() {
          if (active) {
            cleanup();
            socket?.terminate();
            if (!socket) finish();
          }
          await physicalClosed;
        },
      };
      async function reserve(kind: 'CONNECTION' | 'CONTROL') {
        if (!active) throw new Error('SOURCE_CLOSED');
        const limit = ready ? now() + 1000 : context.deadline;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            options.limiter.reserve(endpoint.id, kind, 1, {
              signal: controller.signal,
              deadline: limit,
            }),
            new Promise<never>((_r, j) => {
              timer = setTimeout(
                () => j(new Error('RATE_PORT_TIMEOUT')),
                Math.max(1, Math.min(1000, limit - now())),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      async function send(value: unknown) {
        if (++controlCount > 8) {
          controlCount--;
          throw new Error('CONTROL_CAPACITY');
        }
        try {
          if (!(await reserve('CONTROL')) || !active || socket?.readyState !== WebSocket.OPEN)
            throw new Error('RATE_LIMITED');
          await new Promise<void>((r, j) =>
            socket!.send(typeof value === 'string' ? value : JSON.stringify(value), (e) =>
              e ? j(e) : r(),
            ),
          );
        } finally {
          controlCount--;
        }
      }
      function ack(key: string) {
        if (!pending.delete(key)) throw new Error('UNEXPECTED_ACK');
        if (pending.size === 0 && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(connection);
          for (const b of buffer.splice(0)) data(b.raw);
          bufferBytes = 0;
          watchdog = setInterval(() => {
            if (now() - lastFrame > 45000) {
              fail('STALE_SOURCE');
              return;
            }
            for (const entry of records.values()) {
              const current = options.registry.get(
                endpoint.scope,
                entry.intent.instrumentId,
                now(),
              );
              if (
                !current.ok ||
                current.value.instrument.metadataVersion !==
                  entry.record.instrument.metadataVersion ||
                current.value.rules.version !== entry.record.rules.version
              ) {
                fail('STALE_METADATA');
                return;
              }
            }
          }, 1000);
          if (exchange === 'BYBIT' || exchange === 'OKX')
            heartbeat = setInterval(() => {
              if (pongTimer !== undefined) {
                fail('HEARTBEAT_FAILED');
                return;
              }
              pongTimer = setTimeout(() => fail('HEARTBEAT_FAILED'), 10000);
              void send(exchange === 'OKX' ? 'ping' : { op: 'ping', req_id: randomUUID() }).catch(
                () => fail('HEARTBEAT_FAILED'),
              );
            }, 20000);
        }
      }
      function emit(topic: string, raw: unknown) {
        const entry = records.get(topic);
        if (!entry) throw new Error('UNSUBSCRIBED_TOPIC');
        const current = options.registry.get(endpoint.scope, entry.intent.instrumentId, now());
        if (
          !current.ok ||
          current.value.instrument.metadataVersion !== entry.record.instrument.metadataVersion ||
          current.value.rules.version !== entry.record.rules.version
        )
          throw new Error('STALE_METADATA');
        let tick: TradeTick =
          exchange === 'BINANCE'
            ? binanceTrade(raw, entry.record, now())
            : exchange === 'BYBIT'
              ? bybitTrade(raw, entry.record, now())
              : exchange === 'OKX'
                ? okxTrade(raw, entry.record, now())
                : htxTrade(raw, entry.record, now());
        if (tick.quantityUnit === 'CONTRACTS') {
          const contract = entry.record.instrument.contract;
          if (!contract || contract.unit !== 'BASE') throw new Error('UNSUPPORTED_QUANTITY');
          tick = {
            ...tick,
            quantity: decimalMultiply(tick.quantity, contract.size),
            quantityUnit: 'BASE',
          };
        }
        if (tick.exchangeTime > now() + 5000 || now() - tick.exchangeTime > 60000)
          throw new Error('CLOCK_DRIFT');
        const key = feedKey(tick.scope, tick.instrumentId);
        // Native aggregated feeds do not establish a count of executions by themselves.
        const count =
          exchange === 'BINANCE' && endpoint.scope.market === 'SPOT'
            ? 1
            : exchange === 'BYBIT' || exchange === 'HTX'
              ? 1
              : null;
        onInput(key, {
          kind: 'TRADE',
          tick,
          metadataVersion: entry.record.instrument.metadataVersion,
          executionCount: count,
        });
        if (exchange === 'BINANCE' && endpoint.scope.market === 'SPOT') {
          const id = BigInt(tick.tradeId),
            previous = sequence.get(key);
          if (previous && id > previous.id + 1n) throw new Error('SOURCE_GAP');
          if (previous && id === previous.id + 1n && tick.exchangeTime >= previous.time) {
            const to = tick.exchangeTime - 2000;
            if (to > previous.covered)
              onInput(key, {
                kind: 'COVERAGE',
                proof: {
                  from: previous.covered,
                  to,
                  cursor: tick.tradeId,
                  evidence: 'CONTIGUOUS_NATIVE_SEQUENCE',
                },
                repaired: false,
              });
            sequence.set(key, {
              id,
              time: tick.exchangeTime,
              covered: Math.max(to, previous.covered),
            });
          } else if (!previous)
            sequence.set(key, { id, time: tick.exchangeTime, covered: tick.exchangeTime });
        }
      }
      function data(raw: unknown) {
        const x = object(raw);
        if (exchange === 'BINANCE') {
          const symbol = text(x.s);
          const topic = `${symbol.toLowerCase()}@${endpoint.scope.market === 'SPOT' ? 'trade' : 'aggTrade'}`;
          emit(topic, x);
        } else if (exchange === 'BYBIT') {
          const topic = text(x.topic);
          for (const item of rows(x.data)) emit(topic, item);
        } else if (exchange === 'OKX') {
          const arg = object(x.arg);
          const topic = `${text(arg.channel)}:${text(arg.instId)}`;
          for (const item of rows(x.data)) emit(topic, { ...object(item), instId: arg.instId });
        } else {
          const topic = text(x.ch);
          for (const item of rows(object(x.tick).data)) emit(topic, item);
        }
      }
      try {
        if (!(await reserve('CONNECTION'))) throw new Error('RATE_LIMITED');
        if (!active || context.signal.aborted) throw new Error('ABORTED');
        const base = 'marketWs' in endpoint ? endpoint.marketWs : endpoint.publicWs;
        const url = new URL(exchange === 'BINANCE' ? `${base}/ws` : endpoint.publicWs);
        socket = options.dial
          ? options.dial(url)
          : new WebSocket(url, {
              autoPong: false,
              allowSynchronousEvents: false,
              perMessageDeflate: false,
              maxPayload: 1048576,
              handshakeTimeout: Math.max(1, Math.min(context.deadline - now(), 5000)),
              followRedirects: false,
            });
        socket.on('error', () => fail('CONNECTION_FAILED'));
        socket.once('close', () => {
          if (active) fail('SOURCE_CLOSED');
          cleanup();
          finish();
        });
        socket.on('ping', (bytes) => {
          lastFrame = now();
          if (++controlCount > 8) {
            controlCount--;
            fail('CONTROL_CAPACITY');
            return;
          }
          void reserve('CONTROL')
            .then((ok) => {
              if (!ok || !active) throw new Error('RATE_LIMITED');
              socket!.pong(bytes, false, (e) => {
                if (e) fail('PONG_FAILED');
              });
            })
            .catch(() => fail('PONG_FAILED'))
            .finally(() => {
              controlCount--;
            });
        });
        socket.on('message', (bytes, binary) => {
          if (!active) return;
          lastFrame = now();
          try {
            if (
              exchange === 'OKX' &&
              !binary &&
              Buffer.isBuffer(bytes) &&
              bytes.toString() === 'pong'
            ) {
              clearTimeout(pongTimer);
              pongTimer = undefined;
              return;
            }
            const raw = decode(bytes, binary, exchange === 'HTX'),
              x = object(raw);
            if (exchange === 'HTX' && x.ping !== undefined) {
              void send({ pong: x.ping }).catch(() => fail('PONG_FAILED'));
              return;
            }
            if (exchange === 'HTX' && x.op === 'ping') {
              void send({ op: 'pong', ts: x.ts }).catch(() => fail('PONG_FAILED'));
              return;
            }
            if (exchange === 'BYBIT' && ['ping', 'pong'].includes(String(x.op))) {
              if (x.op === 'ping' && (x.success !== true || x.ret_msg !== 'pong'))
                throw new Error('INVALID_PONG');
              clearTimeout(pongTimer);
              pongTimer = undefined;
              return;
            }
            if (exchange === 'BINANCE' && x.id !== undefined) {
              if (x.result !== null || x.code !== undefined) throw new Error('ACK_FAILED');
              ack(text(x.id));
              return;
            }
            if (exchange === 'BYBIT' && x.op === 'subscribe') {
              if (x.success !== true) throw new Error('ACK_FAILED');
              ack(text(x.req_id));
              return;
            }
            if (exchange === 'OKX' && x.event !== undefined) {
              if (x.event !== 'subscribe') throw new Error('ACK_FAILED');
              const arg = object(x.arg);
              ack(`${text(arg.channel)}:${text(arg.instId)}`);
              return;
            }
            if (exchange === 'HTX' && x.status !== undefined) {
              if (x.status !== 'ok') throw new Error('ACK_FAILED');
              ack(text(x.subbed));
              return;
            }
            if (!ready) {
              const size = Buffer.byteLength(JSON.stringify(raw));
              if (buffer.length >= 128 || bufferBytes + size > 1048576)
                throw new Error('BEFORE_ACK_CAPACITY');
              buffer.push({ raw, bytes: size });
              bufferBytes += size;
              return;
            }
            data(raw);
          } catch {
            fail('RESYNC_REQUIRED');
          }
        });
        socket.once('open', () => {
          void (async () => {
            if (exchange === 'BINANCE') {
              pending.add('1');
              await send({ method: 'SUBSCRIBE', params: [...records.keys()], id: 1 });
            } else if (exchange === 'BYBIT') {
              const topics = [...records.keys()],
                requests: { op: string; args: string[]; req_id: string }[] = [];
              for (let i = 0; i < topics.length; i += 10) {
                const id = randomUUID();
                pending.add(id);
                requests.push({ op: 'subscribe', args: topics.slice(i, i + 10), req_id: id });
              }
              for (const request of requests) await send(request);
            } else if (exchange === 'OKX') {
              for (const topic of records.keys()) pending.add(topic);
              await send({
                op: 'subscribe',
                args: [...records.values()].map((r) => ({
                  channel: 'trades',
                  instId: r.record.instrument.exchangeSymbol,
                })),
              });
            } else {
              for (const topic of records.keys()) pending.add(topic);
              for (const topic of records.keys()) await send({ sub: topic, id: randomUUID() });
            }
          })().catch(() => fail('SUBSCRIBE_FAILED'));
        });
        return await established;
      } catch {
        fail('SOURCE_CLOSED');
        await physicalClosed;
        throw new Error('PUBLIC_FEED_UNAVAILABLE');
      }
    },
  });
}
