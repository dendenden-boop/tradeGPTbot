import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { openPaperAdmissionDatabase } from './admission-database.js';
import { executionRiskLookup, paperExecutionRiskRequestSchema } from './execution-risk-domain.js';
import { preparePaperExecutionAttempt, reducePaperExecutionAttempt } from './execution-attempt.js';
import type { PaperExecutionAttempt } from './execution-attempt.js';
import type { PaperFundingIo } from './funding-domain.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const counter = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((value) => BigInt(value) < 2n ** 63n);
const requestSchema = paperExecutionRiskRequestSchema.extend({
  kind: z.literal('PAPER_EXECUTION_START'),
  startKey: key,
});
const policy = z.strictObject({
  scope: z.enum(['PLATFORM', 'USER']),
  tenantId: uuid.nullable(),
  version: counter,
  eventId: uuid,
  limitsHash: digest,
});
const validation = z.strictObject({
  validatedAt: timestampSchema,
  validUntil: timestampSchema,
  sourceHash: digest,
  policyHeads: z.tuple([policy, policy]),
  book: z.strictObject({
    id: uuid,
    revision: counter.refine((v) => BigInt(v) <= 9007199254740991n),
    hash: digest,
  }),
  metadata: z.strictObject({ instrumentId: uuid, ruleId: uuid }),
  capability: z.strictObject({ id: uuid, hash: digest }),
  authorization: paperExecutionRiskRequestSchema.shape.authorization,
});
const receiptSchema = z.strictObject({
  kind: z.literal('PAPER_EXECUTION_START_RECEIPT'),
  version: z.literal('paper-pristine-start-v1'),
  startKey: key,
  preparationKey: key,
  attemptId: uuid,
  eventId: uuid,
  startedAt: timestampSchema,
  requestHash: digest,
  preparationHash: digest,
  validation,
  validationHash: digest,
});
const unknownCause = z.strictObject({
  eventId: uuid,
  reservationId: uuid,
  orderId: uuid,
  intentId: uuid,
  decisionId: uuid,
  revision: z.literal('2'),
  observedAt: timestampSchema,
  bookId: uuid,
  bookRevision: counter.refine((v) => BigInt(v) <= 9007199254740991n),
  bookHash: digest,
});
const packet = z.strictObject({
  kind: z.enum(['STARTED', 'REPLAY', 'COMMITTED']),
  request: requestSchema,
  preparation: z.unknown(),
  receipt: receiptSchema,
  state: z.unknown(),
  unknown: unknownCause.nullable(),
});
const missing = z.strictObject({ kind: z.literal('MISSING'), request: requestSchema });
export type PaperExecutionStartRequest = z.infer<typeof requestSchema>;
export type PaperExecutionStartReceipt = Readonly<z.infer<typeof receiptSchema>>;
export type PaperExecutionStartView =
  | Readonly<{ kind: 'MISSING'; request: PaperExecutionStartRequest }>
  | Readonly<{
      kind: 'COMMITTED';
      request: PaperExecutionStartRequest;
      preparation: PaperExecutionAttempt;
      receipt: PaperExecutionStartReceipt;
      state: PaperExecutionAttempt;
      unknown: z.infer<typeof unknownCause> | null;
    }>;
