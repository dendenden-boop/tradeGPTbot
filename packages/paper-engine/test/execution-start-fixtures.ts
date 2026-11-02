import {
  preparePaperExecutionAttempt,
  reducePaperExecutionAttempt,
} from '../src/execution-attempt.js';
import {
  preparedSourceFixture,
  preparedSourceId as id,
} from './prepared-execution-source-fixtures.js';
import { wireHash, wireNow } from './admission-wire-fixtures.js';

/** Wire content only; these hashes do not establish Risk/storage authority. */
export function executionStartFixture() {
  const f = preparedSourceFixture();
  const request = { ...f.request, kind: 'PAPER_EXECUTION_START', startKey: 'start-permanent-1' };
  const semantic = {
    preparationKey: request.preparationKey,
    startKey: request.startKey,
    admission: request.admission,
  };
  const validation = {
    validatedAt: wireNow,
    validUntil: Math.min(wireNow + 1000, f.preparation.request.admission.expiresAt),
    sourceHash: '1'.repeat(64),
    policyHeads: [
      {
        scope: 'PLATFORM',
        tenantId: null,
        version: '9007199254740993',
        eventId: id(9701),
        limitsHash: '2'.repeat(64),
      },
      {
        scope: 'USER',
        tenantId: request.admission.binding.tenantId,
        version: '9007199254740994',
        eventId: id(9702),
        limitsHash: '3'.repeat(64),
      },
    ],
    book: {
      id: f.packet.portfolio.bookId,
      revision: f.packet.portfolio.revision,
      hash: f.packet.portfolio.hash,
    },
    metadata: {
      instrumentId: f.preparation.request.admission.dbInstrumentId,
      ruleId: f.preparation.request.admission.dbRuleId,
    },
    capability: { id: id(9703), hash: '4'.repeat(64) },
    authorization: request.authorization,
  };
  const receipt = {
    kind: 'PAPER_EXECUTION_START_RECEIPT',
    version: 'paper-pristine-start-v1',
    startKey: request.startKey,
    preparationKey: request.preparationKey,
    attemptId: f.preparation.request.attemptId,
    eventId: id(9704),
    startedAt: wireNow,
    requestHash: wireHash(semantic),
    preparationHash: wireHash(f.preparation),
    validation,
    validationHash: wireHash(validation),
  };
  const started = reducePaperExecutionAttempt({
    state: f.preparation,
    event: { kind: 'START', id: receipt.eventId, expectedRevision: '1', at: receipt.startedAt },
  }).state;
  const packet = {
    kind: 'STARTED',
    request,
    preparation: f.preparation,
    receipt,
    state: started,
    unknown: null as unknown,
  };
  const cause = {
    eventId: id(9705),
    reservationId: f.preparation.request.admission.reservationId,
    orderId: request.admission.orderId,
    intentId: request.admission.intentId,
    decisionId: f.preparation.request.admission.decisionId,
    revision: '2',
    observedAt: wireNow + 1,
    bookId: validation.book.id,
    bookRevision: String(BigInt(validation.book.revision) + 1n),
    bookHash: '5'.repeat(64),
  };
  const unknown = reducePaperExecutionAttempt({
    state: started,
    event: {
      kind: 'UNKNOWN',
      id: cause.eventId,
      expectedRevision: '2',
      at: cause.observedAt,
      reason: 'AFTER_START',
    },
  }).state;
  return {
    ...f,
    request,
    semantic,
    receipt,
    started,
    packet,
    cause,
    unknown,
    preparePaperExecutionAttempt,
  };
}
