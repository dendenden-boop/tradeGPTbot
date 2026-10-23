import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  immutable,
  positiveAmountSchema,
  sameMarketScope,
  timestampSchema,
} from '@ctp/exchange-core';
import { canonical, eventSchema, reducePortfolio, stateSchema } from '@ctp/portfolio';
import { riskSnapshotKeySchema } from '@ctp/risk-engine';
import type { PaperFundingIo } from './funding-domain.js';
import { openPaperAdmissionDatabase } from './admission-database.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/u)
  .pipe(z.string().refine((v) => BigInt(v) <= 9007199254740991n));
const request = z
  .strictObject({
    kind: z.literal('PAPER_RELEASE_WITHDRAWN'),
    admission: z.strictObject({
      binding: riskSnapshotKeySchema.shape.binding,
      orderId: uuid,
      intentId: uuid,
      operation: z.literal('PLACE'),
      commandHash: digest,
    }),
    reservationId: uuid,
    withdrawalEventId: uuid,
    eventId: uuid,
    expectedRevision: z.literal('1'),
  })
  .refine((v) => v.eventId !== v.withdrawalEventId);
const receipt = z.strictObject({
  outcome: z.literal('NOT_SENT'),
  collateral: z.literal('RELEASED'),
  eventId: uuid,
  withdrawalEventId: uuid,
  reservationId: uuid,
  orderId: uuid,
  intentId: uuid,
  decisionId: uuid,
  commandHash: digest,
  releaseVersion: z.literal('1'),
  releasedAt: timestampSchema,
  bookId: uuid,
  bookRevision: revision,
  bookHash: digest,
  debits: z
    .array(
      z.strictObject({
        asset: z.string().min(1).max(32),
        amount: positiveAmountSchema,
        holdId: uuid,
      }),
    )
    .length(1),
});
const mutation = z.strictObject({
  kind: z.literal('RELEASED'),
  request,
  receipt,
  portfolio: z.strictObject({
    bookId: uuid,
    previousRevision: revision,
    revision,
    before: stateSchema,
    event: eventSchema,
    previousWatermark: z.strictObject({
      timestamp: timestampSchema,
      fingerprint: digest,
      released: z.literal(false),
      unknown: z.literal(false),
    }),
    afterText: z.string().min(1).max(1048576),
    afterHash: digest,
  }),
});
const reconciliation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('MISSING'), request }),
  z.strictObject({ kind: z.literal('COMMITTED'), request, receipt }),
]);
export type PaperWithdrawalReleaseRequest = z.infer<typeof request>;
export type PaperWithdrawalReleaseReceipt = z.infer<typeof receipt>;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw new Error(code);
}
function lookup(raw: unknown) {
  const parsed = request.safeParse(raw);
  if (!parsed.success) fail('PAPER_ADMISSION_INPUT');
  const r = parsed.data,
    b = r.admission.binding;
  if (
    b.mode !== 'PAPER' ||
    b.connectionId !== null ||
    b.profile.market !== 'SPOT' ||
    b.profile.accountMode !== 'SIMULATED' ||
    b.profile.endpointProfileId !== 'paper-spot-v1' ||
    b.profile.profileVersion !== 'spot-l2-taker-v1'
  )
    fail('PAPER_ADMISSION_UNSUPPORTED');
  return r;
}
function single(rows: { result: unknown }[]) {
  if (rows.length !== 1 || Buffer.byteLength(canonical(rows[0]!.result), 'utf8') > 4194304) fail();
  return rows[0]!.result;
}
function verifyReceipt(r: PaperWithdrawalReleaseReceipt, expected: PaperWithdrawalReleaseRequest) {
  if (
    r.eventId !== expected.eventId ||
    r.withdrawalEventId !== expected.withdrawalEventId ||
    r.reservationId !== expected.reservationId ||
    r.orderId !== expected.admission.orderId ||
    r.intentId !== expected.admission.intentId ||
    r.commandHash !== expected.admission.commandHash ||
    r.releasedAt > Date.now()
  )
    fail();
}
function verifyTransition(r: z.infer<typeof mutation>, expected: PaperWithdrawalReleaseRequest) {
  if (!same(r.request, expected)) fail();
  verifyReceipt(r.receipt, expected);
  const p = r.portfolio,
    b = p.before.binding,
    binding = expected.admission.binding,
    event = p.event,
    d = r.receipt.debits[0]!;
  if (
    b.tenantId !== binding.tenantId ||
    b.accountId !== binding.accountId ||
    b.mode !== 'PAPER' ||
    b.connectionId !== null ||
    b.externalAccountId !== binding.externalAccountId ||
    b.walletId !== 'paper-initial:' + p.bookId ||
    !sameMarketScope(b.scope, binding.profile) ||
    r.receipt.bookId !== p.bookId ||
    r.receipt.bookRevision !== p.revision ||
    r.receipt.bookHash !== p.afterHash ||
    BigInt(p.revision) !== BigInt(p.previousRevision) + 1n ||
    event.type !== 'RELEASE' ||
    event.resolved ||
    event.id !== expected.eventId ||
    event.holdId !== d.holdId ||
    event.timestamp !== r.receipt.releasedAt ||
    event.timestamp <= p.previousWatermark.timestamp ||
    p.before.snapshotAt === null ||
    p.previousWatermark.timestamp < p.before.snapshotAt
  )
    fail();
  const old = p.before.holds.filter((h) => h.id === d.holdId);
  if (
    old.length !== 1 ||
    !same(old[0], {
      id: d.holdId,
      asset: d.asset,
      amount: d.amount,
      status: 'RESERVED',
      reflected: false,
    }) ||
    p.previousWatermark.fingerprint !== hash(canonical({ type: 'COMMITMENT', hold: old[0] }))
  )
    fail();
  const after = reducePortfolio(p.before, event, {
    now: () => Date.now(),
    holdWatermark: p.previousWatermark,
  });
  if (
    after.ignored ||
    after.postings.length ||
    !after.holdWatermark?.released ||
    after.holdWatermark.unknown ||
    canonical(after.state) !== p.afterText ||
    hash(p.afterText) !== p.afterHash
  )
    fail();
}

/** Server-only, fixed SQL authority for an irreversible NOT_SENT release.
 * The private terminal cause and Portfolio tombstone must commit together.
 * Original allocations remain historical; neither this receipt nor readonly
 * reconciliation is a grant, public CANCEL acknowledgement or dispatch permit. */
export async function createPostgresPaperWithdrawalRelease(options: unknown) {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async release(raw: unknown, io: PaperFundingIo): Promise<PaperWithdrawalReleaseReceipt> {
      const expected = lookup(raw);
      return database.transaction(expected.admission.binding.tenantId, io, async (sql) => {
        const rows = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
          [canonical(expected)],
        );
        try {
          const r = mutation.parse(single(rows.rows));
          verifyTransition(r, expected);
          return immutable(r.receipt);
        } catch {
          fail();
        }
      });
    },
    async reconcile(raw: unknown, io: PaperFundingIo) {
      const expected = lookup(raw);
      return database.transaction(expected.admission.binding.tenantId, io, async (sql) => {
        const rows = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
          [canonical(expected)],
        );
        try {
          const r = reconciliation.parse(single(rows.rows));
          if (!same(r.request, expected)) fail();
          if (r.kind === 'COMMITTED') verifyReceipt(r.receipt, expected);
          return immutable(r);
        } catch {
          fail();
        }
      });
    },
    close: database.close,
  });
}
