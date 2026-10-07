import {
  decimalCompare,
  immutable,
  inPlaceAmendmentSchema,
  parseDecimal,
  timestampSchema,
  validateOrderAgainstRules,
  type InPlaceAmendment,
  type InstrumentRecord,
} from '@ctp/exchange-core';
import { BinanceProtocolError, type RestSpec } from './client.js';
import type { BinanceAdmission } from './public-data.js';
import type { BinanceEndpointProfile } from './profiles.js';
import { canonicalDecimal, wireArray, wireId, wireInteger, wireObject } from './wire.js';

// Official Spot REST/keep-priority FAQ reviewed 2026-10-07. Only standalone
// LIMIT/GTC quantity reduction: no coupled lists, iceberg, SOR or cancel/replace.
const fail = (
  code: 'INVALID_REQUEST' | 'INVALID_RESPONSE' | 'UNSUPPORTED' | 'STALE_METADATA',
): never => {
  throw new BinanceProtocolError(code);
};
const integerId = (value: unknown) => {
  const s = wireId(value);
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(s) || BigInt(s) > 9223372036854775807n)
    return fail('INVALID_RESPONSE');
  return s;
};
const clientId = (value: string) => /^[A-Za-z0-9_-]{1,36}$/.test(value);

export function validateBinanceAmendment(
  raw: unknown,
  record: InstrumentRecord,
  admission: BinanceAdmission,
  endpoint: BinanceEndpointProfile,
  now: number,
): InPlaceAmendment {
  const parsed = inPlaceAmendmentSchema.safeParse(raw);
  if (!parsed.success) return fail('INVALID_REQUEST');
  const c = parsed.data,
    before = c.target.current,
    after = c.replacement;
  if (
    endpoint.id !== 'binance-spot-testnet-v1' ||
    !admission.amendAllowed ||
    admission.unsupportedFilters.length ||
    before.type !== 'LIMIT' ||
    before.timeInForce !== 'GTC' ||
    before.reduceOnly ||
    before.size.kind !== 'BASE_QUANTITY' ||
    after.size.kind !== 'BASE_QUANTITY' ||
    before.limitPrice !== after.limitPrice ||
    decimalCompare(after.size.value, before.size.value) >= 0
  )
    return fail('UNSUPPORTED');
  if (
    record.instrument.scope.exchange !== 'BINANCE' ||
    record.instrument.scope.market !== 'SPOT' ||
    record.instrument.scope.environment !== 'TESTNET' ||
    record.instrument.scope.region !== endpoint.scope.region ||
    admission.symbol !== record.instrument.exchangeSymbol ||
    c.locator.instrumentId !== record.instrument.id ||
    !clientId(before.clientOrderId) ||
    !clientId(after.clientOrderId)
  )
    return fail('INVALID_REQUEST');
  integerId(c.locator.locator.id);
  if (c.target.observedAt > now || now - c.target.observedAt > 5000) return fail('STALE_METADATA');
  const rules = validateOrderAgainstRules(after, record, now);
  if (!rules.ok)
    throw new BinanceProtocolError(
      rules.error.code === 'STALE_METADATA' ? 'STALE_METADATA' : 'INVALID_REQUEST',
    );
  return immutable(c);
}

/** Check a fresh native query against the server-observed effective target before mutation. */
export function checkBinanceAmendmentTarget(
  raw: unknown,
  c: InPlaceAmendment,
  symbol: string,
): void {
  const n = wireObject(raw),
    b = c.target.current;
  if (
    n.symbol !== symbol ||
    integerId(n.orderId) !== c.locator.locator.id ||
    n.clientOrderId !== b.clientOrderId ||
    wireId(n.orderListId) !== '-1' ||
    (n.status !== 'NEW' && n.status !== 'PARTIALLY_FILLED') ||
    n.type !== 'LIMIT' ||
    n.timeInForce !== 'GTC' ||
    n.side !== b.side ||
    canonicalDecimal(n.price) !== b.limitPrice ||
    canonicalDecimal(n.origQty) !== b.size.value ||
    canonicalDecimal(n.executedQty) !== c.target.filledQuantity ||
    wireInteger(n.updateTime) !== c.target.nativeUpdatedAt ||
    canonicalDecimal(n.icebergQty) !== '0' ||
    canonicalDecimal(n.origQuoteOrderQty) !== '0' ||
    canonicalDecimal(n.stopPrice) !== '0' ||
    (n.usedSor !== undefined && n.usedSor !== false) ||
    n.workingFloor !== undefined ||
    n.trailingDelta !== undefined ||
    n.pegPriceType !== undefined
  )
    return fail('INVALID_REQUEST');
}

