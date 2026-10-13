import { z } from 'zod';
import {
  decimalAdd,
  decimalMultiply,
  immutable,
  idSchema,
  marketScopeSchema,
  nonNegativeDecimalSchema,
  parseDecimal,
  positiveDecimalSchema,
  sameMarketScope,
  timestampSchema,
} from '@ctp/exchange-core';
import { canonical, createState, stateSchema } from '@ctp/portfolio';
import { paperConfigurationReceiptSchema, paperOwnerSchema } from './configuration-domain.js';
import { paperFundingReceiptSchema } from './funding-domain.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((v) => /^(0|[1-9][0-9]{0,18})$/u.test(v) && BigInt(v) <= 9223372036854775807n);
const origin = z.strictObject({
  kind: z.literal('INITIAL_BOOK'),
  bookId: z.uuid(),
  revision: z.literal('1'),
  createdAt: timestampSchema,
  receiptHash: hash,
  configuration: paperConfigurationReceiptSchema,
  funding: paperFundingReceiptSchema,
  state: stateSchema,
});
const account = z.strictObject({
  kind: z.literal('PAPER_BOOK_SOURCE'),
  asOf: timestampSchema,
  hash,
  bookId: z.uuid(),
  revision: z.literal('1'),
  origin,
  state: stateSchema,
  accountState: z.strictObject({
    permissionEpoch: counter,
    reconciliationEpoch: counter,
    clientIdHighWatermark: counter,
    version: z.number().int().nonnegative().max(2147483647),
  }),
  drafts: z
    .array(
      z.strictObject({
        orderId: z.uuid(),
        intentId: z.uuid(),
        clientOrderId: counter.refine((v) => v !== '0'),
        commandHash: hash,
        createdAt: timestampSchema,
      }),
    )
    .max(1000),
});
const inventory = z.strictObject({
  kind: z.literal('PAPER_RISK_PORTFOLIO_SOURCE'),
  owner: paperOwnerSchema,
  asOf: timestampSchema,
  hash,
  accountIds: z.array(z.uuid()).min(1).max(100),
  accounts: z.array(account).min(1).max(100),
});
const price = z.strictObject({
  accountId: z.uuid(),
  asset: idSchema,
  quote: idSchema,
  price: positiveDecimalSchema,
  kind: z.literal('LAST'),
  asOf: timestampSchema,
  sourceId: idSchema,
  scope: marketScopeSchema,
});
const input = z.strictObject({
  now: timestampSchema,
  maxEvidenceAgeMs: z.number().int().min(1).max(5000),
  inventory,
  quote: idSchema,
  prices: z.array(price).max(3200),
});
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const mul = (a: string, b: string) => decimalMultiply(parseDecimal(a), parseDecimal(b));

/** Pure current-capture valuation only. Neither caller values/hashes nor this
 * calculation prove inventory/market authority, certify Risk or grant money.
 * The future coordinator must capture actual source heads under its locks.
 * Active books are deliberately unsupported until their lifecycle is accepted. */
