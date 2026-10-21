import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { riskSnapshotKeySchema } from '@ctp/risk-engine';
import type { PaperFundingIo } from './funding-domain.js';
import { openPaperAdmissionDatabase } from './admission-database.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const request = z.strictObject({
  kind: z.literal('PAPER_WITHDRAW_BEFORE_DISPATCH'),
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
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/u)
  .refine((v) => BigInt(v) <= 9007199254740991n);
const receipt = z.strictObject({
  outcome: z.literal('NOT_SENT'),
  collateral: z.literal('RETAINED'),
  eventId: uuid,
  reservationId: uuid,
  orderId: uuid,
  intentId: uuid,
  decisionId: uuid,
  commandHash: digest,
  stateRevision: z.literal('1'),
  observedAt: timestampSchema,
  bookId: uuid,
  bookRevision: revision,
  bookHash: digest,
});
export type PaperWithdrawalRequest = z.infer<typeof request>;
export type PaperWithdrawalReceipt = z.infer<typeof receipt>;
const mutation = z.strictObject({ kind: z.literal('WITHDRAWN'), request, receipt });
const reconciliation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('MISSING'), request }),
  z.strictObject({ kind: z.literal('COMMITTED'), request, receipt }),
]);
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
  if (rows.length !== 1 || Buffer.byteLength(canonical(rows[0]!.result), 'utf8') > 16384) fail();
  return rows[0]!.result;
}
function verify(
  r: { request: PaperWithdrawalRequest; receipt?: PaperWithdrawalReceipt },
  expected: PaperWithdrawalRequest,
) {
  if (canonical(r.request) !== canonical(expected)) fail();
  if (!r.receipt) return;
  const v = r.receipt;
  if (
    v.eventId !== expected.eventId ||
    v.reservationId !== expected.reservationId ||
    v.orderId !== expected.admission.orderId ||
    v.intentId !== expected.admission.intentId ||
    v.commandHash !== expected.admission.commandHash ||
    v.observedAt > Date.now()
  )
    fail();
}

/** Server-only irreversible prohibition on a pristine issued PAPER PLACE.
 * Additive55 authenticates issuance and the full retained hold, then persists
 * a barrier serialized with dispatch/evidence guards. This is neither a CANCEL
 * acknowledgement nor collateral-release authority. Reconciliation is a read;
 * the existing fixed transport with physical settlement owns COMMIT ambiguity. */
export async function createPostgresPaperWithdrawalBarrier(options: unknown) {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async withdraw(raw: unknown, io: PaperFundingIo): Promise<PaperWithdrawalReceipt> {
      const expected = lookup(raw);
      return database.transaction(expected.admission.binding.tenantId, io, async (sql) => {
        const rows = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
          [canonical(expected)],
        );
        try {
          const r = mutation.parse(single(rows.rows));
          verify(r, expected);
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
          verify(r, expected);
          return immutable(r);
        } catch {
          fail();
        }
      });
    },
    close: database.close,
  });
}
