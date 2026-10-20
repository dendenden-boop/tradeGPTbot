import { randomUUID } from 'node:crypto';
import { commitmentFixture, proofFor } from './commitment-fixtures.js';

/** Content fixture only. No SQL provenance, issued decision or certificate. */
export function journalInventoryFixture() {
  const f = commitmentFixture(),
    old = f.reservations[0]!,
    decisionId = randomUUID();
  const ids = old.debits.map(() => randomUUID());
  const state = { ...f.state, holds: f.state.holds.map((h, i) => ({ ...h, id: ids[i]! })) };
  const holdProofs = f.holdProofs.map((p, i) => {
    if (p.lastEvent.type !== 'COMMITMENT') throw Error('fixture');
    const lastEvent = {
      ...p.lastEvent,
      id: randomUUID(),
      hold: { ...p.lastEvent.hold, id: ids[i]! },
    };
    return { ...p, holdId: ids[i]!, lastEvent, fingerprint: proofFor(lastEvent) };
  });
  const history = ['ACTIVE', 'UNKNOWN'].map((status, i) => ({
    kind: 'PAPER_RESERVATION_STATE_RECORD',
    ...f.owner,
    reservationId: old.id,
    intentId: old.intentId,
    eventId: randomUUID(),
    revision: String(i + 1),
    status,
    observedAt: String(old.updatedAt - 1 + i),
  }));
  return {
    now: f.now,
    asOf: f.asOf,
    maxEvidenceAgeMs: f.maxEvidenceAgeMs,
    owner: f.owner,
    valuationAsset: f.valuationAsset,
    accountIds: [f.owner.accountId],
    accounts: [
      {
        owner: f.owner,
        asOf: f.asOf,
        bookId: f.bookId,
        revision: f.revision,
        state,
        holdProofs,
        reservations: [
          {
            parent: {
              ...f.owner,
              id: old.id,
              decisionId,
              intentId: old.intentId,
              status: 'ACTIVE',
              version: 0,
              paperLegacy: false,
              vectorSize: 2,
              budgetId: null,
              asset: null,
              amount: null,
              consumedAmount: '0',
              releasedAt: null,
              createdAt: String(f.now - 100),
              expiresAt: String(f.now - 1),
            },
            allocation: {
              orderId: old.orderId,
              instrumentId: old.instrumentId,
              base: old.base,
              quote: old.quote,
              side: old.side,
              notional: old.notional,
              notionalAsset: old.notionalAsset,
            },
            debits: old.debits.map((d, i) => ({ ...d, ordinal: i + 1, holdId: ids[i]! })),
            head: { eventId: history[1]!.eventId, revision: '2' },
            history,
          },
        ],
      },
    ],
  };
}

export function addJournalAccount(f: ReturnType<typeof journalInventoryFixture>) {
  const a = journalInventoryFixture().accounts[0]!,
    accountId = randomUUID();
  a.owner = { ...f.owner, accountId };
  a.bookId = randomUUID();
  a.state.binding = { ...a.state.binding, ...a.owner, walletId: 'paper-initial:' + a.bookId };
  const r = a.reservations[0]!;
  r.parent.accountId = accountId;
  r.parent.id = randomUUID();
  r.parent.intentId = randomUUID();
  r.allocation.orderId = randomUUID();
  for (const e of r.history) {
    e.accountId = accountId;
    e.reservationId = r.parent.id;
    e.intentId = r.parent.intentId;
  }
  f.accounts.push(a);
  f.accountIds.push(accountId);
  return a;
}
