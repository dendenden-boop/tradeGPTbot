import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  decimalSchema,
  nonNegativeAmountSchema,
  orderBookSchema,
  tradeTickSchema,
  instrumentRecordSchema,
  newOrderSchema,
  timestampSchema,
  sameMarketScope,
  validateOrderAgainstRules,
  immutable,
} from '@ctp/exchange-core';

// Private constructor: never changes global decimal settings. Inputs have <=38
// significant digits; exact products, 1000-level sums and tick quotients fit 100.
const D = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_EVEN,
  minE: -100,
  maxE: 100,
  toExpNeg: -100,
  toExpPos: 100,
  crypto: false,
});
const validRate = (v: string, cap: string) => {
  const checked = decimalSchema.safeParse(v);
  return checked.success && new D(v).gte(0) && new D(v).lte(cap);
};
const rate = z.string().refine((v) => validRate(v, '1'));
export const paperModelSchema = z.strictObject({
  version: z.literal('spot-l2-taker-v1'),
  seed: z
    .string()
    .refine(
      (v) =>
        /^(?:0|-?[1-9][0-9]{0,18})$/u.test(v) && BigInt(v) >= -(2n ** 63n) && BigInt(v) < 2n ** 63n,
    ),
  takerFeeRate: z.string().refine((v) => validRate(v, '0.1')),
  maxSlippageRate: z.string().refine((v) => validRate(v, '0.1')),
  latencyMs: z.number().int().min(1).max(60000),
  latencyJitterMs: z.number().int().min(0).max(60000),
  participationRate: rate.refine((v) => validRate(v, '1') && v !== '0'),
  maxEvidenceAgeMs: z.number().int().min(1).max(15000),
});
export type PaperModel = z.infer<typeof paperModelSchema>;
const marketFields = {
  model: paperModelSchema,
  record: instrumentRecordSchema,
  book: orderBookSchema,
  trade: tradeTickSchema,
};
const prepareSchema = z.strictObject({ now: timestampSchema, ...marketFields });
export const paperFrameSchema = z.strictObject({
  ...marketFields,
  volumeUsed: nonNegativeAmountSchema,
  asksUsed: z.array(nonNegativeAmountSchema).max(1000),
  bidsUsed: z.array(nonNegativeAmountSchema).max(1000),
});
export type PaperFrame = z.infer<typeof paperFrameSchema>;
const executionSchema = z.strictObject({
  frame: paperFrameSchema,
  now: timestampSchema,
  order: newOrderSchema,
  orderId: z.uuid(),
  submittedAt: timestampSchema,
  executedQuantity: nonNegativeAmountSchema,
  triggeredAt: timestampSchema.nullable(),
});
export interface PaperFillCalculation {
  readonly id: string;
  readonly quantity: string;
  readonly price: string;
  readonly quoteNotional: string;
  readonly quoteFee: string;
  readonly baseDelta: string;
  readonly quoteDelta: string;
}
export interface PaperExecutionCalculation {
  readonly status: 'WAITING' | 'PARTIALLY_FILLED' | 'FILLED' | 'EXPIRED';
  readonly reason: 'LATENCY' | 'TRIGGER' | 'LIQUIDITY' | 'FOK' | 'EXECUTION' | 'COMPLETE';
  readonly eligibleAfter: number;
  readonly triggeredAt: number | null;
  readonly quantity: string;
  readonly fills: readonly PaperFillCalculation[];
  readonly frame: PaperFrame;
}
function hash(value: unknown): string {
  function canonical(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, item]) => `${JSON.stringify(k)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function amount(value: Decimal) {
  return nonNegativeAmountSchema.parse(value.isZero() ? '0' : value.toFixed());
}
function signed(value: Decimal): string {
  return decimalSchema.parse(value.isZero() ? '0' : value.toFixed());
}
function lot(value: Decimal, step: string): Decimal {
  return value.div(step).floor().mul(step);
}
function levelCap(quantity: string, f: PaperFrame | z.infer<typeof prepareSchema>): Decimal {
  return lot(new D(quantity).mul(f.model.participationRate), f.record.rules.stepSize);
}
function evidence(f: PaperFrame | z.infer<typeof prepareSchema>, now: number) {
  const {
    record: { instrument, rules },
    book,
    trade,
    model,
  } = f;
  const fresh = (time: number) => time <= now && now - time <= model.maxEvidenceAgeMs;
  if (
    instrument.scope.market !== 'SPOT' ||
    instrument.status !== 'TRADING' ||
    rules.quantityUnit !== 'BASE' ||
    rules.instrumentId !== instrument.id ||
    !sameMarketScope(instrument.scope, rules.scope) ||
    rules.effectiveAt > now ||
    rules.expiresAt <= now ||
    !sameMarketScope(instrument.scope, book.scope) ||
    !sameMarketScope(instrument.scope, trade.scope) ||
    book.instrumentId !== instrument.id ||
    trade.instrumentId !== instrument.id ||
    book.kind !== 'SNAPSHOT' ||
    book.stale ||
    !book.asks.length ||
    !book.bids.length ||
    trade.quantityUnit !== 'BASE' ||
    (book.sourceSequence === null && book.exchangeTime === null) ||
    (book.sourceSequence !== null && !/^(?:0|[1-9][0-9]{0,127})$/u.test(book.sourceSequence)) ||
    (trade.sourceSequence !== null && !/^(?:0|[1-9][0-9]{0,127})$/u.test(trade.sourceSequence)) ||
    !fresh(book.receivedAt) ||
    !fresh(trade.receivedAt) ||
    !fresh(trade.exchangeTime) ||
    (book.exchangeTime !== null && !fresh(book.exchangeTime))
  )
    throw new Error('PAPER_EVIDENCE');
}
function consumption(f: PaperFrame) {
  if (f.asksUsed.length !== f.book.asks.length || f.bidsUsed.length !== f.book.bids.length)
    throw new Error('PAPER_FRAME');
  let total = new D(0);
  for (const [levels, used] of [
    [f.book.asks, f.asksUsed],
    [f.book.bids, f.bidsUsed],
  ] as const) {
    for (let i = 0; i < levels.length; i++) {
      const value = new D(used[i]!);
      if (
        !value.mod(f.record.rules.stepSize).isZero() ||
        value.gt(levelCap(levels[i]!.quantity, f))
      )
        throw new Error('PAPER_FRAME');
      total = total.add(value);
    }
  }
  if (!total.eq(f.volumeUsed) || total.gt(levelCap(f.trade.quantity, f)))
    throw new Error('PAPER_FRAME');
}
/** Pure evidence validation and liquidity calculation; does not authenticate
 * a source or allocate durable volume. Never a Risk grant or financial writer. */
export function preparePaperFrame(raw: unknown): PaperFrame {
  const checked = prepareSchema.safeParse(raw);
  if (!checked.success) throw new Error('PAPER_EVIDENCE');
  const { now, ...market } = checked.data;
  evidence(checked.data, now);
  return immutable(
    paperFrameSchema.parse({
      ...market,
      volumeUsed: '0',
      asksUsed: market.book.asks.map(() => '0'),
      bidsUsed: market.book.bids.map(() => '0'),
    }),
  );
}
/** Deterministic Spot taker calculation. Caller must atomically enforce current
 * Risk, wallet affordability, permanent order/event replay and shared liquidity. */
export function evaluatePaperOrder(raw: unknown): PaperExecutionCalculation {
  const checked = executionSchema.safeParse(raw);
  if (!checked.success) throw new Error('PAPER_INPUT');
  const input = checked.data;
  const { frame: f, order, now, orderId, submittedAt, executedQuantity } = input;
  evidence(f, now);
  consumption(f);
  if (
    order.size.kind !== 'BASE_QUANTITY' ||
    order.timeInForce === 'POST_ONLY' ||
    order.reduceOnly ||
    (order.trigger !== null && order.trigger.source !== 'LAST')
  )
    throw new Error('PAPER_ORDER_UNSUPPORTED');
  if (!validateOrderAgainstRules(order, f.record, now).ok) throw new Error('PAPER_ORDER_RULES');
  const seed = (purpose: string, evidenceId: string | null = null) =>
    BigInt('0x' + hash({ model: f.model, orderId, purpose, evidenceId }));
  const eligibleAfter =
    submittedAt + f.model.latencyMs + Number(seed('latency') % BigInt(f.model.latencyJitterMs + 1));
  if (
    !timestampSchema.safeParse(eligibleAfter).success ||
    submittedAt > now ||
    new D(executedQuantity).gt(order.size.value) ||
    !new D(executedQuantity).mod(f.record.rules.stepSize).isZero() ||
    (order.trigger !== null && executedQuantity !== '0' && input.triggeredAt === null) ||
    (order.timeInForce === 'FOK' &&
      executedQuantity !== '0' &&
      executedQuantity !== order.size.value) ||
    (input.triggeredAt !== null &&
      (order.trigger === null || input.triggeredAt < eligibleAfter || input.triggeredAt > now))
  )
    throw new Error('PAPER_INPUT');
  let triggeredAt = input.triggeredAt;
  const result = (
    status: PaperExecutionCalculation['status'],
    reason: PaperExecutionCalculation['reason'],
    next = f,
    fills: PaperFillCalculation[] = [],
    quantity = '0',
  ) => immutable({ status, reason, eligibleAfter, triggeredAt, quantity, fills, frame: next });
  if (new D(executedQuantity).eq(order.size.value)) return result('FILLED', 'COMPLETE');
  if (
    now < eligibleAfter ||
    f.book.receivedAt < eligibleAfter ||
    f.trade.receivedAt < eligibleAfter ||
    f.trade.exchangeTime < eligibleAfter ||
    (f.book.exchangeTime !== null && f.book.exchangeTime < eligibleAfter) ||
    (triggeredAt !== null &&
      (f.trade.exchangeTime < triggeredAt ||
        f.book.receivedAt < triggeredAt ||
        (f.book.exchangeTime !== null && f.book.exchangeTime < triggeredAt)))
  )
    return result('WAITING', 'LATENCY');
  if (order.trigger !== null && triggeredAt === null) {
    const reached =
      order.side === 'BUY'
        ? new D(f.trade.price).gte(order.trigger.price)
        : new D(f.trade.price).lte(order.trigger.price);
    if (!reached) return result('WAITING', 'TRIGGER');
    // Receipt time is included: a delayed trade cannot backdate virtual activation.
    triggeredAt = Math.max(f.trade.exchangeTime, f.trade.receivedAt);
  }
  const evidenceId = hash({
    scope: f.trade.scope,
    instrumentId: f.trade.instrumentId,
    identityScope: f.trade.identityScope,
    tradeId: f.trade.tradeId,
  });
  const slippage = new D(f.model.maxSlippageRate)
    .mul((seed('slippage', evidenceId) % 1000001n).toString())
    .div(1000000);
  const bookHash = hash({ ...f.book, receivedAt: 0, snapshotVersion: '' });
  const tradeHash = hash({ ...f.trade, receivedAt: 0 });
  const next = structuredClone(f);
  const levels = order.side === 'BUY' ? f.book.asks : f.book.bids;
  const used = order.side === 'BUY' ? next.asksUsed : next.bidsUsed;
  const remaining = new D(order.size.value).sub(executedQuantity);
  const fills: PaperFillCalculation[] = [];
  let quantity = new D(0),
    volume = levelCap(f.trade.quantity, f).sub(f.volumeUsed);
  for (let i = 0; i < levels.length && volume.gt(0) && quantity.lt(remaining); i++) {
    const level = levels[i]!,
      available = levelCap(level.quantity, f).sub(used[i]!);
    const rawPrice = new D(level.price).mul(
      order.side === 'BUY' ? new D(1).add(slippage) : new D(1).sub(slippage),
    );
    const ticks = rawPrice.div(f.record.rules.tickSize);
    const price = (order.side === 'BUY' ? ticks.ceil() : ticks.floor()).mul(
      f.record.rules.tickSize,
    );
    if (
      price.lte(0) ||
      (f.record.rules.minPrice !== null && price.lt(f.record.rules.minPrice)) ||
      (f.record.rules.maxPrice !== null && price.gt(f.record.rules.maxPrice))
    )
      throw new Error('PAPER_PRICE');
    if (
      order.limitPrice !== null &&
      (order.side === 'BUY' ? price.gt(order.limitPrice) : price.lt(order.limitPrice))
    )
      break;
    const fillQuantity = lot(
      D.min(available, volume, remaining.sub(quantity)),
      f.record.rules.stepSize,
    );
    if (fillQuantity.lte(0)) continue;
    const notional = fillQuantity.mul(price),
      fee = notional.mul(f.model.takerFeeRate).toDecimalPlaces(18, Decimal.ROUND_CEIL);
    fills.push({
      id:
        'paper-' +
        hash({
          version: f.model.version,
          model: f.model,
          orderId,
          evidenceId,
          book: bookHash,
          trade: tradeHash,
          level: i,
          executedQuantity,
          offset: amount(quantity),
        }),
      quantity: amount(fillQuantity),
      price: amount(price),
      quoteNotional: amount(notional),
      quoteFee: amount(fee),
      baseDelta: signed(order.side === 'BUY' ? fillQuantity : fillQuantity.neg()),
      quoteDelta: signed(order.side === 'BUY' ? notional.add(fee).neg() : notional.sub(fee)),
    });
    used[i] = amount(new D(used[i]!).add(fillQuantity));
    quantity = quantity.add(fillQuantity);
    volume = volume.sub(fillQuantity);
  }
  if (order.timeInForce === 'FOK' && !quantity.eq(remaining)) return result('EXPIRED', 'FOK');
  next.volumeUsed = amount(new D(f.volumeUsed).add(quantity));
  consumption(next);
  const status = quantity.eq(remaining)
    ? 'FILLED'
    : order.timeInForce === 'IOC' || order.type === 'MARKET' || order.type === 'STOP_MARKET'
      ? 'EXPIRED'
      : quantity.gt(0)
        ? 'PARTIALLY_FILLED'
        : 'WAITING';
  return result(status, quantity.gt(0) ? 'EXECUTION' : 'LIQUIDITY', next, fills, amount(quantity));
}
