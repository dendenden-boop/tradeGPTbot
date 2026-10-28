import { preparePaperExecutionAttempt } from '../src/execution-attempt.js';
import { executionSourceWire } from './execution-source-fixtures.js';
import { wireNow } from './admission-wire-fixtures.js';

export const preparedSourceId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function preparedSourceFixture(count = 1) {
  const f = executionSourceWire(count),
    c = f.packet.candidates[0]!;
  const request = {
    kind: 'PAPER_PREPARED_EXECUTION_CAPTURE',
    preparationKey: 'original-preparation-key',
    admission: f.request.admission,
    authorization: f.request.authorization,
  };
  const journalRequest = {
    kind: 'PAPER_ATTEMPT_PREPARE',
    key: request.preparationKey,
    admission: request.admission,
    authorization: request.authorization,
  };
  const preparation = preparePaperExecutionAttempt({
    attemptId: preparedSourceId(9001),
    preparedAt: wireNow - 1,
    admission: {
      binding: request.admission.binding,
      orderId: c.orderId,
      intentId: c.intentId,
      reservationId: c.reservationId,
      decisionId: c.decisionId,
      dbInstrumentId: c.dbInstrumentId,
      dbRuleId: c.dbRuleId,
      command: c.command,
      commandHash: c.commandHash,
      admissionSequence: c.admissionSequence,
      admittedAt: c.admittedAt,
      expiresAt: c.original.expiresAt,
    },
  });
  return {
    ...f,
    captureRequest: f.request,
    request,
    preparation,
    journal: {
      kind: 'COMMITTED',
      request: journalRequest,
      preparation,
      state: preparation,
      withdrawal: null,
    },
  };
}
