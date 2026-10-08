import { z } from 'zod';
import {
  adapterProfileSchema,
  capabilityRecordSchema,
  decimalSchema,
  amountDecimalSchema,
  nonNegativeDecimalSchema,
  positiveDecimalSchema,
  positiveAmountSchema,
  rateDecimalSchema,
  idSchema,
  timestampSchema,
  instrumentSchema,
  tradingRulesSchema,
  newOrderSchema,
  inPlaceAmendmentSchema,
  immutable,
  sameMarketScope,
  evaluateCapability,
  validateOrderAgainstRules,
  decimalCompare,
  decimalAdd,
  decimalSubtract,
  decimalMultiply,
  parseDecimal,
} from '@ctp/exchange-core';

const cmp = (a: string, b: string) => decimalCompare(parseDecimal(a), parseDecimal(b));
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const sub = (a: string, b: string) => decimalSubtract(parseDecimal(a), parseDecimal(b));
const mul = (a: string, b: string) => decimalMultiply(parseDecimal(a), parseDecimal(b));
const rate = rateDecimalSchema.refine((v) => cmp(v, '0') >= 0 && cmp(v, '1') <= 0);
const count = z.number().int().min(0).max(1_000_000);
export const riskLimitsSchema = z.strictObject({
  valuationAsset: idSchema,
  maxOrderNotional: nonNegativeDecimalSchema,
  maxInstrumentExposure: nonNegativeDecimalSchema,
  maxAssetExposure: nonNegativeDecimalSchema,
  maxAccountExposure: nonNegativeDecimalSchema,
  maxUserExposure: nonNegativeDecimalSchema,
  maxConcurrentPositions: count,
  maxOpenOrders: count,
  maxLeverage: positiveAmountSchema,
  maxDailyRealizedLoss: nonNegativeDecimalSchema,
  maxDailyTotalLoss: nonNegativeDecimalSchema,
  maxDrawdownRate: rate,
  maxOrdersPerMinute: count,
  minAvailableBalance: nonNegativeDecimalSchema,
  maxPriceDeviationRate: rate,
  maxSpreadRate: rate,
  minLiquidityNotional: nonNegativeDecimalSchema,
  maxEvidenceAgeMs: z.number().int().min(1).max(5000),
});
export type RiskLimits = z.infer<typeof riskLimitsSchema>;
/** Pure limits intersection; no defaults, persistence, authentication or transport authority. */
export function intersectRiskLimits(platform: unknown, user: unknown): Readonly<RiskLimits> {
  try {
    const p = riskLimitsSchema.parse(platform),
      u = riskLimitsSchema.parse(user);
    if (p.valuationAsset !== u.valuationAsset) throw new Error();
    const result = { ...p };
    for (const k of [
      'maxOrderNotional',
      'maxInstrumentExposure',
      'maxAssetExposure',
      'maxAccountExposure',
      'maxUserExposure',
      'maxLeverage',
      'maxDailyRealizedLoss',
      'maxDailyTotalLoss',
      'maxDrawdownRate',
      'maxPriceDeviationRate',
      'maxSpreadRate',
    ] as const)
      result[k] = cmp(p[k], u[k]) <= 0 ? p[k] : u[k];
    for (const k of ['minAvailableBalance', 'minLiquidityNotional'] as const)
      result[k] = cmp(p[k], u[k]) >= 0 ? p[k] : u[k];
    for (const k of [
      'maxConcurrentPositions',
      'maxOpenOrders',
      'maxOrdersPerMinute',
      'maxEvidenceAgeMs',
    ] as const)
      result[k] = Math.min(p[k], u[k]);
    return immutable(result);
  } catch {
    throw new Error('RISK_POLICY_INVALID');
  }
}
const bindingSchema = z.strictObject({
  tenantId: z.uuid(),
  accountId: z.uuid(),
  mode: z.enum(['PAPER', 'TESTNET', 'DEMO', 'LIVE']),
  profile: adapterProfileSchema,
});
const health = z.enum(['HEALTHY', 'FAILED', 'UNKNOWN']);
const snapshotSchema = z.strictObject({
  binding: bindingSchema,
  instrumentId: idSchema,
  revision: z.string().regex(/^[1-9]\d{0,63}$/),
  sourceId: idSchema,
  sourceAt: timestampSchema,
  reconciledAt: timestampSchema,
  complete: z.boolean(),
  unknownExposure: z.boolean(),
  valuationAsset: idSchema,
  instrumentExposure: nonNegativeDecimalSchema,
  assetExposure: nonNegativeDecimalSchema,
  accountExposure: nonNegativeDecimalSchema,
  userExposure: nonNegativeDecimalSchema,
  positionQuantity: amountDecimalSchema,
  positionEvidence: z.strictObject({
    mode: z.enum(['SPOT', 'ONE_WAY', 'HEDGE']),
    accountMode: idSchema,
    accountId: z.uuid(),
    instrumentId: idSchema,
    sourceId: idSchema,
    revision: z.string().regex(/^[1-9]\d{0,63}$/),
    asOf: timestampSchema,
    side: z.enum(['NET', 'LONG', 'SHORT']),
    quantity: amountDecimalSchema,
  }),
  committedReductionQuantity: nonNegativeDecimalSchema,
  instrumentHasPendingEntry: z.boolean(),
  concurrentPositions: count,
  openOrders: count,
  ordersInLastMinute: count,
  leverage: positiveAmountSchema,
  availableAsset: idSchema,
  availableAmount: nonNegativeDecimalSchema,
  dailyNetRealizedPnl: decimalSchema,
  adjustedOpeningEquity: decimalSchema,
  adjustedCurrentEquity: decimalSchema,
  adjustedPeakEquity: decimalSchema,
  utcDayStart: timestampSchema,
  lossBaselineComplete: z.boolean(),
  pauses: z.strictObject({
    global: z.boolean(),
    user: z.boolean(),
    connection: z.boolean(),
    strategy: z.boolean(),
  }),
  circuit: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
  health: z.strictObject({
    database: health,
    limiter: health,
    authentication: health,
    exchangeRest: health,
    privateStream: health,
    clock: health,
    latency: health,
    rejectRate: health,
    maintenance: health,
  }),
  market: z.strictObject({
    sourceId: idSchema,
    asOf: timestampSchema,
    complete: z.boolean(),
    referencePrice: positiveAmountSchema,
    lowerExecutionPrice: positiveAmountSchema,
    upperExecutionPrice: positiveAmountSchema,
    bid: positiveAmountSchema,
    ask: positiveAmountSchema,
    liquidityNotional: nonNegativeDecimalSchema,
    liquidityAsset: idSchema,
    priceAsset: idSchema,
    quoteToValuation: positiveDecimalSchema,
    fxFromAsset: idSchema,
    fxToAsset: idSchema,
    fxKind: z.enum(['IDENTITY', 'OBSERVED']),
    fxSourceId: idSchema,
    fxAsOf: timestampSchema,
    kind: z.enum(['LAST', 'MARK']),
    executionBoundEnforced: z.boolean(),
    feeAsset: idSchema,
    maxFeeRate: rate,
  }),
});
export const riskEvaluationInputSchema = z.strictObject({
  now: timestampSchema,
  binding: bindingSchema,
  adapterVersion: idSchema,
  platform: riskLimitsSchema,
  user: riskLimitsSchema,
  order: newOrderSchema,
  record: z.strictObject({ instrument: instrumentSchema, rules: tradingRulesSchema }),
  capabilities: z.array(capabilityRecordSchema).max(8),
  snapshot: snapshotSchema,
});
export type RiskEvaluationInput = z.infer<typeof riskEvaluationInputSchema>;
export type RiskEvaluation =
  | { readonly kind: 'REJECTED'; readonly reasons: readonly string[] }
  | {
      readonly kind: 'EVALUATED';
      readonly effect: 'INCREASE' | 'REDUCE' | 'RETAIN';
      readonly notional: string;
      readonly proposal: { readonly asset: string; readonly amount: string };
    };
