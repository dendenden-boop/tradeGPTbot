import { randomUUID } from 'node:crypto';
import { calculatePaperStartedTransition } from '../src/started-transition.js';
import { preparePaperFrame } from '../src/model.js';
import type { PaperExecutionCommitRequest } from '../src/postgres-execution-commit.js';
import { startedPreviewFixture } from './started-preview-fixtures.js';
import { admissionWire, wireHash } from './admission-wire-fixtures.js';
export function executedBookFixture() {
  const f = startedPreviewFixture(),
    c = f.packet.started.capture,
    attempt = f.packet.started.journal.state,
    a = attempt.request.admission;
  const request: PaperExecutionCommitRequest = {
    ...f.request,
    kind: 'PAPER_EXECUTION_COMMIT',
    executionKey: 'first-execution',
  };
  const portfolio = JSON.parse(c.portfolio.stateText) as ReturnType<
    typeof admissionWire
  >['packet']['portfolio']['before'];
  const { model, record, book, trade } = admissionWire(a.admittedAt).packet.budget;
  const hold = portfolio.holds[0]!;
  const input = {
    now: f.now,
    attempt,
    frame: preparePaperFrame({
      now: f.now,
      model: c.model,
      record: c.market.record,
      book: c.market.book,
      trade: c.market.trade,
    }),
    portfolio,
    original: { now: a.admittedAt, model, record, book, trade },
    reservation: {
      id: a.reservationId,
      decisionId: a.decisionId,
      orderId: a.orderId,
      intentId: a.intentId,
      revision: '1',
      status: 'ACTIVE',
      debits: c.candidates[0]!.debits,
      watermarks: [
        {
          holdId: hold.id,
          timestamp: a.admittedAt,
          fingerprint: wireHash({ type: 'COMMITMENT', hold }),
          released: false,
          unknown: false,
        },
      ],
    },
  };
  const value = calculatePaperStartedTransition(input),
    e = value.execution.calculation.ledger.execution.executions[0]!;
  const effects = {
    execution: {
      status: e.status,
      reason: e.reason,
      eligibleAfter: e.eligibleAfter,
      triggeredAt: e.triggeredAt,
      quantity: e.quantity,
      fills: e.fills,
      frame: value.execution.calculation.ledger.execution.frame,
    },
    order: value.order,
    reservation: value.reservation,
    fills: value.execution.calculation.fills,
    holdChanges: value.holdChanges,
    state: value.state,
  };
  const receipt = {
    kind: 'PAPER_EXECUTION_COMMIT_RECEIPT',
    version: 'paper-pristine-execution-v1',
    executionKey: request.executionKey,
    executionId: randomUUID(),
    attemptId: attempt.request.attemptId,
    orderId: a.orderId,
    intentId: a.intentId,
    reservationId: a.reservationId,
    order: {
      status: value.order.status,
      executedQuantity: value.order.executedQuantity,
      remainingQuantity: value.order.remainingQuantity,
    },
    reservation: { status: value.reservation.status, revision: value.reservation.revision },
    fillIds: effects.fills.map(() => randomUUID()),
    ledgerTransactionIds: effects.fills.map(() => randomUUID()),
  };
  const packet = {
    kind: 'COMMITTED',
    request,
    authorization: f.request.authorization,
    evaluatedAt: f.now,
    source: f.packet,
    input,
    effects,
    receipt,
  };
  return { ...f, request, packet, receipt };
}
