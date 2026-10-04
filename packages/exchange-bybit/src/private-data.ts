import {
  accountSnapshotSchema,
  orderSchema,
  positionSchema,
  fillSchema,
  decimalSchema,
  decimalSubtract,
  decimalCompare,
  immutable,
  nonNegativeDecimalSchema,
  positiveAmountSchema,
  nonNegativeAmountSchema,
  type AccountScope,
  type InstrumentRecord,
  type MarketScope,
} from '@ctp/exchange-core';
import {
  canonicalDecimal as decimal,
  wireArray as array,
  wireId as id,
  wireInteger as integer,
  wireObject as object,
} from './wire.js';
import { observedPrice } from './public-data.js';
import { BybitProtocolError } from './client.js';

const invalid = (): never => {
  throw new BybitProtocolError('INVALID_RESPONSE');
};
const missing = { state: 'UNAVAILABLE' as const, reason: 'NOT_PROVIDED' as const };
export function normalizeWallet(
  raw: unknown,
  account: AccountScope,
  scope: MarketScope,
  exchangeTime: number,
  receivedAt: number,
) {
  const list = array(object(raw).list, 1);
  if (list.length !== 1) return invalid();
  const wallet = object(list[0]);
  if (wallet.accountType !== 'UNIFIED') throw new BybitProtocolError('UNSUPPORTED');
  return immutable(
    accountSnapshotSchema.parse({
      account,
      scope,
      balances: array(wallet.coin, 1000).map((entry) => {
        const c = object(entry);
        const total = decimalSubtract(
          decimal(c.walletBalance),
          nonNegativeDecimalSchema.parse(decimal(c.spotBorrow)),
        );
        return {
          asset: c.coin,
          free: null,
          locked:
            c.locked === undefined || c.locked === ''
              ? null
              : nonNegativeDecimalSchema.parse(decimal(c.locked)),
          total,
          availableToTrade: missing,
        };
      }),
      sourceVersion: `bybit-wallet-${exchangeTime}`,
      asOf: exchangeTime,
      receivedAt,
      freshness:
        exchangeTime > receivedAt + 1000 || receivedAt - exchangeTime > 60_000 ? 'STALE' : 'FRESH',
    }),
  );
}
export function validateNativeScope(
  x: Readonly<Record<string, unknown>>,
  record: InstrumentRecord,
) {
  if (
    x.symbol !== record.instrument.exchangeSymbol ||
    (x.category !== undefined &&
      x.category !== (record.instrument.scope.market === 'SPOT' ? 'spot' : 'linear'))
  )
    return invalid();
  if (x.positionIdx !== undefined && integer(x.positionIdx) !== 0)
    throw new BybitProtocolError('UNSUPPORTED');
}
export function normalizeOrder(
  raw: unknown,
  record: InstrumentRecord,
  account: AccountScope,
  identity: { readonly internalOrderId: string; readonly intentId: string },
) {
  const x = object(raw);
  validateNativeScope(x, record);
  if (
    !['Buy', 'Sell'].includes(String(x.side)) ||
    !['Market', 'Limit'].includes(String(x.orderType))
  )
    return invalid();
  if (
    record.instrument.scope.market === 'SPOT' &&
    x.orderType === 'Market' &&
    x.marketUnit !== 'baseCoin'
  )
    throw new BybitProtocolError('UNSUPPORTED');
  if (x.isLeverage !== undefined && integer(x.isLeverage) !== 0)
    throw new BybitProtocolError('UNSUPPORTED');
  if (x.triggerPrice !== undefined && x.triggerPrice !== '' && decimal(x.triggerPrice) !== '0')
    throw new BybitProtocolError('UNSUPPORTED');
  if (
    x.stopOrderType !== undefined &&
    !['', 'UNKNOWN'].includes(typeof x.stopOrderType === 'string' ? x.stopOrderType : 'INVALID')
  )
    throw new BybitProtocolError('UNSUPPORTED');
  const statuses: Record<string, string> = {
    New: 'OPEN',
    PartiallyFilled: 'PARTIALLY_FILLED',
    Filled: 'FILLED',
    Cancelled: 'CANCELED',
    PartiallyFilledCanceled: 'CANCELED',
    Rejected: 'REJECTED',
    Deactivated: 'EXPIRED',
  };
  const status = statuses[String(x.orderStatus)];
  if (!status) return invalid();
  const filledQuantity = nonNegativeAmountSchema.parse(decimal(x.cumExecQty));
  const quantity = positiveAmountSchema.parse(decimal(x.qty));
  if (
    (status === 'OPEN' && filledQuantity !== '0') ||
    (status === 'PARTIALLY_FILLED' &&
      (filledQuantity === '0' || decimalCompare(filledQuantity, quantity) >= 0))
  )
    return invalid();
  const averageFillPrice =
    filledQuantity === '0'
      ? { state: 'UNAVAILABLE' as const, reason: 'NO_EXECUTIONS' as const }
      : observedPrice(x.avgPrice);
  return immutable(
    orderSchema.parse({
      account,
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      ...identity,
      clientOrderId: id(x.orderLinkId),
      exchangeOrderId: id(x.orderId),
      side: x.side === 'Buy' ? 'BUY' : 'SELL',
      type: x.orderType === 'Market' ? 'MARKET' : 'LIMIT',
      status,
      price: x.orderType === 'Limit' ? observedPrice(x.price) : missing,
      stopPrice: missing,
      quantity,
      quantityUnit: 'BASE',
      filledQuantity,
      averageFillPrice,
      fees: [],
      createdAt: integer(x.createdTime),
      updatedAt: integer(x.updatedTime),
    }),
  );
}
export function normalizePosition(
  raw: unknown,
  record: InstrumentRecord,
  account: AccountScope,
  marginMode: string,
) {
  const x = object(raw);
  validateNativeScope(x, record);
  if (
    record.instrument.scope.market !== 'LINEAR_PERPETUAL' ||
    integer(x.positionIdx) !== 0 ||
    !['REGULAR_MARGIN', 'ISOLATED_MARGIN'].includes(marginMode) ||
    !['', 'Buy', 'Sell'].includes(String(x.side))
  )
    throw new BybitProtocolError('UNSUPPORTED');
  const qty = nonNegativeAmountSchema.parse(decimal(x.size));
  if (qty !== '0' && x.side === '') return invalid();
  return immutable(
    positionSchema.parse({
      account,
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      side: 'NET',
      quantity: x.side === 'Sell' && qty !== '0' ? decimal(`-${qty}`) : qty,
      quantityUnit: 'BASE',
      entryPrice: observedPrice(x.avgPrice),
      marginMode: marginMode === 'ISOLATED_MARGIN' ? 'ISOLATED' : 'CROSS',
      leverage: positiveAmountSchema.parse(decimal(x.leverage)),
      liquidationPrice: observedPrice(x.liqPrice),
      realizedPnl:
        x.cumRealisedPnl === undefined || x.cumRealisedPnl === ''
          ? missing
          : { state: 'AVAILABLE', value: decimal(x.cumRealisedPnl) },
      unrealizedPnl:
        x.unrealisedPnl === undefined || x.unrealisedPnl === ''
          ? missing
          : { state: 'AVAILABLE', value: decimal(x.unrealisedPnl) },
      version: `bybit-position-${integer(x.updatedTime)}`,
      updatedAt: integer(x.updatedTime),
    }),
  );
}
export function normalizeFill(
  raw: unknown,
  record: InstrumentRecord,
  account: AccountScope,
  internalOrderId: string,
  receivedAt: number,
) {
  const x = object(raw);
  validateNativeScope(x, record);
  if (x.execType !== 'Trade') throw new BybitProtocolError('UNSUPPORTED');
  return immutable(
    fillSchema.parse({
      account,
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      exchangeTime: integer(x.execTime),
      receivedAt,
      fillId: id(x.execId),
      identityScope: `BYBIT:${record.instrument.scope.market}:EXECUTIONS`,
      internalOrderId,
      exchangeOrderId: id(x.orderId),
      price: positiveAmountSchema.parse(decimal(x.execPrice)),
      quantity: positiveAmountSchema.parse(decimal(x.execQty)),
      quantityUnit: 'BASE',
      fees: [
        {
          asset: x.feeCurrency,
          amount: decimal(x.execFee),
          kind:
            decimalCompare(decimal(x.execFee), decimalSchema.parse('0')) < 0 ? 'REBATE' : 'TRADING',
        },
      ],
    }),
  );
}
