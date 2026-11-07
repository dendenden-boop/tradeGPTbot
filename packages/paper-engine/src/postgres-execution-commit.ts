import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { openPaperAdmissionDatabase } from './admission-database.js';
import {
  lookupPaperStartedRiskRequest,
  decodePaperStartedRiskWire,
} from './postgres-started-risk.js';
import type { PaperStartedRiskRequest } from './postgres-started-risk.js';
import { preparePaperFrame } from './model.js';
import { calculatePaperStartedTransition } from './started-transition.js';
import type { PaperFundingIo } from './funding-domain.js';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const uuid = z.uuid().transform((v) => v.toLowerCase());
const receiptSchema = z.strictObject({
  kind: z.literal('PAPER_EXECUTION_COMMIT_RECEIPT'),
  version: z.literal('paper-pristine-execution-v1'),
  executionKey: key,
  executionId: uuid,
  attemptId: uuid,
  orderId: uuid,
  intentId: uuid,
  reservationId: uuid,
  order: z.strictObject({
    status: z.enum(['FILLED', 'PARTIALLY_FILLED', 'EXPIRED']),
    executedQuantity: z.string(),
    remainingQuantity: z.string(),
  }),
  reservation: z.strictObject({ status: z.enum(['ACTIVE', 'RELEASED']), revision: z.literal('2') }),
  fillIds: z.array(uuid).max(1000),
  ledgerTransactionIds: z.array(uuid).max(1000),
});
const packet = z.strictObject({
  kind: z.literal('COMMITTED'),
  request: z.unknown(),
  authorization: z.unknown(),
  evaluatedAt: timestampSchema,
  source: z.unknown(),
  input: z.unknown(),
  effects: z.unknown(),
  receipt: receiptSchema,
});
export type PaperExecutionCommitRequest = Omit<PaperStartedRiskRequest, 'kind'> & {
  kind: 'PAPER_EXECUTION_COMMIT';
  executionKey: string;
};
export type PaperExecutionCommitReceipt = z.infer<typeof receiptSchema>;
export interface PaperExecutionCommitter {
  execute(
    request: PaperExecutionCommitRequest,
    io: PaperFundingIo,
  ): Promise<PaperExecutionCommitReceipt>;
  read(
    request: PaperExecutionCommitRequest,
    io: PaperFundingIo,
  ): Promise<
    Readonly<{ kind: 'MISSING' } | { kind: 'COMMITTED'; receipt: PaperExecutionCommitReceipt }>
  >;
  close(): Promise<void>;
}
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function lookup(raw: unknown): PaperExecutionCommitRequest {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
    const proto = Object.getPrototypeOf(raw) as unknown;
    if (proto !== null && proto !== Object.prototype) fail();
    const fields = Reflect.ownKeys(raw);
    const allowed = [
      'kind',
      'executionKey',
      'preparationKey',
      'startKey',
      'admission',
      'authorization',
    ];
    if (
      fields.length !== allowed.length ||
      fields.some((f) => typeof f !== 'string' || !allowed.includes(f))
    )
      fail();
    const copy: Record<string, unknown> = {};
    for (const field of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, field);
      if (!descriptor?.enumerable || !('value' in descriptor)) fail();
      copy[field] = descriptor.value;
    }
    if (copy.kind !== 'PAPER_EXECUTION_COMMIT') fail();
    const executionKey = key.parse(copy.executionKey);
    delete copy.executionKey;
    copy.kind = 'PAPER_STARTED_RISK_CAPTURE';
    const checked = lookupPaperStartedRiskRequest(copy);
    return immutable({ ...checked, kind: 'PAPER_EXECUTION_COMMIT' as const, executionKey });
  } catch {
    fail('PAPER_ADMISSION_INPUT');
  }
}
function decode(raw: unknown, request: PaperExecutionCommitRequest) {
  try {
    const w = packet.parse(raw);
    if (!same(w.request, request) || w.evaluatedAt > Date.now()) fail();
    // Permanent replay is evaluated at the actual original transaction time,
    // never against replaced metadata. Current scope/epochs were checked by SQL.
    const { executionKey: _executionKey, ...selection } = request;
    void _executionKey;
    const storedRequest = lookupPaperStartedRiskRequest({
      ...selection,
      kind: 'PAPER_STARTED_RISK_CAPTURE',
      authorization: w.authorization,
    });
    const source = decodePaperStartedRiskWire(w.source, storedRequest, w.evaluatedAt);
    const captured = source.started.source;
    const value = calculatePaperStartedTransition(w.input);
    const input = z
      .object({
        now: timestampSchema,
        attempt: z.unknown(),
        frame: z.unknown(),
        portfolio: z.unknown(),
        reservation: z.object({ debits: z.unknown() }),
      })
      .parse(w.input);
    const frame = preparePaperFrame({
      now: w.evaluatedAt,
      model: captured.model,
      record: captured.market.record,
      book: captured.market.book,
      trade: captured.market.trade,
    });
    if (
      input.now !== w.evaluatedAt ||
      !same(input.attempt, source.started.journal.state) ||
      !same(input.frame, frame) ||
      !same(input.portfolio, captured.portfolio) ||
      !same(input.reservation.debits, captured.candidates[0]!.debits)
    )
      fail();
    const execution = value.execution.calculation.ledger.execution.executions[0]!;
    const expected = {
      execution: {
        status: execution.status,
        reason: execution.reason,
        eligibleAfter: execution.eligibleAfter,
        triggeredAt: execution.triggeredAt,
        quantity: execution.quantity,
        fills: execution.fills,
        frame: value.execution.calculation.ledger.execution.frame,
      },
      order: value.order,
      reservation: value.reservation,
      fills: value.execution.calculation.fills,
      holdChanges: value.holdChanges,
      state: value.state,
    };
    const r = w.receipt;
    if (
      !same(w.effects, expected) ||
      r.executionKey !== request.executionKey ||
      r.attemptId !== value.execution.attemptId ||
      r.orderId !== request.admission.orderId ||
      r.intentId !== request.admission.intentId ||
      r.reservationId !== value.reservation.id ||
      !same(r.order, {
        status: value.order.status,
        executedQuantity: value.order.executedQuantity,
        remainingQuantity: value.order.remainingQuantity,
      }) ||
      !same(r.reservation, {
        status: value.reservation.status,
        revision: value.reservation.revision,
      }) ||
      r.fillIds.length !== value.execution.calculation.fills.length ||
      r.ledgerTransactionIds.length !== r.fillIds.length ||
      new Set([...r.fillIds, ...r.ledgerTransactionIds, r.executionId]).size !==
        r.fillIds.length * 2 + 1
    )
      fail();
    return immutable(r);
  } catch {
    fail();
  }
}

