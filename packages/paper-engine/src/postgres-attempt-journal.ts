import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { riskSnapshotKeySchema } from '@ctp/risk-engine';
import { openPaperAdmissionDatabase } from './admission-database.js';
import { preparePaperExecutionAttempt, reducePaperExecutionAttempt } from './execution-attempt.js';
import type { PaperExecutionAttempt } from './execution-attempt.js';
import type { PaperFundingIo } from './funding-domain.js';
import type { PaperWithdrawalReceipt } from './postgres-withdrawal-barrier.js';
import {
  decodePaperExecutionSource,
  type PaperExecutionSource,
  type PaperExecutionSourceRequest,
} from './postgres-execution-source.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const epoch = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const fields = {
  key,
  admission: z.strictObject({
    binding: riskSnapshotKeySchema.shape.binding,
    orderId: uuid,
    intentId: uuid,
    operation: z.literal('PLACE'),
    commandHash: digest,
  }),
  authorization: z.strictObject({
    permissionEpoch: epoch,
    userSessionEpoch: epoch.refine((v) => BigInt(v) <= 2147483647n),
  }),
};
const preparationRequest = z.strictObject({ kind: z.literal('PAPER_ATTEMPT_PREPARE'), ...fields });
const preparedExecutionRequest = z.strictObject({
  kind: z.literal('PAPER_PREPARED_EXECUTION_CAPTURE'),
  preparationKey: key,
  admission: fields.admission,
  authorization: fields.authorization,
});
const stopRequest = z.strictObject({
  kind: z.literal('PAPER_ATTEMPT_STOP'),
  ...fields,
  stopKey: key,
  reason: z.enum(['CONTROL', 'DEADLINE', 'AUTHORIZATION', 'RULES', 'HEALTH', 'CANCELLED']),
});
const withdrawal = z.strictObject({
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
  bookRevision: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/u)
    .refine((v) => BigInt(v) <= 9007199254740991n),
  bookHash: digest,
});
const requestSchema = z.union([preparationRequest, stopRequest]);
const packet = z.strictObject({
  kind: z.enum(['PREPARED', 'STOPPED', 'COMMITTED']),
  request: requestSchema,
  preparation: z.unknown(),
  state: z.unknown(),
  withdrawal: withdrawal.nullable(),
});
const missing = z.strictObject({ kind: z.literal('MISSING'), request: requestSchema });
export type PaperAttemptPreparationRequest = z.infer<typeof preparationRequest>;
export type PaperAttemptStopRequest = z.infer<typeof stopRequest>;
export type PaperAttemptJournalView =
  | Readonly<{ kind: 'MISSING'; request: z.infer<typeof requestSchema> }>
  | Readonly<{
      kind: 'COMMITTED';
      request: z.infer<typeof requestSchema>;
      preparation: PaperExecutionAttempt;
      state: PaperExecutionAttempt;
      withdrawal: PaperWithdrawalReceipt | null;
    }>;
export interface PaperAttemptJournal {
  prepare(
    request: PaperAttemptPreparationRequest,
    io: PaperFundingIo,
  ): Promise<PaperExecutionAttempt>;
  read(
    request: PaperAttemptPreparationRequest,
    io: PaperFundingIo,
  ): Promise<PaperAttemptJournalView>;
  stopBeforeStart(
    request: PaperAttemptStopRequest,
    io: PaperFundingIo,
  ): Promise<PaperExecutionAttempt>;
  reconcileStop(
    request: PaperAttemptStopRequest,
    io: PaperFundingIo,
  ): Promise<PaperAttemptJournalView>;
  close(): Promise<void>;
}

