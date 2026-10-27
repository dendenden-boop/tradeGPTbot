import { canonical } from '@ctp/portfolio';
import { admissionWire, wireHash, wireNow } from './admission-wire-fixtures.js';

// Protocol content only; this fixture authenticates no SQL issuance or source.
export function executionSourceWire(count = 1) {
  const f = admissionWire(wireNow - 10),
    p = f.packet,
    b = p.budget;
  const request = {
    kind: 'PAPER_EXECUTION_CAPTURE',
    admission: f.expected,
    authorization: { permissionEpoch: p.permissionEpoch, userSessionEpoch: '0' },
  };
  const portfolio = JSON.parse(p.portfolio.afterText) as typeof p.portfolio.before;
  portfolio.holds = [];
  portfolio.balances[0]!.total =
    portfolio.balances[0]!.free =
    portfolio.balances[0]!.available =
      '1000000';
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const candidates = Array.from({ length: count }, (_, index) => {
    const command = { ...b.order, clientOrderId: String(index + 1) },
      orderId = index === 0 ? f.expected.orderId : id(100 + index),
      intentId = index === 0 ? f.expected.intentId : id(500 + index),
      debit = { ...p.debits[0]!, holdId: id(1000 + index) },
      commandHash = wireHash({ operation: 'createOrder', command, binding: f.expected.binding });
    portfolio.holds.push({
      id: debit.holdId,
      asset: debit.asset,
      amount: debit.amount,
      status: 'RESERVED',
      reflected: false,
    });
    return {
      orderId,
      intentId,
      reservationId: id(2000 + index),
      decisionId: id(3000 + index),
      commandHash,
      command,
      dbInstrumentId: id(4000),
      dbRuleId: id(4001),
      admissionSequence: (9007199254740993n + BigInt(index)).toString(),
      admittedAt: b.now,
      original: {
        certificateId: id(5000 + index),
        sourceHash: p.certificate.sourceHash,
        expiresAt: p.receipt.expiresAt,
        executionBounds: {
          minimum: p.policy.snapshot.market.lowerExecutionPrice,
          maximum: p.policy.snapshot.market.upperExecutionPrice,
          feeRate: b.model.takerFeeRate,
        },
      },
      debits: [debit],
    };
  });
  if (candidates[0]) request.admission.commandHash = candidates[0].commandHash;
  const age = b.model.maxEvidenceAgeMs;
  const packet = {
    kind: 'PAPER_EXECUTION_CAPTURE',
    request,
    asOf: wireNow,
    validUntil: b.now + age + 1,
    maxEvidenceAgeMs: age,
    configurationId: id(6000),
    fundingId: p.portfolio.bookId,
    model: b.model,
    portfolio: {
      bookId: p.portfolio.bookId,
      revision: '2',
      stateText: canonical(portfolio),
      hash: wireHash(portfolio),
    },
    market: {
      record: b.record,
      book: b.book,
      trade: b.trade,
      snapshotAt: b.now,
      tradeAt: b.now,
      dbInstrumentId: id(4000),
      dbRuleId: id(4001),
      snapshot: { id: id(7000), revision: '1', hash: 'a'.repeat(64) },
      tradeReference: { id: id(7001), revision: '1', hash: 'b'.repeat(64) },
    },
    candidates,
  };
  return { request, packet, portfolio };
}
