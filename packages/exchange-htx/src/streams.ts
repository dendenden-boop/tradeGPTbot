import { randomUUID, createHash } from 'node:crypto';
import {
  type AccountScope,
  type InstrumentRecord,
  type RequestContext,
  type StreamOperation,
} from '@ctp/exchange-core';
import { assertActive, boundedPort, HtxProtocolError } from './client.js';
import type { NetworkIo, NetworkSocket } from './io.js';
import type { HtxEndpointProfile } from './profiles.js';
import type { HtxRateLimitPort, HtxRateRequest } from './ports.js';
import type { HtxSigner } from './auth.js';
import type { PrivateTransport } from './private-transport.js';
import {
  nativeInterval,
  normalizeTicker,
  normalizeBook,
  normalizeCandle,
  normalizeTrade,
  exchangeTimestamp,
} from './public-data.js';
import { normalizePosition } from './private-data.js';
import {
  parseWireJson,
  wireObject as object,
  wireArray as array,
  wireInteger as integer,
  wireId as id,
} from './wire.js';

/** A bounded application heartbeat queue; every control frame consumes the shared server budget. */
function heartbeat(
  raw: Record<string, unknown>,
  spotPrivate: boolean,
): Record<string, unknown> | null {
  if (raw.ping !== undefined) {
    integer(raw.ping);
    return { pong: raw.ping };
  }
  if (raw.op === 'ping') {
    integer(raw.ts);
    return { op: 'pong', ts: raw.ts };
  }
  if (spotPrivate && raw.action === 'ping') {
    const data = object(raw.data);
    integer(data.ts);
    return { action: 'pong', data: { ts: data.ts } };
  }
  return null;
}
function rate(
  endpoint: HtxEndpointProfile,
  path: string,
  symbol: string,
  accountId: string | null,
  controls: number,
  connections = 0,
): HtxRateRequest {
  return {
    profileId: endpoint.id,
    accountId,
    route: path,
    method: 'WS',
    symbol,
    requests: 0,
    orders: 0,
    connectionAttempts: connections,
    controlMessages: controls,
  };
}
export async function requestSpotCandles(
  endpoint: HtxEndpointProfile,
  io: NetworkIo,
  limiter: HtxRateLimitPort,
  symbol: string,
  period: string,
  from: number,
  to: number,
  context: RequestContext,
  now: () => number,
): Promise<unknown> {
  assertActive(context, now);
  const channel = `market.${symbol}.kline.${period}`,
    requestId = randomUUID(),
    url = new URL(endpoint.publicWs),
    controller = new AbortController(),
    local = { ...context, signal: controller.signal };
  let socket: NetworkSocket | undefined,
    resolve!: (data: unknown) => void,
    reject!: (cause: unknown) => void,
    done = false;
  const result = new Promise<unknown>((r, j) => {
    resolve = r;
    reject = j;
  });
  void result.catch(() => undefined);
  const abort = () => {
    controller.abort();
    reject(new HtxProtocolError(context.signal.aborted ? 'ABORTED' : 'DEADLINE_EXCEEDED'));
  };
  const timer = setTimeout(abort, Math.max(1, context.deadline - now()));
  context.signal.addEventListener('abort', abort, { once: true });
  const controls: Record<string, unknown>[] = [];
  let sending = false;
  async function sendPending() {
    if (sending || !socket) return;
    sending = true;
    try {
      while (controls.length && !done) {
        if (
          (await boundedPort(
            () => limiter.reserve(rate(endpoint, url.pathname, symbol, null, 1), local),
            local,
            now,
          )) !== true
        )
          throw new HtxProtocolError('RATE_LIMITED');
        await socket.send(JSON.stringify(controls.shift()));
      }
    } catch (e) {
      reject(e);
      controller.abort();
    } finally {
      sending = false;
    }
  }
  try {
    if (
      (await boundedPort(
        () => limiter.reserve(rate(endpoint, url.pathname, symbol, null, 0, 1), local),
        local,
        now,
      )) !== true
    )
      throw new HtxProtocolError('RATE_LIMITED');
    socket = await io.openSocket(
      url,
      local,
      (text) => {
        try {
          const x = object(parseWireJson(text)),
            pong = heartbeat(x, false);
          if (pong) {
            if (controls.length >= 8) throw new HtxProtocolError('BUSY');
            controls.push(pong);
            void sendPending();
            return;
          }
          if (x.status !== 'ok' || x.id !== requestId || x.rep !== channel)
            throw new HtxProtocolError('INVALID_RESPONSE');
          resolve(array(x.data, 200));
        } catch (e) {
          reject(e);
          controller.abort();
        }
      },
      () => reject(new HtxProtocolError('UNAVAILABLE')),
    );
    controls.push({ req: channel, id: requestId, from: from / 1000, to: (to - 1000) / 1000 });
    await sendPending();
    return await result;
  } finally {
    done = true;
    clearTimeout(timer);
    context.signal.removeEventListener('abort', abort);
    controller.abort();
    await socket?.close().catch(() => undefined);
  }
}
export function createStreams(
  endpoint: HtxEndpointProfile,
  io: NetworkIo,
  limiter: HtxRateLimitPort,
  signer: HtxSigner,
  privateTransport: PrivateTransport,
  now: () => number,
  currentRecord: (instrumentId: string) => InstrumentRecord,
  account: AccountScope | null,
) {
  let disconnected = false;
  const sources = new Set<() => Promise<void>>();
  return Object.freeze({
    async subscribe(
      operation: StreamOperation,
      raw: unknown,
      context: RequestContext,
      onEvent: (raw: unknown) => void,
      onGap: () => void,
    ): Promise<() => Promise<void>> {
      if (disconnected) throw new HtxProtocolError('UNAVAILABLE');
      if (sources.size >= 16) throw new HtxProtocolError('BUSY');
      assertActive(context, now);
      if (
        operation === 'subscribeBalances' ||
        operation === 'subscribeAlgoOrders' ||
        (operation === 'subscribePositions' && endpoint.spot)
      )
        throw new HtxProtocolError('UNSUPPORTED');
      const input = object(raw),
        privateStream = ['subscribePrivateOrders', 'subscribePositions'].includes(operation),
        r = currentRecord(String(input.instrumentId)),
        symbol = r.instrument.id,
        depth = operation === 'subscribeOrderBook' ? integer(input.depth) : 0;
      if (depth > 150) throw new HtxProtocolError('UNSUPPORTED');
      if (privateStream) await privateTransport.accountEvidence(context);
      const channel = privateStream
        ? endpoint.spot
          ? `orders#${symbol}`
          : operation === 'subscribePrivateOrders'
            ? `orders_cross.${symbol}`
            : `positions_cross.${symbol}`
        : operation === 'subscribeTicker'
          ? `market.${symbol}.detail`
          : operation === 'subscribeTrades'
            ? `market.${symbol}.trade.detail`
            : operation === 'subscribeOrderBook'
              ? `market.${symbol}.depth.step0`
              : `market.${symbol}.kline.${nativeInterval(String(input.timeframe))}`;
      const url = new URL(privateStream ? endpoint.privateWs : endpoint.publicWs),
        controller = new AbortController(),
        local = { ...context, signal: controller.signal };
      let socket: NetworkSocket | undefined,
        active = true,
        subscribed = false,
        closePromise: Promise<void> | undefined,
        authPending = false,
        ackPending = false,
        ackId = '',
        resolveAck!: () => void,
        rejectAck!: (e: unknown) => void;
      const ack = new Promise<void>((resolve, reject) => {
        resolveAck = resolve;
        rejectAck = reject;
      });
      void ack.catch(() => undefined);
      const beforeAck: string[] = [],
        controls: Record<string, unknown>[] = [],
        privateQueue: Record<string, unknown>[] = [];
      let beforeBytes = 0,
        sending = false,
        reading = false,
        lastActivity = now(),
        lastTicker = -1,
        lastBook = -1,
        lastTickerHash = '',
        lastPositionTime = -1,
        lastPositionHash = '';
      const seen = new Map<string, string>(),
        orderTimes = new Map<string, number>(),
        candles = new Map<number, { fingerprint: string; revision: number; complete: boolean }>();
      const assertRecord = () => {
        const current = currentRecord(symbol);
        if (
          now() >= r.rules.expiresAt ||
          current.rules.version !== r.rules.version ||
          current.instrument.metadataVersion !== r.instrument.metadataVersion
        )
          throw new HtxProtocolError('STALE_METADATA');
      };
      let proofTimer: ReturnType<typeof setTimeout> | undefined;
      const close = (): Promise<void> => {
        if (closePromise) return closePromise;
        active = false;
        subscribed = false;
        clearTimeout(timer);
        clearTimeout(metadataTimer);
        clearInterval(heartbeatTimer);
        if (proofTimer) clearTimeout(proofTimer);
        beforeAck.length = 0;
        controls.length = 0;
        privateQueue.length = 0;
        context.signal.removeEventListener('abort', abort);
        rejectAck(new HtxProtocolError('UNAVAILABLE'));
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
        };
      const timer = setTimeout(abort, Math.max(1, context.deadline - now()));
      const metadataTimer = setTimeout(fail, Math.max(1, r.rules.expiresAt - now()));
      const heartbeatTimer = setInterval(() => {
        if (now() - lastActivity > (privateStream && endpoint.spot ? 45000 : 15000)) fail();
      }, 1000);
      context.signal.addEventListener('abort', abort, { once: true });
      sources.add(close);
      async function reserve(controls: number, connections = 0) {
        if (
          (await boundedPort(
            () =>
              limiter.reserve(
                rate(
                  endpoint,
                  url.pathname,
                  symbol,
                  privateStream ? (account?.externalAccountId ?? null) : null,
                  controls,
                  connections,
                ),
                local,
              ),
            local,
            now,
          )) !== true
        )
          throw new HtxProtocolError('RATE_LIMITED');
        assertActive(local, now);
        assertRecord();
      }
      async function sendPending() {
        if (sending || !socket || !active) return;
        sending = true;
        try {
          while (controls.length && active) {
            await reserve(1);
            await socket.send(JSON.stringify(controls.shift()));
          }
        } catch {
          fail();
        } finally {
          sending = false;
        }
      }
      function send(x: Record<string, unknown>) {
        if (controls.length >= 8) throw new HtxProtocolError('BUSY');
        controls.push(x);
        void sendPending();
      }
      function subscribeControl() {
        authPending = false;
        ackPending = true;
        ackId = randomUUID();
        send(
          privateStream
            ? endpoint.spot
              ? { action: 'sub', ch: channel }
              : { op: 'sub', topic: channel, cid: ackId }
            : { sub: channel, id: ackId },
        );
      }
      const fingerprint = (x: unknown) =>
        createHash('sha256').update(JSON.stringify(x)).digest('hex');
      function unique(key: string, data: unknown) {
        const hash = fingerprint(data),
          previous = seen.get(key);
        if (previous !== undefined) {
          if (previous !== hash) throw new HtxProtocolError('INVALID_RESPONSE');
          return false;
        }
        if (seen.size >= 256) throw new HtxProtocolError('BUSY');
        seen.set(key, hash);
        return true;
      }
      async function readPrivate() {
        if (reading) return;
        reading = true;
        try {
          while (privateQueue.length && active) {
            const x = privateQueue.shift()!;
            assertRecord();
            await signer.permission(local);
            assertRecord();
            assertActive(local, now);
            if (!active) return;
            if (operation === 'subscribePositions') {
              const time = exchangeTimestamp(x.ts, now()),
                hash = fingerprint(x.data);
              if (now() - time > 5000 || time < lastPositionTime)
                throw new HtxProtocolError('STALE_METADATA');
              if (time === lastPositionTime) {
                if (hash !== lastPositionHash) throw new HtxProtocolError('INVALID_RESPONSE');
                continue;
              }
              lastPositionTime = time;
              lastPositionHash = hash;
            }
            const rawData = endpoint.spot ? [x.data] : array(x.data, 100);
            for (const raw of rawData) {
              const row = object(raw);
              if (operation === 'subscribePositions') {
                onEvent(normalizePosition(row, r, account!, exchangeTimestamp(x.ts, now())));
                continue;
              }
              if (
                (endpoint.spot && row.symbol !== symbol) ||
                (!endpoint.spot && row.contract_code !== symbol)
              )
                throw new HtxProtocolError('SCOPE_MISMATCH');
              if (
                endpoint.spot &&
                row.accountId !== undefined &&
                id(row.accountId) !== privateTransport.spotAccountId
              )
                throw new HtxProtocolError('SCOPE_MISMATCH');
              const exchangeId = id(
                  endpoint.spot ? row.orderId : (row.order_id_str ?? row.order_id),
                ),
                time = exchangeTimestamp(endpoint.spot ? row.lastActTime : x.ts, now());
              if (!unique(`${exchangeId}.${time}`, row)) continue;
              const previous = orderTimes.get(exchangeId);
              if (previous !== undefined && time < previous)
                throw new HtxProtocolError('INVALID_RESPONSE');
              if (orderTimes.size >= 256 && !orderTimes.has(exchangeId))
                throw new HtxProtocolError('BUSY');
              orderTimes.set(exchangeId, time);
              const found = await privateTransport.lookup(
                symbol,
                { kind: 'EXCHANGE_ID', id: exchangeId },
                local,
              );
              assertRecord();
              if (!active) return;
              if (found.kind !== 'FOUND' || !('order' in found))
                throw new HtxProtocolError('UNAVAILABLE');
              onEvent(found.order);
            }
          }
        } catch {
          fail();
        } finally {
          reading = false;
        }
      }
      function handle(text: string) {
        if (!active) return;
        try {
          const x = object(parseWireJson(text)),
            pong = heartbeat(x, privateStream && endpoint.spot);
          if (pong) {
            lastActivity = now();
            send(pong);
            return;
          }
          if (authPending) {
            if (endpoint.spot) {
              if (x.action !== 'req' || x.ch !== 'auth' || integer(x.code) !== 200)
                throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
            } else {
              if (x.op !== 'auth' || integer(x['err-code']) !== 0)
                throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
              if (
                x.data !== undefined &&
                object(x.data).uid !== undefined &&
                id(object(x.data).uid) !== account!.externalAccountId
              )
                throw new HtxProtocolError('SCOPE_MISMATCH');
            }
            subscribeControl();
            return;
          }
          const isAck = privateStream
            ? endpoint.spot
              ? x.action === 'sub'
              : x.op === 'sub'
            : x.subbed !== undefined;
          if (isAck) {
            if (!ackPending) throw new HtxProtocolError('INVALID_RESPONSE');
            if (
              privateStream
                ? endpoint.spot
                  ? x.ch !== channel || integer(x.code) !== 200
                  : x.topic !== channel || x.cid !== ackId || integer(x['err-code']) !== 0
                : x.subbed !== channel || x.id !== ackId || x.status !== 'ok'
            )
              throw new HtxProtocolError('INVALID_RESPONSE');
            ackPending = false;
            subscribed = true;
            lastActivity = now();
            resolveAck();
            for (const t of beforeAck.splice(0)) handle(t);
            beforeBytes = 0;
            return;
          }
          if (!subscribed) {
            if (beforeAck.length >= 32 || beforeBytes + Buffer.byteLength(text) > 65536)
              throw new HtxProtocolError('BUSY');
            beforeAck.push(text);
            beforeBytes += Buffer.byteLength(text);
            return;
          }
          assertRecord();
          lastActivity = now();
          if (privateStream) {
            if (
              endpoint.spot
                ? x.action !== 'push' || x.ch !== channel
                : x.op !== 'notify' ||
                  x.topic !== channel ||
                  id(x.uid) !== account!.externalAccountId
            )
              throw new HtxProtocolError('SCOPE_MISMATCH');
            if (privateQueue.length >= 16) throw new HtxProtocolError('BUSY');
            privateQueue.push(x);
            void readPrivate();
            return;
          }
          if (x.ch !== channel) throw new HtxProtocolError('SCOPE_MISMATCH');
          if (operation === 'subscribeTicker') {
            const time = exchangeTimestamp(x.ts, now());
            if (time < lastTicker) throw new HtxProtocolError('INVALID_RESPONSE');
            const hash = fingerprint(x.tick);
            if (time === lastTicker) {
              if (hash !== lastTickerHash) throw new HtxProtocolError('INVALID_RESPONSE');
              return;
            }
            lastTicker = time;
            lastTickerHash = hash;
            onEvent(normalizeTicker(x.tick, r, time, now()));
          } else if (operation === 'subscribeOrderBook') {
            const b = normalizeBook(x.tick, r, depth, now());
            if (b.sourceSequence !== null && !unique('book.' + b.sourceSequence, x.tick)) return;
            if (b.exchangeTime !== null && b.exchangeTime < lastBook)
              throw new HtxProtocolError('INVALID_RESPONSE');
            if (b.exchangeTime !== null) lastBook = b.exchangeTime;
            onEvent(b);
          } else if (operation === 'subscribeTrades') {
            for (const row of array(object(x.tick).data, 100)) {
              const t = normalizeTrade(row, r, now());
              if (unique(t.tradeId, row)) onEvent(t);
            }
          } else {
            const c = normalizeCandle(x.tick, r, String(input.timeframe), now()),
              hash = fingerprint(c),
              old = candles.get(c.openTime);
            if (old?.fingerprint === hash) return;
            if (old?.complete) throw new HtxProtocolError('INVALID_RESPONSE');
            if (candles.size >= 256 && !old) throw new HtxProtocolError('BUSY');
            const revision = old ? old.revision + 1 : 0;
            candles.set(c.openTime, { fingerprint: hash, revision, complete: c.complete });
            onEvent({ ...c, revision });
          }
        } catch {
          fail();
        }
      }
      try {
        assertRecord();
        await reserve(0, 1);
        if (privateStream) {
          const proof = await signer.permission(local);
          proofTimer = setTimeout(fail, Math.max(1, proof.expiresAt - now()));
          authPending = true;
          controls.push(await signer.ws(local));
        }
        socket = await io.openSocket(url, local, handle, fail);
        if (!active) {
          await socket.close();
          throw new HtxProtocolError('UNAVAILABLE');
        }
        if (!privateStream) subscribeControl();
        await sendPending();
        await ack;
        assertRecord();
        assertActive(local, now);
        return close;
      } catch (e) {
        await close();
        throw e;
      }
    },
    async disconnect() {
      disconnected = true;
      await Promise.all([...sources].map((close) => close()));
    },
  });
}
