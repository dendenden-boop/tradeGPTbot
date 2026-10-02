import {
  immutable,
  operations,
  sameMarketScope,
  type InstrumentRecord,
  type RequestContext,
  type StreamOperation,
} from '@ctp/exchange-core';
import { assertActive, BinanceProtocolError } from './client.js';
import type { NetworkIo, NetworkSocket } from './io.js';
import type { BinanceRateLimitPort, BinanceRateRequest } from './ports.js';
import { publicStreamUrl, type BinanceEndpointProfile } from './profiles.js';
import {
  normalizeBook,
  normalizeKlineEvent,
  normalizeTicker,
  normalizeTrade,
} from './public-data.js';
import { parseWireJson, wireId, wireObject } from './wire.js';

type PublicOperation =
  'subscribeTicker' | 'subscribeTrades' | 'subscribeOrderBook' | 'subscribeCandles';
const PUBLIC_OPERATIONS: readonly StreamOperation[] = [
  'subscribeTicker',
  'subscribeTrades',
  'subscribeOrderBook',
  'subscribeCandles',
];
function numericId(value: unknown): string {
  const id = wireId(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(id)) throw new BinanceProtocolError('INVALID_RESPONSE');
  return id;
}
function specification(operation: PublicOperation, input: unknown) {
  let request: Record<string, unknown>;
  try {
    request = operations[operation].input.parse(input);
  } catch {
    throw new BinanceProtocolError('INVALID_REQUEST');
  }
  if (operation === 'subscribeCandles' && request.timeframe === '30s')
    throw new BinanceProtocolError('UNSUPPORTED');
  const depth = operation === 'subscribeOrderBook' ? (request.depth as number) : 0;
  if (depth > 20) throw new BinanceProtocolError('UNSUPPORTED');
  const nativeDepth = depth <= 5 ? 5 : depth <= 10 ? 10 : 20;
  const timeframe = request.timeframe as string | undefined;
  const stream =
    operation === 'subscribeTicker'
      ? 'ticker'
      : operation === 'subscribeTrades'
        ? 'aggTrade'
        : operation === 'subscribeCandles'
          ? `kline_${timeframe}`
          : `depth${nativeDepth}@100ms`;
  return { instrumentId: request.instrumentId, stream, depth, nativeDepth, timeframe };
}

