import { createHash } from 'node:crypto';
import {
  accountInfoSchema,
  accountScopeSchema,
  accountSnapshotSchema,
  algoOrderSchema,
  decimalAdd,
  decimalCompare,
  fillSchema,
  immutable,
  instrumentSchema,
  marketScopeSchema,
  newAlgoOrderSchema,
  newOrderSchema,
  orderSchema,
  parseDecimal,
  positionSchema,
  sameMarketScope,
  sideSchema,
  tradingRulesSchema,
} from '@ctp/exchange-core';
import type {
  AccountInfo,
  AccountScope,
  AccountSnapshot,
  AlgoOrder,
  DecimalString,
  Fill,
  InstrumentRecord,
  MarketScope,
  NewAlgoOrder,
  NewOrder,
  Order,
  Position,
} from '@ctp/exchange-core';
import type { BinanceIdentityPort } from './ports.js';
import { canonicalDecimal, wireArray, wireId, wireInteger, wireObject } from './wire.js';

// Primary schemas reviewed 2026-10-01:
// https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md
// https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account
// https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade
const zero = parseDecimal('0');
const invalid = (): never => {
  throw new Error('INVALID_BINANCE_RESPONSE');
};
const requestError = (code: 'INVALID_REQUEST' | 'UNSUPPORTED' | 'STALE_METADATA'): never => {
  throw new Error(code);
};
function guarded<T>(action: () => T): T {
  try {
    return immutable(action());
  } catch {
    return invalid();
  }
}
function money(raw: unknown): DecimalString {
  if (typeof raw !== 'string') return invalid();
  return canonicalDecimal(raw);
}
function positive(raw: unknown): DecimalString {
  const value = money(raw);
  if (decimalCompare(value, zero) <= 0) return invalid();
  return value;
}
function nonnegative(raw: unknown): DecimalString {
  const value = money(raw);
  if (decimalCompare(value, zero) < 0) return invalid();
  return value;
}
function numericId(raw: unknown): string {
  const value = wireId(raw);
  if (!/^(?:0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n)
    return invalid();
  return value;
}
function clientId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[.A-Za-z0-9_:/-]{1,36}$/.test(raw)) return invalid();
  return raw;
}
function scopeFor(scope: MarketScope, market: 'SPOT' | 'LINEAR_PERPETUAL'): MarketScope {
  const parsed = marketScopeSchema.parse(scope);
  if (parsed.exchange !== 'BINANCE' || parsed.market !== market) return invalid();
  return parsed;
}
function recordFor(record: InstrumentRecord): InstrumentRecord {
  const instrument = instrumentSchema.parse(record.instrument);
  const rules = tradingRulesSchema.parse(record.rules);
  if (
    instrument.scope.exchange !== 'BINANCE' ||
    !['SPOT', 'LINEAR_PERPETUAL'].includes(instrument.scope.market) ||
    instrument.id !== rules.instrumentId ||
    !sameMarketScope(instrument.scope, rules.scope) ||
    rules.quantityUnit !== 'BASE'
  )
    return invalid();
  return { instrument, rules };
}
function observedPrice(raw: unknown) {
  if (raw === undefined) return { state: 'UNAVAILABLE' as const, reason: 'NOT_PROVIDED' as const };
  const value = nonnegative(raw);
  return value === '0'
    ? { state: 'UNAVAILABLE' as const, reason: 'NOT_PROVIDED' as const }
    : { state: 'AVAILABLE' as const, value };
}
function version(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function normalizeSpotAccount(
  raw: unknown,
  scope: MarketScope,
  account: AccountScope,
  receivedAt: number,
): AccountSnapshot {
  return guarded(() => {
    scope = scopeFor(scope, 'SPOT');
    account = accountScopeSchema.parse(account);
    const data = wireObject(raw);
    if (data.accountType !== 'SPOT') return invalid();
    const balances = wireArray(data.balances, 1000).map((rawBalance) => {
      const b = wireObject(rawBalance);
      const free = nonnegative(b.free);
      const locked = nonnegative(b.locked);
      return {
        asset: b.asset,
        free,
        locked,
        total: decimalAdd(free, locked),
        availableToTrade: { state: 'AVAILABLE' as const, value: free },
      };
    });
    const asOf = wireInteger(data.updateTime);
    return accountSnapshotSchema.parse({
      account,
      scope,
      balances,
      sourceVersion: version('spot-account', [asOf, balances]),
      asOf,
      receivedAt,
      freshness: 'FRESH',
    });
  });
}

/** USD-M available collateral is not Spot free balance; wallet minus available is not locked. */
export function normalizeFuturesBalances(
  raw: unknown,
  scope: MarketScope,
  account: AccountScope,
  receivedAt: number,
): AccountSnapshot {
  return guarded(() => {
    scope = scopeFor(scope, 'LINEAR_PERPETUAL');
    account = accountScopeSchema.parse(account);
    const data = wireArray(raw, 1000);
    if (data.length === 0) return invalid();
    let asOf = 0;
    const balances = data.map((rawBalance) => {
      const b = wireObject(rawBalance);
      asOf = Math.max(asOf, wireInteger(b.updateTime));
      return {
        asset: b.asset,
        free: null,
        locked: null,
        total: money(b.balance),
        availableToTrade: { state: 'AVAILABLE' as const, value: money(b.availableBalance) },
      };
    });
    return accountSnapshotSchema.parse({
      account,
      scope,
      balances,
      sourceVersion: version('usdm-wallet', [asOf, balances]),
      asOf,
      receivedAt,
      freshness: 'FRESH',
    });
  });
}

export function normalizeSpotAccountInfo(
  raw: unknown,
  scope: MarketScope,
  account: AccountScope,
  checkedAt: number,
): AccountInfo {
  return guarded(() => {
    const data = wireObject(raw);
    if (data.accountType !== 'SPOT' || typeof data.canTrade !== 'boolean') return invalid();
    return accountInfoSchema.parse({
      account: accountScopeSchema.parse(account),
      scope: scopeFor(scope, 'SPOT'),
      accountMode: 'SPOT',
      permissions: data.canTrade ? ['READ', 'TRADE'] : ['READ'],
      positionMode: 'NOT_APPLICABLE',
      checkedAt,
    });
  });
}

/** Position mode is read from the signed positionSide/dual endpoint, never assumed from a URL. */
export function normalizeFuturesAccountInfo(
  raw: unknown,
  dualSidePosition: unknown,
  scope: MarketScope,
  account: AccountScope,
  checkedAt: number,
): AccountInfo {
  return guarded(() => {
    const data = wireObject(raw);
    if (
      typeof data.canTrade !== 'boolean' ||
      data.multiAssetsMargin !== false ||
      dualSidePosition !== false
    )
      return invalid();
    return accountInfoSchema.parse({
      account: accountScopeSchema.parse(account),
      scope: scopeFor(scope, 'LINEAR_PERPETUAL'),
      accountMode: 'ONE_WAY',
      permissions: data.canTrade ? ['READ', 'TRADE'] : ['READ'],
      positionMode: 'ONE_WAY',
      checkedAt,
    });
  });
}

const statusMap = Object.freeze({
  PENDING_NEW: 'PENDING',
  NEW: 'OPEN',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELED: 'CANCELED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  EXPIRED_IN_MATCH: 'EXPIRED',
} as const);
function status(raw: unknown): Order['status'] {
  if (typeof raw !== 'string' || !Object.hasOwn(statusMap, raw)) return invalid();
  return statusMap[raw as keyof typeof statusMap];
}
function orderType(raw: unknown, spot: boolean): Order['type'] {
  switch (raw) {
    case 'MARKET':
      return 'MARKET';
    case 'LIMIT':
      return 'LIMIT';
    case 'LIMIT_MAKER':
      if (spot) return 'LIMIT';
      break;
    case 'STOP_LOSS':
      if (spot) return 'STOP_MARKET';
      break;
    case 'STOP_LOSS_LIMIT':
      if (spot) return 'STOP_LIMIT';
      break;
    case 'STOP_MARKET':
      if (!spot) return 'STOP_MARKET';
      break;
    case 'STOP':
      if (!spot) return 'STOP_LIMIT';
  }
  return invalid();
}

/** REST order snapshots; ACK responses and partial WS reports are not complete order snapshots. */
export function normalizeOrder(
  raw: unknown,
  record: InstrumentRecord,
  account: AccountScope,
  identities: BinanceIdentityPort,
): Order {
  return guarded(() => {
    record = recordFor(record);
    account = accountScopeSchema.parse(account);
    const data = wireObject(raw);
    const spot = record.instrument.scope.market === 'SPOT';
    if (data.symbol !== record.instrument.exchangeSymbol || (!spot && data.positionSide !== 'BOTH'))
      return invalid();
    const exchangeOrderId = numericId(data.orderId);
    const clientOrderId = clientId(data.clientOrderId);
    const identity = identities.order(
      account,
      record.instrument.id,
      exchangeOrderId,
      clientOrderId,
    );
    const filledQuantity = nonnegative(data.executedQty);
    const type = orderType(data.type, spot);
    const averageFillPrice =
      filledQuantity === '0'
        ? { state: 'UNAVAILABLE' as const, reason: 'NO_EXECUTIONS' as const }
        : observedPrice(data.avgPrice);
    return orderSchema.parse({
      account,
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      ...identity,
      clientOrderId,
      exchangeOrderId,
      side: sideSchema.parse(data.side),
      type,
      status: status(data.status),
      price: observedPrice(data.price),
      stopPrice: observedPrice(data.stopPrice),
      quantity: positive(data.origQty),
      quantityUnit: 'BASE',
      filledQuantity,
      averageFillPrice,
      fees: [],
      createdAt: wireInteger(data.time),
      updatedAt: wireInteger(data.updateTime),
    });
  });
}

/** myTrades/userTrades has no clientOrderId; the caller supplies a trusted durable fill identity. */
export function normalizeFill(
  raw: unknown,
  record: InstrumentRecord,
  account: AccountScope,
  identity: { readonly internalOrderId: string },
  receivedAt: number,
): Fill {
  return guarded(() => {
    record = recordFor(record);
    account = accountScopeSchema.parse(account);
    const data = wireObject(raw);
    if (
      data.symbol !== record.instrument.exchangeSymbol ||
      (record.instrument.scope.market !== 'SPOT' && data.positionSide !== 'BOTH')
    )
      return invalid();
    const commission = money(data.commission);
    return fillSchema.parse({
      account,
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      fillId: numericId(data.id),
      identityScope: version('binance-fill', [
        record.instrument.scope,
        account,
        record.instrument.id,
      ]),
      internalOrderId: identity.internalOrderId,
      exchangeOrderId: numericId(data.orderId),
      price: positive(data.price),
      quantity: positive(data.qty),
      quantityUnit: 'BASE',
      fees: [
        {
          amount: commission,
          asset: data.commissionAsset,
          kind: commission.startsWith('-') ? 'REBATE' : 'TRADING',
        },
      ],
      exchangeTime: wireInteger(data.time),
      receivedAt,
    });
  });
}

/** V2 is used because V3 omits leverage and marginType; neither value is inferred. */
export function normalizePositionV2(
  raw: unknown,
  record: InstrumentRecord,
  account: AccountScope,
): Position {
  return guarded(() => {
    record = recordFor(record);
    scopeFor(record.instrument.scope, 'LINEAR_PERPETUAL');
    account = accountScopeSchema.parse(account);
    const data = wireObject(raw);
    if (
      data.symbol !== record.instrument.exchangeSymbol ||
      data.positionSide !== 'BOTH' ||
      !['cross', 'isolated'].includes(String(data.marginType))
    )
      return invalid();
    const updatedAt = wireInteger(data.updateTime);
    const quantity = money(data.positionAmt);
    const fields = {
      account,
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      side: 'NET',
      quantity,
      quantityUnit: 'BASE',
      entryPrice: observedPrice(data.entryPrice),
      marginMode: data.marginType === 'cross' ? 'CROSS' : 'ISOLATED',
      leverage: positive(data.leverage),
      liquidationPrice: observedPrice(data.liquidationPrice),
      realizedPnl: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      unrealizedPnl: { state: 'AVAILABLE', value: money(data.unRealizedProfit) },
      updatedAt,
    };
    return positionSchema.parse({ ...fields, version: version('binance-position', fields) });
  });
}

export function normalizeAlgoOrder(
  raw: unknown,
  record: InstrumentRecord,
  account: AccountScope,
  identities: BinanceIdentityPort,
): AlgoOrder {
  return guarded(() => {
    record = recordFor(record);
    scopeFor(record.instrument.scope, 'LINEAR_PERPETUAL');
    account = accountScopeSchema.parse(account);
    const data = wireObject(raw);
    if (
      data.symbol !== record.instrument.exchangeSymbol ||
      data.positionSide !== 'BOTH' ||
      data.algoType !== 'CONDITIONAL' ||
      !['STOP', 'STOP_MARKET'].includes(String(data.orderType))
    )
      return invalid();
    sideSchema.parse(data.side);
    const source =
      data.workingType === 'MARK_PRICE'
        ? 'MARK'
        : data.workingType === 'CONTRACT_PRICE'
          ? 'LAST'
          : invalid();
    const exchangeAlgoId = numericId(data.algoId);
    const clientAlgoId = clientId(data.clientAlgoId);
    let state: AlgoOrder['state'];
    switch (data.algoStatus) {
      case 'NEW':
        state = 'ACTIVE';
        break;
      case 'TRIGGERED':
      case 'FINISHED':
        state = 'TRIGGERED';
        break;
      case 'CANCELED':
        state = 'CANCELED';
        break;
      case 'REJECTED':
        state = 'REJECTED';
        break;
      case 'EXPIRED':
        state = 'UNKNOWN';
        break;
      default:
        return invalid();
    }
    const childOrderIds = data.actualOrderId === '' ? [] : [numericId(data.actualOrderId)];
    if (state === 'TRIGGERED' && childOrderIds.length !== 1) return invalid();
    return algoOrderSchema.parse({
      account,
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      ...identities.algo(account, record.instrument.id, exchangeAlgoId, clientAlgoId),
      clientAlgoId,
      exchangeAlgoId,
      childOrderIds,
      trigger: { source, price: positive(data.triggerPrice) },
      state,
      updatedAt: wireInteger(data.updateTime),
    });
  });
}

export interface BinanceMutationSpec {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly weight: number;
  readonly orders: number;
}
function commandOrder(raw: NewOrder, record: InstrumentRecord): NewOrder {
  const result = newOrderSchema.safeParse(raw);
  if (!result.success) return requestError('INVALID_REQUEST');
  const order = result.data;
  if (order.instrumentId !== record.instrument.id) return requestError('INVALID_REQUEST');
  if (order.ruleVersion !== record.rules.version) return requestError('STALE_METADATA');
  if (!/^[.A-Za-z0-9_:/-]{1,36}$/.test(order.clientOrderId)) return requestError('INVALID_REQUEST');
  if (order.size.kind !== 'BASE_QUANTITY') return requestError('UNSUPPORTED');
  if (order.size.asset !== record.instrument.baseAsset) return requestError('INVALID_REQUEST');
  if (record.instrument.scope.market === 'SPOT' && order.reduceOnly)
    return requestError('INVALID_REQUEST');
  return order;
}
function tif(value: NonNullable<NewOrder['timeInForce']>): string {
  return value === 'POST_ONLY' ? 'GTX' : value;
}

/** Signing, risk authorization, dynamic filter admission and dispatch belong to the caller. */
export function serializeOrder(raw: NewOrder, record: InstrumentRecord): BinanceMutationSpec {
  const order = commandOrder(raw, record);
  const spot = record.instrument.scope.market === 'SPOT';
  if (!spot && record.instrument.scope.market !== 'LINEAR_PERPETUAL')
    return requestError('UNSUPPORTED');
  if (!spot && order.type.startsWith('STOP_')) return requestError('UNSUPPORTED');
  if (spot && order.trigger && order.trigger.source !== 'LAST') return requestError('UNSUPPORTED');
  if (spot && order.type === 'STOP_LIMIT' && order.timeInForce === 'POST_ONLY')
    return requestError('UNSUPPORTED');
  const params: Record<string, string> = {
    symbol: record.instrument.exchangeSymbol,
    side: order.side,
    type: order.type,
    newClientOrderId: order.clientOrderId,
    quantity: order.size.value,
    newOrderRespType: 'ACK',
  };
  if (!spot) {
    params.positionSide = 'BOTH';
    params.reduceOnly = String(order.reduceOnly);
  }
  if (order.limitPrice !== null) {
    params.price = order.limitPrice;
    params.timeInForce = tif(order.timeInForce!);
  }
  if (spot) {
    if (order.type === 'LIMIT' && order.timeInForce === 'POST_ONLY') {
      params.type = 'LIMIT_MAKER';
      delete params.timeInForce;
    } else if (order.type === 'STOP_MARKET') params.type = 'STOP_LOSS';
    else if (order.type === 'STOP_LIMIT') params.type = 'STOP_LOSS_LIMIT';
  }
  if (order.trigger) params.stopPrice = order.trigger.price;
  return immutable({
    path: spot ? '/api/v3/order' : '/fapi/v1/order',
    params,
    weight: spot ? 1 : 0,
    orders: 1,
  });
}

/** Native USD-M accepts clientAlgoId but cannot honor the required child clientOrderId. */
export function serializeAlgoOrder(
  raw: NewAlgoOrder,
  record: InstrumentRecord,
): BinanceMutationSpec {
  const parsed = newAlgoOrderSchema.safeParse(raw);
  if (!parsed.success) return requestError('INVALID_REQUEST');
  if (record.instrument.scope.market !== 'LINEAR_PERPETUAL') return requestError('UNSUPPORTED');
  commandOrder(parsed.data.order, record);
  return requestError('UNSUPPORTED');
}

export function serializeOrderLocator(
  record: InstrumentRecord,
  locator: { readonly kind: 'EXCHANGE_ID' | 'CLIENT_ID'; readonly id: string },
): Readonly<Record<string, string>> {
  try {
    const params: Record<string, string> = { symbol: record.instrument.exchangeSymbol };
    if (locator.kind === 'EXCHANGE_ID') params.orderId = numericId(locator.id);
    else if (locator.kind === 'CLIENT_ID') params.origClientOrderId = clientId(locator.id);
    else return requestError('INVALID_REQUEST');
    return immutable(params);
  } catch {
    return requestError('INVALID_REQUEST');
  }
}