const reject = (code: string): RiskEvaluation => immutable({ kind: 'REJECTED', reasons: [code] });
/** Server-only pure calculation. EVALUATED is not a durable RiskGrant or permission to dispatch. */
export function evaluateRiskPolicy(raw: unknown): RiskEvaluation {
  return evaluatePolicy(raw, false);
}

export const riskAmendmentRetentionSchema = z.strictObject({
  orderId: z.uuid(),
  placeIntentId: z.uuid(),
  reservationId: z.uuid(),
  accountId: z.uuid(),
  mode: bindingSchema.shape.mode,
  asset: idSchema,
  amount: nonNegativeDecimalSchema,
  status: z.enum(['ACTIVE', 'UNRESOLVED', 'RELEASED']),
  orderRevision: z.string().regex(/^[1-9][0-9]{0,63}$/),
  command: newOrderSchema,
  filledQuantity: nonNegativeDecimalSchema,
  exchangeOrderId: idSchema,
  nativeUpdatedAt: timestampSchema,
  nativeHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const amendmentInputSchema = z.strictObject({
  evaluation: riskEvaluationInputSchema,
  command: inPlaceAmendmentSchema,
  retention: riskAmendmentRetentionSchema,
});
/** Pure retained-effect evaluation; this neither certifies its source nor issues
 * a grant. Production SQL must independently bind/recheck the retained proof. */
export function evaluateRiskAmendmentPolicy(raw: unknown): RiskEvaluation {
  try {
    return evaluateAmendment(raw);
  } catch {
    return reject('RISK_ARITHMETIC_UNPROVED');
  }
}

function evaluateAmendment(raw: unknown): RiskEvaluation {
  const parsed = amendmentInputSchema.safeParse(raw);
  if (!parsed.success) return reject('RISK_INPUT');
  const { evaluation: e, command: c, retention: r } = parsed.data;
  const before = c.target.current,
    after = c.replacement;
  if (
    e.binding.mode !== 'TESTNET' ||
    e.binding.profile.exchange !== 'BINANCE' ||
    e.binding.profile.market !== 'SPOT' ||
    e.binding.profile.endpointProfileId !== 'binance-spot-testnet-v1' ||
    before.type !== 'LIMIT' ||
    before.timeInForce !== 'GTC' ||
    before.reduceOnly ||
    before.size.kind !== 'BASE_QUANTITY' ||
    after.size.kind !== 'BASE_QUANTITY' ||
    before.limitPrice !== after.limitPrice ||
    cmp(after.size.value, before.size.value) >= 0
  )
    return reject('RISK_AMEND_UNSUPPORTED');
  if (
    r.status !== 'ACTIVE' ||
    r.orderId !== c.target.internalOrderId ||
    r.placeIntentId !== c.target.placeIntentId ||
    r.accountId !== e.binding.accountId ||
    r.mode !== e.binding.mode ||
    r.orderRevision !== c.target.revision ||
    r.exchangeOrderId !== c.locator.locator.id ||
    r.nativeUpdatedAt !== c.target.nativeUpdatedAt ||
    r.filledQuantity !== c.target.filledQuantity ||
    JSON.stringify(r.command) !== JSON.stringify(before) ||
    JSON.stringify(e.order) !== JSON.stringify(after) ||
    c.target.observedAt > e.now ||
    e.now - c.target.observedAt > Math.min(e.platform.maxEvidenceAgeMs, e.user.maxEvidenceAgeMs) ||
    !e.snapshot.instrumentHasPendingEntry ||
    e.snapshot.openOrders < 1
  )
    return reject('RISK_AMEND_TARGET');
  const capability = e.capabilities.filter((v) => v.feature === 'AMEND_ORDER');
  if (
    capability.length !== 1 ||
    !evaluateCapability({
      profile: e.binding.profile,
      record: capability[0],
      feature: 'AMEND_ORDER',
      now: e.now,
      adapterVersion: e.adapterVersion,
      instrumentId: after.instrumentId,
      allowSynthetic: false,
    }).allowed
  )
    return reject('RISK_CAPABILITY');
  const base = after.side === 'SELL',
    asset = base ? e.record.instrument.baseAsset : e.record.instrument.quoteAsset;
  const remaining = sub(after.size.value, c.target.filledQuantity);
  const principal = base ? remaining : mul(remaining, after.limitPrice!);
  const required = add(principal, mul(principal, e.snapshot.market.maxFeeRate));
  if (
    r.asset !== asset ||
    cmp(r.amount, required) < 0 ||
    cmp(
      e.snapshot.instrumentExposure,
      mul(
        mul(sub(before.size.value, c.target.filledQuantity), before.limitPrice!),
        e.snapshot.market.quoteToValuation,
      ),
    ) < 0
  )
    return reject('RISK_AMEND_RESERVE_UNPROVED');
  return evaluatePolicy(e, true);
}

function evaluatePolicy(raw: unknown, retained: boolean): RiskEvaluation {
  let parsed: RiskEvaluationInput;
  try {
    parsed = riskEvaluationInputSchema.parse(raw);
  } catch {
    return reject('RISK_INPUT');
  }
  let p: Readonly<RiskLimits>;
  try {
    p = intersectRiskLimits(parsed.platform, parsed.user);
  } catch {
    return reject('RISK_POLICY_INVALID');
  }
  try {
    const { now, binding, order, record, snapshot: s } = parsed,
      m = s.market;
    if (
      JSON.stringify(binding) !== JSON.stringify(s.binding) ||
      (binding.mode !== 'PAPER' && binding.mode !== binding.profile.environment) ||
      !sameMarketScope(binding.profile, record.instrument.scope) ||
      s.instrumentId !== order.instrumentId ||
      s.valuationAsset !== p.valuationAsset
    )
      return reject('RISK_SCOPE');
    const position = s.positionEvidence;
    const oneWayAccountMode = {
      BINANCE: 'ONE_WAY',
      BYBIT: 'UTA2_ONE_WAY',
      OKX: 'FUTURES_MODE_NET',
      HTX: null,
    }[binding.profile.exchange];
    if (
      position.mode !== (binding.profile.market === 'SPOT' ? 'SPOT' : 'ONE_WAY') ||
      (binding.profile.market !== 'SPOT' && binding.profile.accountMode !== oneWayAccountMode) ||
      position.accountMode !== binding.profile.accountMode ||
      position.accountId !== binding.accountId ||
      position.instrumentId !== order.instrumentId ||
      position.sourceId !== s.sourceId ||
      position.revision !== s.revision ||
      position.side !== 'NET' ||
      position.quantity !== s.positionQuantity ||
      position.asOf > now ||
      now - position.asOf > p.maxEvidenceAgeMs
    )
      return reject('RISK_POSITION_MODE_UNPROVED');
    if (
      !['SPOT', 'LINEAR_PERPETUAL'].includes(binding.profile.market) ||
      order.size.kind !== 'BASE_QUANTITY' ||
      !['LIMIT', 'MARKET'].includes(order.type)
    )
      return reject('RISK_UNSUPPORTED');
    if (!validateOrderAgainstRules(order, record, now).ok) return reject('RISK_ORDER_RULES');
    const features = order.reduceOnly
      ? ([order.type === 'LIMIT' ? 'LIMIT_ORDER' : 'MARKET_ORDER', 'REDUCE_ONLY'] as const)
      : ([order.type === 'LIMIT' ? 'LIMIT_ORDER' : 'MARKET_ORDER'] as const);
    for (const feature of features) {
      const matching = parsed.capabilities.filter((c) => c.feature === feature);
      if (
        matching.length !== 1 ||
        !evaluateCapability({
          profile: binding.profile,
          record: matching[0],
          feature,
          now,
          adapterVersion: parsed.adapterVersion,
          instrumentId: order.instrumentId,
          allowSynthetic: false,
        }).allowed
      )
        return reject('RISK_CAPABILITY');
    }
    const fresh = (at: number) => at <= now && now - at <= p.maxEvidenceAgeMs;
    if (!fresh(s.sourceAt) || !fresh(s.reconciledAt) || s.reconciledAt < s.sourceAt)
      return reject('RISK_STALE_STATE');
    if (!s.complete || s.unknownExposure) return reject('RISK_STATE_UNPROVED');
    if (
      cmp(s.instrumentExposure, s.assetExposure) > 0 ||
      cmp(s.assetExposure, s.accountExposure) > 0 ||
      cmp(s.accountExposure, s.userExposure) > 0 ||
      (binding.profile.market === 'SPOT' && cmp(s.positionQuantity, '0') < 0) ||
      (s.positionQuantity !== '0' && s.concurrentPositions === 0) ||
      (s.instrumentHasPendingEntry && s.openOrders === 0)
    )
      return reject('RISK_STATE_UNPROVED');
    if (Object.values(s.health).some((v) => v !== 'HEALTHY')) return reject('RISK_HEALTH');
    if (!fresh(m.asOf) || !fresh(m.fxAsOf)) return reject('RISK_STALE_MARKET');
    if (
      !m.complete ||
      cmp(m.bid, m.ask) > 0 ||
      cmp(m.lowerExecutionPrice, m.upperExecutionPrice) > 0 ||
      cmp(m.lowerExecutionPrice, m.bid) > 0 ||
      cmp(m.upperExecutionPrice, m.ask) < 0 ||
      (order.type === 'MARKET' && !m.executionBoundEnforced) ||
      (binding.profile.market !== 'SPOT' && m.kind !== 'MARK')
    )
      return reject('RISK_MARKET_UNPROVED');
    if (
      m.priceAsset !== record.instrument.quoteAsset ||
      m.liquidityAsset !== p.valuationAsset ||
      m.fxFromAsset !== record.instrument.quoteAsset ||
      m.fxToAsset !== p.valuationAsset ||
      (record.instrument.quoteAsset === p.valuationAsset
        ? m.fxKind !== 'IDENTITY' || m.quoteToValuation !== '1'
        : m.fxKind !== 'OBSERVED')
    )
      return reject('RISK_CURRENCY_UNPROVED');
    if (cmp(s.leverage, p.maxLeverage) > 0) return reject('RISK_MAX_LEVERAGE');
    if (binding.profile.market === 'SPOT' && s.leverage !== '1')
      return reject('RISK_LEVERAGE_UNPROVED');
    const qty = order.size.value,
      positionAbs = s.positionQuantity.startsWith('-')
        ? s.positionQuantity.slice(1)
        : s.positionQuantity;
    const reducing = order.reduceOnly;
    if (
      reducing &&
      (binding.profile.market !== 'LINEAR_PERPETUAL' ||
        (cmp(s.positionQuantity, '0') > 0
          ? order.side !== 'SELL'
          : cmp(s.positionQuantity, '0') < 0
            ? order.side !== 'BUY'
            : true) ||
        cmp(qty, sub(positionAbs, s.committedReductionQuantity)) > 0)
    )
      return reject('RISK_REDUCTION_UNPROVED');
    if (!reducing) {
      if (Object.values(s.pauses).some(Boolean)) return reject('RISK_PAUSED');
      if (s.circuit !== 'CLOSED') return reject('RISK_CIRCUIT_OPEN');
    }
    const nativeNotional = mul(qty, order.limitPrice ?? m.upperExecutionPrice),
      notional = mul(nativeNotional, m.quoteToValuation);
    const lower = mul(qty, order.limitPrice ?? m.lowerExecutionPrice);
    if (
      cmp(lower, record.rules.minNotional) < 0 ||
      (record.rules.maxNotional !== null && cmp(nativeNotional, record.rules.maxNotional) > 0)
    )
      return reject('RISK_ORDER_NOTIONAL');
    const price = order.limitPrice ?? m.upperExecutionPrice,
      delta = sub(price, m.referencePrice),
      absDelta = delta.startsWith('-') ? delta.slice(1) : delta;
    const lowerDelta = sub(order.limitPrice ?? m.lowerExecutionPrice, m.referencePrice),
      absLower = lowerDelta.startsWith('-') ? lowerDelta.slice(1) : lowerDelta;
    if (
      cmp(absDelta, mul(m.referencePrice, p.maxPriceDeviationRate)) > 0 ||
      cmp(absLower, mul(m.referencePrice, p.maxPriceDeviationRate)) > 0
    )
      return reject('RISK_PRICE_DEVIATION');
    if (cmp(sub(m.ask, m.bid), mul(m.referencePrice, p.maxSpreadRate)) > 0)
      return reject('RISK_SPREAD');
    if (
      cmp(m.liquidityNotional, p.minLiquidityNotional) < 0 ||
      cmp(m.liquidityNotional, notional) < 0
    )
      return reject('RISK_LIQUIDITY');
    if (!reducing) {
      if (cmp(notional, p.maxOrderNotional) > 0) return reject('RISK_MAX_ORDER_NOTIONAL');
      for (const [current, limit, code] of [
        [s.instrumentExposure, p.maxInstrumentExposure, 'RISK_MAX_INSTRUMENT_EXPOSURE'],
        [s.assetExposure, p.maxAssetExposure, 'RISK_MAX_ASSET_EXPOSURE'],
        [s.accountExposure, p.maxAccountExposure, 'RISK_MAX_ACCOUNT_EXPOSURE'],
        [s.userExposure, p.maxUserExposure, 'RISK_MAX_USER_EXPOSURE'],
      ] as const)
        if (cmp(add(current, retained ? '0' : notional), limit) > 0) return reject(code);
      if (
        s.concurrentPositions +
          (!retained && s.positionQuantity === '0' && !s.instrumentHasPendingEntry ? 1 : 0) >
        p.maxConcurrentPositions
      )
        return reject('RISK_MAX_CONCURRENT_POSITIONS');
      if (s.openOrders + (retained ? 0 : 1) > p.maxOpenOrders)
        return reject('RISK_MAX_OPEN_ORDERS');
      if (s.ordersInLastMinute + 1 > p.maxOrdersPerMinute) return reject('RISK_ORDER_FREQUENCY');
      if (
        !s.lossBaselineComplete ||
        s.utcDayStart !== Math.floor(now / 86400000) * 86400000 ||
        cmp(s.adjustedPeakEquity, '0') <= 0 ||
        cmp(s.adjustedOpeningEquity, '0') <= 0 ||
        cmp(s.adjustedCurrentEquity, '0') <= 0 ||
        cmp(s.adjustedPeakEquity, s.adjustedCurrentEquity) < 0 ||
        cmp(s.adjustedPeakEquity, s.adjustedOpeningEquity) < 0
      )
        return reject('RISK_LOSS_BASELINE');
      const realized = s.dailyNetRealizedPnl.startsWith('-') ? s.dailyNetRealizedPnl.slice(1) : '0',
        total = sub(s.adjustedOpeningEquity, s.adjustedCurrentEquity),
        dd = sub(s.adjustedPeakEquity, s.adjustedCurrentEquity);
      if (cmp(realized, '0') > 0 && cmp(realized, p.maxDailyRealizedLoss) >= 0)
        return reject('RISK_DAILY_REALIZED_LOSS');
      if (cmp(total, '0') > 0 && cmp(total, p.maxDailyTotalLoss) >= 0)
        return reject('RISK_DAILY_TOTAL_LOSS');
      if (cmp(dd, '0') > 0 && cmp(dd, mul(s.adjustedPeakEquity, p.maxDrawdownRate)) >= 0)
        return reject('RISK_DRAWDOWN');
    }
    if (binding.profile.market === 'LINEAR_PERPETUAL') {
      const target = add(s.instrumentExposure, reducing ? '0' : notional),
        tier = record.rules.leverageTiers.find(
          (t) => cmp(target, mul(t.notionalCap, m.quoteToValuation)) <= 0,
        );
      if (!tier || cmp(s.leverage, tier.maxLeverage) > 0) return reject('RISK_LEVERAGE_UNPROVED');
    }
    const baseReserve = binding.profile.market === 'SPOT' && order.side === 'SELL',
      asset = baseReserve ? record.instrument.baseAsset : record.instrument.quoteAsset;
    if (
      binding.profile.market === 'LINEAR_PERPETUAL' &&
      record.instrument.settlementAsset !== asset
    )
      return reject('RISK_CURRENCY_UNPROVED');
    if (m.feeAsset !== asset) return reject('RISK_FEE_UNPROVED');
    if (s.availableAsset !== asset) return reject('RISK_CURRENCY_UNPROVED');
    const principal = baseReserve ? qty : reducing ? '0' : nativeNotional,
      fee = mul(baseReserve ? qty : nativeNotional, m.maxFeeRate),
      amount = retained ? '0' : add(principal, fee);
    const conversion = baseReserve
        ? mul(m.lowerExecutionPrice, m.quoteToValuation)
        : m.quoteToValuation,
      after = sub(s.availableAmount, amount);
    if (cmp(after, '0') < 0 || cmp(mul(after, conversion), p.minAvailableBalance) < 0)
      return reject('RISK_AVAILABLE_BALANCE');
    return immutable({
      kind: 'EVALUATED',
      effect: retained ? 'RETAIN' : reducing ? 'REDUCE' : 'INCREASE',
      notional: retained ? '0' : notional,
      proposal: { asset, amount },
    });
  } catch {
    return reject('RISK_ARITHMETIC_UNPROVED');
  }
}