/** Internal source only: endpoints and instrument scope have already been resolved by the server. */
export function createPublicStreams(
  endpoint: BinanceEndpointProfile,
  io: NetworkIo,
  limiter: BinanceRateLimitPort,
  now: () => number,
) {
  let disconnected = false;
  let disconnecting: Promise<void> | undefined;
  const sources = new Set<() => Promise<void>>();
  const reserve = limiter.reserve.bind(limiter);
  return Object.freeze({
    async subscribe(
      operation: StreamOperation,
      input: unknown,
      record: InstrumentRecord,
      context: RequestContext,
      onEvent: (event: unknown) => void,
      onGap: () => void,
    ): Promise<() => Promise<void>> {
      if (disconnected) throw new BinanceProtocolError('UNAVAILABLE');
      assertActive(context, now);
      if (!PUBLIC_OPERATIONS.includes(operation)) throw new BinanceProtocolError('UNSUPPORTED');
      const kind = operation as PublicOperation;
      const spec = specification(kind, input);
      if (
        spec.instrumentId !== record.instrument.id ||
        !sameMarketScope(endpoint.scope, record.instrument.scope) ||
        !sameMarketScope(endpoint.scope, context.profile) ||
        context.profile.endpointProfileId !== endpoint.id
      )
        throw new BinanceProtocolError('SCOPE_MISMATCH');
      const symbol = record.instrument.exchangeSymbol;
      const stream = `${symbol.toLowerCase()}@${spec.stream}`;
      const url = publicStreamUrl(endpoint, symbol, spec.stream, kind === 'subscribeOrderBook');
      const admission: BinanceRateRequest = immutable({
        profileId: endpoint.id,
        accountId: context.account?.externalAccountId ?? null,
        symbol,
        route: url.pathname,
        method: 'WS',
        weight: 0,
        orders: 0,
        connectionAttempts: 1,
        // No JSON controls are sent. Reserve the bounded stream lifetime's automatic pongs.
        controlMessages: endpoint.scope.market === 'SPOT' ? 2 : 1,
      });
      const controller = new AbortController();
      const localContext = Object.freeze({ ...context, signal: controller.signal });
      let active = true;
      let opened = false;
      let socket: NetworkSocket | undefined;
      let socketClosing: Promise<void> | undefined;
      let stopCode: 'ABORTED' | 'DEADLINE_EXCEEDED' | 'UNAVAILABLE' = 'UNAVAILABLE';
      let previousBook: string | undefined;
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => (complete = resolve));
      function release() {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', abort);
        sources.delete(close);
        complete();
      }
      function closeSocket(): Promise<void> {
        if (socketClosing) return socketClosing;
        if (!socket) return Promise.resolve();
        try {
          socketClosing = Promise.resolve(socket.close()).then(
            () => undefined,
            () => undefined,
          );
        } catch {
          socketClosing = Promise.resolve();
        }
        return socketClosing;
      }
      function close(): Promise<void> {
        if (active) {
          active = false;
          clearTimeout(timer);
          context.signal.removeEventListener('abort', abort);
          controller.abort();
          if (opened) void closeSocket().then(release);
        }
        return completion;
      }
      function abort() {
        stopCode = 'ABORTED';
        void close();
      }
      function gap() {
        if (!active) return;
        void close();
        try {
          onGap();
        } catch {
          // Consumer failures cannot retain the socket or turn a gap into emitted DATA.
        }
      }
      function receive(text: string) {
        if (!active) return;
        if (context.signal.aborted || now() >= context.deadline) {
          void close();
          return;
        }
        try {
          let value = wireObject(parseWireJson(text));
          if (endpoint.scope.market === 'SPOT') {
            if (
              Object.keys(value).length !== 2 ||
              value.stream !== stream ||
              !Object.hasOwn(value, 'data')
            )
              throw new BinanceProtocolError('INVALID_RESPONSE');
            value = wireObject(value.data);
          } else if (value.st !== undefined && value.st !== '1') {
            throw new BinanceProtocolError('INVALID_RESPONSE');
          }
          if (kind === 'subscribeTicker') onEvent(normalizeTicker(value, record, now()));
          else if (kind === 'subscribeTrades') {
            if (value.e !== 'aggTrade') throw new BinanceProtocolError('INVALID_RESPONSE');
            onEvent(normalizeTrade(value, record, now()));
          } else if (kind === 'subscribeCandles') {
            onEvent(normalizeKlineEvent(value, record, spec.timeframe as string, now()));
          } else {
            let raw: unknown = value;
            let previous: string | undefined;
            if (endpoint.scope.market !== 'SPOT') {
              // Only the known depth5/10/20 URL supplies complete top-level snapshots.
              // Generic depthUpdate payloads MUST NOT be reused as snapshots elsewhere.
              // Binance's partial stream documents pu as the last stream event's final u.
              // https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/public
              if (value.e !== 'depthUpdate' || value.s !== symbol)
                throw new BinanceProtocolError('INVALID_RESPONSE');
              const first = numericId(value.U);
              const final = numericId(value.u);
              previous = numericId(value.pu);
              if (BigInt(first) > BigInt(final) || BigInt(previous) > BigInt(final))
                throw new BinanceProtocolError('INVALID_RESPONSE');
              raw = { lastUpdateId: final, T: value.T, bids: value.b, asks: value.a };
            }
            const normalized = normalizeBook(raw, record, now(), spec.depth);
            // Validate full native snapshot size before trimming; oversized data is not the selected stream.
            const bids = endpoint.scope.market === 'SPOT' ? value.bids : value.b;
            const asks = endpoint.scope.market === 'SPOT' ? value.asks : value.a;
            if (
              !Array.isArray(bids) ||
              !Array.isArray(asks) ||
              bids.length > spec.nativeDepth ||
              asks.length > spec.nativeDepth
            )
              throw new BinanceProtocolError('INVALID_RESPONSE');
            const sequence = normalized.sourceSequence as string;
            if (previousBook !== undefined) {
              if (BigInt(sequence) < BigInt(previousBook))
                throw new BinanceProtocolError('INVALID_RESPONSE');
              if (sequence === previousBook) return;
              if (previous !== undefined && previous !== previousBook)
                throw new BinanceProtocolError('INVALID_RESPONSE');
            }
            previousBook = sequence;
            onEvent(normalized);
          }
        } catch {
          gap();
        }
      }
      sources.add(close);
      context.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => {
          stopCode = 'DEADLINE_EXCEEDED';
          void close();
        },
        Math.max(1, context.deadline - now()),
      );
      timer.unref();
      if (context.signal.aborted) abort();
      try {
        // A trusted rate coordinator may be remote; its late result must never dispatch after cancellation.
        const allowed = await new Promise<boolean>((resolve, reject) => {
          let settled = false;
          const cancel = () => settle(undefined, new BinanceProtocolError(stopCode));
          function settle(value?: boolean, error?: unknown) {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener('abort', cancel);
            if (error !== undefined)
              reject(
                error instanceof BinanceProtocolError
                  ? error
                  : new BinanceProtocolError('UNAVAILABLE'),
              );
            else resolve(value === true);
          }
          controller.signal.addEventListener('abort', cancel, { once: true });
          if (controller.signal.aborted) cancel();
          else {
            try {
              Promise.resolve(reserve(admission, localContext)).then(
                (value) => settle(value),
                (error: unknown) => settle(undefined, error),
              );
            } catch (error: unknown) {
              settle(undefined, error);
            }
          }
        });
        if (!active) throw new BinanceProtocolError(stopCode);
        assertActive(localContext, now);
        if (!allowed) throw new BinanceProtocolError('RATE_LIMITED');
        socket = await io.openSocket(url, localContext, receive, () => {
          if (active && !controller.signal.aborted && now() < context.deadline) gap();
        });
        opened = true;
        if (!active) throw new BinanceProtocolError(stopCode);
        assertActive(localContext, now);
        return close;
      } catch (error: unknown) {
        void close();
        await closeSocket();
        release();
        throw error;
      }
    },
    disconnect(): Promise<void> {
      if (disconnecting) return disconnecting;
      disconnected = true;
      disconnecting = Promise.all([...sources].map((close) => close())).then(() => undefined);
      return disconnecting;
    },
  });
}
