import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  decimalSchema,
  immutable,
  instrumentRecordSchema,
  newOrderSchema,
  nonNegativeAmountSchema,
  orderBookSchema,
  positiveAmountSchema,
  timestampSchema,
  tradeTickSchema,
} from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { paperModelSchema } from './model.js';
import { calculatePaperRiskEnvelope, type PaperRiskEnvelopeCalculation } from './risk-envelope.js';

// At most 38+38+18 significant product digits, plus bounded sums of 1000 fills.
// Neither lot counts nor money become Number, and global Decimal is untouched.
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
const fill = z.strictObject({
  id: z.string().regex(/^paper-[a-f0-9]{64}$/u),
  quantity: positiveAmountSchema,
  price: positiveAmountSchema,
  quoteNotional: positiveAmountSchema,
  quoteFee: nonNegativeAmountSchema,
  baseDelta: decimalSchema,
  quoteDelta: decimalSchema,
});
const schema = z.strictObject({
  original: z.strictObject({
    now: timestampSchema,
    model: paperModelSchema,
    record: instrumentRecordSchema,
    book: orderBookSchema,
    trade: tradeTickSchema,
    order: newOrderSchema,
  }),
  fills: z.array(fill).max(1000),
});
export interface PaperReservationProgressCalculation {
  readonly kind: 'PAPER_RESERVATION_PROGRESS_CALCULATION';
  readonly version: 'spot-l2-taker-remaining-v1';
  readonly envelope: PaperRiskEnvelopeCalculation;
  readonly filledQuantity: string;
  readonly remainingQuantity: string;
  readonly fillIds: readonly string[];
  readonly debits: readonly {
    readonly asset: string;
    readonly original: string;
    readonly spent: string;
    readonly remaining: string;
    /** Mathematical residual only; no released money or authority is implied. */
    readonly surplus: string;
  }[];
}
const ceilQuote = (v: Decimal) => v.toDecimalPlaces(18, Decimal.ROUND_CEIL);
function amount(v: Decimal) {
  if (!v.isFinite() || v.isNegative() || v.e >= 20 || v.decimalPlaces() > 18)
    throw new Error('PAPER_PROGRESS_RANGE');
  return nonNegativeAmountSchema.parse(v.isZero() ? '0' : v.toFixed());
}

/** Bounded historical arithmetic, not a lifecycle writer or trusted resolution.
 * The fixed future writer must authenticate original issuance and complete fills,
 * post economics exactly once, preserve UNKNOWN, and authorize any reduction.
 * Caller JSON, valid fill economics and zero remaining quantity prove none of it. */
export function calculatePaperReservationProgress(
  raw: unknown,
): PaperReservationProgressCalculation {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('PAPER_PROGRESS_INPUT');
  const x = parsed.data;
  if (Buffer.byteLength(canonical(x), 'utf8') > 4194304) throw new Error('PAPER_PROGRESS_INPUT');
  let envelope: PaperRiskEnvelopeCalculation;
  try {
    // Recompute the original bound. Never accept a serialized caller envelope or
    // re-admit the smaller remainder against minQuantity/new metadata/new time.
    envelope = calculatePaperRiskEnvelope(x.original);
  } catch {
    throw new Error('PAPER_PROGRESS_EVIDENCE');
  }
  const { order, record, model } = x.original,
    step = new D(record.rules.stepSize),
    maximum = new D(envelope.executionPrice.maximum),
    seen = new Map<string, string>();
  let filled = new D(0),
    notional = new D(0),
    fees = new D(0);
  for (const f of x.fills) {
    const text = canonical(f),
      previous = seen.get(f.id);
    if (previous !== undefined) {
      if (previous !== text) throw new Error('PAPER_PROGRESS_CONFLICT');
      continue;
    }
    seen.set(f.id, text);
    const quantity = new D(f.quantity),
      price = new D(f.price),
      cost = quantity.mul(price),
      fee = ceilQuote(cost.mul(model.takerFeeRate)),
      base = order.side === 'BUY' ? quantity : quantity.neg(),
      quote = order.side === 'BUY' ? cost.add(fee).neg() : cost.sub(fee);
    if (
      !quantity.mod(step).isZero() ||
      !price.mod(record.rules.tickSize).isZero() ||
      price.lt(envelope.executionPrice.minimum) ||
      price.gt(maximum) ||
      cost.decimalPlaces() > 18 ||
      !cost.eq(f.quoteNotional) ||
      !fee.eq(f.quoteFee) ||
      !base.eq(f.baseDelta) ||
      !quote.eq(f.quoteDelta)
    )
      throw new Error('PAPER_PROGRESS_FILL');
    filled = filled.add(quantity);
    notional = notional.add(cost);
    fees = fees.add(fee);
    if (filled.gt(envelope.quantity)) throw new Error('PAPER_PROGRESS_FILL');
  }
  if (order.timeInForce === 'FOK' && !filled.isZero() && !filled.eq(envelope.quantity))
    throw new Error('PAPER_PROGRESS_FILL');
  const remaining = new D(envelope.quantity).sub(filled),
    remainingLots = remaining.div(step),
    feeBound = remainingLots.mul(ceilQuote(step.mul(maximum).mul(model.takerFeeRate))),
    quoteBound = order.side === 'BUY' ? ceilQuote(remaining.mul(maximum)).add(feeBound) : feeBound;
  if (!remainingLots.isInteger()) throw new Error('PAPER_PROGRESS_FILL');
  const debits = envelope.debits
    .filter((d) => d.amount !== '0')
    .map((d) => {
      const spent =
          d.asset === record.instrument.baseAsset
            ? filled
            : order.side === 'BUY'
              ? notional.add(fees)
              : fees,
        future = d.asset === record.instrument.baseAsset ? remaining : quoteBound,
        surplus = new D(d.amount).sub(spent).sub(future);
      if (surplus.isNegative()) throw new Error('PAPER_PROGRESS_FILL');
      return {
        asset: d.asset,
        original: d.amount,
        spent: amount(spent),
        remaining: amount(future),
        surplus: amount(surplus),
      };
    });
  return immutable({
    kind: 'PAPER_RESERVATION_PROGRESS_CALCULATION',
    version: 'spot-l2-taker-remaining-v1',
    envelope,
    filledQuantity: amount(filled),
    remainingQuantity: amount(remaining),
    fillIds: [...seen.keys()].sort(),
    debits,
  });
}
