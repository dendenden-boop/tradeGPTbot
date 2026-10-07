import { createHash } from 'node:crypto';
import {
  createOrderObservationWindow,
  accountScopeSchema,
  accountSnapshotSchema,
  idSchema,
  immutable,
  operations,
  orderSchema,
  positionSchema,
  sameMarketScope,
  type AccountScope,
  type AccountSnapshot,
  type InstrumentRecord,
  type MarketScope,
  type Order,
  type Position,
  type RequestContext,
  type StreamOperation,
} from '@ctp/exchange-core';
import type { BinanceSigner } from './auth.js';
import {
  assertActive,
  BinanceProtocolError,
  readResponse,
  type BinanceRestClient,
} from './client.js';
import type { NetworkIo, NetworkSocket } from './io.js';
import type { BinanceRateLimitPort, BinanceRateRequest } from './ports.js';
import type { BinanceEndpointProfile } from './profiles.js';
import {
  canonicalDecimal,
  parseWireJson,
  wireArray,
  wireId,
  wireInteger,
  wireObject,
} from './wire.js';

type PrivateOperation = 'subscribePrivateOrders' | 'subscribeBalances' | 'subscribePositions';
type DirtyEvent = Readonly<Record<string, unknown>>;
type InstrumentInput = { readonly instrumentId: string };
interface PendingEvent {
  readonly data: DirtyEvent;
  readonly eventTime: number;
  readonly transactionTime: number;
  readonly exchangeOrderId?: string;
  readonly clientOrderId?: string;
}

export interface BinancePrivateStreamsOptions {
  readonly endpoint: BinanceEndpointProfile;
  readonly io: NetworkIo;
  readonly limiter: BinanceRateLimitPort;
  readonly rest: BinanceRestClient;
  readonly signer: BinanceSigner;
  readonly account: AccountScope | null;
  readonly now: () => number;
  readonly syncTime: (context: RequestContext) => Promise<void>;
  /** Exact order lookup from the notification ID; an open-orders list loses filled/canceled orders. */
  readonly snapshotOrders?:
    | ((
        event: DirtyEvent,
        input: InstrumentInput,
        context: RequestContext,
      ) => Promise<readonly Order[]>)
    | undefined;
  readonly snapshotBalances?:
    ((event: DirtyEvent, context: RequestContext) => Promise<AccountSnapshot>) | undefined;
  readonly snapshotPositions?:
    | ((
        event: DirtyEvent,
        input: InstrumentInput,
        context: RequestContext,
      ) => Promise<readonly Position[]>)
    | undefined;
}

const QUEUE_CAPACITY = 16;
const MAX_LIFETIME = 30_000;
const PRIVATE_OPERATIONS: readonly StreamOperation[] = [
  'subscribePrivateOrders',
  'subscribeBalances',
  'subscribePositions',
];
const error = (code: ConstructorParameters<typeof BinanceProtocolError>[0]) =>
  new BinanceProtocolError(code);
function sameAccount(a: AccountScope, b: AccountScope | null): boolean {
  return (
    b !== null &&
    a.tenantId === b.tenantId &&
    a.connectionId === b.connectionId &&
    a.externalAccountId === b.externalAccountId
  );
}
function exchangeId(raw: unknown): string {
  const id = wireId(raw);
  if (!/^(?:0|[1-9]\d{0,18})$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n)
    throw error('INVALID_RESPONSE');
  return id;
}
function clientId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[.A-Za-z0-9_:/-]{1,36}$/.test(raw))
    throw error('INVALID_RESPONSE');
  return raw;
}
function validateAsset(raw: unknown): void {
  if (!idSchema.safeParse(raw).success) throw error('INVALID_RESPONSE');
}
function validateMoney(raw: unknown): void {
  if (typeof raw !== 'string') throw error('INVALID_RESPONSE');
  canonicalDecimal(raw);
}

