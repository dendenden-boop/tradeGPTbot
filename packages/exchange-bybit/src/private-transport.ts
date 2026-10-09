import { randomUUID } from 'node:crypto';
import {
  accountInfoSchema,
  newOrderSchema,
  validateOrderAgainstRules,
  decimalCompare,
  isStepAligned,
  type MutationOperation,
  type ReadOperation,
  type RequestContext,
  type ExchangeErrorCode,
} from '@ctp/exchange-core';
import {
  assertActive,
  boundedPort,
  readResponse,
  BybitProtocolError,
  type BybitResponse,
} from './client.js';
import type { BybitBinding, BybitSigner } from './auth.js';
import type { BybitEndpointProfile } from './profiles.js';
import type { BybitAdapterOptions } from './ports.js';
import type { PublicTransport } from './public-transport.js';
import {
  normalizeWallet,
  normalizeOrder,
  normalizePosition,
  normalizeFill,
  validateNativeScope,
} from './private-data.js';
import {
  wireObject as object,
  wireArray as array,
  wireId as id,
  wireInteger as integer,
  canonicalDecimal as decimal,
} from './wire.js';

export interface PrivateTransportOptions {
  readonly endpoint: BybitEndpointProfile;
  readonly binding: BybitBinding | null;
  readonly signer: BybitSigner;
  readonly publicTransport: PublicTransport;
  readonly now: () => number;
  readonly syncTime: (context: RequestContext) => Promise<void>;
  readonly identities?: BybitAdapterOptions['identities'];
  readonly orderAdmission?: BybitAdapterOptions['orderAdmission'];
}
export function createPrivateTransport(options: PrivateTransportOptions) {
  const { endpoint, binding, signer, publicTransport: pub, now, syncTime } = options;
  const cursors = new Map<string, { query: string; cursor: string; expires: number }>();
  const consuming = new Set<string>();
  let pendingInitialPages = 0;
  let verifiedMargin: string | null = null;
  const account = () => {
    if (!binding) throw new BybitProtocolError('AUTHORIZATION_REQUIRED');
    return binding.account;
  };
  async function call(
    path: string,
    context: RequestContext,
    params?: Readonly<Record<string, string>>,
    body?: Readonly<Record<string, string | number | boolean>>,
    onDispatch?: () => void,
    dispatchGate?: () => Promise<boolean>,
  ) {
    account();
    return pub.client.call(
      {
        path,
        sign: signer.rest,
        ...(params === undefined ? {} : { params }),
        ...(body === undefined ? {} : { body }),
        ...(onDispatch === undefined ? {} : { onDispatch }),
        ...(dispatchGate === undefined ? {} : { beforeDispatch: dispatchGate }),
        ...(params?.symbol === undefined && body?.symbol === undefined
          ? {}
          : { symbol: String(params?.symbol ?? body?.symbol) }),
      },
      context,
    );
  }
  async function accountEvidence(context: RequestContext) {
    const permission = await signer.permission(context);
    const response = await call('/v5/account/info', context);
    const x = readResponse(response);
    if (
      ![5, 6].includes(integer(x.unifiedMarginStatus)) ||
      !['REGULAR_MARGIN', 'ISOLATED_MARGIN'].includes(String(x.marginMode)) ||
      x.spotHedgingStatus !== 'OFF' ||
      x.isMasterTrader !== false
    )
      throw new BybitProtocolError('UNSUPPORTED');
    verifiedMargin = String(x.marginMode);
    return {
      permission,
      info: accountInfoSchema.parse({
        account: account(),
        scope: endpoint.scope,
        accountMode: endpoint.category === 'spot' ? 'UTA2_SPOT' : 'UTA2_ONE_WAY',
        permissions: permission.canTrade ? ['READ', 'TRADE'] : ['READ'],
        positionMode: endpoint.category === 'spot' ? 'NOT_APPLICABLE' : 'ONE_WAY',
        checkedAt: response.receivedAt,
      }),
    };
  }
  async function positions(instrumentId: string, context: RequestContext) {
    if (endpoint.category === 'spot') throw new BybitProtocolError('UNSUPPORTED');
    const record = pub.record(instrumentId);
    const r = await call('/v5/position/list', context, {
      category: endpoint.category,
      symbol: record.instrument.exchangeSymbol,
      limit: '200',
    });
    const x = readResponse(r);
    if (
      x.category !== endpoint.category ||
      (x.nextPageCursor !== undefined && x.nextPageCursor !== '')
    )
      throw new BybitProtocolError('INVALID_RESPONSE');
    const rows = array(x.list, 2);
    if (rows.length !== 1) throw new BybitProtocolError('UNSUPPORTED');
    return rows.map((row) => normalizePosition(row, record, account(), verifiedMargin ?? ''));
  }
  function normalizedOrder(raw: unknown, instrumentId: string) {
    const record = pub.record(instrumentId),
      x = object(raw);
    validateNativeScope(x, record);
    if (!options.identities) throw new BybitProtocolError('AUTHORIZATION_REQUIRED');
    const identity = options.identities.order(
      account(),
      instrumentId,
      id(x.orderId),
      id(x.orderLinkId),
    );
    return normalizeOrder(raw, record, account(), identity);
  }
  async function mutation(
    operation: MutationOperation,
    raw: unknown,
    context: RequestContext,
    dispatchGate?: () => Promise<boolean>,
  ): Promise<unknown> {
    const input = object(raw);
    if (operation === 'cancelAllOrders') {
      const commands = array(input.commands, 100);
      const outcomes = [];
      for (const command of commands) {
        const item = object(command),
          auth = object(item.authorization);
        outcomes.push({
          commandId: auth.commandId,
          outcome: await mutation('cancelOrder', item, context),
        });
      }
      return { kind: 'RESULTS', outcomes };
    }
    const authorization = object(input.authorization),
      command = object(input.command);
    let dispatched = false;
    const rejected = (code: ExchangeErrorCode) => ({
      kind: 'DEFINITIVELY_REJECTED',
      error: { code },
    });
    try {
      if (endpoint.scope.environment === 'LIVE') return rejected('LIVE_DISABLED');
      if (!['createOrder', 'cancelOrder', 'setLeverage'].includes(operation))
        return rejected('UNSUPPORTED');
      await syncTime(context);
      const evidence = await accountEvidence(context);
      if (!evidence.permission.canTrade) return rejected('AUTHORIZATION_REQUIRED');
      const record = pub.record(command.instrumentId),
        symbol = record.instrument.exchangeSymbol;
      if (endpoint.category === 'linear') await positions(record.instrument.id, context);
      let path: string,
        body: Record<string, string | number | boolean>,
        preDispatch = () => assertActive(context, now);
      if (operation === 'createOrder') {
        const order = newOrderSchema.parse(command),
          admission = pub.admission(order.instrumentId);
        if (
          order.size.kind !== 'BASE_QUANTITY' ||
          !['MARKET', 'LIMIT'].includes(order.type) ||
          admission.unsupportedConstraints.length > 0
        )
          return rejected('UNSUPPORTED');
        if (!/^[A-Za-z0-9_-]{1,36}$/.test(order.clientOrderId)) return rejected('INVALID_REQUEST');
        if (!options.orderAdmission) return rejected('AUTHORIZATION_REQUIRED');
        if (!validateOrderAgainstRules(order, record, now()).ok) return rejected('INVALID_REQUEST');
        if (
          (await boundedPort(
            () =>
              options.orderAdmission!.validate(
                endpoint.id,
                account(),
                order,
                record,
                admission,
                context,
              ),
            context,
            now,
          )) !== true
        )
          return rejected('AUTHORIZATION_REQUIRED');
        const rulesVersion = record.rules.version,
          fingerprint = JSON.stringify(admission);
        preDispatch = () => {
          assertActive(context, now);
          const current = pub.record(order.instrumentId);
          if (
            current.rules.version !== rulesVersion ||
            JSON.stringify(pub.admission(order.instrumentId)) !== fingerprint ||
            !validateOrderAgainstRules(order, current, now()).ok ||
            now() >= evidence.permission.expiresAt ||
            now() >= Number(authorization.expiresAt)
          )
            throw new BybitProtocolError('STALE_METADATA');
        };
        path = '/v5/order/create';
        body = {
          category: endpoint.category,
          symbol,
          side: order.side === 'BUY' ? 'Buy' : 'Sell',
          orderType: order.type === 'MARKET' ? 'Market' : 'Limit',
          qty: order.size.value,
          orderLinkId: order.clientOrderId,
          ...(endpoint.category === 'spot'
            ? { isLeverage: 0, ...(order.type === 'MARKET' ? { marketUnit: 'baseCoin' } : {}) }
            : { positionIdx: 0, reduceOnly: order.reduceOnly }),
          ...(order.limitPrice === null
            ? {}
            : {
                price: order.limitPrice,
                timeInForce: order.timeInForce === 'POST_ONLY' ? 'PostOnly' : order.timeInForce!,
              }),
        };
      } else if (operation === 'cancelOrder') {
        const locator = object(command.locator);
        path = '/v5/order/cancel';
        body = {
          category: endpoint.category,
          symbol,
          ...(locator.kind === 'EXCHANGE_ID'
            ? { orderId: id(locator.id) }
            : { orderLinkId: id(locator.id) }),
        };
      } else {
        if (endpoint.category === 'spot') return rejected('UNSUPPORTED');
        const a = pub.admission(record.instrument.id);
        if (a.unsupportedConstraints.length > 0) return rejected('UNSUPPORTED');
        path = '/v5/position/set-leverage';
        const leverage = decimal(command.leverage);
        const filter = object(a.constraints.leverageFilter);
        if (
          decimalCompare(leverage, decimal(filter.minLeverage)) < 0 ||
          decimalCompare(leverage, decimal(filter.maxLeverage)) > 0 ||
          !isStepAligned(leverage, decimal(filter.leverageStep))
        )
          return rejected('INVALID_REQUEST');
        preDispatch = () => {
          assertActive(context, now);
          const current = pub.record(record.instrument.id);
          if (
            current.rules.version !== record.rules.version ||
            JSON.stringify(pub.admission(record.instrument.id)) !== JSON.stringify(a)
          )
            throw new BybitProtocolError('STALE_METADATA');
        };
        body = { category: 'linear', symbol, buyLeverage: leverage, sellLeverage: leverage };
      }
      const response = await call(
        path,
        context,
        undefined,
        body,
        () => {
          preDispatch();
          assertActive(context, now);
          if (now() >= evidence.permission.expiresAt || now() >= Number(authorization.expiresAt))
            throw new BybitProtocolError('AUTHORIZATION_REQUIRED');
          dispatched = true;
        },
        dispatchGate,
      );
      return outcome(
        response,
        authorization.commandId,
        operation === 'setLeverage' ? null : String(body.orderLinkId ?? ''),
        operation,
        now(),
        typeof body.orderId === 'string' ? body.orderId : null,
      );
    } catch (error) {
      return dispatched
        ? { kind: 'UNKNOWN', error: { code: 'UNKNOWN_OUTCOME' } }
        : rejected(error instanceof BybitProtocolError ? error.code : 'INVALID_RESPONSE');
    }
  }
  return Object.freeze({
    normalizedOrder,
    accountEvidence,
    marginMode: () => verifiedMargin,
    async request(
      operation: ReadOperation | MutationOperation,
      raw: unknown,
      context: RequestContext,
      dispatchGate?: () => Promise<boolean>,
    ): Promise<unknown> {
      const input = object(raw);
      if (
        [
          'createOrder',
          'cancelOrder',
          'cancelAllOrders',
          'setLeverage',
          'amendOrder',
          'changePositionMode',
          'closePosition',
          'createAlgoOrder',
          'cancelAlgoOrder',
          'cancelAllAlgoOrders',
        ].includes(operation)
      )
        return mutation(operation as MutationOperation, input, context, dispatchGate);
      account();
      await syncTime(context);
      const evidence = await accountEvidence(context);
      if (operation === 'getAccountInfo') return evidence.info;
      if (operation === 'testConnection')
        return {
          authenticated: true,
          canRead: true,
          canTrade: evidence.permission.canTrade,
          checkedAt: now(),
        };
      if (operation === 'getBalances') {
        const r = await call('/v5/account/wallet-balance', context, { accountType: 'UNIFIED' });
        return normalizeWallet(
          readResponse(r),
          account(),
          endpoint.scope,
          r.exchangeTime,
          r.receivedAt,
        );
      }
      const instrumentId = id(input.instrumentId),
        record = pub.record(instrumentId),
        params = { category: endpoint.category, symbol: record.instrument.exchangeSymbol };
      if (operation === 'getPositions') {
        const items = await positions(instrumentId, context);
        return { items, nextCursor: null, queryId: input.queryId };
      }
      if (operation === 'getOrder') {
        const locator = object(input.locator),
          lookup =
            locator.kind === 'EXCHANGE_ID'
              ? { orderId: id(locator.id) }
              : { orderLinkId: id(locator.id) };
        for (const path of ['/v5/order/realtime', '/v5/order/history']) {
          const r = await call(path, context, { ...params, ...lookup, limit: '1' });
          if (r.code === 110001) continue;
          const x = readResponse(r);
          if (x.category !== endpoint.category) throw new BybitProtocolError('SCOPE_MISMATCH');
          const rows = array(x.list, 1);
          if (rows.length === 1) {
            const result = normalizedOrder(rows[0], instrumentId);
            if (
              locator.kind === 'EXCHANGE_ID'
                ? result.exchangeOrderId !== locator.id
                : result.clientOrderId !== locator.id
            )
              throw new BybitProtocolError('INVALID_RESPONSE');
            return { kind: 'FOUND', order: result };
          }
        }
        return { kind: 'INDETERMINATE', reason: 'NOT_AUTHORITATIVE' };
      }
      if (!['getOpenOrders', 'getOrderHistory', 'getTrades'].includes(operation))
        throw new BybitProtocolError('UNSUPPORTED');
      const history = operation !== 'getOpenOrders',
        from = history ? integer(input.from) : null,
        to = history ? integer(input.to) : null;
      if (history && from! >= to!) return { items: [], nextCursor: null, queryId: input.queryId };
      if (history && to! - from! > 7 * 24 * 60 * 60 * 1000)
        throw new BybitProtocolError('INVALID_REQUEST');
      const limit = Math.min(integer(input.limit), operation === 'getTrades' ? 100 : 50),
        query = JSON.stringify({ operation, ...input, cursor: null });
      for (const [token, value] of cursors) if (now() >= value.expires) cursors.delete(token);
      const existing = input.cursor === null ? null : cursors.get(id(input.cursor));
      if (input.cursor !== null && (!existing || existing.query !== query))
        throw new BybitProtocolError('INVALID_REQUEST');
      const initial = existing === null;
      const activeCursor = String(input.cursor);
      if (
        (initial && cursors.size + pendingInitialPages >= 16) ||
        (!initial && consuming.has(activeCursor))
      )
        throw new BybitProtocolError('BUSY');
      if (initial) pendingInitialPages++;
      else consuming.add(activeCursor);
      try {
        const path =
          operation === 'getOpenOrders'
            ? '/v5/order/realtime'
            : operation === 'getOrderHistory'
              ? '/v5/order/history'
              : '/v5/execution/list';
        const r = await call(path, context, {
          ...params,
          limit: String(limit),
          ...(history ? { startTime: String(from), endTime: String(to! - 1) } : { openOnly: '0' }),
          ...(existing ? { cursor: existing.cursor } : {}),
        });
        const x = readResponse(r);
        if (x.category !== endpoint.category) throw new BybitProtocolError('SCOPE_MISMATCH');
        const rows = array(x.list, limit);
        let items: unknown[];
        if (operation === 'getTrades') {
          if (!options.identities) throw new BybitProtocolError('AUTHORIZATION_REQUIRED');
          items = rows
            .map((row) => {
              const f = object(row);
              validateNativeScope(f, record);
              return normalizeFill(
                f,
                record,
                account(),
                options.identities!.fill(account(), instrumentId, id(f.orderId)).internalOrderId,
                r.receivedAt,
              );
            })
            .filter((f) => f.exchangeTime >= from! && f.exchangeTime < to!);
        } else {
          items = rows
            .map((row) => normalizedOrder(row, instrumentId))
            .filter((o) =>
              operation === 'getOpenOrders'
                ? ['OPEN', 'PARTIALLY_FILLED', 'PENDING'].includes(o.status)
                : o.createdAt >= from! && o.createdAt < to!,
            );
        }
        const native = x.nextPageCursor;
        if (native !== undefined && typeof native !== 'string')
          throw new BybitProtocolError('INVALID_RESPONSE');
        if (
          typeof native === 'string' &&
          (native.length > 2048 || (native !== '' && native === existing?.cursor))
        )
          throw new BybitProtocolError('INVALID_RESPONSE');
        if (existing) cursors.delete(String(input.cursor));
        let nextCursor: string | null = null;
        if (native) {
          nextCursor = randomUUID();
          cursors.set(nextCursor, {
            query,
            cursor: native,
            expires: existing?.expires ?? now() + 300_000,
          });
        }
        return { items, nextCursor, queryId: input.queryId };
      } finally {
        if (initial) pendingInitialPages--;
        else consuming.delete(activeCursor);
      }
    },
  });
}
function outcome(
  response: BybitResponse,
  commandId: unknown,
  clientOrderId: string | null,
  operation: string,
  receivedAt: number,
  exchangeOrderId: string | null,
) {
  const rejectCodes = new Set([
    10001, 10002, 10003, 10004, 10005, 10007, 10008, 10010, 10027, 10029, 10028, 110003, 110004,
    110007, 110012, 110013, 110017, 110020, 110032, 170131, 170133, 170134, 170136, 170137, 170140,
  ]);
  if (response.status === 200 && response.code === 0) {
    const x = response.result;
    if (
      operation !== 'setLeverage' &&
      (typeof x.orderId !== 'string' ||
        x.orderId === '' ||
        (exchangeOrderId !== null && x.orderId !== exchangeOrderId) ||
        (clientOrderId && x.orderLinkId !== clientOrderId))
    )
      return { kind: 'UNKNOWN', error: { code: 'UNKNOWN_OUTCOME' } };
    return {
      kind: 'ACCEPTED',
      ack: {
        commandId,
        status: 'ACKNOWLEDGED',
        exchangeId: operation === 'setLeverage' ? null : id(x.orderId),
        receivedAt,
      },
    };
  }
  if (response.status === 200 && rejectCodes.has(response.code))
    return {
      kind: 'DEFINITIVELY_REJECTED',
      error: {
        code: [10003, 10004, 10005, 10007].includes(response.code)
          ? 'AUTHORIZATION_REQUIRED'
          : 'INVALID_REQUEST',
      },
    };
  return { kind: 'UNKNOWN', error: { code: 'UNKNOWN_OUTCOME' } };
}
export type PrivateTransport = ReturnType<typeof createPrivateTransport>;
