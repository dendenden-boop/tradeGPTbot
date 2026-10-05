import { z } from 'zod';
import {
  decimalAdd,
  decimalSubtract,
  decimalMultiply,
  decimalCompare,
  parseDecimal,
  positiveAmountSchema,
  timestampSchema,
  idSchema,
  marketScopeSchema,
  sameMarketScope,
} from '@ctp/exchange-core';
import { restorePortfolio } from './accounting.js';
import { walletKey, type Binding, type PortfolioState } from './domain.js';
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const sub = (a: string, b: string) => decimalSubtract(parseDecimal(a), parseDecimal(b));
const mul = (a: string, b: string) => decimalMultiply(parseDecimal(a), parseDecimal(b));
const cmp = (a: string, b: string) => decimalCompare(parseDecimal(a), parseDecimal(b));
const priceSchema = z.strictObject({
  asset: idSchema,
  quote: idSchema,
  price: z.string().refine((x) => positiveAmountSchema.safeParse(x).success),
  kind: z.enum(['LAST', 'MARK']),
  asOf: timestampSchema,
  sourceId: idSchema,
  fresh: z.boolean(),
  scope: marketScopeSchema.optional(),
  instrumentId: idSchema.optional(),
});
export type PriceEvidence = z.infer<typeof priceSchema>;
export function valuePortfolio(
  raw: readonly PortfolioState[],
  rawPrices: readonly PriceEvidence[],
  options: { quote: string; now: number; reconciledAfterRestart: boolean },
) {
  const opt = z
    .strictObject({ quote: idSchema, now: timestampSchema, reconciledAfterRestart: z.boolean() })
    .parse(options);
  if (raw.length > 100 || rawPrices.length > 2000) throw new Error('PORTFOLIO_VIEW_CAPACITY');
  const states = raw.map(restorePortfolio),
    prices = rawPrices.map((p) => priceSchema.parse(p));
  if (new Set(states.map((s) => walletKey(s.binding))).size !== states.length)
    throw new Error('DUPLICATE_WALLET');
  if (new Set(states.map((s) => `${s.binding.tenantId}/${s.binding.mode}`)).size > 1)
    throw new Error('MIXED_PORTFOLIO_SCOPE');
  if (
    new Set(
      prices.map((p) =>
        JSON.stringify([p.asset, p.quote, p.kind, p.scope ?? null, p.instrumentId ?? null]),
      ),
    ).size !== prices.length
  )
    throw new Error('AMBIGUOUS_PRICE');
  let complete = true,
    estimate = '0',
    partialValue = '0';
  const sourcePrice = (
    asset: string,
    quote: string,
    kind: 'LAST' | 'MARK',
    binding?: Binding,
    instrumentId?: string,
  ) => {
    if (asset === quote) return { price: '1', fresh: true, sourceId: 'IDENTITY' };
    const candidates = prices.filter(
      (p) =>
        p.asset === asset &&
        p.quote === quote &&
        p.kind === kind &&
        (kind !== 'MARK' ||
          (!!binding &&
            !!p.scope &&
            sameMarketScope(p.scope, binding.scope) &&
            p.instrumentId === instrumentId)),
    );
    if (candidates.length > 1) throw new Error('AMBIGUOUS_PRICE');
    const p = candidates[0];
    if (!p || p.asOf > opt.now) return null;
    return { ...p, fresh: p.fresh && opt.now - p.asOf <= 10000 };
  };
  const accounts = states.map((s) => {
    const balancesFresh =
      opt.reconciledAfterRestart &&
      s.status === 'RECONCILED' &&
      s.snapshotAt !== null &&
      s.snapshotAt <= opt.now &&
      opt.now - s.snapshotAt <= 15000;
    if (!balancesFresh) complete = false;
    const balances = s.balances.map((b) => {
      const holds = s.holds
        .filter((h) => h.asset === b.asset && !h.reflected)
        .reduce((n, h) => add(n, h.amount), '0');
      const after = b.available === null ? null : sub(b.available, holds),
        spendable = after === null ? null : cmp(after, '0') < 0 ? '0' : after;
      const p =
        b.total === '0'
          ? { price: '1', fresh: true, sourceId: 'ZERO_EXPOSURE' }
          : sourcePrice(b.asset, opt.quote, 'LAST');
      const value = p ? mul(b.total, p.price) : null;
      if (value !== null) {
        estimate = add(estimate, value);
        if (p?.fresh && balancesFresh) partialValue = add(partialValue, value);
      }
      if (!p?.fresh) complete = false;
      return {
        ...b,
        spendable,
        unreflectedHolds: holds,
        value,
        valueFresh: !!p?.fresh && balancesFresh,
        priceSource: p?.sourceId ?? null,
      };
    });
    const positions = s.positions.map((p) => {
      const spot = s.binding.scope.market === 'SPOT',
        price =
          p.quantity === '0'
            ? null
            : sourcePrice(p.base, p.quote, spot ? 'LAST' : 'MARK', s.binding, p.instrumentId);
      let unrealizedGross: string | null = p.quantity === '0' ? '0' : null;
      if (price && p.basis !== null) {
        const absolute = p.quantity.startsWith('-') ? p.quantity.slice(1) : p.quantity;
        unrealizedGross = p.quantity.startsWith('-')
          ? sub(p.basis, mul(absolute, price.price))
          : sub(mul(absolute, price.price), p.basis);
      }
      const pnlFresh =
        balancesFresh && (p.quantity === '0' || !!price?.fresh) && unrealizedGross !== null;
      if (!spot) {
        const fx = sourcePrice(p.quote, opt.quote, 'LAST');
        if (unrealizedGross === null || !pnlFresh || !fx?.fresh) complete = false;
        if (unrealizedGross !== null && fx) {
          const value = mul(unrealizedGross, fx.price);
          estimate = add(estimate, value);
          if (pnlFresh && fx.fresh) partialValue = add(partialValue, value);
        }
      }
      const netRealized =
        p.realizedGross === null || p.feesQuote === null
          ? null
          : add(sub(p.realizedGross, p.feesQuote), p.fundingQuote);
      return {
        ...p,
        unrealizedGross,
        pnlFresh,
        netRealized,
        pnlAsset: p.quote,
        priceSource: price?.sourceId ?? null,
      };
    });
    return {
      binding: s.binding,
      balances,
      positions,
      balancesFresh,
      status: s.status,
      differences: s.differences,
      unknownCommitments: s.holds.some((h) => h.status === 'UNKNOWN'),
      holds: s.holds,
    };
  });
  return {
    quote: opt.quote,
    complete,
    total: complete ? estimate : null,
    estimate,
    partialValue,
    accounts,
  };
}
