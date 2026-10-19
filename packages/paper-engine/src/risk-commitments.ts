import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  decimalAdd,
  decimalCompare,
  idSchema,
  immutable,
  nonNegativeAmountSchema,
  parseDecimal,
  positiveAmountSchema,
  positiveDecimalSchema,
  timestampSchema,
} from '@ctp/exchange-core';
import {
  canonical,
  eventSchema,
  restorePortfolio,
  stateSchema,
  type PortfolioEvent,
} from '@ctp/portfolio';
import { paperOwnerSchema } from './configuration-domain.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .pipe(z.string().refine((v) => BigInt(v) <= 9223372036854775807n));
const debit = z.strictObject({ asset: idSchema, amount: positiveAmountSchema, holdId: idSchema });
const reservation = z.strictObject({
  id: uuid,
  orderId: uuid,
  intentId: uuid,
  instrumentId: idSchema,
  base: idSchema,
  quote: idSchema,
  side: z.enum(['BUY', 'SELL']),
  notional: positiveDecimalSchema,
  notionalAsset: idSchema,
  status: z.enum(['ACTIVE', 'UNKNOWN', 'RELEASED']),
  updatedAt: timestampSchema,
  debits: z.array(debit).min(1).max(2),
});
const proof = z.strictObject({
  holdId: idSchema,
  timestamp: timestampSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  released: z.boolean(),
  unknown: z.boolean(),
  lastEvent: eventSchema,
});
const schema = z.strictObject({
  now: timestampSchema,
  asOf: timestampSchema,
  maxEvidenceAgeMs: z.number().int().min(1).max(5000),
  owner: paperOwnerSchema,
  valuationAsset: idSchema,
  bookId: uuid,
  revision,
  state: stateSchema,
  reservations: z.array(reservation).max(1000),
  holdProofs: z.array(proof).max(2000),
});
function textOrder(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function unique(ids: readonly string[]) {
  if (new Set(ids).size !== ids.length) throw Error('PAPER_COMMITMENT_DUPLICATE');
}
function fingerprint(e: PortfolioEvent) {
  const data =
    e.type === 'COMMITMENT'
      ? { type: e.type, hold: e.hold }
      : e.type === 'RELEASE'
        ? { type: e.type, holdId: e.holdId, resolved: e.resolved }
        : e.type === 'RESOLVE_COMMITMENT'
          ? { type: e.type, hold: e.hold, proofId: e.proofId, proofHash: e.proofHash }
          : null;
  if (data === null) throw Error('PAPER_COMMITMENT_PROOF');
  return createHash('sha256').update(canonical(data)).digest('hex');
}

/** Pure account-local content projection, never certified completeness or financial
 * authority. The future fixed SQL coordinator must lock/capture current rows,
 * authenticate their immutable allocations/resolution proofs and atomically
 * persist the entire vector. JSON, revision and fingerprints cannot do that. */
export function projectPaperRiskCommitments(raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw Error('PAPER_COMMITMENT_INPUT');
  try {
    const x = parsed.data,
      { owner, asOf, now } = x,
      state = restorePortfolio(x.state),
      b = state.binding;
    if (Buffer.byteLength(canonical(x), 'utf8') > 4194304) throw Error('PAPER_COMMITMENT_CAPACITY');
    if (asOf > now || now - asOf > x.maxEvidenceAgeMs) throw Error('PAPER_COMMITMENT_STALE');
    if (
      b.tenantId.toLowerCase() !== owner.tenantId ||
      b.accountId.toLowerCase() !== owner.accountId ||
      b.mode !== 'PAPER' ||
      b.connectionId !== null ||
      b.scope.market !== 'SPOT' ||
      b.walletId !== 'paper-initial:' + x.bookId
    )
      throw Error('PAPER_COMMITMENT_SCOPE');
    if (
      state.status !== 'RECONCILED' ||
      state.pending.length ||
      state.differences.length ||
      state.snapshotId === null ||
      state.snapshotAt === null ||
      state.snapshotAt > asOf ||
      (state.lastEconomicAt !== null && state.lastEconomicAt > asOf)
    )
      throw Error('PAPER_COMMITMENT_PORTFOLIO');
    if (!state.balances.length || state.balances.length > 32)
      throw Error('PAPER_COMMITMENT_BALANCE');
    const balances = state.balances.map((v) => {
      const available = nonNegativeAmountSchema.parse(v.available);
      // PAPER stores gross ledger cash. Commitments change no monetary balance;
      // native locked/reflected credit is not part of this model.
      if (v.total !== available || v.free !== available || v.locked !== '0')
        throw Error('PAPER_COMMITMENT_BALANCE');
      return { accountId: owner.accountId, asset: v.asset, available };
    });
    for (const field of ['id', 'orderId', 'intentId'] as const)
      unique(x.reservations.map((r) => r[field]));
    unique(x.holdProofs.map((p) => p.holdId));
    unique(x.holdProofs.map((p) => p.lastEvent.id));
    const live = new Map(state.holds.map((h) => [h.id, h])),
      proofs = new Map(x.holdProofs.map((p) => [p.holdId, p]));
    const instruments = new Map<string, string>();
    const reservations = [],
      holds = [],
      allocated = new Set<string>(),
      held = new Map<string, string>();
    for (const r of x.reservations) {
      if (r.updatedAt > asOf || r.base === r.quote || r.notionalAsset !== x.valuationAsset)
        throw Error('PAPER_COMMITMENT_VECTOR');
      const pair = canonical([r.base, r.quote]);
      if (instruments.has(r.instrumentId) && instruments.get(r.instrumentId) !== pair)
        throw Error('PAPER_COMMITMENT_SCOPE');
      instruments.set(r.instrumentId, pair);
      unique(r.debits.map((d) => d.asset));
      if (
        r.side === 'BUY'
          ? r.debits.length !== 1 || r.debits[0]!.asset !== r.quote
          : !r.debits.some((d) => d.asset === r.base) ||
            r.debits.some((d) => d.asset !== r.base && d.asset !== r.quote)
      )
        throw Error('PAPER_COMMITMENT_VECTOR');
      const unknown = r.status === 'UNKNOWN';
      for (const d of r.debits) {
        if (allocated.has(d.holdId)) throw Error('PAPER_COMMITMENT_DUPLICATE');
        allocated.add(d.holdId);
        const p = proofs.get(d.holdId),
          h = live.get(d.holdId);
        if (
          !p ||
          p.timestamp !== r.updatedAt ||
          p.lastEvent.timestamp !== p.timestamp ||
          p.fingerprint !== fingerprint(p.lastEvent)
        )
          throw Error('PAPER_COMMITMENT_PROOF');
        proofs.delete(d.holdId);
        if (r.status === 'RELEASED') {
          if (
            h ||
            !p.released ||
            p.unknown ||
            p.lastEvent.type !== 'RELEASE' ||
            p.lastEvent.holdId !== d.holdId ||
            !p.lastEvent.resolved
          )
            throw Error('PAPER_COMMITMENT_RELEASE');
        } else {
          if (
            !h ||
            p.released ||
            p.unknown !== unknown ||
            (h.status === 'UNKNOWN') !== unknown ||
            h.reflected ||
            h.asset !== d.asset ||
            h.amount !== d.amount ||
            (p.lastEvent.type !== 'COMMITMENT' && p.lastEvent.type !== 'RESOLVE_COMMITMENT') ||
            canonical(p.lastEvent.hold) !== canonical(h) ||
            (p.lastEvent.type === 'RESOLVE_COMMITMENT' && h.status !== 'RESERVED')
          )
            throw Error('PAPER_COMMITMENT_HOLD');
          live.delete(d.holdId);
          holds.push({
            id: h.id,
            accountId: owner.accountId,
            asset: h.asset,
            amount: d.amount,
            unknown,
            reflected: false,
          });
          held.set(
            d.asset,
            decimalAdd(parseDecimal(held.get(d.asset) ?? '0'), parseDecimal(d.amount)),
          );
        }
      }
      if (r.status !== 'RELEASED')
        reservations.push({
          id: r.id,
          orderId: r.orderId,
          intentId: r.intentId,
          accountId: owner.accountId,
          instrumentId: r.instrumentId,
          base: r.base,
          quote: r.quote,
          side: r.side,
          notional: r.notional,
          unknown,
          debits: [...r.debits].sort((a, b) => textOrder(a.asset, b.asset)),
        });
    }
    if (live.size || proofs.size) throw Error('PAPER_COMMITMENT_INCOMPLETE');
    for (const [asset, amount] of held) {
      const balance = balances.find((b) => b.asset === asset);
      if (!balance || decimalCompare(parseDecimal(balance.available), parseDecimal(amount)) < 0)
        throw Error('PAPER_COMMITMENT_BALANCE');
    }
    return immutable({
      kind: 'PAPER_COMMITMENT_PROJECTION' as const,
      owner,
      bookId: x.bookId,
      revision: x.revision,
      valuationAsset: x.valuationAsset,
      asOf,
      validUntil: timestampSchema.parse(asOf + x.maxEvidenceAgeMs + 1),
      balances: balances.sort((a, b) => textOrder(a.asset, b.asset)),
      reservations: reservations.sort((a, b) => textOrder(a.id, b.id)),
      holds: holds.sort((a, b) => textOrder(a.id, b.id)),
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && /^PAPER_COMMITMENT_[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'PAPER_COMMITMENT_CORRUPT',
      {
        // eslint-disable-next-line preserve-caught-error -- Never disclose private account, balance or history payloads.
        cause: new Error('PAPER_COMMITMENT_INVALID'),
      },
    );
  }
}
