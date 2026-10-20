import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import * as candidate from '../src/index.js';
import type { projectPaperRiskCommitments } from '../src/risk-commitments.js';
import { calculatePaperRiskBudget } from '../src/risk-budget.js';
import { journalInventoryFixture, addJournalAccount } from './journal-inventory-fixtures.js';
import { fixture as marketFixture } from './fixtures.js';
import { fixture as policyFixture } from '../../risk-engine/test/fixtures.js';

type Fixture = ReturnType<typeof journalInventoryFixture>;
type Commitment = ReturnType<typeof projectPaperRiskCommitments>;
type Projection = Pick<
  Commitment,
  'reservations' | 'holds' | 'balances' | 'validUntil' | 'asOf'
> & {
  kind: string;
  accountIds: readonly string[];
};
// A missing export is an executable product RED, rather than a TS/import error.
const project = (raw: unknown) => {
  const fn = (candidate as Record<string, unknown>).projectPaperRiskJournalInventory;
  expect(fn, 'PAPER current journal inventory projection is required').toBeTypeOf('function');
  return (fn as (raw: unknown) => Projection)(raw);
};
it('derives UNKNOWN from the full journal while the immutable public parent stays ACTIVE, including after expiry', () => {
  const f = journalInventoryFixture(),
    before = JSON.stringify(f),
    result = project(f);
  expect(result.kind).toBe('PAPER_JOURNAL_INVENTORY_PROJECTION');
  expect(result.reservations).toMatchObject([
    { unknown: true, id: f.accounts[0]!.reservations[0]!.parent.id, notional: '8' },
  ]);
  expect(result.holds).toHaveLength(2);
  expect(result.holds.every((h: { unknown: boolean }) => h.unknown)).toBe(true);
  expect(result.balances.map((b: { available: string }) => b.available)).toEqual(['2', '1000']);
  expect(result.validUntil).toBe(f.asOf + 5001);
  expect(JSON.stringify(f)).toBe(before);
  expect(project(JSON.parse(before))).toEqual(result);
  expect(Object.isFrozen(result.reservations[0]!.debits)).toBe(true);
  for (const field of [
    'complete',
    'certificate',
    'grant',
    'permit',
    'approve',
    'positions',
    'orders',
  ])
    expect(result).not.toHaveProperty(field);
});
it('charges journal UNKNOWN and its two Portfolio holds exactly once in common vector budgets', () => {
  const f = journalInventoryFixture(),
    p = project(f),
    m = marketFixture(),
    limits = {
      ...policyFixture().platform,
      maxOrderNotional: '10000',
      maxInstrumentExposure: '10000',
      maxAssetExposure: '10000',
      maxAccountExposure: '10000',
      maxUserExposure: '10000',
    };
  const { execution, ...market } = m;
  const result = calculatePaperRiskBudget({
    ...market,
    order: execution.order,
    owner: f.owner,
    target: { orderId: randomUUID(), intentId: randomUUID() },
    platform: limits,
    user: limits,
    fx: {
      from: 'USDT',
      to: 'USDT',
      kind: 'IDENTITY',
      rate: '1',
      sourceId: 'identity',
      asOf: f.asOf,
    },
    evidence: {
      scope: { tenantId: f.owner.tenantId, mode: 'PAPER', valuationAsset: 'USDT' },
      asOf: p.asOf,
      complete: true,
      accountIds: p.accountIds,
      positions: [],
      orders: [],
      reservations: p.reservations,
      holds: p.holds,
      balances: p.balances,
    },
  });
  expect(result.current.user).toBe('8');
  expect(result.orders.current).toBe(1);
  expect(result.coverage.debits[0]!.available).toBe('999.5');
});
const changes: [string, (f: Fixture) => void][] = [
  [
    'omitted UNKNOWN tail with original current head',
    (f) => {
      f.accounts[0]!.reservations[0]!.history.pop();
    },
  ],
  [
    'old ACTIVE receipt substituted for full history',
    (f) => {
      f.accounts[0]!.reservations[0]!.history.splice(1);
    },
  ],
  [
    'missing explicit first state',
    (f) => {
      f.accounts[0]!.reservations[0]!.history.shift();
    },
  ],
  [
    'missing current head',
    (f) => {
      Object.assign(f.accounts[0]!.reservations[0]!, { head: null });
    },
  ],
  [
    'conflicting current head',
    (f) => {
      f.accounts[0]!.reservations[0]!.head.eventId = randomUUID();
    },
  ],
  [
    'head revision regression',
    (f) => {
      f.accounts[0]!.reservations[0]!.head.revision = '1';
    },
  ],
  [
    'reordered events',
    (f) => {
      f.accounts[0]!.reservations[0]!.history.reverse();
    },
  ],
  [
    'duplicate event identity',
    (f) => {
      const r = f.accounts[0]!.reservations[0]!;
      r.history[1]!.eventId = r.history[0]!.eventId;
      r.head.eventId = r.history[0]!.eventId;
    },
  ],
  [
    'equal observed time',
    (f) => {
      const h = f.accounts[0]!.reservations[0]!.history;
      h[1]!.observedAt = h[0]!.observedAt;
    },
  ],
  [
    'regressed observed time',
    (f) => {
      const h = f.accounts[0]!.reservations[0]!.history;
      h[1]!.observedAt = String(BigInt(h[0]!.observedAt) - 1n);
    },
  ],
  [
    'future event',
    (f) => {
      f.accounts[0]!.reservations[0]!.history[1]!.observedAt = String(f.asOf + 1);
    },
  ],
  [
    'first event before parent',
    (f) => {
      f.accounts[0]!.reservations[0]!.parent.createdAt = String(f.asOf);
    },
  ],
  [
    'UNKNOWN weakened to ACTIVE',
    (f) => {
      f.accounts[0]!.reservations[0]!.history[1]!.status = 'ACTIVE';
    },
  ],
  [
    'release without accepted causal contract',
    (f) => {
      f.accounts[0]!.reservations[0]!.history[1]!.status = 'RELEASED';
    },
  ],
  [
    'third event not supported by conservative journal',
    (f) => {
      const r = f.accounts[0]!.reservations[0]!;
      r.history.push({ ...r.history[1]!, eventId: randomUUID(), revision: '3' });
    },
  ],
  [
    'empty history',
    (f) => {
      f.accounts[0]!.reservations[0]!.history = [];
    },
  ],
  [
    'legacy scalar parent',
    (f) => {
      f.accounts[0]!.reservations[0]!.parent.paperLegacy = true;
    },
  ],
  [
    'wrong vector size',
    (f) => {
      f.accounts[0]!.reservations[0]!.parent.vectorSize = 1;
    },
  ],
  [
    'duplicate debit ordinal',
    (f) => {
      f.accounts[0]!.reservations[0]!.debits[1]!.ordinal = 1;
    },
  ],
  [
    'reordered debit vector',
    (f) => {
      f.accounts[0]!.reservations[0]!.debits.reverse();
    },
  ],
  [
    'native scalar silently carried over',
    (f) => {
      Object.assign(f.accounts[0]!.reservations[0]!.parent, { amount: '1' });
    },
  ],
  [
    'mutable parent lifecycle used as latest state',
    (f) => {
      f.accounts[0]!.reservations[0]!.parent.status = 'UNKNOWN';
    },
  ],
  [
    'parent version used as journal revision',
    (f) => {
      f.accounts[0]!.reservations[0]!.parent.version = 2;
    },
  ],
  [
    'consumption without execution proof',
    (f) => {
      f.accounts[0]!.reservations[0]!.parent.consumedAmount = '0.1';
    },
  ],
  [
    'missing hold for one vector leg',
    (f) => {
      f.accounts[0]!.holdProofs.pop();
    },
  ],
  [
    'no latest Portfolio proof',
    (f) => {
      f.accounts[0]!.holdProofs = [];
    },
  ],
  [
    'no book holds while journal retains UNKNOWN',
    (f) => {
      f.accounts[0]!.state.holds = [];
    },
  ],
  [
    'journal status and actual hold disagree',
    (f) => {
      Object.assign(f.accounts[0]!.state.holds[0]!, { status: 'RESERVED' });
    },
  ],
  [
    'unknown property grants completeness',
    (f) => {
      Object.assign(f, { complete: true });
    },
  ],
  [
    'missing account from declared catalog',
    (f) => {
      f.accounts = [];
    },
  ],
  [
    'unlisted account',
    (f) => {
      f.accountIds = [randomUUID()];
    },
  ],
  [
    'duplicate account',
    (f) => {
      f.accounts.push(structuredClone(f.accounts[0]!));
      f.accountIds.push(f.owner.accountId);
    },
  ],
  [
    'wrong tenant',
    (f) => {
      f.accounts[0]!.owner = { ...f.owner, tenantId: randomUUID() };
    },
  ],
  [
    'target absent from catalog',
    (f) => {
      f.owner = { ...f.owner, accountId: randomUUID() };
    },
  ],
  [
    'new enclosing time renews stale book',
    (f) => {
      f.now += 5001;
      f.asOf = f.now;
    },
  ],
  [
    'future enclosing capture',
    (f) => {
      f.asOf++;
    },
  ],
  [
    'book captured after enclosing transaction',
    (f) => {
      f.accounts[0]!.asOf++;
    },
  ],
  [
    'contradictory valuation asset',
    (f) => {
      f.valuationAsset = 'USD';
    },
  ],
  [
    'cross-account reuse of reservation identity',
    (f) => {
      addJournalAccount(f).reservations[0]!.parent.id = f.accounts[0]!.reservations[0]!.parent.id;
    },
  ],
  [
    'cross-account reuse of intent identity',
    (f) => {
      addJournalAccount(f).reservations[0]!.parent.intentId =
        f.accounts[0]!.reservations[0]!.parent.intentId;
    },
  ],
  [
    'cross-account reuse of decision identity',
    (f) => {
      addJournalAccount(f).reservations[0]!.parent.decisionId =
        f.accounts[0]!.reservations[0]!.parent.decisionId;
    },
  ],
  [
    'cross-account reuse of order identity',
    (f) => {
      addJournalAccount(f).reservations[0]!.allocation.orderId =
        f.accounts[0]!.reservations[0]!.allocation.orderId;
    },
  ],
  [
    'cross-account reuse of hold identity',
    (f) => {
      addJournalAccount(f).reservations[0]!.debits[0]!.holdId =
        f.accounts[0]!.reservations[0]!.debits[0]!.holdId;
    },
  ],
  [
    'cross-account reuse of event identity',
    (f) => {
      addJournalAccount(f).reservations[0]!.history[0]!.eventId =
        f.accounts[0]!.reservations[0]!.history[0]!.eventId;
    },
  ],
  [
    'two accounts sharing a book',
    (f) => {
      addJournalAccount(f).bookId = f.accounts[0]!.bookId;
    },
  ],
  [
    'same instrument with contradictory asset identity in sibling',
    (f) => {
      addJournalAccount(f).reservations[0]!.allocation.base = 'ETH';
    },
  ],
  [
    'more than 100 account captures',
    (f) => {
      for (let i = 0; i < 100; i++) addJournalAccount(f);
    },
  ],
  [
    'trailing newline in an otherwise valid SQL timestamp',
    (f) => {
      f.accounts[0]!.reservations[0]!.history[1]!.observedAt += '\n';
    },
  ],
  [
    'trailing newline in otherwise valid book revision',
    (f) => {
      f.accounts[0]!.revision += '\n';
    },
  ],
  [
    'malformed book revision before BigInt bound check',
    (f) => {
      f.accounts[0]!.revision = '1.5';
    },
  ],
];
it.each(changes)('fails closed for %s', (_name, change) => {
  const f = journalInventoryFixture();
  change(f);
  expect(() => project(f)).toThrow(/^PAPER_JOURNAL_INVENTORY_/u);
});
it.each(['tenantId', 'accountId', 'reservationId', 'intentId', 'mode', 'kind'] as const)(
  'rejects journal event scope mismatch in %s',
  (field) => {
    const f = journalInventoryFixture();
    Object.assign(f.accounts[0]!.reservations[0]!.history[1]!, {
      [field]: field === 'mode' ? 'TESTNET' : field === 'kind' ? 'OTHER' : randomUUID(),
    });
    expect(() => project(f)).toThrow(/^PAPER_JOURNAL_INVENTORY_/u);
  },
);
it.each(['1.5', '01', '9007199254740993', '9223372036854775808', '1e0', '1\n'])(
  'rejects malformed or out-of-contract journal revision %j without exposing BigInt conversion',
  (revision) => {
    const f = journalInventoryFixture();
    f.accounts[0]!.reservations[0]!.history[1]!.revision = revision;
    expect(() => project(f)).toThrow(/^PAPER_JOURNAL_INVENTORY_/u);
  },
);
it.each(['-1', '1.5', '01', '8640000000000001', '9007199254740993', '1e3', '100\n'])(
  'rejects invalid SQL millisecond timestamp %j',
  (stamp) => {
    const f = journalInventoryFixture();
    f.accounts[0]!.reservations[0]!.history[0]!.observedAt = stamp;
    expect(() => project(f)).toThrow(/^PAPER_JOURNAL_INVENTORY_/u);
  },
);
it('does not wrap, round or reorder adjacent timestamps at the accepted maximum', () => {
  const f = journalInventoryFixture(),
    offset = 8640000000000000 - f.now;
  f.now += offset;
  f.asOf += offset;
  f.accounts[0]!.asOf += offset;
  const r = f.accounts[0]!.reservations[0]!;
  r.parent.createdAt = String(BigInt(r.parent.createdAt) + BigInt(offset));
  r.parent.expiresAt = String(BigInt(r.parent.expiresAt) + BigInt(offset));
  for (const e of r.history) e.observedAt = String(BigInt(e.observedAt) + BigInt(offset));
  f.accounts[0]!.state.snapshotAt = f.asOf - 10000;
  f.accounts[0]!.state.holds = f.accounts[0]!.state.holds.map((h) => ({ ...h }));
  for (const p of f.accounts[0]!.holdProofs) {
    p.timestamp += offset;
    p.lastEvent.timestamp += offset;
  }
  // Freshness arithmetic must fail closed instead of returning an invalid deadline.
  expect(() => project(f)).toThrow(/^PAPER_JOURNAL_INVENTORY_/u);
});
it('merges 100 accounts without pooling cash, losing UNKNOWN or mutating original vectors', () => {
  const f = journalInventoryFixture();
  for (let i = 1; i < 100; i++) addJournalAccount(f);
  const before = JSON.stringify(f),
    p = project(f);
  expect(p.accountIds).toHaveLength(100);
  expect(p.reservations).toHaveLength(100);
  expect(p.holds).toHaveLength(200);
  expect(p.balances).toHaveLength(200);
  expect(p.reservations.every((r) => r.unknown)).toBe(true);
  expect(new Set(p.reservations.map((r) => r.id)).size).toBe(100);
  expect(JSON.stringify(f)).toBe(before);
  f.accounts.reverse();
  f.accountIds.reverse();
  expect(project(f)).toEqual(p);
});
it('retains the earliest sibling witness and lossless book revision rather than renewing it', () => {
  const f = journalInventoryFixture(),
    a = addJournalAccount(f);
  a.asOf -= 100;
  const r = a.reservations[0]!;
  r.parent.createdAt = String(BigInt(r.parent.createdAt) - 100n);
  for (const e of r.history) e.observedAt = String(BigInt(e.observedAt) - 100n);
  for (const p of a.holdProofs) {
    p.timestamp -= 100;
    p.lastEvent.timestamp -= 100;
  }
  const p = project(f);
  expect(p.asOf).toBe(f.asOf - 100);
  expect(p.validUntil).toBe(f.asOf + 4901);
  f.now = f.asOf + 4901;
  expect(() => project(f)).toThrow(/^PAPER_JOURNAL_INVENTORY_/u);
});
it('rejects oversized private capture with a sanitized error and no secret values', () => {
  const f = journalInventoryFixture();
  Object.assign(f.accounts[0]!.state, { secret: 'private-sentinel-' + 'x'.repeat(4194304) });
  try {
    project(f);
    throw Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('PAPER_JOURNAL_INVENTORY_CAPACITY');
    expect(JSON.stringify(error)).not.toContain('private-sentinel');
  }
});
it('does not turn a consistent JSON projection into accepted pristine source or Risk authority', () => {
  const f = journalInventoryFixture(),
    p = project(f);
  const result = candidate.calculatePaperRiskEvaluation({
    now: f.now,
    request: { owner: f.owner, intentId: randomUUID() },
    capture: p,
  });
  expect(result.result.kind).toBe('REJECTED');
  expect(result.sourceHash).toBeNull();
  for (const field of [
    'certificateId',
    'decisionId',
    'reservationId',
    'permissionEpoch',
    'expiresAt',
    'prepare',
    'approve',
  ])
    expect(p).not.toHaveProperty(field);
});
