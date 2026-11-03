import { preparePaperExecutionAttempt } from '../src/execution-attempt.js';
import { executionStartFixture } from './execution-start-fixtures.js';
import { preparedSourceFixture, preparedSourceId } from './prepared-execution-source-fixtures.js';
import { wireNow } from './admission-wire-fixtures.js';
import { executionRiskFixture } from './execution-risk-fixtures.js';

// Wire content only. Authenticity must come from the fixed private SQL reader.
export function startedSourceFixture(count = 1) {
  const started = executionStartFixture(),
    source = preparedSourceFixture(count);
  const request = { ...started.request, kind: 'PAPER_STARTED_EXECUTION_CAPTURE' as const };
  const capture = structuredClone(source.packet);
  const { publication, ...runtime } = executionRiskFixture(count).packet.runtime;
  void publication;
  const context = { ...runtime, kind: 'PAPER_RUNTIME_CONTEXT' };
  if (count > 1) capture.portfolio.revision = '3';
  const entries = capture.candidates.map((c, n) => {
    const preparation =
      n === 0
        ? started.preparation
        : preparePaperExecutionAttempt({
            attemptId: preparedSourceId(9800 + n),
            preparedAt: wireNow - 1,
            admission: {
              binding: request.admission.binding,
              orderId: c.orderId,
              intentId: c.intentId,
              decisionId: c.decisionId,
              reservationId: c.reservationId,
              dbInstrumentId: c.dbInstrumentId,
              dbRuleId: c.dbRuleId,
              command: c.command,
              commandHash: c.commandHash,
              admissionSequence: c.admissionSequence,
              admittedAt: c.admittedAt,
              expiresAt: c.original.expiresAt,
            },
          });
    return n === 0
      ? {
          kind: 'STARTED',
          intentId: c.intentId,
          key: request.preparationKey,
          preparation,
          state: started.started,
        }
      : { kind: 'PREPARED', intentId: c.intentId, key: 'queued-' + n, preparation };
  });
  return {
    ...started,
    request,
    packet: {
      kind: 'PAPER_STARTED_EXECUTION_CAPTURE',
      request,
      asOf: wireNow + 1,
      validUntil: Math.min(
        capture.validUntil,
        ...capture.candidates.map((c) => c.original.expiresAt),
      ),
      capture,
      context,
      journal: { ...started.packet, kind: 'COMMITTED' },
      entries,
    },
  };
}
