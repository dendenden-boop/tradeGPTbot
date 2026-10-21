import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, sameMarketScope, timestampSchema } from '@ctp/exchange-core';
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
const request = z.strictObject({
  kind: z.literal('PAPER_RESERVATION_UNKNOWN'),
  admission: z.strictObject({
    binding: riskSnapshotKeySchema.shape.binding,
    orderId: uuid,
    intentId: uuid,
    operation: z.literal('PLACE'),
    commandHash: digest,
  }),
  reservationId: uuid,
  eventId: uuid,
  expectedRevision: z.literal('1'),
});
const receipt = z.strictObject({
  eventId: uuid,
  reservationId: uuid,
  orderId: uuid,
  intentId: uuid,
  decisionId: uuid,
  revision: z.literal('2'),
  observedAt: timestampSchema,
  bookId: uuid,
  bookRevision: revision,
  bookHash: digest,
});
const watermark = z.strictObject({
  timestamp: timestampSchema,
  fingerprint: digest,
  released: z.literal(false),
  unknown: z.literal(false),
});
const mutationReply = z.strictObject({
  kind: z.literal('UNKNOWN'),
  request,
  receipt,
  portfolio: z.strictObject({
    bookId: uuid,
    previousRevision: revision,
    revision,
    before: stateSchema,
    event: eventSchema,
    previousWatermark: watermark,
    afterText: z.string().min(1).max(1048576),
    afterHash: digest,
  }),
});
export type PaperReservationUnknownRequest = z.infer<typeof request>;
export type PaperReservationUnknownReceipt = z.infer<typeof receipt>;
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
function verifyReceipt(
  r: PaperReservationUnknownReceipt,
  expected: PaperReservationUnknownRequest,
) {
  if (
    r.eventId !== expected.eventId ||
    r.reservationId !== expected.reservationId ||
    r.orderId !== expected.admission.orderId ||
    r.intentId !== expected.admission.intentId ||
    r.observedAt > Date.now()
  )
    fail();
}
function verifyTransition(
  r: z.infer<typeof mutationReply>,
  expected: PaperReservationUnknownRequest,
) {
  if (!same(r.request, expected)) fail();
  verifyReceipt(r.receipt, expected);
  const p = r.portfolio,
    b = p.before.binding,
    binding = expected.admission.binding,
    event = p.event;
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
    event.type !== 'COMMITMENT' ||
    event.id !== expected.eventId ||
    event.timestamp !== r.receipt.observedAt ||
    event.timestamp <= p.previousWatermark.timestamp
  )
    fail();
  const old = p.before.holds.filter((h) => h.id === event.hold.id);
  if (
    old.length !== 1 ||
    old[0]!.status !== 'RESERVED' ||
    old[0]!.reflected ||
    !same(event.hold, { ...old[0]!, status: 'UNKNOWN' }) ||
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
    after.holdWatermark?.unknown !== true ||
    canonical(after.state) !== p.afterText ||
    hash(p.afterText) !== p.afterHash
  )
    fail();
}

/** Server-only conservative quarantine, never a grant, release or resolution.
 * Fixed additive54 SQL authenticates original issuance and atomically retains
 * its full vector. The existing physically bounded two-RPC transport is reused;
 * no SQL/role/client override, caller snapshot or authority callback is accepted. */
export async function createPostgresPaperReservationLifecycle(options: unknown) {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async markUnknown(raw: unknown, io: PaperFundingIo): Promise<PaperReservationUnknownReceipt> {
      const expected = lookup(raw);
      return database.transaction(expected.admission.binding.tenantId, io, async (sql) => {
        const rows = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
          [canonical(expected)],
        );
        try {
          const r = mutationReply.parse(single(rows.rows));
          verifyTransition(r, expected);
          return immutable(r.receipt);
        } catch {
          throw new Error('PAPER_ADMISSION_EVIDENCE');
        }
      });
    },
    async reconcileUnknown(raw: unknown, io: PaperFundingIo) {
      const expected = lookup(raw);
      return database.transaction(expected.admission.binding.tenantId, io, async (sql) => {
        const rows = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
          [canonical(expected)],
        );
        try {
          const r = z
            .discriminatedUnion('kind', [
              z.strictObject({ kind: z.literal('MISSING'), request }),
              z.strictObject({ kind: z.literal('COMMITTED'), request, receipt }),
            ])
            .parse(single(rows.rows));
          if (!same(r.request, expected)) fail();
          if (r.kind === 'COMMITTED') verifyReceipt(r.receipt, expected);
          return immutable(r);
        } catch {
          throw new Error('PAPER_ADMISSION_EVIDENCE');
        }
      });
    },
    close: database.close,
  });
}
