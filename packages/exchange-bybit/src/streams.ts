import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  createOrderObservationWindow,
  immutable,
  type InstrumentRecord,
  type RequestContext,
  type StreamOperation,
} from '@ctp/exchange-core';
import { assertActive, boundedPort, BybitProtocolError } from './client.js';
import type { NetworkIo, NetworkSocket } from './io.js';
import type { BybitEndpointProfile } from './profiles.js';
import type { BybitRateLimitPort, BybitRateRequest } from './ports.js';
import type { BybitSigner } from './auth.js';
import type { PrivateTransport } from './private-transport.js';
import {
  createBookAssembler,
  nativeInterval,
  normalizeKline,
  normalizeTicker,
  normalizeTrade,
} from './public-data.js';
import { normalizePosition } from './private-data.js';
import {
  parseWireJson,
  wireObject as object,
  wireArray as array,
  wireInteger as integer,
} from './wire.js';

export function createStreams(
  endpoint: BybitEndpointProfile,
  io: NetworkIo,
  limiter: BybitRateLimitPort,
  signer: BybitSigner,
  privateTransport: PrivateTransport,
  syncTime: (context: RequestContext) => Promise<void>,
  now: () => number,
) {
  let disconnected = false;
  const sources = new Set<() => Promise<void>>();
  return Object.freeze({
    async subscribe(
      operation: StreamOperation,
      raw: unknown,
      record: InstrumentRecord | null,
      context: RequestContext,
      onEvent: (x: unknown) => void,
      onGap: () => void,
    ): Promise<() => Promise<void>> {
      if (disconnected) throw new BybitProtocolError('UNAVAILABLE');
      if (sources.size >= 16) throw new BybitProtocolError('BUSY');
      assertActive(context, now);
      const input = object(raw),
        privateStream = [
          'subscribePrivateOrders',
          'subscribePositions',
          'subscribeBalances',
        ].includes(operation);
      if (
        operation === 'subscribeBalances' ||
        (operation === 'subscribePositions' && endpoint.category === 'spot')
      )
        throw new BybitProtocolError('UNSUPPORTED');
      if (!record) throw new BybitProtocolError('STALE_METADATA');
      const symbol = record.instrument.exchangeSymbol,
        depth = operation === 'subscribeOrderBook' ? integer(input.depth) : 0,
        nativeDepth = depth <= 1 ? 1 : depth <= 50 ? 50 : depth <= 200 ? 200 : 1000;
      const topic =
        operation === 'subscribeTicker'
          ? `tickers.${symbol}`
          : operation === 'subscribeTrades'
            ? `publicTrade.${symbol}`
            : operation === 'subscribeCandles'
              ? `kline.${nativeInterval(String(input.timeframe))}.${symbol}`
              : operation === 'subscribeOrderBook'
                ? `orderbook.${nativeDepth}.${symbol}`
                : operation === 'subscribePrivateOrders'
                  ? `order.${endpoint.category}`
                  : `position.${endpoint.category}`;
      const url = new URL(privateStream ? endpoint.privateWs : endpoint.publicWs);
      const controller = new AbortController(),
        local = { ...context, signal: controller.signal };
      let active = true,
        subscribed = false,
        socket: NetworkSocket | undefined,
        closePromise: Promise<void> | undefined,
        heartbeat: ReturnType<typeof setInterval> | undefined;
      let pending:
        | {
            op: string;
            reqId: string;
            resolve: () => void;
            reject: (e: BybitProtocolError) => void;
          }
        | undefined;
      let ticker: Record<string, unknown> | null = null,
        heartbeatPending = false,
        lastPositionTime = -1,
        lastPosition = '',
        lastTickerTime = -1;
      const book = operation === 'subscribeOrderBook' ? createBookAssembler(record, depth) : null;
      const orders = createOrderObservationWindow();
      const beforeAck: string[] = [];
      let beforeAckBytes = 0;
      const close = (): Promise<void> => {
        if (closePromise) return closePromise;
        active = false;
        beforeAck.length = 0;
        beforeAckBytes = 0;
        subscribed = false;
        clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        context.signal.removeEventListener('abort', abort);
        pending?.reject(new BybitProtocolError('UNAVAILABLE'));
        pending = undefined;
        controller.abort();
        sources.delete(close);
        closePromise = socket ? socket.close().catch(() => undefined) : Promise.resolve();
        return closePromise;
      };
      const fail = () => {
        if (active) {
          void close();
          onGap();
        }
      };
      const abort = () => {
        void close();
      };
      const timer = setTimeout(abort, Math.max(1, context.deadline - now()));
      context.signal.addEventListener('abort', abort, { once: true });
      sources.add(close);
      const rate = (controls: number, connections = 0): BybitRateRequest =>
        immutable({
          profileId: endpoint.id,
          accountId: privateStream ? (context.account?.externalAccountId ?? null) : null,
          route: url.pathname,
          method: 'WS',
          symbol,
          requests: 0,
          orders: 0,
          connectionAttempts: connections,
          controlMessages: controls,
        });
      async function reserve(controls: number, connections = 0) {
        if (
          (await boundedPort(
            () => limiter.reserve(rate(controls, connections), local),
            local,
            now,
          )) !== true
        )
          throw new BybitProtocolError('RATE_LIMITED');
        assertActive(local, now);
      }
      function receive(text: string) {
        if (!active) return;
        try {
          const event = object(parseWireJson(text));
          if (event.op !== undefined) {
            if (event.op === 'ping' || event.op === 'pong') {
              if (!heartbeatPending) throw new BybitProtocolError('INVALID_RESPONSE');
              heartbeatPending = false;
              return;
            }
            if (
              !pending ||
              event.op !== pending.op ||
              (event.req_id !== undefined && event.req_id !== pending.reqId) ||
              event.success !== true
            )
              throw new BybitProtocolError('INVALID_RESPONSE');
            const waiter = pending;
            pending = undefined;
            if (waiter.op === 'subscribe') subscribed = true;
            waiter.resolve();
            if (subscribed) {
              const buffered = beforeAck.splice(0);
              beforeAckBytes = 0;
              for (const frame of buffered) receive(frame);
            }
            return;
          }
          if (event.topic !== topic) throw new BybitProtocolError('INVALID_RESPONSE');
          if (!subscribed) {
            if (pending?.op !== 'subscribe') throw new BybitProtocolError('INVALID_RESPONSE');
            const bytes = Buffer.byteLength(text);
            if (beforeAck.length >= 16 || beforeAckBytes + bytes > 1024 * 1024)
              throw new BybitProtocolError('BUSY');
            beforeAck.push(text);
            beforeAckBytes += bytes;
            return;
          }
          if (operation === 'subscribeTicker') {
            const value = object(event.data);
            const timestamp = integer(event.ts);
            if (timestamp < lastTickerTime || Object.keys(value).length > 64)
              throw new BybitProtocolError('INVALID_RESPONSE');
            lastTickerTime = timestamp;
            if (event.type === 'snapshot') ticker = { ...value };
            else if (event.type === 'delta' && ticker) {
              if (Object.keys(value).length > 64) throw new BybitProtocolError('INVALID_RESPONSE');
              ticker = { ...ticker, ...value };
            } else throw new BybitProtocolError('INVALID_RESPONSE');
            onEvent(normalizeTicker(ticker, record!, integer(event.ts), now()));
          } else if (operation === 'subscribeOrderBook') {
            const value = book!.update(event, now());
            if (value) onEvent(value);
          } else if (operation === 'subscribeTrades') {
            for (const trade of array(event.data, 1024))
              onEvent(normalizeTrade(trade, record!, now()));
          } else if (operation === 'subscribeCandles') {
            for (const candle of array(event.data, 200))
              onEvent(normalizeKline(candle, record!, String(input.timeframe), now()));
          } else if (operation === 'subscribePrivateOrders') {
            for (const row of array(event.data, 200)) {
              const x = object(row);
              if (x.category !== endpoint.category) throw new BybitProtocolError('SCOPE_MISMATCH');
              if (x.symbol !== symbol) continue;
              const current = privateTransport.normalizedOrder(row, record!.instrument.id);
              if (orders.observe(current)) onEvent(current);
            }
          } else {
            for (const row of array(event.data, 200)) {
              const x = object(row);
              if (x.category !== endpoint.category) throw new BybitProtocolError('SCOPE_MISMATCH');
              if (x.symbol !== symbol) continue;
              const current = normalizePosition(
                x,
                record!,
                context.account!,
                privateTransport.marginMode() ?? '',
              );
              if (current.updatedAt < lastPositionTime)
                throw new BybitProtocolError('INVALID_RESPONSE');
              const fingerprint = JSON.stringify(current);
              if (current.updatedAt === lastPositionTime) {
                if (fingerprint !== lastPosition) throw new BybitProtocolError('INVALID_RESPONSE');
                continue;
              }
              lastPosition = fingerprint;
              lastPositionTime = current.updatedAt;
              onEvent(current);
            }
          }
        } catch {
          fail();
        }
      }
      async function control(
        op: string,
        source: readonly unknown[] | (() => Promise<readonly unknown[]>),
      ) {
        if (pending) throw new BybitProtocolError('BUSY');
        await reserve(1);
        const args = typeof source === 'function' ? await source() : source;
        if (!active || !socket) throw new BybitProtocolError('ABORTED');
        const reqId = randomUUID();
        const ack = new Promise<void>((resolve, reject) => {
          pending = { op, reqId, resolve, reject };
        });
        // A rejection handler is attached before send; abort/source close cannot become unhandled.
        const awaited = boundedPort(() => ack, local, now);
        const caught = awaited.catch((e) => {
          throw e;
        });
        await Promise.all([
          Promise.resolve().then(() => socket!.send(JSON.stringify({ op, args, req_id: reqId }))),
          caught,
        ]);
        assertActive(local, now);
      }
      try {
        if (privateStream) {
          await syncTime(local);
          await privateTransport.accountEvidence(local);
        }
        await reserve(0, 1);
        socket = await io.openSocket(url, local, receive, fail);
        if (!active) {
          await socket.close();
          throw new BybitProtocolError('ABORTED');
        }
        if (privateStream) await control('auth', () => signer.ws(local));
        await control('subscribe', [topic]);
        heartbeat = setInterval(() => {
          if (!active) return;
          if (heartbeatPending) {
            fail();
            return;
          }
          heartbeatPending = true;
          void reserve(1)
            .then(() => {
              if (!active || !socket) throw new BybitProtocolError('ABORTED');
              return socket.send(JSON.stringify({ op: 'ping' }));
            })
            .catch(fail);
        }, 20_000);
        if (context.signal.aborted) throw new BybitProtocolError('ABORTED');
        return close;
      } catch (e) {
        await close();
        throw e instanceof BybitProtocolError ? e : new BybitProtocolError('UNAVAILABLE');
      }
    },
    async disconnect() {
      disconnected = true;
      await Promise.allSettled([...sources].map((close) => close()));
    },
  });
}