/** Translate WS coordinator evidence to the same allowlisted counters used by REST. */
function acknowledgementHeaders(reply: DirtyEvent, now: number): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (reply.rateLimits !== undefined) {
    const units: Readonly<Record<string, string>> = {
      SECOND: 's',
      MINUTE: 'm',
      HOUR: 'h',
      DAY: 'd',
    };
    for (const raw of wireArray(reply.rateLimits, 64)) {
      const limit = wireObject(raw);
      if (typeof limit.interval !== 'string' || !Object.hasOwn(units, limit.interval))
        throw error('INVALID_RESPONSE');
      const period = wireInteger(limit.intervalNum);
      if (period < 1 || period > 1000) throw error('INVALID_RESPONSE');
      const type = limit.rateLimitType;
      if (type !== 'REQUEST_WEIGHT' && type !== 'ORDERS') throw error('INVALID_RESPONSE');
      const key = `${type === 'REQUEST_WEIGHT' ? 'x-mbx-used-weight' : 'x-mbx-order-count'}-${period}${units[limit.interval] as string}`;
      if (Object.hasOwn(headers, key)) throw error('INVALID_RESPONSE');
      headers[key] = String(wireInteger(limit.count));
    }
  }
  const details = reply.error === undefined ? undefined : wireObject(reply.error).data;
  const retryAfter =
    reply.retryAfter ?? (details === undefined ? undefined : wireObject(details).retryAfter);
  if (retryAfter !== undefined) {
    const retryAt = wireInteger(retryAfter);
    headers['retry-after'] = String(Math.max(1, Math.ceil((retryAt - now) / 1000)));
  }
  return immutable(headers);
}

/** Only routing identifiers and clocks are authoritative here; delta financial fields never become snapshots. */
function notification(
  raw: DirtyEvent,
  kind: PrivateOperation,
  record: InstrumentRecord | null,
  spot: boolean,
): PendingEvent | null {
  const e = raw.e;
  if (typeof e !== 'string') throw error('INVALID_RESPONSE');
  if (['serverShutdown', 'eventStreamTerminated', 'listenKeyExpired', 'MARGIN_CALL'].includes(e))
    throw error('INVALID_RESPONSE');
  const eventTime = wireInteger(raw.E);
  let transactionTime: number;
  let exchangeOrderId: string | undefined;
  let clientOrderId: string | undefined;
  if (spot) {
    if (e === 'executionReport') {
      validateAsset(raw.s);
      exchangeOrderId = exchangeId(raw.i);
      clientOrderId = clientId(raw.c);
      transactionTime = wireInteger(raw.T);
      if (kind !== 'subscribePrivateOrders' || raw.s !== record?.instrument.exchangeSymbol)
        return null;
    } else if (e === 'outboundAccountPosition') {
      transactionTime = wireInteger(raw.u);
      for (const item of wireArray(raw.B, 1000)) {
        const balance = wireObject(item);
        validateAsset(balance.a);
        validateMoney(balance.f);
        validateMoney(balance.l);
      }
      if (kind !== 'subscribeBalances') return null;
    } else if (e === 'balanceUpdate' || e === 'externalLockUpdate') {
      transactionTime = wireInteger(raw.T);
      validateAsset(raw.a);
      validateMoney(raw.d);
      if (kind !== 'subscribeBalances') return null;
    } else if (e === 'listStatus') {
      // Every ordinary order in an order list has its own executionReport.
      return null;
    } else throw error('INVALID_RESPONSE');
  } else {
    if (e === 'ORDER_TRADE_UPDATE') {
      const order = wireObject(raw.o);
      validateAsset(order.s);
      exchangeOrderId = exchangeId(order.i);
      clientOrderId = clientId(order.c);
      transactionTime = wireInteger(order.T);
      if (wireInteger(raw.T) !== transactionTime || order.ps !== 'BOTH')
        throw error('INVALID_RESPONSE');
      if (kind !== 'subscribePrivateOrders' || order.s !== record?.instrument.exchangeSymbol)
        return null;
    } else if (e === 'ACCOUNT_UPDATE') {
      transactionTime = wireInteger(raw.T);
      const account = wireObject(raw.a);
      const balances = wireArray(account.B, 1000);
      for (const rawBalance of balances) {
        const balance = wireObject(rawBalance);
        validateAsset(balance.a);
        validateMoney(balance.wb);
        validateMoney(balance.cw);
        validateMoney(balance.bc);
      }
      const positions = wireArray(account.P, 1000).map((item) => wireObject(item));
      for (const position of positions) {
        validateAsset(position.s);
        if (position.ps !== 'BOTH') throw error('INVALID_RESPONSE');
      }
      if (kind === 'subscribeBalances') {
        if (balances.length === 0) return null;
      } else if (kind === 'subscribePositions') {
        if (!positions.some((position) => position.s === record?.instrument.exchangeSymbol))
          return null;
      } else return null;
    } else if (e === 'ACCOUNT_CONFIG_UPDATE') {
      if (raw.ai !== undefined) throw error('INVALID_RESPONSE');
      transactionTime = wireInteger(raw.T);
      const configuration = wireObject(raw.ac);
      validateAsset(configuration.s);
      if (kind !== 'subscribePositions' || configuration.s !== record?.instrument.exchangeSymbol)
        return null;
    } else if (['TRADE_LITE', 'ALGO_UPDATE'].includes(e)) {
      // TRADE_LITE duplicates the ordinary order stream. Algo has a separate unsupported contract.
      return null;
    } else throw error('INVALID_RESPONSE');
  }
  if (transactionTime > eventTime) throw error('INVALID_RESPONSE');
  return {
    data: immutable(raw),
    eventTime,
    transactionTime,
    ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
    ...(clientOrderId === undefined ? {} : { clientOrderId }),
  };
}

