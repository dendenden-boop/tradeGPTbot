import { z } from 'zod';
import {
  idSchema,
  immutable,
  positiveAmountSchema,
  positiveDecimalSchema,
  timestampSchema,
} from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { paperOwnerSchema } from './configuration-domain.js';
import { projectPaperRiskCommitments } from './risk-commitments.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
// Validate format in a non-continuable stage before BigInt. SQL milliseconds
// are strings; compare losslessly before converting within Date's safe bound.
const milliseconds = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/u)
  .pipe(z.string().refine((v) => v.trim() === v && BigInt(v) <= 8640000000000000n));
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .pipe(z.string().refine((v) => v.trim() === v && BigInt(v) <= 9223372036854775807n));
const event = z.strictObject({
  kind: z.literal('PAPER_RESERVATION_STATE_RECORD'),
  ...paperOwnerSchema.shape,
  reservationId: uuid,
  intentId: uuid,
  eventId: uuid,
  revision: z.enum(['1', '2']),
  status: z.enum(['ACTIVE', 'UNKNOWN']),
  observedAt: milliseconds,
});
const reservation = z.strictObject({
  parent: z.strictObject({
    ...paperOwnerSchema.shape,
    id: uuid,
    decisionId: uuid,
    intentId: uuid,
    status: z.literal('ACTIVE'),
    version: z.literal(0),
    paperLegacy: z.literal(false),
    vectorSize: z.union([z.literal(1), z.literal(2)]),
    budgetId: z.null(),
    asset: z.null(),
    amount: z.null(),
    consumedAmount: z.literal('0'),
    releasedAt: z.null(),
    createdAt: milliseconds,
    expiresAt: milliseconds,
  }),
  allocation: z.strictObject({
    orderId: uuid,
    instrumentId: idSchema,
    base: idSchema,
    quote: idSchema,
    side: z.enum(['BUY', 'SELL']),
    notional: positiveDecimalSchema,
    notionalAsset: idSchema,
  }),
  debits: z
    .array(
      z.strictObject({
        ordinal: z.union([z.literal(1), z.literal(2)]),
        asset: idSchema,
        amount: positiveAmountSchema,
        holdId: uuid,
      }),
    )
    .min(1)
    .max(2),
  head: z.strictObject({ eventId: uuid, revision: z.enum(['1', '2']) }),
  history: z.array(event).min(1).max(2),
});
const input = z.strictObject({
  now: timestampSchema,
  asOf: timestampSchema,
  maxEvidenceAgeMs: z.number().int().min(1).max(5000),
  owner: paperOwnerSchema,
  valuationAsset: idSchema,
  accountIds: z.array(uuid).min(1).max(100),
  accounts: z
    .array(
      z.strictObject({
        owner: paperOwnerSchema,
        asOf: timestampSchema,
        bookId: uuid,
        revision,
        state: z.unknown(),
        holdProofs: z.array(z.unknown()).max(2000),
        reservations: z.array(reservation).max(1000),
      }),
    )
    .min(1)
    .max(100),
});
function ordered(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function unique(values: readonly string[]) {
  if (new Set(values).size !== values.length) throw Error('PAPER_JOURNAL_INVENTORY_DUPLICATE');
}

/** Content projection only. The future fixed SQL source must authenticate the
 * complete catalog, heads, original decision/model allocations and Portfolio
 * watermarks in one locked transaction. Caller JSON can forge a consistent
 * catalog/head/history and therefore cannot certify completeness or admission.
 * This contract covers only immutable original vectors with ACTIVE->UNKNOWN;
 * it cannot invent remaining amounts, execution, release or trusted resolution. */
export function projectPaperRiskJournalInventory(raw: unknown) {
  try {
    if (Buffer.byteLength(canonical(raw), 'utf8') > 4194304)
      throw Error('PAPER_JOURNAL_INVENTORY_CAPACITY');
    const x = input.parse(raw);
    if (x.asOf > x.now || x.now - x.asOf > x.maxEvidenceAgeMs)
      throw Error('PAPER_JOURNAL_INVENTORY_STALE');
    unique(x.accountIds);
    unique(x.accounts.map((a) => a.owner.accountId));
    unique(x.accounts.map((a) => a.bookId));
    if (
      !x.accountIds.includes(x.owner.accountId) ||
      canonical([...x.accountIds].sort(ordered)) !==
        canonical(x.accounts.map((a) => a.owner.accountId).sort(ordered))
    )
      throw Error('PAPER_JOURNAL_INVENTORY_SCOPE');
    const all = x.accounts.flatMap((a) => a.reservations);
    if (all.length > 10000) throw Error('PAPER_JOURNAL_INVENTORY_CAPACITY');
    for (const ids of [
      all.map((r) => r.parent.id),
      all.map((r) => r.parent.intentId),
      all.map((r) => r.parent.decisionId),
      all.map((r) => r.allocation.orderId),
      all.flatMap((r) => r.debits.map((d) => d.holdId)),
      all.flatMap((r) => r.history.map((e) => e.eventId)),
    ])
      unique(ids);
    const projections = x.accounts.map((a) => {
      if (a.owner.tenantId !== x.owner.tenantId || a.asOf > x.asOf)
        throw Error('PAPER_JOURNAL_INVENTORY_SCOPE');
      const reservations = a.reservations.map((r) => {
        const p = r.parent,
          last = r.history.at(-1)!;
        if (
          p.tenantId !== a.owner.tenantId ||
          p.accountId !== a.owner.accountId ||
          BigInt(p.createdAt) > BigInt(a.asOf) ||
          r.allocation.notionalAsset !== x.valuationAsset ||
          r.head.revision !== last.revision ||
          r.head.eventId !== last.eventId ||
          r.debits.length !== p.vectorSize ||
          r.debits.some((d, i) => d.ordinal !== i + 1)
        )
          throw Error('PAPER_JOURNAL_INVENTORY_VECTOR');
        let previous = BigInt(p.createdAt);
        for (const [i, e] of r.history.entries()) {
          const at = BigInt(e.observedAt);
          if (
            e.tenantId !== p.tenantId ||
            e.accountId !== p.accountId ||
            e.intentId !== p.intentId ||
            e.reservationId !== p.id ||
            e.revision !== String(i + 1) ||
            e.status !== (i === 0 ? 'ACTIVE' : 'UNKNOWN') ||
            at > BigInt(a.asOf) ||
            (i === 0 ? at < previous : at <= previous)
          )
            throw Error('PAPER_JOURNAL_INVENTORY_HISTORY');
          previous = at;
        }
        return {
          id: p.id,
          intentId: p.intentId,
          ...r.allocation,
          status: last.status,
          updatedAt: Number(last.observedAt),
          debits: r.debits.map(({ ordinal, ...d }) => {
            void ordinal;
            return d;
          }),
        };
      });
      return projectPaperRiskCommitments({
        now: x.now,
        asOf: a.asOf,
        maxEvidenceAgeMs: x.maxEvidenceAgeMs,
        owner: a.owner,
        valuationAsset: x.valuationAsset,
        bookId: a.bookId,
        revision: a.revision,
        state: a.state,
        holdProofs: a.holdProofs,
        reservations,
      });
    });
    // A sibling's older original capture bounds the entire result. No enclosing
    // read, expired reservation or replayed ACTIVE receipt renews its evidence.
    const asOf = Math.min(x.asOf, ...projections.map((p) => p.asOf)),
      validUntil = timestampSchema.parse(
        Math.min(x.asOf + x.maxEvidenceAgeMs + 1, ...projections.map((p) => p.validUntil)),
      );
    if (x.now >= validUntil) throw Error('PAPER_JOURNAL_INVENTORY_STALE');
    const instruments = new Map<string, string>();
    for (const r of projections.flatMap((p) => p.reservations)) {
      const pair = canonical([r.base, r.quote]),
        old = instruments.get(r.instrumentId);
      if (old !== undefined && old !== pair) throw Error('PAPER_JOURNAL_INVENTORY_SCOPE');
      instruments.set(r.instrumentId, pair);
    }
    return immutable({
      kind: 'PAPER_JOURNAL_INVENTORY_PROJECTION' as const,
      tenantId: x.owner.tenantId,
      mode: 'PAPER' as const,
      valuationAsset: x.valuationAsset,
      asOf,
      validUntil,
      accountIds: [...x.accountIds].sort(ordered),
      books: projections
        .map((p) => ({
          accountId: p.owner.accountId,
          bookId: p.bookId,
          revision: p.revision,
          asOf: p.asOf,
        }))
        .sort((a, b) => ordered(a.accountId, b.accountId)),
      balances: projections
        .flatMap((p) => p.balances)
        .sort((a, b) => ordered(a.accountId, b.accountId) || ordered(a.asset, b.asset)),
      reservations: projections.flatMap((p) => p.reservations).sort((a, b) => ordered(a.id, b.id)),
      holds: projections.flatMap((p) => p.holds).sort((a, b) => ordered(a.id, b.id)),
    });
  } catch (error) {
    const code =
      error instanceof Error && /^PAPER_JOURNAL_INVENTORY_[A-Z_]+$/u.test(error.message)
        ? error.message
        : error instanceof Error && /^PAPER_COMMITMENT_STALE$/u.test(error.message)
          ? 'PAPER_JOURNAL_INVENTORY_STALE'
          : 'PAPER_JOURNAL_INVENTORY_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Stored tenant/hold/history values must not escape the content boundary.
      cause: new Error('PAPER_JOURNAL_INVENTORY_INVALID'),
    });
  }
}
