import { randomUUID } from 'node:crypto';
import {
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
  OkxProtocolError,
  type OkxResponse,
} from './client.js';
import { verifyAccountConfiguration, type OkxBinding, type OkxSigner } from './auth.js';
import type { OkxEndpointProfile } from './profiles.js';
import type { OkxAdapterOptions } from './ports.js';
import type { PublicTransport } from './public-transport.js';
import {
  normalizeWallet,
  normalizeOrder,
  normalizePosition,
  normalizeFill,
  validateNativeScope,
  validateOrdinaryOrder,
} from './private-data.js';
import {
  wireObject as object,
  wireArray as array,
  wireId as id,
  wireInteger as integer,
  canonicalDecimal as decimal,
} from './wire.js';

export interface PrivateTransportOptions {
  readonly endpoint: OkxEndpointProfile;
  readonly binding: OkxBinding | null;
  readonly signer: OkxSigner;
  readonly publicTransport: PublicTransport;
  readonly now: () => number;
  readonly syncTime: (context: RequestContext) => Promise<void>;
  readonly identities?: OkxAdapterOptions['identities'];
  readonly orderAdmission?: OkxAdapterOptions['orderAdmission'];
  readonly tradeMode?: 'cross' | 'isolated';
}
export function createPrivateTransport(options: PrivateTransportOptions) {
  const { endpoint, binding, signer, publicTransport: pub, now, syncTime } = options,
    tradeMode = endpoint.instType === 'SPOT' ? 'cash' : (options.tradeMode ?? 'cross');
  const cursors = new Map<string, { query: string; cursor: string; expires: number }>(),
    consuming = new Set<string>();
  let pendingInitialPages = 0;
  const account = () => {
    if (!binding) throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
    return binding.account;
  };
  async function call(
    path: string,
    context: RequestContext,
    params?: Readonly<Record<string, string>>,
    body?: Readonly<Record<string, string | number | boolean>>,
    onDispatch?: () => void,
    expTime?: number,
  ) {
    account();
    return pub.client.call(
      {
        path,
        sign: signer.rest,
        ...(params === undefined ? {} : { params }),
        ...(body === undefined ? {} : { body }),
        ...(onDispatch === undefined ? {} : { onDispatch }),
        ...(expTime === undefined ? {} : { expTime }),
        ...(params?.instId === undefined && body?.instId === undefined
          ? {}
          : { symbol: String(params?.instId ?? body?.instId) }),
      },
      context,
    );
  }
  async function accountEvidence(context: RequestContext) {
    const permission = await signer.permission(context),
      response = await call('/api/v5/account/config', context),
      info = verifyAccountConfiguration(
        readResponse(response),
        account(),
        endpoint.scope,
        response.receivedAt,
      );
    return { permission, info };
  }
  async function positions(instrumentId: string, context: RequestContext) {
    if (endpoint.instType === 'SPOT') throw new OkxProtocolError('UNSUPPORTED');
    const record = pub.record(instrumentId);
    const r = await call('/api/v5/account/positions', context, {
      instType: 'SWAP',
      instId: record.instrument.exchangeSymbol,
    });
    return array(readResponse(r), 100).map((row) =>
      normalizePosition(row, record, account(), tradeMode),
    );
  }
  function normalizedOrder(raw: unknown, instrumentId: string) {
    const record = pub.record(instrumentId),
      x = object(raw);
    validateOrdinaryOrder(x, record, tradeMode);
    if (!options.identities) throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
    const identity = options.identities.order(account(), instrumentId, id(x.ordId), id(x.clOrdId));
    return normalizeOrder(raw, record, account(), identity, tradeMode);
  }
  async function mutation(
    operation: MutationOperation,
    raw: unknown,
    context: RequestContext,
  ): Promise<unknown> {
    const input = object(raw);
    if (operation === 'cancelAllOrders') {
      const outcomes = [];
      for (const command of array(input.commands, 100)) {
        const item = object(command);
        outcomes.push({
          commandId: object(item.authorization).commandId,
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
      if (!evidence.permission.canTrade || !evidence.info.permissions.includes('TRADE'))
        return rejected('AUTHORIZATION_REQUIRED');
      const record = pub.record(command.instrumentId),
        symbol = record.instrument.exchangeSymbol;
      if (endpoint.instType === 'SWAP') await positions(record.instrument.id, context);
      let path: string,
        body: Record<string, string | number | boolean>,
        preDispatch = () => assertActive(context, now);
      if (operation === 'createOrder') {
        const order = newOrderSchema.parse(command),
          admission = pub.admission(order.instrumentId);
        if (
          order.size.kind !== (endpoint.instType === 'SPOT' ? 'BASE_QUANTITY' : 'CONTRACTS') ||
          !['MARKET', 'LIMIT'].includes(order.type) ||
          admission.unsupportedConstraints.length > 0
        )
          return rejected('UNSUPPORTED');
        if (!/^[A-Za-z0-9]{1,32}$/.test(order.clientOrderId)) return rejected('INVALID_REQUEST');
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
            !validateOrderAgainstRules(order, current, now()).ok
          )
            throw new OkxProtocolError('STALE_METADATA');
        };
        path = '/api/v5/trade/order';
        const types = { GTC: 'limit', IOC: 'ioc', FOK: 'fok', POST_ONLY: 'post_only' };
        body = {
          instId: symbol,
          tdMode: tradeMode,
          side: order.side === 'BUY' ? 'buy' : 'sell',
          ordType: order.type === 'MARKET' ? 'market' : types[order.timeInForce!],
          sz: order.size.value,
          clOrdId: order.clientOrderId,
          pxAmendType: '0',
          ...(endpoint.instType === 'SPOT'
            ? {
                tradeQuoteCcy: 'USDT',
                ...(order.type === 'MARKET' ? { tgtCcy: 'base_ccy', banAmend: true } : {}),
              }
            : { posSide: 'net', reduceOnly: order.reduceOnly }),
          ...(order.limitPrice === null ? {} : { px: order.limitPrice }),
        };
      } else if (operation === 'cancelOrder') {
        const locator = object(command.locator);
        path = '/api/v5/trade/cancel-order';
        body = {
          instId: symbol,
          ...(locator.kind === 'EXCHANGE_ID'
            ? { ordId: id(locator.id) }
            : { clOrdId: id(locator.id) }),
        };
      } else {
        if (endpoint.instType === 'SPOT') return rejected('UNSUPPORTED');
        const admission = pub.admission(record.instrument.id);
        if (admission.unsupportedConstraints.length > 0) return rejected('UNSUPPORTED');
        const leverage = decimal(command.leverage),
          maximum = decimal(admission.constraints.lever);
        if (
          decimalCompare(leverage, decimal('1')) < 0 ||
          decimalCompare(leverage, maximum) > 0 ||
          !isStepAligned(leverage, decimal('1'))
        )
          return rejected('INVALID_REQUEST');
        preDispatch = () => {
          assertActive(context, now);
          if (
            pub.record(record.instrument.id).rules.version !== record.rules.version ||
            JSON.stringify(pub.admission(record.instrument.id)) !== JSON.stringify(admission)
          )
            throw new OkxProtocolError('STALE_METADATA');
        };
        path = '/api/v5/account/set-leverage';
        body = { instId: symbol, lever: leverage, mgnMode: tradeMode, posSide: 'net' };
      }
      const expTime = Math.min(context.deadline, integer(authorization.expiresAt));
      const response = await call(
        path,
        context,
        undefined,
        body,
        () => {
          preDispatch();
          assertActive(context, now);
          if (
            now() >= evidence.permission.expiresAt ||
            now() - evidence.info.checkedAt > 30000 ||
            now() >= integer(authorization.expiresAt)
          )
            throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
          dispatched = true;
        },
        operation === 'createOrder' ? expTime : undefined,
      );
      return mutationOutcome(response, authorization.commandId, operation, body);
    } catch (error) {
      return dispatched
        ? { kind: 'UNKNOWN', error: { code: 'UNKNOWN_OUTCOME' } }
        : rejected(error instanceof OkxProtocolError ? error.code : 'INVALID_RESPONSE');
    }
  }
  return Object.freeze({
    normalizedOrder,
    accountEvidence,
    marginMode: () => tradeMode,
    async request(
      operation: ReadOperation | MutationOperation,
      raw: unknown,
      context: RequestContext,
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
        return mutation(operation as MutationOperation, input, context);
      account();
      await syncTime(context);
      const evidence = await accountEvidence(context);
      if (operation === 'getAccountInfo') return evidence.info;
      if (operation === 'testConnection')
        return {
          authenticated: true,
          canRead: true,
          canTrade: evidence.permission.canTrade && evidence.info.permissions.includes('TRADE'),
          checkedAt: now(),
        };
      if (operation === 'getBalances') {
        const r = await call('/api/v5/account/balance', context);
        return normalizeWallet(readResponse(r), account(), endpoint.scope, r.receivedAt);
      }
      const instrumentId = id(input.instrumentId),
        record = pub.record(instrumentId),
        params = { instType: endpoint.instType, instId: record.instrument.exchangeSymbol };
      if (operation === 'getPositions') {
        const items = await positions(instrumentId, context);
        return { items, nextCursor: null, queryId: input.queryId };
      }
      if (operation === 'getOrder') {
        const locator = object(input.locator),
          lookup =
            locator.kind === 'EXCHANGE_ID'
              ? { ordId: id(locator.id) }
              : { clOrdId: id(locator.id) },
          r = await call('/api/v5/trade/order', context, { instId: params.instId, ...lookup });
        if (r.code === 51603 && r.status === 200)
          return { kind: 'INDETERMINATE', reason: 'NOT_AUTHORITATIVE' };
        const rows = array(readResponse(r), 1);
        if (rows.length === 0) return { kind: 'INDETERMINATE', reason: 'NOT_AUTHORITATIVE' };
        const result = normalizedOrder(rows[0], instrumentId);
        if (
          locator.kind === 'EXCHANGE_ID'
            ? result.exchangeOrderId !== locator.id
            : result.clientOrderId !== locator.id
        )
          throw new OkxProtocolError('INVALID_RESPONSE');
        return { kind: 'FOUND', order: result };
      }
      if (!['getOpenOrders', 'getOrderHistory', 'getTrades'].includes(operation))
        throw new OkxProtocolError('UNSUPPORTED');
      const history = operation !== 'getOpenOrders',
        from = history ? integer(input.from) : null,
        to = history ? integer(input.to) : null;
      if (history && from! >= to!) return { items: [], nextCursor: null, queryId: input.queryId };
      if (history && to! - from! > 7 * 86400000) throw new OkxProtocolError('INVALID_REQUEST');
      const limit = Math.min(integer(input.limit), 100),
        query = JSON.stringify({ operation, ...input, cursor: null });
      for (const [token, value] of cursors) if (now() >= value.expires) cursors.delete(token);
      const existing = input.cursor === null ? null : cursors.get(id(input.cursor));
      if (input.cursor !== null && (!existing || existing.query !== query))
        throw new OkxProtocolError('INVALID_REQUEST');
      const initial = existing === null,
        activeCursor = String(input.cursor);
      if (
        (initial && cursors.size + pendingInitialPages >= 16) ||
        (!initial && consuming.has(activeCursor))
      )
        throw new OkxProtocolError('BUSY');
      if (initial) pendingInitialPages++;
      else consuming.add(activeCursor);
      try {
        const path =
          operation === 'getOpenOrders'
            ? '/api/v5/trade/orders-pending'
            : operation === 'getOrderHistory'
              ? '/api/v5/trade/orders-history-archive'
              : '/api/v5/trade/fills-history';
        const r = await call(path, context, {
            ...params,
            limit: String(limit),
            ...(history ? { begin: String(from), end: String(to! - 1) } : {}),
            ...(existing ? { after: existing.cursor } : {}),
          }),
          rows = array(readResponse(r), limit);
        const items =
          operation === 'getTrades'
            ? rows
                .map((row) => {
                  const x = object(row);
                  validateNativeScope(x, record);
                  if (!options.identities) throw new OkxProtocolError('AUTHORIZATION_REQUIRED');
                  return normalizeFill(
                    x,
                    record,
                    account(),
                    options.identities.fill(account(), instrumentId, id(x.ordId)).internalOrderId,
                    r.receivedAt,
                  );
                })
                .filter((f) => f.exchangeTime >= from! && f.exchangeTime < to!)
            : rows
                .map((row) => normalizedOrder(row, instrumentId))
                .filter((o) =>
                  operation === 'getOpenOrders'
                    ? ['OPEN', 'PARTIALLY_FILLED'].includes(o.status)
                    : o.createdAt >= from! && o.createdAt < to!,
                );
        const ids = rows.map((row) =>
          id(object(row)[operation === 'getTrades' ? 'billId' : 'ordId']),
        );
        if (
          new Set(ids).size !== ids.length ||
          ids.some((value) => !/^\d{1,30}$/.test(value)) ||
          ids.some((value, i) => i > 0 && BigInt(value) >= BigInt(ids[i - 1]!)) ||
          (existing && ids.some((value) => BigInt(value) >= BigInt(existing.cursor)))
        )
          throw new OkxProtocolError('INVALID_RESPONSE');
        if (existing) cursors.delete(activeCursor);
        let nextCursor: string | null = null;
        if (rows.length === limit) {
          nextCursor = randomUUID();
          cursors.set(nextCursor, {
            query,
            cursor: ids.at(-1)!,
            expires: existing?.expires ?? now() + 300000,
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
function mutationOutcome(
  response: OkxResponse,
  commandId: unknown,
  operation: string,
  body: Readonly<Record<string, string | number | boolean>>,
) {
  const unknown = () => ({ kind: 'UNKNOWN', error: { code: 'UNKNOWN_OUTCOME' } }),
    rejected = () => ({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'INVALID_REQUEST' } }),
    rejectCodes = new Set([51000, 51001, 51006, 51008]);
  if (response.status !== 200) return unknown();
  if (rejectCodes.has(response.code)) return rejected();
  if (response.code !== 0 && response.code !== 1) return unknown();
  const rows = array(response.data, 1);
  if (rows.length !== 1) return unknown();
  const x = object(rows[0]);
  if (operation === 'setLeverage') {
    if (
      response.code !== 0 ||
      x.instId !== body.instId ||
      x.mgnMode !== body.mgnMode ||
      decimal(x.lever) !== body.lever ||
      x.posSide !== 'net'
    )
      return unknown();
  } else {
    if (typeof x.sCode !== 'string' || !/^\d{1,6}$/.test(x.sCode)) return unknown();
    if (rejectCodes.has(Number(x.sCode))) return rejected();
    if (
      response.code !== 0 ||
      x.sCode !== '0' ||
      typeof x.ordId !== 'string' ||
      !/^\d{1,30}$/.test(x.ordId) ||
      (body.ordId !== undefined && x.ordId !== body.ordId) ||
      (body.clOrdId !== undefined && x.clOrdId !== body.clOrdId)
    )
      return unknown();
  }
  return {
    kind: 'ACCEPTED',
    ack: {
      commandId,
      status: 'ACKNOWLEDGED',
      exchangeId: operation === 'setLeverage' ? null : id(x.ordId),
      receivedAt: response.receivedAt,
    },
  };
}
export type PrivateTransport = ReturnType<typeof createPrivateTransport>;