/** A serialization helper is not authorization. Only Core's one-use permit may reach I/O. */
export function serializeBinanceAmendment(c: InPlaceAmendment, symbol: string): RestSpec {
  return immutable({
    path: '/api/v3/order/amend/keepPriority',
    method: 'PUT',
    weight: 4,
    orders: 0,
    symbol,
    params: {
      symbol,
      orderId: c.locator.locator.id,
      origClientOrderId: c.target.current.clientOrderId,
      newClientOrderId: c.replacement.clientOrderId,
      newQty: c.replacement.size.value,
    },
  });
}

/** Even a correlated response is ACK only; a raced fill retains UNKNOWN and collateral. */
export function checkBinanceAmendmentAck(
  raw: unknown,
  c: InPlaceAmendment,
  symbol: string,
  receivedAt: number,
) {
  const root = wireObject(raw),
    n = wireObject(root.amendedOrder);
  const time = timestampSchema.parse(wireInteger(root.transactTime));
  const executionId = integerId(root.executionId);
  if (
    time < c.target.nativeUpdatedAt ||
    time > receivedAt ||
    root.listStatus !== undefined ||
    n.symbol !== symbol ||
    integerId(n.orderId) !== c.locator.locator.id ||
    wireId(n.orderListId) !== '-1' ||
    n.origClientOrderId !== c.target.current.clientOrderId ||
    n.clientOrderId !== c.replacement.clientOrderId ||
    canonicalDecimal(n.qty) !== c.replacement.size.value ||
    canonicalDecimal(n.price) !== c.replacement.limitPrice ||
    canonicalDecimal(n.executedQty) !== c.target.filledQuantity ||
    canonicalDecimal(n.preventedQty) !== '0' ||
    canonicalDecimal(n.quoteOrderQty) !== '0' ||
    n.type !== 'LIMIT' ||
    n.side !== c.replacement.side ||
    n.timeInForce !== 'GTC' ||
    !['NEW', 'PARTIALLY_FILLED'].includes(String(n.status))
  )
    return fail('INVALID_RESPONSE');
  return immutable({ executionId, time, exchangeOrderId: c.locator.locator.id });
}

/** Historical causal evidence, never a final order outcome or proof of absence. */
export function reconcileBinanceAmendmentHistory(
  raw: unknown,
  c: InPlaceAmendment,
  symbol: string,
  receivedAt: number,
) {
  const rows = wireArray(raw, 1000);
  if (rows.length === 1000) return fail('INVALID_RESPONSE');
  let previous: { executionId: string; time: number; newQty: string; clientId: string } | undefined;
  let match:
    | {
        executionId: string;
        time: number;
        exchangeOrderId: string;
        oldClientOrderId: string;
        newClientOrderId: string;
        originalQuantity: string;
        newQuantity: string;
      }
    | undefined;
  for (const rawRow of rows) {
    const n = wireObject(rawRow),
      executionId = integerId(n.executionId),
      time = timestampSchema.parse(wireInteger(n.time));
    const origQty = canonicalDecimal(n.origQty),
      newQty = canonicalDecimal(n.newQty);
    if (
      n.symbol !== symbol ||
      integerId(n.orderId) !== c.locator.locator.id ||
      time > receivedAt ||
      typeof n.origClientOrderId !== 'string' ||
      typeof n.newClientOrderId !== 'string' ||
      !clientId(n.origClientOrderId) ||
      !clientId(n.newClientOrderId) ||
      decimalCompare(parseDecimal(newQty), parseDecimal('0')) <= 0 ||
      decimalCompare(parseDecimal(newQty), parseDecimal(origQty)) >= 0 ||
      (previous &&
        (BigInt(executionId) <= BigInt(previous.executionId) ||
          time < previous.time ||
          origQty !== previous.newQty ||
          n.origClientOrderId !== previous.clientId))
    )
      return fail('INVALID_RESPONSE');
    previous = { executionId, time, newQty, clientId: n.newClientOrderId };
    if (
      n.origClientOrderId === c.target.current.clientOrderId &&
      n.newClientOrderId === c.replacement.clientOrderId
    ) {
      if (
        match ||
        origQty !== c.target.current.size.value ||
        newQty !== c.replacement.size.value ||
        time < c.target.nativeUpdatedAt
      )
        return fail('INVALID_RESPONSE');
      match = {
        executionId,
        time,
        exchangeOrderId: c.locator.locator.id,
        oldClientOrderId: n.origClientOrderId,
        newClientOrderId: n.newClientOrderId,
        originalQuantity: origQty,
        newQuantity: newQty,
      };
    }
  }
  return immutable(
    match
      ? { kind: 'APPLIED_EVIDENCE' as const, evidence: match }
      : { kind: 'INDETERMINATE' as const, reason: 'NO_CAUSAL_EVIDENCE' as const },
  );
}
