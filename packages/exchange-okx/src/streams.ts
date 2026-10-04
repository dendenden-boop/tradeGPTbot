import { randomUUID } from 'node:crypto';
import {
  decimalCompare,
  immutable,
  type InstrumentRecord,
  type Order,
  type RequestContext,
  type StreamOperation,
} from '@ctp/exchange-core';
import { assertActive, boundedPort, OkxProtocolError } from './client.js';
import type { NetworkIo, NetworkSocket } from './io.js';
import type { OkxEndpointProfile } from './profiles.js';
import type { OkxRateLimitPort, OkxRateRequest } from './ports.js';
import type { OkxSigner } from './auth.js';
import type { PrivateTransport } from './private-transport.js';
import {
  createBookAssembler,
  nativeInterval,
  normalizeCandles,
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
  endpoint: OkxEndpointProfile,
  io: NetworkIo,
  limiter: OkxRateLimitPort,
  signer: OkxSigner,
  privateTransport: PrivateTransport,
  syncTime: (context: RequestContext) => Promise<void>,
  now: () => number,
  currentRecord: (instrumentId: string) => InstrumentRecord,
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
      if (disconnected) throw new OkxProtocolError('UNAVAILABLE');
      if (sources.size >= 16) throw new OkxProtocolError('BUSY');
      assertActive(context, now);
      const input = object(raw),
        privateStream = [
          'subscribePrivateOrders',
          'subscribePositions',
          'subscribeBalances',
        ].includes(operation);
      if (
        operation === 'subscribeBalances' ||
        operation === 'subscribeAlgoOrders' ||
        (operation === 'subscribePositions' && endpoint.instType === 'SPOT')
      )
        throw new OkxProtocolError('UNSUPPORTED');
      if (!record) throw new OkxProtocolError('STALE_METADATA');
      const assertRecord = () => {
        const current = currentRecord(record.instrument.id);
        if (
          now() >= record.rules.expiresAt ||
          current.rules.version !== record.rules.version ||
          current.instrument.metadataVersion !== record.instrument.metadataVersion
        )
          throw new OkxProtocolError('STALE_METADATA');
      };
      assertRecord();
      const symbol = record.instrument.exchangeSymbol,
        depth = operation === 'subscribeOrderBook' ? integer(input.depth) : 0;
      const channel =
        operation === 'subscribeTicker'
          ? 'tickers'
          : operation === 'subscribeTrades'
            ? 'trades'
            : operation === 'subscribeCandles'
              ? `candle${nativeInterval(String(input.timeframe))}`
              : operation === 'subscribeOrderBook'
                ? 'books'
                : operation === 'subscribePrivateOrders'
                  ? 'orders'
                  : 'positions';
      const arg = immutable({
          channel,
          ...(privateStream ? { instType: endpoint.instType } : {}),
          instId: symbol,
        }),
        url = new URL(
          privateStream
            ? endpoint.privateWs
            : operation === 'subscribeCandles'
              ? endpoint.businessWs
              : endpoint.publicWs,
        );
      const controller = new AbortController(),
        local = { ...context, signal: controller.signal };
      let active = true,
        subscribed = false,
        socket: NetworkSocket | undefined,
        closePromise: Promise<void> | undefined,
        heartbeat: ReturnType<typeof setInterval> | undefined;
      let pending:
          | { op: string; id: string; resolve: () => void; reject: (e: OkxProtocolError) => void }
          | undefined,
        heartbeatPending = false,
        lastTickerTime = -1,
        lastPositionTime = -1,
        lastPosition = '';
      const book = operation === 'subscribeOrderBook' ? createBookAssembler(record, depth) : null,
        orders = new Map<string, Order>(),
        beforeAck: string[] = [];
      let beforeAckBytes = 0;
      const close = (): Promise<void> => {
        if (closePromise) return closePromise;
        active = false;
        subscribed = false;
        beforeAck.length = 0;
        beforeAckBytes = 0;
        clearTimeout(timer);
        clearTimeout(metadataTimer);
        if (heartbeat) clearInterval(heartbeat);
        context.signal.removeEventListener('abort', abort);
        pending?.reject(new OkxProtocolError('UNAVAILABLE'));
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
        },
        abort = () => {
          void close();
        },
        timer = setTimeout(abort, Math.max(1, context.deadline - now()));
      const metadataTimer = setTimeout(fail, Math.max(1, record.rules.expiresAt - now()));
      context.signal.addEventListener('abort', abort, { once: true });
      sources.add(close);
      const rate = (controls: number, connections = 0): OkxRateRequest =>
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
          throw new OkxProtocolError('RATE_LIMITED');
        assertActive(local, now);
      }
      function matchesArg(value: unknown) {
        const x = object(value);
        return (
          x.channel === arg.channel &&
          x.instId === arg.instId &&
          (!privateStream || x.instType === endpoint.instType)
        );
      }
      function receive(text: string) {
        if (!active) return;
        try {
          assertRecord();
          if (text === 'pong') {
            if (!heartbeatPending) throw new OkxProtocolError('INVALID_RESPONSE');
            heartbeatPending = false;
            return;
          }
          const event = object(parseWireJson(text));
          if (event.event !== undefined) {
            if (
              !pending ||
              event.event !== pending.op ||
              (event.id !== undefined && event.id !== pending.id) ||
              (event.code !== undefined && event.code !== '0') ||
              (event.event === 'login' && event.code !== '0') ||
              (event.event === 'subscribe' && !matchesArg(event.arg))
            )
              throw new OkxProtocolError('INVALID_RESPONSE');
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
          if (!matchesArg(event.arg)) throw new OkxProtocolError('SCOPE_MISMATCH');
          if (!subscribed) {
            if (pending?.op !== 'subscribe') throw new OkxProtocolError('INVALID_RESPONSE');
            const bytes = Buffer.byteLength(text);
            if (beforeAck.length >= 16 || beforeAckBytes + bytes > 1024 * 1024)
              throw new OkxProtocolError('BUSY');
            beforeAck.push(text);
            beforeAckBytes += bytes;
            return;
          }
          if (operation === 'subscribeOrderBook') {
            const value = book!.update(event, now());
            if (value) onEvent(value);
            return;
          }
          const rows = array(event.data, 200);
          if (operation === 'subscribeTicker') {
            if (rows.length !== 1) throw new OkxProtocolError('INVALID_RESPONSE');
            const x = object(rows[0]),
              time = integer(x.ts);
            if (time < lastTickerTime) throw new OkxProtocolError('INVALID_RESPONSE');
            lastTickerTime = time;
            onEvent(normalizeTicker(x, record!, now()));
          } else if (operation === 'subscribeTrades') {
            for (const row of rows) onEvent(normalizeTrade(row, record!, now()));
          } else if (operation === 'subscribeCandles') {
            for (const candle of normalizeCandles(rows, record!, String(input.timeframe), now()))
              onEvent(candle);
          } else if (operation === 'subscribePrivateOrders') {
            for (const row of rows) {
              const x = object(row);
              if (x.instType !== endpoint.instType || x.instId !== symbol)
                throw new OkxProtocolError('SCOPE_MISMATCH');
              const current = privateTransport.normalizedOrder(row, record!.instrument.id),
                previous = orders.get(current.exchangeOrderId!);
              if (previous) {
                if (
                  current.updatedAt < previous.updatedAt ||
                  decimalCompare(current.filledQuantity, previous.filledQuantity) < 0 ||
                  (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(previous.status) &&
                    current.status !== previous.status)
                )
                  throw new OkxProtocolError('INVALID_RESPONSE');
                if (JSON.stringify(current) === JSON.stringify(previous)) continue;
              } else if (orders.size >= 64) throw new OkxProtocolError('BUSY');
              orders.set(current.exchangeOrderId!, current);
              onEvent(current);
            }
          } else {
            for (const row of rows) {
              const x = object(row);
              if (x.instType !== endpoint.instType || x.instId !== symbol)
                throw new OkxProtocolError('SCOPE_MISMATCH');
              const current = normalizePosition(
                  x,
                  record!,
                  context.account!,
                  privateTransport.marginMode(),
                ),
                fingerprint = JSON.stringify(current);
              if (current.updatedAt < lastPositionTime)
                throw new OkxProtocolError('INVALID_RESPONSE');
              if (current.updatedAt === lastPositionTime) {
                if (fingerprint !== lastPosition) throw new OkxProtocolError('INVALID_RESPONSE');
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
        if (pending) throw new OkxProtocolError('BUSY');
        await reserve(1);
        const args = typeof source === 'function' ? await source() : source;
        if (!active || !socket) throw new OkxProtocolError('ABORTED');
        const id = randomUUID().replaceAll('-', '');
        const ack = new Promise<void>((resolve, reject) => {
          pending = { op, id, resolve, reject };
        });
        const awaited = boundedPort(() => ack, local, now);
        await Promise.all([
          Promise.resolve().then(() => socket!.send(JSON.stringify({ op, args, id }))),
          awaited,
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
          throw new OkxProtocolError('ABORTED');
        }
        if (privateStream) await control('login', async () => [await signer.ws(local)]);
        await control('subscribe', [arg]);
        heartbeat = setInterval(() => {
          if (!active) return;
          if (heartbeatPending) {
            fail();
            return;
          }
          heartbeatPending = true;
          void reserve(1)
            .then(() => {
              if (!active || !socket) throw new OkxProtocolError('ABORTED');
              return socket.send('ping');
            })
            .catch(fail);
        }, 20000);
        if (context.signal.aborted) throw new OkxProtocolError('ABORTED');
        return close;
      } catch (e) {
        await close();
        throw e instanceof OkxProtocolError ? e : new OkxProtocolError('UNAVAILABLE');
      }
    },
    async disconnect() {
      disconnected = true;
      await Promise.allSettled([...sources].map((close) => close()));
    },
  });
}