/**
 * Internal private source, with trusted snapshot callbacks and server-owned endpoint/credentials.
 * Spot uses the signed WebSocket API subscription, never a legacy Spot listenKey.
 * USD-M uses /private/ws/<listenKey>; sandbox routing remains disabled unless the profile verifies it.
 * The core lifetime is at most 30 s, below listenKey's 60 min lease. No keepalive/reconnect is implied.
 * POST can return a shared existing listenKey, so closing our socket does not invalidate other consumers.
 *
 * Primary contracts checked 2026-10-01:
 * https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-api.md
 * https://github.com/binance/binance-spot-api-docs/blob/master/user-data-stream.md
 * https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/user-data-streams
 * https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/user-data-streams
 */
export function createPrivateStreams(options: BinancePrivateStreamsOptions) {
  const {
    endpoint,
    io,
    limiter,
    rest,
    signer,
    now,
    syncTime,
    snapshotOrders,
    snapshotBalances,
    snapshotPositions,
  } = options;
  const account =
    options.account === null ? null : immutable(accountScopeSchema.parse(options.account));
  const reserve = limiter.reserve.bind(limiter);
  const observe = limiter.observe.bind(limiter);
  let disconnected = false;
  let disconnecting: Promise<void> | undefined;
  const sources = new Set<() => Promise<void>>();

  return Object.freeze({
    async subscribe(
      operation: StreamOperation,
      input: unknown,
      record: InstrumentRecord | null,
      context: RequestContext,
      onEvent: (event: unknown) => void,
      onGap: () => void,
    ): Promise<() => Promise<void>> {
      if (disconnected) throw error('UNAVAILABLE');
      assertActive(context, now);
      if (context.deadline - now() > MAX_LIFETIME) throw error('INVALID_REQUEST');
      if (!PRIVATE_OPERATIONS.includes(operation) || !endpoint.privateWsVerified)
        throw error('UNSUPPORTED');
      if (account === null) throw error('AUTHORIZATION_REQUIRED');
      const kind = operation as PrivateOperation;
      if (kind === 'subscribePositions' && endpoint.scope.market === 'SPOT')
        throw error('UNSUPPORTED');
      if (
        (kind === 'subscribePrivateOrders' && snapshotOrders === undefined) ||
        (kind === 'subscribeBalances' && snapshotBalances === undefined) ||
        (kind === 'subscribePositions' && snapshotPositions === undefined)
      )
        throw error('UNSUPPORTED');
      let request: { readonly instrumentId?: string };
      try {
        request = operations[kind].input.parse(input);
      } catch {
        throw error('INVALID_REQUEST');
      }
      if (
        !sameMarketScope(endpoint.scope, context.profile) ||
        context.profile.endpointProfileId !== endpoint.id ||
        context.profile.accountMode !== endpoint.accountMode ||
        !sameAccount(account, context.account) ||
        (kind !== 'subscribeBalances' &&
          (record === null ||
            record.instrument.id !== request.instrumentId ||
            !sameMarketScope(endpoint.scope, record.instrument.scope)))
      )
        throw error('SCOPE_MISMATCH');
      if (sources.size >= 16) throw error('RATE_LIMITED');
      const instrumentInput = { instrumentId: request.instrumentId ?? '' };
      const spot = endpoint.scope.market === 'SPOT';
      const controller = new AbortController();
      const localContext: RequestContext = Object.freeze({ ...context, signal: controller.signal });
      let active = true;
      let opening = false;
      let ready = false;
      let socket: NetworkSocket | undefined;
      let socketClosing: Promise<void> | undefined;
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      let released = false;
      let stopCode: ConstructorParameters<typeof BinanceProtocolError>[0] = 'UNAVAILABLE';
      let subscriptionId: number | undefined;
      let acknowledgement!: (ack: DirtyEvent) => void;
      let rejectAcknowledgement!: (failure: Error) => void;
      const ack = new Promise<DirtyEvent>((resolve, reject) => {
        acknowledgement = resolve;
        rejectAcknowledgement = reject;
      });
      void ack.catch(() => undefined);
      let ackReceived = false;
      const waiting: DirtyEvent[] = [];
      const queue: PendingEvent[] = [];
      const seen: string[] = [];
      const previous = new Map<string, number>();
      const orders = createOrderObservationWindow();
      let draining = false;

      function release(): void {
        if (released) return;
        released = true;
        if (timer !== undefined) clearTimeout(timer);
        context.signal.removeEventListener('abort', aborted);
        sources.delete(close);
        complete();
      }
      function closeSocket(): Promise<void> {
        if (socketClosing !== undefined) return socketClosing;
        if (socket === undefined) return Promise.resolve();
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
          queue.length = 0;
          waiting.length = 0;
          if (timer !== undefined) clearTimeout(timer);
          context.signal.removeEventListener('abort', aborted);
          controller.abort();
          rejectAcknowledgement(error(stopCode));
          if (!opening) void closeSocket().then(release);
        }
        return completion;
      }
      function aborted(): void {
        stopCode = 'ABORTED';
        void close();
      }
      function gap(): void {
        if (!active) return;
        stopCode = 'INVALID_RESPONSE';
        void close();
        try {
          onGap();
        } catch {
          /* Consumer failure cannot retain the socket. */
        }
      }
      async function bounded<T>(start: () => Promise<T>): Promise<T> {
        assertActive(localContext, now);
        return new Promise<T>((resolve, reject) => {
          let settled = false;
          const finish = (
            value:
              | { readonly ok: true; readonly result: T }
              | { readonly ok: false; readonly failure: Error },
          ) => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener('abort', cancel);
            if (value.ok) resolve(value.result);
            else reject(value.failure);
          };
          const cancel = () => finish({ ok: false, failure: error(stopCode) });
          controller.signal.addEventListener('abort', cancel, { once: true });
          if (controller.signal.aborted) {
            cancel();
            return;
          }
          try {
            Promise.resolve(start()).then(
              (result) => finish({ ok: true, result }),
              (failure: unknown) => {
                const sanitized =
                  failure instanceof BinanceProtocolError
                    ? error(failure.code)
                    : error('UNAVAILABLE');
                finish({ ok: false, failure: sanitized });
              },
            );
          } catch {
            finish({ ok: false, failure: error('UNAVAILABLE') });
          }
        });
      }
      function validScope(value: {
        readonly scope: MarketScope;
        readonly account: AccountScope;
      }): void {
        if (
          !sameAccount(account as AccountScope, value.account) ||
          !sameMarketScope(endpoint.scope, value.scope)
        )
          throw error('SCOPE_MISMATCH');
      }
      async function drain(): Promise<void> {
        if (draining) return;
        draining = true;
        try {
          while (active && queue.length > 0) {
            const event = queue.shift();
            if (event === undefined) break;
            const startedAt = now();
            let values: readonly (Order | Position | AccountSnapshot)[];
            if (kind === 'subscribePrivateOrders') {
              if (
                !orders.check(event.exchangeOrderId!, {
                  time: event.transactionTime,
                  fingerprint: createHash('sha256')
                    .update(JSON.stringify(event.data))
                    .digest('hex'),
                })
              )
                continue;
              const snapshots = await bounded(() =>
                (snapshotOrders as NonNullable<typeof snapshotOrders>)(
                  event.data,
                  instrumentInput,
                  localContext,
                ),
              );
              if (!active) return;
              if (!Array.isArray(snapshots) || snapshots.length !== 1)
                throw error('INVALID_RESPONSE');
              values = snapshots.map((order) => orderSchema.parse(order));
              const order = values[0] as Order;
              if (
                order.instrumentId !== instrumentInput.instrumentId ||
                order.exchangeOrderId !== event.exchangeOrderId ||
                order.clientOrderId !== event.clientOrderId ||
                order.updatedAt < event.transactionTime
              )
                throw error('INVALID_RESPONSE');
            } else if (kind === 'subscribePositions') {
              const positions = await bounded(() =>
                (snapshotPositions as NonNullable<typeof snapshotPositions>)(
                  event.data,
                  instrumentInput,
                  localContext,
                ),
              );
              if (!active) return;
              if (!Array.isArray(positions) || positions.length !== 1)
                throw error('INVALID_RESPONSE');
              values = positions.map((position) => positionSchema.parse(position));
              const position = values[0] as Position;
              if (
                position.instrumentId !== instrumentInput.instrumentId ||
                position.side !== 'NET' ||
                position.updatedAt < event.transactionTime
              )
                throw error('INVALID_RESPONSE');
            } else {
              const snapshot = accountSnapshotSchema.parse(
                await bounded(() =>
                  (snapshotBalances as NonNullable<typeof snapshotBalances>)(
                    event.data,
                    localContext,
                  ),
                ),
              );
              if (!active) return;
              if (
                snapshot.asOf < event.transactionTime ||
                snapshot.receivedAt < startedAt ||
                snapshot.freshness !== 'FRESH'
              )
                throw error('INVALID_RESPONSE');
              values = [snapshot];
            }
            for (const value of values) {
              validScope(value);
              assertActive(localContext, now);
              if (
                kind === 'subscribePrivateOrders' &&
                !orders.observe(value as Order, {
                  time: event.transactionTime,
                  fingerprint: createHash('sha256')
                    .update(JSON.stringify(event.data))
                    .digest('hex'),
                })
              )
                continue;
              if (active) onEvent(immutable(value));
            }
          }
        } catch {
          if (active) gap();
        } finally {
          draining = false;
        }
      }
      function enqueue(raw: DirtyEvent): void {
        if (!active) return;
        let data = raw;
        if (spot) {
          if (wireObject(raw.event).e === 'serverShutdown') throw error('INVALID_RESPONSE');
          if (wireInteger(raw.subscriptionId) !== subscriptionId) throw error('INVALID_RESPONSE');
          data = wireObject(raw.event);
        }
        const event = notification(data, kind, record, spot);
        if (event === null) return;
        const hash = createHash('sha256').update(JSON.stringify(event.data)).digest('hex');
        if (seen.includes(hash)) return;
        const type = String(event.data.e);
        const prior = previous.get(type);
        if (prior !== undefined && event.eventTime < prior) throw error('INVALID_RESPONSE');
        previous.set(type, event.eventTime);
        seen.push(hash);
        if (seen.length > 64) seen.shift();
        if (queue.length >= QUEUE_CAPACITY) throw error('INVALID_RESPONSE');
        queue.push(event);
        void drain();
      }
      function receive(text: string): void {
        if (!active) return;
        if (context.signal.aborted || now() >= context.deadline) {
          void close();
          return;
        }
        try {
          const raw = wireObject(parseWireJson(text));
          if (spot && Object.hasOwn(raw, 'id')) {
            if (ackReceived || raw.id !== context.correlationId) throw error('INVALID_RESPONSE');
            const status = wireInteger(raw.status);
            if (status < 100 || status > 599) throw error('INVALID_RESPONSE');
            if (status === 200) {
              subscriptionId = wireInteger(wireObject(raw.result).subscriptionId);
              if (subscriptionId > 65_535) throw error('INVALID_RESPONSE');
            }
            ackReceived = true;
            acknowledgement(immutable(raw));
          } else if (ready) enqueue(raw);
          else {
            if (waiting.length >= QUEUE_CAPACITY) throw error('INVALID_RESPONSE');
            waiting.push(immutable(raw));
          }
        } catch {
          gap();
        }
      }
      sources.add(close);
      context.signal.addEventListener('abort', aborted, { once: true });
      const timer = setTimeout(
        () => {
          stopCode = 'DEADLINE_EXCEEDED';
          void close();
        },
        Math.max(1, context.deadline - now()),
      );
      timer.unref();
      if (context.signal.aborted) aborted();
      try {
        let url: URL;
        if (spot) {
          // Validate the account credential binding before opening a socket, then
          // discard the returned header; no key/signature is cached across admission.
          await bounded(() => signer.apiKeyHeaders(localContext));
          await bounded(() => syncTime(localContext));
          url = new URL(endpoint.privateWs);
        } else {
          const headers = await bounded(() => signer.apiKeyHeaders(localContext));
          // The client bounds admission/observation and awaits actual HTTP settling.
          const response = await rest.call(
            { path: '/fapi/v1/listenKey', method: 'POST', headers, weight: 1 },
            localContext,
          );
          const listenKey = wireObject(readResponse(response)).listenKey;
          if (typeof listenKey !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(listenKey))
            throw error('INVALID_RESPONSE');
          url = new URL(`${endpoint.privateWs}/ws/${listenKey}`);
        }
        const connection: BinanceRateRequest = immutable({
          profileId: endpoint.id,
          accountId: account.externalAccountId,
          method: 'WS',
          route: spot ? '/ws-api/v3' : '/private/ws',
          weight: spot ? 2 : 0,
          orders: 0,
          connectionAttempts: 1,
          controlMessages: spot ? 2 : 1,
        });
        if ((await bounded(() => reserve(connection, localContext))) !== true)
          throw error('RATE_LIMITED');
        if (!active) throw error(stopCode);
        assertActive(localContext, now);
        opening = true;
        try {
          socket = await io.openSocket(url, localContext, receive, () => {
            if (active) gap();
          });
        } finally {
          opening = false;
        }
        if (!active) throw error(stopCode);
        assertActive(localContext, now);
        if (spot) {
          const control: BinanceRateRequest = immutable({
            ...connection,
            route: 'userDataStream.subscribe.signature',
            weight: 2,
            connectionAttempts: 0,
            controlMessages: 1,
          });
          if ((await bounded(() => reserve(control, localContext))) !== true)
            throw error('RATE_LIMITED');
          // Credential resolution and signature time are sampled only after both
          // connection and control admission have finished, immediately before send.
          const subscription = await bounded(() =>
            signer.spotSubscription(context.correlationId, localContext),
          );
          assertActive(localContext, now);
          await bounded(() => (socket as NetworkSocket).send(JSON.stringify(subscription)));
          const reply = await bounded(() => ack);
          const status = wireInteger(reply.status);
          const headers = acknowledgementHeaders(reply, now());
          await bounded(() => observe(control, status, headers, localContext));
          if (status !== 200)
            throw error(
              status === 429 || status === 418 ? 'RATE_LIMITED' : 'AUTHORIZATION_REQUIRED',
            );
        }
        if (!active) throw error(stopCode);
        ready = true;
        for (const event of waiting.splice(0)) enqueue(event);
        if (!active) throw error(stopCode);
        return close;
      } catch (failure: unknown) {
        void close();
        await closeSocket();
        release();
        if (context.signal.aborted) throw error('ABORTED');
        if (now() >= context.deadline) throw error('DEADLINE_EXCEEDED');
        if (failure instanceof BinanceProtocolError) throw error(failure.code);
        throw error('UNAVAILABLE');
      }
    },
    disconnect(): Promise<void> {
      if (disconnecting !== undefined) return disconnecting;
      disconnected = true;
      disconnecting = Promise.all([...sources].map((close) => close())).then(() => undefined);
      return disconnecting;
    },
  });
}
