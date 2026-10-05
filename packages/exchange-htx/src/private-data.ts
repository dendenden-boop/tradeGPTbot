import { randomUUID } from 'node:crypto';
import {
  accountSnapshotSchema,
  orderSchema,
  positionSchema,
  fillSchema,
  immutable,
  decimalAdd,
  decimalCompare,
  decimalSubtract,
  isStepAligned,
  parseDecimal,
  type AccountScope,
  type InstrumentRecord,
  type MarketScope,
} from '@ctp/exchange-core';
import { HtxProtocolError } from './client.js';
import { exchangeTimestamp } from './public-data.js';
import {
  canonicalDecimal as decimal,
  wireObject as object,
  wireArray as array,
  wireInteger as integer,
  wireId as id,
} from './wire.js';
const unavailable = Object.freeze({
  state: 'UNAVAILABLE' as const,
  reason: 'NOT_PROVIDED' as const,
});
const price = (x: unknown) =>
  x === null || x === undefined || x === '' || decimal(x) === '0'
    ? unavailable
    : { state: 'AVAILABLE' as const, value: decimal(x) };
const asset = (x: unknown) => {
  if (typeof x !== 'string' || !/^[a-zA-Z0-9]{1,32}$/.test(x))
    throw new HtxProtocolError('INVALID_RESPONSE');
  return x.toUpperCase();
};
function nativeId(x: Record<string, unknown>): string {
  const n = id(x.order_id_str ?? x.order_id);
  if (x.order_id !== undefined && id(x.order_id) !== n)
    throw new HtxProtocolError('SCOPE_MISMATCH');
  return n;
}
export function validateLinearScope(x: Record<string, unknown>, r: InstrumentRecord) {
  if (
    x.contract_code !== r.instrument.exchangeSymbol ||
    x.symbol !== r.instrument.baseAsset ||
    x.pair !== r.instrument.exchangeSymbol ||
    x.business_type !== 'swap' ||
    x.contract_type !== 'swap' ||
    x.margin_mode !== 'cross' ||
    x.margin_account !== 'USDT' ||
    (x.margin_asset !== undefined && x.margin_asset !== 'USDT')
  )
    throw new HtxProtocolError('SCOPE_MISMATCH');
}
export function normalizeWallet(
  raw: unknown,
  account: AccountScope,
  scope: MarketScope,
  asOf: number,
  receivedAt: number,
  spotAccountId?: string,
) {
  const t = exchangeTimestamp(asOf, receivedAt);
  if (scope.market === 'SPOT') {
    const x = object(raw);
    if (id(x.id) !== spotAccountId || x.type !== 'spot' || x.state !== 'working')
      throw new HtxProtocolError('SCOPE_MISMATCH');
    const balances = new Map<string, Map<string, ReturnType<typeof decimal>>>();
    for (const row of array(x.list, 2000)) {
      const b = object(row),
        currency = asset(b.currency),
        kind = String(b.type);
      if (!['trade', 'frozen'].includes(kind)) throw new HtxProtocolError('UNSUPPORTED');
      const entries = balances.get(currency) ?? new Map<string, ReturnType<typeof decimal>>();
      if (entries.has(kind)) throw new HtxProtocolError('INVALID_RESPONSE');
      entries.set(kind, decimal(b.balance));
      balances.set(currency, entries);
    }
    return immutable(
      accountSnapshotSchema.parse({
        account,
        scope,
        balances: [...balances].map(([asset, x]) => {
          const free = x.get('trade'),
            locked = x.get('frozen');
          if (free === undefined || locked === undefined)
            throw new HtxProtocolError('INVALID_RESPONSE');
          return {
            asset,
            free,
            locked,
            total: decimalAdd(free, locked),
            availableToTrade: { state: 'AVAILABLE', value: free },
          };
        }),
        sourceVersion: randomUUID(),
        asOf: t,
        receivedAt,
        freshness: receivedAt - t <= 5000 ? 'FRESH' : 'STALE',
      }),
    );
  }
  const rows = array(raw, 1);
  if (rows.length !== 1) throw new HtxProtocolError('INVALID_RESPONSE');
  const x = object(rows[0]);
  if (
    x.margin_mode !== 'cross' ||
    x.margin_account !== 'USDT' ||
    x.margin_asset !== 'USDT' ||
    x.position_mode !== 'dual_side'
  )
    throw new HtxProtocolError('SCOPE_MISMATCH');
  // Native equity includes unrealized PnL; Portfolio adds that component separately.
  const total = decimal(x.margin_static);
  if (
    receivedAt - t > 5000 ||
    decimalCompare(decimal(x.margin_balance), decimalAdd(total, decimal(x.profit_unreal))) !== 0
  )
    throw new HtxProtocolError('INVALID_RESPONSE');
  return immutable(
    accountSnapshotSchema.parse({
      account,
      scope,
      balances: [
        {
          asset: 'USDT',
          free: null,
          locked: null,
          total,
          availableToTrade: unavailable,
        },
      ],
      sourceVersion: randomUUID(),
      asOf: t,
      receivedAt,
      freshness: receivedAt - t <= 5000 ? 'FRESH' : 'STALE',
    }),
  );
}
export function normalizeOrder(
  raw: unknown,
  r: InstrumentRecord,
  account: AccountScope,
  identity: { readonly internalOrderId: string; readonly intentId: string },
  receivedAt: number,
  spotAccountId?: string,
) {
  const x = object(raw),
    spot = r.instrument.scope.market === 'SPOT';
  let side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    status: string,
    quantity: ReturnType<typeof decimal>,
    filled: ReturnType<typeof decimal>,
    createdAt: number,
    updatedAt: number,
    exchangeOrderId: string,
    clientOrderId: string;
  if (spot) {
    if (x.symbol !== r.instrument.id || id(x['account-id']) !== spotAccountId)
      throw new HtxProtocolError('SCOPE_MISMATCH');
    const nativeType = String(x.type);
    if (nativeType === 'buy-market') throw new HtxProtocolError('UNSUPPORTED');
    if (
      !/^(buy|sell)-(limit|ioc|limit-maker|limit-fok|market)$/.test(nativeType) ||
      (x['stop-price'] !== undefined && decimal(x['stop-price']) !== '0')
    )
      throw new HtxProtocolError('UNSUPPORTED');
    side = nativeType.startsWith('buy-') ? 'BUY' : 'SELL';
    type = nativeType.endsWith('market') ? 'MARKET' : 'LIMIT';
    const states: Record<string, string> = {
      created: 'PENDING',
      submitted: 'OPEN',
      'partial-filled': 'PARTIALLY_FILLED',
      filled: 'FILLED',
      canceled: 'CANCELED',
      'partial-canceled': 'CANCELED',
      rejected: 'REJECTED',
    };
    status = states[String(x.state)] ?? '';
    quantity = decimal(x.amount);
    filled = decimal(x['filled-amount'] ?? x['field-amount']);
    createdAt = integer(x['created-at']);
    updatedAt = Math.max(createdAt, integer(x['finished-at'] ?? 0), integer(x['canceled-at'] ?? 0));
    exchangeOrderId = id(x.id);
    clientOrderId = id(x['client-order-id']);
  } else {
    validateLinearScope(x, r);
    if (
      !['buy', 'sell'].includes(String(x.direction)) ||
      !['open', 'close'].includes(String(x.offset)) ||
      (x.is_tpsl !== undefined && integer(x.is_tpsl) !== 0) ||
      (x.reduce_only !== undefined && integer(x.reduce_only) !== 0)
    )
      throw new HtxProtocolError('UNSUPPORTED');
    if (!['market', 'limit', 'post_only', 'ioc', 'fok'].includes(String(x.order_price_type)))
      throw new HtxProtocolError('UNSUPPORTED');
    side = x.direction === 'buy' ? 'BUY' : 'SELL';
    type = x.order_price_type === 'market' ? 'MARKET' : 'LIMIT';
    status =
      (
        {
          1: 'PENDING',
          2: 'PENDING',
          3: 'OPEN',
          4: 'PARTIALLY_FILLED',
          5: 'CANCELED',
          6: 'FILLED',
          7: 'CANCELED',
          11: 'EXPIRED',
        } as Record<number, string>
      )[integer(x.status)] ?? '';
    quantity = decimal(x.volume);
    filled = decimal(x.trade_volume);
    if (!isStepAligned(quantity, parseDecimal('1')) || !isStepAligned(filled, parseDecimal('1')))
      throw new HtxProtocolError('INVALID_RESPONSE');
    createdAt = integer(x.created_at);
    updatedAt = Math.max(createdAt, integer(x.update_time ?? 0), integer(x.canceled_at ?? 0));
    exchangeOrderId = nativeId(x);
    clientOrderId = id(x.client_order_id);
    if (!/^\d{1,19}$/.test(clientOrderId) || BigInt(clientOrderId) > 9223372036854775807n)
      throw new HtxProtocolError('INVALID_RESPONSE');
  }
  exchangeTimestamp(updatedAt, receivedAt);
  return immutable(
    orderSchema.parse({
      account,
      scope: r.instrument.scope,
      instrumentId: r.instrument.id,
      ...identity,
      exchangeOrderId,
      clientOrderId,
      side,
      type,
      status,
      price: type === 'MARKET' ? unavailable : price(x.price),
      stopPrice: unavailable,
      quantity,
      quantityUnit: spot ? 'BASE' : 'CONTRACTS',
      filledQuantity: filled,
      averageFillPrice:
        filled === '0'
          ? { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' }
          : spot
            ? unavailable
            : price(x.trade_avg_price),
      fees: [],
      createdAt,
      updatedAt,
    }),
  );
}
export function normalizePosition(
  raw: unknown,
  r: InstrumentRecord,
  account: AccountScope,
  observedAt: number,
) {
  const x = object(raw);
  validateLinearScope(x, r);
  if (x.position_mode !== 'dual_side' || !['buy', 'sell'].includes(String(x.direction)))
    throw new HtxProtocolError('SCOPE_MISMATCH');
  const quantity = decimal(x.volume);
  if (!isStepAligned(quantity, parseDecimal('1'))) throw new HtxProtocolError('INVALID_RESPONSE');
  return immutable(
    positionSchema.parse({
      account,
      scope: r.instrument.scope,
      instrumentId: r.instrument.id,
      side: x.direction === 'buy' ? 'LONG' : 'SHORT',
      quantity,
      quantityUnit: 'CONTRACTS',
      entryPrice: price(x.cost_open),
      marginMode: 'CROSS',
      leverage: decimal(x.lever_rate),
      liquidationPrice: price(x.liquidation_price),
      realizedPnl:
        x.profit === undefined ? unavailable : { state: 'AVAILABLE', value: decimal(x.profit) },
      unrealizedPnl:
        x.profit_unreal === undefined
          ? unavailable
          : { state: 'AVAILABLE', value: decimal(x.profit_unreal) },
      version: randomUUID(),
      updatedAt: observedAt,
    }),
  );
}
export function normalizeFill(
  raw: unknown,
  r: InstrumentRecord,
  account: AccountScope,
  identity: { readonly internalOrderId: string },
  receivedAt: number,
) {
  const x = object(raw),
    spot = r.instrument.scope.market === 'SPOT';
  if (spot) {
    if (
      x.symbol !== r.instrument.id ||
      !['spot-api', 'spot-web', 'spot-app'].includes(String(x.source))
    )
      throw new HtxProtocolError('SCOPE_MISMATCH');
    if (x['fee-deduct-state'] === 'ongoing') throw new HtxProtocolError('UNSUPPORTED');
  } else validateLinearScope(x, r);
  const fee = decimal(spot ? x['filled-fees'] : x.trade_fee),
    fees = [
      {
        amount: spot ? fee : decimalSubtract(parseDecimal('0'), fee),
        asset: asset(spot ? x['fee-currency'] : x.fee_asset),
        kind: (
          spot
            ? decimalCompare(fee, parseDecimal('0')) < 0
            : decimalCompare(fee, parseDecimal('0')) > 0
        )
          ? 'REBATE'
          : 'TRADING',
      },
    ];
  if (spot && x['filled-points'] !== undefined && decimal(x['filled-points']) !== '0')
    fees.push({
      amount: decimal(x['filled-points']),
      asset: asset(x['fee-deduct-currency']),
      kind: 'TRADING',
    });
  const quantity = decimal(spot ? x['filled-amount'] : x.trade_volume);
  if (!spot && !isStepAligned(quantity, parseDecimal('1')))
    throw new HtxProtocolError('INVALID_RESPONSE');
  return immutable(
    fillSchema.parse({
      account,
      scope: r.instrument.scope,
      instrumentId: r.instrument.id,
      internalOrderId: identity.internalOrderId,
      fillId: spot ? id(x.id) : `${id(x.match_id)}.${id(x.id)}`,
      identityScope: `HTX:${r.instrument.scope.market}:${r.instrument.id}:EXECUTION`,
      exchangeOrderId: spot ? id(x['order-id']) : nativeId(x),
      exchangeTime: exchangeTimestamp(spot ? x['created-at'] : x.create_date, receivedAt),
      receivedAt,
      price: decimal(spot ? x.price : x.trade_price),
      quantity,
      quantityUnit: spot ? 'BASE' : 'CONTRACTS',
      fees,
    }),
  );
}
