import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  immutable,
  instrumentRecordSchema,
  newOrderSchema,
  nonNegativeAmountSchema,
  orderBookSchema,
  timestampSchema,
  tradeTickSchema,
  validateOrderAgainstRules,
  type InstrumentRecord,
  type NewOrder,
} from '@ctp/exchange-core';
import { paperModelSchema, preparePaperFrame, type PaperModel } from './model.js';

// Products have at most 38+38+18 significant digits. A private constructor
// preserves the complete product and never changes global Decimal settings.
const D = Decimal.clone({
  precision: 120,
  rounding: Decimal.ROUND_HALF_EVEN,
  modulo: Decimal.ROUND_FLOOR,
  minE: -100,
  maxE: 100,
  toExpNeg: -100,
  toExpPos: 100,
  crypto: false,
});
const schema = z.strictObject({
  now: timestampSchema,
  model: paperModelSchema,
  record: instrumentRecordSchema,
  book: orderBookSchema,
  trade: tradeTickSchema,
  order: newOrderSchema,
});

export interface PaperRiskEnvelopeCalculation {
  readonly kind: 'PAPER_RISK_ENVELOPE_CALCULATION';
  readonly version: 'spot-l2-taker-reserve-v1';
  readonly record: InstrumentRecord;
  readonly model: PaperModel;
  readonly order: NewOrder;
  readonly computedAt: number;
  /** Exclusive mathematical freshness deadline; not permission or certification. */
  readonly validUntil: number;
  readonly executionPrice: { readonly minimum: string; readonly maximum: string };
  readonly quantity: string;
  readonly maxFillCount: string;
  readonly quoteNotionalBound: string;
  readonly quoteFeeBound: string;
  readonly debits: readonly { readonly asset: string; readonly amount: string }[];
}
function amount(value: Decimal): string {
  if (!value.isFinite() || value.isNegative() || value.e >= 20 || value.decimalPlaces() > 18)
    throw new Error('PAPER_ENVELOPE_RANGE');
  return nonNegativeAmountSchema.parse(value.isZero() ? '0' : value.toFixed());
}
const ceilQuote = (value: Decimal) => value.toDecimalPlaces(18, Decimal.ROUND_CEIL);

/** Pure conservative bound for a new supported Spot command. Neither caller
 * evidence nor this result can authorize a reservation or financial mutation.
 * Future composition must certify scope and enforce these exact bounds atomically. */
export function calculatePaperRiskEnvelope(raw: unknown): PaperRiskEnvelopeCalculation {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('PAPER_ENVELOPE_INPUT');
  const { order, ...market } = parsed.data;
  try {
    try {
      preparePaperFrame(market);
    } catch {
      throw new Error('PAPER_ENVELOPE_EVIDENCE');
    }
    const { instrument, rules } = market.record;
    if (instrument.baseAsset === instrument.quoteAsset || rules.leverageTiers.length)
      throw new Error('PAPER_ENVELOPE_EVIDENCE');
    if (
      order.size.kind !== 'BASE_QUANTITY' ||
      order.timeInForce === 'POST_ONLY' ||
      order.reduceOnly ||
      (order.trigger !== null && order.trigger.source !== 'LAST')
    )
      throw new Error('PAPER_ENVELOPE_UNSUPPORTED');
    if (!validateOrderAgainstRules(order, market.record, market.now).ok)
      throw new Error('PAPER_ENVELOPE_ORDER_RULES');

    const tick = new D(rules.tickSize),
      quantity = new D(order.size.value);
    const lower = D.max(
      tick,
      new D(rules.minPrice ?? rules.tickSize),
      order.side === 'SELL' && order.limitPrice !== null ? new D(order.limitPrice) : tick,
    );
    const upper =
      order.side === 'BUY' && order.limitPrice !== null ? order.limitPrice : rules.maxPrice;
    // A reference price or trigger is not a lifetime ceiling. In particular a
    // SELL limit is a floor; maxNotional is not a proven fill price constraint.
    if (upper === null) throw new Error('PAPER_ENVELOPE_UNBOUNDED');
    const minimum = lower.div(tick).ceil().mul(tick);
    const maximum = new D(upper).div(tick).floor().mul(tick);
    if (maximum.lte(0) || minimum.gt(maximum)) throw new Error('PAPER_ENVELOPE_UNBOUNDED');
    const count = quantity.div(rules.stepSize);
    if (!count.isInteger() || count.lte(0)) throw new Error('PAPER_ENVELOPE_ORDER_RULES');
    // Every actual fill is a positive lot multiple. Ceiling is subadditive:
    // ceil(k * lotFee) <= k * ceil(lotFee). No fill count becomes JS Number,
    // and no iteration proportional to order size or the number of lots occurs.
    const quoteNotionalBound = amount(ceilQuote(quantity.mul(maximum)));
    const perLotFee = ceilQuote(new D(rules.stepSize).mul(maximum).mul(market.model.takerFeeRate));
    const quoteFeeBound = amount(count.mul(perLotFee));
    const debits =
      order.side === 'BUY'
        ? [
            {
              asset: instrument.quoteAsset,
              amount: amount(new D(quoteNotionalBound).add(quoteFeeBound)),
            },
          ]
        : [
            { asset: instrument.baseAsset, amount: amount(quantity) },
            { asset: instrument.quoteAsset, amount: quoteFeeBound },
          ];
    const evidenceTimes = [
      market.book.receivedAt,
      market.trade.receivedAt,
      market.trade.exchangeTime,
    ];
    if (market.book.exchangeTime !== null) evidenceTimes.push(market.book.exchangeTime);
    const validUntil = Math.min(
      rules.expiresAt,
      instrument.expiryAt ?? rules.expiresAt,
      ...evidenceTimes.map((time) => time + market.model.maxEvidenceAgeMs + 1),
    );
    return immutable({
      kind: 'PAPER_RISK_ENVELOPE_CALCULATION',
      version: 'spot-l2-taker-reserve-v1',
      record: market.record,
      model: market.model,
      order,
      computedAt: market.now,
      validUntil,
      executionPrice: { minimum: amount(minimum), maximum: amount(maximum) },
      quantity: amount(quantity),
      maxFillCount: count.toFixed(0),
      quoteNotionalBound,
      quoteFeeBound,
      debits,
    });
  } catch (error) {
    const known = [
      'PAPER_ENVELOPE_EVIDENCE',
      'PAPER_ENVELOPE_UNSUPPORTED',
      'PAPER_ENVELOPE_ORDER_RULES',
      'PAPER_ENVELOPE_UNBOUNDED',
      'PAPER_ENVELOPE_RANGE',
    ];
    throw new Error(
      error instanceof Error && known.includes(error.message)
        ? error.message
        : 'PAPER_ENVELOPE_RANGE',
      { cause: error },
    );
  }
}
