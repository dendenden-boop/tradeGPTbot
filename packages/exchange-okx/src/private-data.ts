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
import { OkxProtocolError } from './client.js';
const invalid = (): never => {
  throw new OkxProtocolError('INVALID_RESPONSE');
};
const missing = { state: 'UNAVAILABLE' as const, reason: 'NOT_PROVIDED' as const };
export function normalizeWallet(
  raw: unknown,
  account: AccountScope,
  scope: MarketScope,
  receivedAt: number,
) {
  const rows = array(raw, 1);
  if (rows.length !== 1) return invalid();
  const x = object(rows[0]),
    asOf = integer(x.uTime);
  return immutable(
    accountSnapshotSchema.parse({
      account,
      scope,
      balances: array(x.details, 1000).map((entry) => {
        const c = object(entry);
        if (c.liab === undefined || decimal(c.liab) !== '0')
          throw new OkxProtocolError('UNSUPPORTED');
        return {
          asset: c.ccy,
          free: null,
          locked:
            c.frozenBal === undefined || c.frozenBal === ''
              ? null
              : nonNegativeDecimalSchema.parse(decimal(c.frozenBal)),
          total: decimal(c.cashBal),
          availableToTrade:
            c.availBal === undefined || c.availBal === ''
              ? missing
              : { state: 'AVAILABLE', value: decimal(c.availBal) },
        };
      }),
      sourceVersion: `okx-wallet-${asOf}`,
      asOf,
      receivedAt,
      freshness: asOf > receivedAt + 1000 || receivedAt - asOf > 60000 ? 'STALE' : 'FRESH',
    }),
  );
}
export function validateNativeScope(
  x: Readonly<Record<string, unknown>>,
  record: InstrumentRecord,
) {
  if (
    x.instId !== record.instrument.exchangeSymbol ||
    x.instType !== (record.instrument.scope.market === 'SPOT' ? 'SPOT' : 'SWAP')
  )
    return invalid();
  if (x.posSide !== undefined && x.posSide !== '' && x.posSide !== 'net')
    throw new OkxProtocolError('UNSUPPORTED');
}
export function validateOrdinaryOrder(
  x: Readonly<Record<string, unknown>>,
  record: InstrumentRecord,
  tradeMode: string,
) {
  validateNativeScope(x, record);
  if (
    (x.algoId !== undefined && x.algoId !== '') ||
    (x.algoClOrdId !== undefined && x.algoClOrdId !== '') ||
    array(x.attachAlgoOrds ?? [], 16).length !== 0
  )
    throw new OkxProtocolError('UNSUPPORTED');
  if (x.tdMode !== tradeMode) throw new OkxProtocolError('UNSUPPORTED');
  if (
    record.instrument.scope.market === 'SPOT' &&
    (tradeMode !== 'cash' ||
      x.posSide !== '' ||
      x.tradeQuoteCcy !== 'USDT' ||
      (x.ordType === 'market' && x.tgtCcy !== 'base_ccy'))
  )
    throw new OkxProtocolError('UNSUPPORTED');
  if (
    record.instrument.scope.market !== 'SPOT' &&
    (x.posSide !== 'net' || !['cross', 'isolated'].includes(tradeMode))
  )
    throw new OkxProtocolError('UNSUPPORTED');
}
export function normalizeOrder(
  raw: unknown,
  record: InstrumentRecord,
  account: AccountScope,
  identity: { readonly internalOrderId: string; readonly intentId: string },
  tradeMode: string,
) {
  const x = object(raw);
  validateOrdinaryOrder(x, record, tradeMode);
  if (
    !['buy', 'sell'].includes(String(x.side)) ||
    !['market', 'limit', 'post_only', 'ioc', 'fok'].includes(String(x.ordType))
  )
    return invalid();
  const statuses: Record<string, string> = {
      live: 'OPEN',
      partially_filled: 'PARTIALLY_FILLED',
      filled: 'FILLED',
      canceled: 'CANCELED',
      mmp_canceled: 'CANCELED',
    },
    status = statuses[String(x.state)];
  if (!status) return invalid();
  const quantity = positiveAmountSchema.parse(decimal(x.sz)),
    filledQuantity = nonNegativeAmountSchema.parse(decimal(x.accFillSz));
  if (
    (status === 'OPEN' && filledQuantity !== '0') ||
    (status === 'PARTIALLY_FILLED' &&
      (filledQuantity === '0' || decimalCompare(filledQuantity, quantity) >= 0))
  )
    return invalid();
  return immutable(
    orderSchema.parse({
      account,
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      ...identity,
      clientOrderId: id(x.clOrdId),
      exchangeOrderId: id(x.ordId),
      side: x.side === 'buy' ? 'BUY' : 'SELL',
      type: x.ordType === 'market' ? 'MARKET' : 'LIMIT',
      status,
      price: x.ordType === 'market' ? missing : observedPrice(x.px),
      stopPrice: missing,
      quantity,
      quantityUnit: record.rules.quantityUnit,
      filledQuantity,
      averageFillPrice:
        filledQuantity === '0'
          ? { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' }
          : observedPrice(x.avgPx),
      fees: [],
      createdAt: integer(x.cTime),
      updatedAt: integer(x.uTime),
    }),
  );
}
export function normalizePosition(
  raw: unknown,
  record: InstrumentRecord,
  account: AccountScope,
  tradeMode: string,
) {
  const x = object(raw);
  validateNativeScope(x, record);
  if (
    record.instrument.scope.market !== 'LINEAR_PERPETUAL' ||
    x.posSide !== 'net' ||
    x.mgnMode !== tradeMode ||
    !['cross', 'isolated'].includes(tradeMode)
  )
    throw new OkxProtocolError('UNSUPPORTED');
  const observed = (v: unknown) =>
    v === undefined || v === '' ? missing : { state: 'AVAILABLE' as const, value: decimal(v) };
  return immutable(
    positionSchema.parse({
      account,
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      side: 'NET',
      quantity: decimal(x.pos),
      quantityUnit: 'CONTRACTS',
      entryPrice: observedPrice(x.avgPx),
      marginMode: tradeMode === 'cross' ? 'CROSS' : 'ISOLATED',
      leverage: positiveAmountSchema.parse(decimal(x.lever)),
      liquidationPrice: observedPrice(x.liqPx),
      realizedPnl: observed(x.realizedPnl),
      unrealizedPnl: observed(x.upl),
      version: `okx-position-${integer(x.uTime)}`,
      updatedAt: integer(x.uTime),
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
  if (
    !['buy', 'sell'].includes(String(x.side)) ||
    (record.instrument.scope.market === 'SPOT' && x.tradeQuoteCcy !== 'USDT')
  )
    return invalid();
  const fee = decimal(x.fee);
  return immutable(
    fillSchema.parse({
      account,
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      exchangeTime: integer(x.fillTime),
      receivedAt,
      fillId: id(x.billId),
      identityScope: `OKX:${record.instrument.scope.market}:EXECUTION_BILL`,
      internalOrderId,
      exchangeOrderId: id(x.ordId),
      price: positiveAmountSchema.parse(decimal(x.fillPx)),
      quantity: positiveAmountSchema.parse(decimal(x.fillSz)),
      quantityUnit: record.rules.quantityUnit,
      fees: [
        {
          asset: x.feeCcy,
          amount: decimalSubtract(decimalSchema.parse('0'), fee),
          kind: decimalCompare(fee, decimalSchema.parse('0')) > 0 ? 'REBATE' : 'TRADING',
        },
      ],
    }),
  );
}