export type PaperPreparedExecutionSourceRequest = z.infer<typeof preparedExecutionRequest>;
export interface PaperPreparedExecutionSource {
  readonly kind: 'PAPER_PREPARED_EXECUTION_SOURCE';
  readonly request: PaperPreparedExecutionSourceRequest;
  readonly asOf: number;
  readonly validUntil: number;
  readonly hash: string;
  readonly source: PaperExecutionSource;
  readonly preparation: PaperExecutionAttempt;
}
export interface PaperPreparedExecutionSourceReader {
  read(
    request: PaperPreparedExecutionSourceRequest,
    io: PaperFundingIo,
  ): Promise<PaperPreparedExecutionSource>;
  close(): Promise<void>;
}
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
function lookup(raw: unknown, stop: boolean) {
  const parsed = (stop ? stopRequest : preparationRequest).safeParse(raw);
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
function decode(
  raw: unknown,
  expected: z.infer<typeof requestSchema>,
  kind: string,
): PaperAttemptJournalView {
  try {
    if (Buffer.byteLength(canonical(raw)) > 65536) fail();
    const absent = missing.safeParse(raw);
    if (absent.success) {
      if (kind !== 'COMMITTED' || canonical(absent.data.request) !== canonical(expected)) fail();
      return immutable(absent.data);
    }
    const w = packet.parse(raw);
    if (w.kind !== kind || canonical(w.request) !== canonical(expected)) fail();
    const original = w.preparation as PaperExecutionAttempt;
    const preparation = preparePaperExecutionAttempt(original.request);
    if (canonical(preparation) !== canonical(w.preparation)) fail();
    const a = preparation.request.admission;
    if (
      canonical(a.binding) !== canonical(expected.admission.binding) ||
      a.orderId !== expected.admission.orderId ||
      a.intentId !== expected.admission.intentId ||
      a.commandHash !== expected.admission.commandHash ||
      preparation.request.preparedAt > Date.now()
    )
      fail();
    let state = preparation;
    if (w.withdrawal === null) {
      if (expected.kind === 'PAPER_ATTEMPT_STOP' || canonical(w.state) !== canonical(preparation))
        fail();
    } else {
      const v = w.withdrawal,
        last = (w.state as PaperExecutionAttempt).lastEvent;
      if (
        last.kind !== 'NOT_SENT' ||
        last.expectedRevision !== '1' ||
        v.eventId !== last.id ||
        v.observedAt !== last.at ||
        v.observedAt > Date.now() ||
        v.reservationId !== a.reservationId ||
        v.orderId !== a.orderId ||
        v.intentId !== a.intentId ||
        v.decisionId !== a.decisionId ||
        v.commandHash !== a.commandHash ||
        (expected.kind === 'PAPER_ATTEMPT_STOP' && expected.reason !== last.reason)
      )
        fail();
      state = reducePaperExecutionAttempt({ state: preparation, event: last }).state;
      if (canonical(state) !== canonical(w.state)) fail();
    }
    return immutable({
      kind: 'COMMITTED',
      request: expected,
      preparation,
      state,
      withdrawal: w.withdrawal,
    });
  } catch {
    fail();
  }
}

/** Durable preparation and irreversible negative cause only. Neither a replay
 * nor a successful COMMIT grants dispatch or releases collateral. */
export async function createPostgresPaperAttemptJournal(
  options: unknown,
): Promise<PaperAttemptJournal> {
  const database = await openPaperAdmissionDatabase(options);
  async function call(raw: unknown, io: PaperFundingIo, stop: boolean, readOnly: boolean) {
    const expected = lookup(raw, stop);
    return database.transaction(expected.admission.binding.tenantId, io, async (sql) => {
      const result = await sql.query<{ result: unknown }>(
        readOnly
          ? 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result'
          : 'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
        [canonical(expected)],
      );
      if (result.rows.length !== 1) fail();
      return decode(
        result.rows[0]!.result,
        expected,
        readOnly ? 'COMMITTED' : stop ? 'STOPPED' : 'PREPARED',
      );
    });
  }
  return Object.freeze({
    async prepare(raw: unknown, io: PaperFundingIo) {
      const view = await call(raw, io, false, false);
      if (view.kind !== 'COMMITTED') fail();
      return view.preparation;
    },
    read(raw: unknown, io: PaperFundingIo) {
      return call(raw, io, false, true);
    },
    async stopBeforeStart(raw: unknown, io: PaperFundingIo) {
      const view = await call(raw, io, true, false);
      if (view.kind !== 'COMMITTED') fail();
      return view.state;
    },
    reconcileStop(raw: unknown, io: PaperFundingIo) {
      return call(raw, io, true, true);
    },
    close: database.close,
  });
}

/** Current input and original preparation content only. This is not a final
 * Risk check, a START boundary, an idempotent grant or dispatch permission. */
export async function createPostgresPaperPreparedExecutionSource(
  options: unknown,
): Promise<PaperPreparedExecutionSourceReader> {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async read(raw: PaperPreparedExecutionSourceRequest, io: PaperFundingIo) {
      let parsed;
      try {
        parsed = preparedExecutionRequest.safeParse(raw);
      } catch {
        fail('PAPER_ADMISSION_INPUT');
      }
      if (!parsed.success) fail('PAPER_ADMISSION_INPUT');
      const r = parsed.data;
      const journalRequest = lookup(
        {
          kind: 'PAPER_ATTEMPT_PREPARE',
          key: r.preparationKey,
          admission: r.admission,
          authorization: r.authorization,
        },
        false,
      ) as PaperAttemptPreparationRequest;
      const request: PaperPreparedExecutionSourceRequest = {
        kind: 'PAPER_PREPARED_EXECUTION_CAPTURE',
        preparationKey: journalRequest.key,
        admission: journalRequest.admission,
        authorization: journalRequest.authorization,
      };
      const capture: PaperExecutionSourceRequest = {
        kind: 'PAPER_EXECUTION_CAPTURE',
        admission: journalRequest.admission,
        authorization: journalRequest.authorization,
      };
      const result = await database.transaction(
        request.admission.binding.tenantId,
        io,
        async (sql) => {
          const rows = await sql.query<{ result: unknown }>(
            'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
            [canonical(capture)],
          );
          if (rows.rows.length !== 1) fail();
          const source = decodePaperExecutionSource(rows.rows[0]!.result, capture, Date.now());
          const journalRows = await sql.query<{ result: unknown }>(
            'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
            [canonical(journalRequest)],
          );
          if (journalRows.rows.length !== 1) fail();
          const view = decode(journalRows.rows[0]!.result, journalRequest, 'COMMITTED');
          if (
            view.kind !== 'COMMITTED' ||
            view.withdrawal !== null ||
            view.state.phase !== 'PREPARED'
          )
            fail();
          const preparation = view.preparation;
          const target = source.candidates.find(
            (c) =>
              c.orderId === request.admission.orderId && c.intentId === request.admission.intentId,
          );
          if (!target || preparation.request.preparedAt > source.asOf) fail();
          const original = {
            binding: request.admission.binding,
            orderId: target.orderId,
            intentId: target.intentId,
            reservationId: target.reservationId,
            decisionId: target.decisionId,
            dbInstrumentId: target.dbInstrumentId,
            dbRuleId: target.dbRuleId,
            command: target.command,
            commandHash: target.commandHash,
            admissionSequence: target.admissionSequence,
            admittedAt: target.admittedAt,
            expiresAt: target.original.expiresAt,
          };
          if (canonical(preparation.request.admission) !== canonical(original)) fail();
          if (Date.now() >= source.validUntil) fail('PAPER_ADMISSION_EXPIRED');
          return immutable({
            kind: 'PAPER_PREPARED_EXECUTION_SOURCE' as const,
            request,
            asOf: source.asOf,
            validUntil: source.validUntil,
            hash: createHash('sha256')
              .update(canonical({ request, sourceHash: source.hash, preparation }))
              .digest('hex'),
            source,
            preparation,
          });
        },
      );
      if (io.signal.aborted || Date.now() >= io.deadline) fail('PAPER_ADMISSION_ABORTED');
      if (Date.now() >= result.validUntil) fail('PAPER_ADMISSION_EXPIRED');
      return result;
    },
    close: database.close,
  });
}
