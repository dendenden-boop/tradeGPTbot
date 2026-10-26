import { z } from 'zod';
import { idSchema, immutable, operations, timestampSchema } from '@ctp/exchange-core';
import { bindingSchema, canonical, stateSchema } from '@ctp/order-engine';
import { preparePaperUnsentCancellation } from '@ctp/order-engine/paper';
import { openPaperAdmissionDatabase } from './admission-database.js';
import type { PaperFundingIo } from './funding-domain.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const epoch = z
  .string()
  .refine((v) => /^(0|[1-9][0-9]{0,18})$/u.test(v) && BigInt(v) <= 9223372036854775807n);
const request = z.strictObject({
  kind: z.literal('PAPER_CANCEL_UNSENT'),
  binding: bindingSchema,
  orderId: uuid,
  key: idSchema,
  authorization: z.strictObject({
    permissionEpoch: epoch,
    userSessionEpoch: epoch.refine((v) => BigInt(v) <= 2147483647n),
  }),
});
const semantic = z.strictObject({
  binding: bindingSchema,
  orderId: uuid,
  operation: z.literal('CANCEL'),
  key: idSchema,
});
const receipt = z.strictObject({
  outcome: z.literal('NOT_SENT'),
  collateral: z.literal('RELEASED'),
  orderId: uuid,
  placeIntentId: uuid,
  intentId: uuid,
  eventId: uuid,
  clientOrderId: idSchema,
  requestHash: digest,
  command: operations.cancelOrder.input.shape.command,
  commandHash: digest,
  status: z.literal('CANCELED'),
  version: z.literal('1'),
  canceledAt: timestampSchema,
  reservationId: uuid,
  withdrawalEventId: uuid,
  releaseEventId: uuid,
});
const packet = z.strictObject({
  kind: z.enum(['CANCELED', 'COMMITTED']),
  request: semantic,
  receipt,
  source: z.strictObject({ state: stateSchema, withdrawal: z.unknown(), release: z.unknown() }),
});
const missing = z.strictObject({ kind: z.literal('MISSING'), request: semantic });
export type PaperUnsentCancellationRequest = z.infer<typeof request>;
export type PaperUnsentCancellationReceipt = z.infer<typeof receipt>;
export type PaperUnsentCancellationReconciliation =
  | z.infer<typeof missing>
  | {
      kind: 'COMMITTED';
      request: z.infer<typeof semantic>;
      receipt: PaperUnsentCancellationReceipt;
    };
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
function lookup(raw: unknown) {
  const p = request.safeParse(raw);
  if (!p.success) fail('PAPER_ADMISSION_INPUT');
  const r = p.data,
    b = r.binding;
  if (
    b.mode !== 'PAPER' ||
    b.connectionId !== null ||
    b.profile.market !== 'SPOT' ||
    b.profile.accountMode !== 'SIMULATED' ||
    b.profile.endpointProfileId !== 'paper-spot-v1' ||
    b.profile.profileVersion !== 'spot-l2-taker-v1' ||
    b.profile.credentialRef !== undefined
  )
    fail('PAPER_ADMISSION_UNSUPPORTED');
  return r;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function identity(r: PaperUnsentCancellationRequest) {
  return { binding: r.binding, orderId: r.orderId, operation: 'CANCEL' as const, key: r.key };
}
function verify(
  raw: unknown,
  expected: PaperUnsentCancellationRequest,
  kind: 'CANCELED' | 'COMMITTED',
) {
  const p = packet.parse(raw),
    r = p.receipt,
    s = p.source.state;
  if (p.kind !== kind || !same(p.request, identity(expected))) fail();
  const plan = preparePaperUnsentCancellation(
    { kind: 'PAPER_PREPARE_UNSENT_CANCEL', key: expected.key, ...p.source },
    Date.now(),
  );
  if (
    !same(plan.request, p.request) ||
    r.orderId !== expected.orderId ||
    r.placeIntentId !== s.intentId ||
    r.clientOrderId !== s.command.clientOrderId ||
    r.requestHash !== plan.requestHash ||
    r.commandHash !== plan.commandHash ||
    !same(r.command, plan.command) ||
    r.canceledAt > Date.now() ||
    r.canceledAt < (p.source.release as { releasedAt: number }).releasedAt ||
    r.reservationId !== (p.source.release as { reservationId: string }).reservationId ||
    r.withdrawalEventId !== (p.source.withdrawal as { eventId: string }).eventId ||
    r.releaseEventId !== (p.source.release as { eventId: string }).eventId ||
    new Set([
      r.orderId,
      r.placeIntentId,
      r.intentId,
      r.eventId,
      r.reservationId,
      r.withdrawalEventId,
      r.releaseEventId,
    ]).size !== 7
  )
    fail();
  return r;
}

/** Trusted server composition only. Private issuance/withdrawal/release and
 * current authenticated ownership are checked by fixed SQL, never by a plan.
 * Returning a receipt requires a known COMMIT; uncertainty is not retried. */
export async function createPostgresPaperUnsentCancellation(options: unknown) {
  const database = await openPaperAdmissionDatabase(options);
  function call(
    raw: unknown,
    io: PaperFundingIo,
    readOnly: false,
  ): Promise<PaperUnsentCancellationReceipt>;
  function call(
    raw: unknown,
    io: PaperFundingIo,
    readOnly: true,
  ): Promise<PaperUnsentCancellationReconciliation>;
  async function call(raw: unknown, io: PaperFundingIo, readOnly: boolean) {
    const expected = lookup(raw);
    return database.transaction(expected.binding.tenantId, io, async (sql) => {
      const rows = await sql.query<{ result: unknown }>(
        readOnly
          ? 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result'
          : 'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
        [canonical(expected)],
      );
      try {
        if (
          rows.rows.length !== 1 ||
          Buffer.byteLength(canonical(rows.rows[0]!.result), 'utf8') > 65536
        )
          fail();
        const rawResult = rows.rows[0]!.result;
        if (readOnly) {
          const absent = missing.safeParse(rawResult);
          if (absent.success) {
            if (!same(absent.data.request, identity(expected))) fail();
            return immutable(absent.data);
          }
          return immutable({
            kind: 'COMMITTED' as const,
            request: identity(expected),
            receipt: verify(rawResult, expected, 'COMMITTED'),
          });
        }
        return immutable(verify(rawResult, expected, 'CANCELED'));
      } catch {
        fail();
      }
    });
  }
  return Object.freeze({
    cancel: (raw: unknown, io: PaperFundingIo) => call(raw, io, false),
    reconcile: (raw: unknown, io: PaperFundingIo) => call(raw, io, true),
    close: database.close,
  });
}