export function calculatePaperInventoryValuation(raw: unknown) {
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new Error('PAPER_VALUATION_INPUT');
  const f = parsed.data,
    s = f.inventory;
  const fresh = (at: number) => at <= f.now && f.now - at <= f.maxEvidenceAgeMs;
  if (Buffer.byteLength(canonical(f), 'utf8') > 1048576)
    throw new Error('PAPER_VALUATION_CAPACITY');
  if (!fresh(s.asOf) || f.prices.some((p) => !fresh(p.asOf)))
    throw new Error('PAPER_VALUATION_STALE');
  if (
    s.accountIds.length !== s.accounts.length ||
    new Set(s.accountIds).size !== s.accountIds.length ||
    canonical(s.accountIds) !== canonical([...s.accountIds].sort()) ||
    !s.accountIds.includes(s.owner.accountId) ||
    new Set(s.accounts.map((b) => b.bookId)).size !== s.accounts.length
  )
    throw new Error('PAPER_VALUATION_SCOPE');
  const allDrafts = s.accounts.flatMap((a) => a.drafts);
  if (allDrafts.length > 1000) throw new Error('PAPER_VALUATION_CAPACITY');
  if (
    new Set(allDrafts.map((d) => d.orderId)).size !== allDrafts.length ||
    new Set(allDrafts.map((d) => d.intentId)).size !== allDrafts.length
  )
    throw new Error('PAPER_VALUATION_SCOPE');
  const prices = new Map<string, z.infer<typeof price>>();
  const common = new Map<string, string>();
  for (const p of f.prices) {
    const key = canonical([p.accountId, p.asset]);
    if (prices.has(key) || p.asset === f.quote || p.quote !== f.quote)
      throw new Error('PAPER_VALUATION_PRICE');
    prices.set(key, p);
    const commonKey = canonical([p.scope, p.asset, p.quote]);
    const content = canonical({ price: p.price, asOf: p.asOf, sourceId: p.sourceId });
    if (common.has(commonKey) && common.get(commonKey) !== content)
      throw new Error('PAPER_VALUATION_PRICE');
    common.set(commonKey, content);
  }
  let equity = '0';
  const values = new Map<string, string>(),
    used = new Set<string>();
  try {
    const accounts = s.accounts.map((a, index) => {
      const o = a.origin,
        c = o.configuration,
        seed = o.funding;
      const owner = { ...s.owner, accountId: s.accountIds[index]! };
      if (
        canonical(c.configuration.owner) !== canonical(owner) ||
        canonical(seed.funding.owner) !== canonical(owner) ||
        a.asOf !== s.asOf ||
        a.bookId !== o.bookId ||
        a.bookId !== seed.funding.id ||
        seed.ledgerTransactionId !== seed.funding.id ||
        seed.funding.configurationId !== c.configuration.id ||
        canonical(c.accountIdentity) !== canonical(seed.accountIdentity) ||
        c.configuration.valuationAsset !== f.quote ||
        c.configuration.source.market !== 'SPOT' ||
        c.createdAt > seed.createdAt ||
        seed.createdAt > o.createdAt ||
        o.createdAt > s.asOf ||
        canonical(a.state) !== canonical(o.state)
      )
        throw new Error('PAPER_VALUATION_SCOPE');
      const expected = {
        ...createState({
          tenantId: owner.tenantId,
          accountId: owner.accountId,
          mode: 'PAPER',
          connectionId: null,
          externalAccountId: seed.accountIdentity.externalAccountId,
          walletId: 'paper-initial:' + seed.funding.id,
          scope: c.configuration.source,
        }),
        balances: seed.funding.balances.map((b) => ({
          asset: b.asset,
          total: b.amount,
          free: b.amount,
          available: b.amount,
          locked: '0',
        })),
        status: 'RECONCILED',
        snapshotId: 'paper-bootstrap:' + seed.funding.id,
        snapshotAt: o.createdAt,
      };
      if (canonical(a.state) !== canonical(expected)) throw new Error('PAPER_VALUATION_STATE');
      let last = 0n;
      for (const d of a.drafts) {
        const seq = BigInt(d.clientOrderId);
        if (
          seq <= last ||
          seq > BigInt(a.accountState.clientIdHighWatermark) ||
          d.createdAt < c.createdAt ||
          d.createdAt > s.asOf
        )
          throw new Error('PAPER_VALUATION_STATE');
        last = seq;
      }
      let accountEquity = '0';
      const balances = a.state.balances.map((b) => {
        const key = canonical([owner.accountId, b.asset]);
        const p = prices.get(key);
        const identity = b.asset === f.quote;
        if (!identity && (!p || !sameMarketScope(p.scope, c.configuration.source)))
          throw new Error('PAPER_VALUATION_PRICE');
        if (p) used.add(key);
        const value = identity ? b.total : mul(b.total, p!.price);
        nonNegativeDecimalSchema.parse(value);
        accountEquity = add(accountEquity, value);
        values.set(b.asset, add(values.get(b.asset) ?? '0', value));
        return {
          asset: b.asset,
          total: b.total,
          available: b.available!,
          value,
          valuation: identity
            ? { kind: 'IDENTITY' as const, sourceId: null, asOf: s.asOf }
            : { kind: 'OBSERVED' as const, sourceId: p!.sourceId, asOf: p!.asOf },
        };
      });
      equity = add(equity, accountEquity);
      return {
        accountId: owner.accountId,
        bookId: a.bookId,
        sourceHash: a.hash,
        snapshotAt: o.createdAt,
        equity: accountEquity,
        balances,
      };
    });
    if (used.size !== prices.size) throw new Error('PAPER_VALUATION_PRICE');
    const validUntil = Math.min(s.asOf, ...f.prices.map((p) => p.asOf)) + f.maxEvidenceAgeMs + 1;
    if (validUntil > 8640000000000000 || validUntil <= f.now)
      throw new Error('PAPER_VALUATION_RANGE');
    return immutable({
      kind: 'PAPER_INVENTORY_VALUATION_CALCULATION' as const,
      portfolioHash: s.hash,
      quote: f.quote,
      computedAt: f.now,
      validUntil,
      equity,
      accounts,
      assets: [...values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([asset, value]) => ({ asset, value })),
    });
  } catch (error) {
    const code =
      error instanceof Error && /^PAPER_VALUATION_[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'PAPER_VALUATION_ARITHMETIC';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Stored account and market payloads must not cross the calculation error boundary.
      cause: new Error('PAPER_VALUATION_INVALID'),
    });
  }
}