/** Server-only pristine native-START financial writer. One fixed bounded
 * transaction; no supplied projection, callback, Risk grant or automatic retry.
 * Public financial dispatch remains disabled. Ambiguous COMMIT is reconciled
 * explicitly with read(), which never executes another monetary transition. */
export async function createPostgresPaperExecutionCommitter(
  options: unknown,
): Promise<PaperExecutionCommitter> {
  const database = await openPaperAdmissionDatabase(options);
  async function run(raw: PaperExecutionCommitRequest, io: PaperFundingIo, read: boolean) {
    const request = lookup(raw);
    return database.transaction(request.admission.binding.tenantId, io, async (sql) => {
      const rows = await sql.query<{ result: unknown }>(
        read
          ? 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result'
          : 'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
        [canonical(request)],
      );
      if (rows.rows.length !== 1) fail();
      const raw = rows.rows[0]!.result;
      if (read) {
        const missing = z
          .strictObject({ kind: z.literal('MISSING'), request: z.unknown() })
          .safeParse(raw);
        if (missing.success) {
          if (!same(missing.data.request, request)) fail();
          return immutable({ kind: 'MISSING' as const });
        }
      }
      return immutable({ kind: 'COMMITTED' as const, receipt: decode(raw, request) });
    });
  }
  return Object.freeze({
    async execute(request: PaperExecutionCommitRequest, io: PaperFundingIo) {
      const result = await run(request, io, false);
      if (result.kind !== 'COMMITTED') fail();
      return result.receipt;
    },
    read: (request: PaperExecutionCommitRequest, io: PaperFundingIo) => run(request, io, true),
    close: database.close,
  });
}