export interface PaperExecutionStartJournal {
  start(
    request: PaperExecutionStartRequest,
    io: PaperFundingIo,
  ): Promise<PaperExecutionStartReceipt>;
  read(request: PaperExecutionStartRequest, io: PaperFundingIo): Promise<PaperExecutionStartView>;
  close(): Promise<void>;
}
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function bounded(raw: unknown, request: boolean) {
  const active = new WeakSet<object>();
  let nodes = 0,
    bytes = 0;
  function visit(value: unknown, depth: number) {
    if (++nodes > (request ? 256 : 2000) || depth > 16) fail('PAPER_ADMISSION_LIMIT');
    if (typeof value === 'string') {
      if (value.length > (request ? 16384 : 65536)) fail('PAPER_ADMISSION_LIMIT');
      bytes += Buffer.byteLength(value);
    } else if (value === null || typeof value === 'boolean') return;
    else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) fail();
    } else if (typeof value === 'object') {
      if (active.has(value)) fail();
      active.add(value);
      if (Array.isArray(value)) {
        if (request || value.length > 2 || Reflect.ownKeys(value).length !== value.length + 1)
          fail();
        for (let n = 0; n < value.length; n++) {
          const field = Object.getOwnPropertyDescriptor(value, String(n));
          if (!field?.enumerable || !('value' in field)) fail();
          visit(field.value, depth + 1);
        }
      } else {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) fail();
        const keys = Reflect.ownKeys(value);
        if (keys.length > 32) fail();
        for (const name of keys) {
          if (typeof name !== 'string' || name.length > 64) fail();
          const field = Object.getOwnPropertyDescriptor(value, name);
          if (!field?.enumerable || !('value' in field)) fail();
          bytes += Buffer.byteLength(name);
          visit(field.value, depth + 1);
        }
      }
      active.delete(value);
    } else fail();
    if (bytes > (request ? 16384 : 65536)) fail('PAPER_ADMISSION_LIMIT');
  }
  visit(raw, 0);
}
function lookup(raw: unknown): PaperExecutionStartRequest {
  try {
    bounded(raw, true);
    const r = requestSchema.parse(raw);
    const current = executionRiskLookup({
      kind: 'PAPER_EXECUTION_RISK_CAPTURE',
      preparationKey: r.preparationKey,
      admission: r.admission,
      authorization: r.authorization,
    });
    return immutable({
      kind: 'PAPER_EXECUTION_START',
      startKey: r.startKey,
      preparationKey: current.preparationKey,
      admission: current.admission,
      authorization: current.authorization,
    });
  } catch {
    fail('PAPER_ADMISSION_INPUT');
  }
}
function decode(
  raw: unknown,
  expected: PaperExecutionStartRequest,
  readOnly: boolean,
): PaperExecutionStartView {
  try {
    bounded(raw, false);
    const absent = missing.safeParse(raw);
    if (absent.success) {
      if (!readOnly || !same(absent.data.request, expected)) fail();
      return immutable(absent.data);
    }
    const w = packet.parse(raw),
      r = w.receipt,
      v = r.validation;
    if (
      !same(w.request, expected) ||
      (readOnly ? w.kind !== 'COMMITTED' : !['STARTED', 'REPLAY'].includes(w.kind))
    )
      fail();
    const original = z.object({ request: z.unknown() }).parse(w.preparation);
    const preparation = preparePaperExecutionAttempt(original.request),
      a = preparation.request.admission;
    const semantic = {
      preparationKey: expected.preparationKey,
      startKey: expected.startKey,
      admission: expected.admission,
    };
    if (
      !same(preparation, w.preparation) ||
      !same(a.binding, expected.admission.binding) ||
      a.orderId !== expected.admission.orderId ||
      a.intentId !== expected.admission.intentId ||
      a.commandHash !== expected.admission.commandHash ||
      r.startKey !== expected.startKey ||
      r.preparationKey !== expected.preparationKey ||
      r.attemptId !== preparation.request.attemptId ||
      r.requestHash !== hash(semantic) ||
      r.preparationHash !== hash(preparation) ||
      r.validationHash !== hash(v) ||
      v.validatedAt !== r.startedAt ||
      v.validUntil <= r.startedAt ||
      v.validUntil > a.expiresAt ||
      v.metadata.instrumentId !== a.dbInstrumentId ||
      v.metadata.ruleId !== a.dbRuleId ||
      v.policyHeads[0].scope !== 'PLATFORM' ||
      v.policyHeads[0].tenantId !== null ||
      v.policyHeads[1].scope !== 'USER' ||
      v.policyHeads[1].tenantId !== a.binding.tenantId ||
      (w.kind === 'STARTED' && !same(v.authorization, expected.authorization))
    )
      fail();
    let state = reducePaperExecutionAttempt({
      state: preparation,
      event: { id: r.eventId, kind: 'START', expectedRevision: '1', at: r.startedAt },
    }).state;
    const cause = w.unknown;
    if (cause !== null) {
      if (
        cause.reservationId !== a.reservationId ||
        cause.orderId !== a.orderId ||
        cause.intentId !== a.intentId ||
        cause.decisionId !== a.decisionId ||
        cause.observedAt < r.startedAt ||
        cause.bookId !== v.book.id ||
        BigInt(cause.bookRevision) <= BigInt(v.book.revision)
      )
        fail();
      state = reducePaperExecutionAttempt({
        state,
        event: {
          id: cause.eventId,
          kind: 'UNKNOWN',
          expectedRevision: '2',
          at: cause.observedAt,
          reason: 'AFTER_START',
        },
      }).state;
    }
    if (!same(state, w.state)) fail();
    return immutable({
      kind: 'COMMITTED',
      request: expected,
      preparation,
      receipt: r,
      state,
      unknown: cause,
    });
  } catch {
    fail();
  }
}

/** Fixed server-only journal port. Historical START content is not a financial
 * permit: neither replay nor reconciliation can dispatch, allocate or post. */
export async function createPostgresPaperExecutionStartJournal(
  options: unknown,
): Promise<PaperExecutionStartJournal> {
  const database = await openPaperAdmissionDatabase(options);
  async function call(raw: unknown, io: PaperFundingIo, readOnly: boolean) {
    const expected = lookup(raw);
    return database.transaction(expected.admission.binding.tenantId, io, async (sql) => {
      const result = await sql.query<{ result: unknown }>(
        readOnly
          ? 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result'
          : 'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
        [canonical(expected)],
      );
      if (result.rows.length !== 1) fail();
      return decode(result.rows[0]!.result, expected, readOnly);
    });
  }
  return Object.freeze({
    async start(raw: PaperExecutionStartRequest, io: PaperFundingIo) {
      const view = await call(raw, io, false);
      if (view.kind !== 'COMMITTED') fail();
      return view.receipt;
    },
    read(raw: PaperExecutionStartRequest, io: PaperFundingIo) {
      return call(raw, io, true);
    },
    close: database.close,
  });
}
