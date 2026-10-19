import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonical, reducePortfolio, type PortfolioEvent } from '@ctp/portfolio';
import {
  projectPaperRiskCommitments,
  calculatePaperRiskBudget,
  calculatePaperRiskEvaluation,
} from '../src/index.js';
import { commitmentFixture, proofFor } from './commitment-fixtures.js';
import { fixture as marketFixture } from './fixtures.js';
import { fixture as policyFixture } from '../../risk-engine/test/fixtures.js';

it('projects UNKNOWN full-vector commitments exactly once without deducting gross ledger balances', () => {
  const f = commitmentFixture(),
    before = JSON.stringify(f),
    r = projectPaperRiskCommitments(f);
  expect(r).toMatchObject({
    kind: 'PAPER_COMMITMENT_PROJECTION',
    bookId: f.bookId,
    revision: '9007199254740993',
    asOf: f.asOf,
    validUntil: f.asOf + 5001,
    owner: f.owner,
    balances: [
      { accountId: f.owner.accountId, asset: 'BTC', available: '2' },
      { accountId: f.owner.accountId, asset: 'USDT', available: '1000' },
    ],
    reservations: [{ id: f.reservations[0]!.id, unknown: true, notional: '8' }],
    holds: [
      { id: 'hold-0', unknown: true, reflected: false },
      { id: 'hold-1', unknown: true, reflected: false },
    ],
  });
  expect(r.reservations).toHaveLength(1);
  expect(r.holds).toHaveLength(2);
  expect(JSON.stringify(f)).toBe(before);
  expect(Object.isFrozen(r.holds)).toBe(true);
  expect(Object.isFrozen(r.reservations[0]!.debits)).toBe(true);
  for (const key of ['complete', 'certificateId', 'decisionId', 'grant', 'permit', 'approve'])
    expect(key in r).toBe(false);
});
it('reconstructs the same content after JSON restart without state or fingerprint authority', () => {
  const f = commitmentFixture();
  expect(projectPaperRiskCommitments(JSON.parse(JSON.stringify(f)))).toEqual(
    projectPaperRiskCommitments(f),
  );
});
it('composes with the accepted budget using one liability and two monetary holds', () => {
  const f = commitmentFixture(),
    r = projectPaperRiskCommitments(f),
    m = marketFixture(),
    limits = {
      ...policyFixture().platform,
      maxOrderNotional: '10000',
      maxInstrumentExposure: '10000',
      maxAssetExposure: '10000',
      maxAccountExposure: '10000',
      maxUserExposure: '10000',
    },
    old = r.reservations[0]!;
  const out = calculatePaperRiskBudget({
    now: m.now,
    model: m.model,
    record: m.record,
    book: m.book,
    trade: m.trade,
    order: m.execution.order,
    owner: f.owner,
    target: {
      orderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      intentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    },
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
      asOf: r.asOf,
      complete: true,
      accountIds: [f.owner.accountId],
      positions: [],
      orders: [
        {
          id: old.orderId,
          intentId: old.intentId,
          accountId: old.accountId,
          instrumentId: old.instrumentId,
          base: old.base,
          quote: old.quote,
          side: old.side,
          status: 'UNKNOWN',
          notional: '9',
        },
      ],
      reservations: r.reservations,
      holds: r.holds,
      balances: r.balances,
    },
  });
  expect(out.current.user).toBe('9');
  expect(out.orders.current).toBe(1);
  expect(out.coverage.debits[0]!.available).toBe('999.5');
});
function releaseFixture() {
  const f = commitmentFixture();
  f.now++;
  f.asOf++;
  f.revision = '9007199254740994';
  f.reservations[0]!.status = 'RELEASED';
  f.reservations[0]!.updatedAt = f.now;
  const postings = [];
  for (const p of f.holdProofs) {
    const lastEvent: PortfolioEvent = {
      type: 'RELEASE',
      id: 'release-' + p.holdId,
      timestamp: f.now,
      holdId: p.holdId,
      resolved: true,
    };
    const out = reducePortfolio(f.state, lastEvent, { now: () => f.now, holdWatermark: p });
    f.state = out.state;
    postings.push(...out.postings);
    if (!out.holdWatermark) throw Error('fixture release');
    Object.assign(p, out.holdWatermark, { lastEvent });
  }
  return { f, postings };
}
it('definitive release projects no liability, preserves tombstones and has no second monetary posting', () => {
  const { f, postings } = releaseFixture(),
    r = projectPaperRiskCommitments(f);
  expect(r.reservations).toEqual([]);
  expect(r.holds).toEqual([]);
  expect(postings).toEqual([]);
  expect(r.balances.map((b) => b.available)).toEqual(['2', '1000']);
  expect(projectPaperRiskCommitments(JSON.parse(JSON.stringify(f)))).toEqual(r);
});
it('old COMMITMENT after a released watermark cannot resurrect a hold after restart', () => {
  const old = commitmentFixture(),
    { f } = releaseFixture(),
    restored = JSON.parse(JSON.stringify(f)) as typeof f;
  for (const p of restored.holdProofs) {
    const event = old.holdProofs.find((v) => v.holdId === p.holdId)!.lastEvent;
    const out = reducePortfolio(restored.state, event, {
      now: () => restored.now,
      holdWatermark: p,
    });
    expect(out.ignored).toBe(true);
    restored.state = out.state;
  }
  expect(projectPaperRiskCommitments(restored).holds).toEqual([]);
});
it.each(['PENDING', 'RESERVED'] as const)(
  'projects an ACTIVE %s vector without treating holds as monetary postings',
  (status) => {
    const f = commitmentFixture();
    f.reservations[0]!.status = 'ACTIVE';
    for (const p of f.holdProofs) {
      const h = f.state.holds.find((h) => h.id === p.holdId)!;
      h.status = status;
      p.unknown = false;
      p.lastEvent = {
        type: 'COMMITMENT',
        id: p.lastEvent.id,
        timestamp: p.timestamp,
        hold: { ...h },
      };
      p.fingerprint = proofFor(p.lastEvent);
    }
    expect(projectPaperRiskCommitments(f).reservations[0]!.unknown).toBe(false);
  },
);
it('only a matching persisted RESOLVE_COMMITMENT can describe a smaller resolved vector', () => {
  const f = commitmentFixture();
  f.now++;
  f.asOf++;
  f.reservations[0]!.status = 'ACTIVE';
  f.reservations[0]!.updatedAt = f.now;
  for (const [i, p] of f.holdProofs.entries()) {
    const h = f.state.holds.find((h) => h.id === p.holdId)!,
      event: PortfolioEvent = {
        type: 'RESOLVE_COMMITMENT',
        id: 'resolution-' + i,
        timestamp: f.now,
        hold: { ...h, status: 'RESERVED', amount: '0.4' },
        proofId: 'proof-' + i,
        proofHash: 'a'.repeat(64),
      };
    const out = reducePortfolio(f.state, event, {
      now: () => f.now,
      holdWatermark: p,
      resolutionEvidence: { eventId: event.id, fingerprint: proofForFull(event) },
    });
    f.state = out.state;
    if (!out.holdWatermark) throw Error('fixture resolve');
    Object.assign(p, out.holdWatermark, { lastEvent: event });
    f.reservations[0]!.debits[i]!.amount = '0.4';
  }
  expect(projectPaperRiskCommitments(f).holds.map((h) => h.amount)).toEqual(['0.4', '0.4']);
});
function proofForFull(event: PortfolioEvent) {
  return createHash('sha256').update(canonical(event)).digest('hex');
}

it.each([
  'missing hold',
  'missing watermark',
  'orphan hold',
  'orphan proof',
  'shared hold',
  'wrong amount',
  'wrong asset',
  'wrong fingerprint',
  'wrong event time',
  'wrong row time',
  'future row',
  'future proof',
  'released live',
  'unknown weakened',
  'unknown row weakened',
  'wrong event payload',
])('rejects inconsistent retained vector: %s', (kind) => {
  const f = commitmentFixture(),
    p = f.holdProofs[0]!,
    r = f.reservations[0]!;
  if (kind === 'missing hold') f.state.holds.shift();
  if (kind === 'missing watermark') f.holdProofs.shift();
  if (kind === 'orphan hold') f.state.holds.push({ ...f.state.holds[0]!, id: 'orphan' });
  if (kind === 'orphan proof') f.holdProofs.push({ ...p, holdId: 'orphan' });
  if (kind === 'shared hold') r.debits[1]!.holdId = r.debits[0]!.holdId;
  if (kind === 'wrong amount') r.debits[0]!.amount = '0.499999999999999999';
  if (kind === 'wrong asset') r.debits[0]!.asset = 'ETH';
  if (kind === 'wrong fingerprint') p.fingerprint = 'a'.repeat(64);
  if (kind === 'wrong event time') p.lastEvent.timestamp--;
  if (kind === 'wrong row time') r.updatedAt--;
  if (kind === 'future row') r.updatedAt = f.now + 1;
  if (kind === 'future proof') p.timestamp = f.now + 1;
  if (kind === 'released live') p.released = true;
  if (kind === 'unknown weakened') f.state.holds[0]!.status = 'RESERVED';
  if (kind === 'unknown row weakened') r.status = 'ACTIVE';
  if (kind === 'wrong event payload' && p.lastEvent.type === 'COMMITMENT')
    p.lastEvent.hold.amount = '0.4';
  expect(() => projectPaperRiskCommitments(f)).toThrow(/^PAPER_COMMITMENT_/u);
});
it.each(['missing tombstone', 'stale commitment', 'live resurrection', 'unresolved release'])(
  'rejects invalid released history: %s',
  (kind) => {
    const old = commitmentFixture(),
      { f } = releaseFixture();
    if (kind === 'missing tombstone') f.holdProofs.pop();
    if (kind === 'stale commitment') f.holdProofs[0] = old.holdProofs[0]!;
    if (kind === 'live resurrection') f.state.holds.push(old.state.holds[0]!);
    if (kind === 'unresolved release') {
      const p = f.holdProofs[0]!;
      if (p.lastEvent.type === 'RELEASE') p.lastEvent.resolved = false;
      p.fingerprint = proofFor(p.lastEvent);
    }
    expect(() => projectPaperRiskCommitments(f)).toThrow(/^PAPER_COMMITMENT_/u);
  },
);
it.each([
  'tenant',
  'account',
  'native mode',
  'derivatives',
  'wallet',
  'gap',
  'pending',
  'difference',
  'missing snapshot',
  'future snapshot',
  'future economic',
  'negative',
  'null cash',
  'native locked',
  'reflected credit',
  'oversubscribed',
])('fails closed at Portfolio boundary: %s', (kind) => {
  const f = commitmentFixture(),
    b = f.state.balances[0]!;
  if (kind === 'tenant') f.owner.tenantId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  if (kind === 'account') f.owner.accountId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  if (kind === 'native mode') f.state.binding.mode = 'TESTNET';
  if (kind === 'derivatives')
    f.state.binding.scope = { ...f.state.binding.scope, market: 'LINEAR_PERPETUAL' };
  if (kind === 'wallet') f.state.binding.walletId = 'wrong';
  if (kind === 'gap') f.state.status = 'GAP';
  if (kind === 'pending') f.state.pending = ['fill'];
  if (kind === 'difference') f.state.differences = ['mismatch'];
  if (kind === 'missing snapshot') f.state.snapshotAt = null;
  if (kind === 'future snapshot') f.state.snapshotAt = f.now + 1;
  if (kind === 'future economic') f.state.lastEconomicAt = f.now + 1;
  if (kind === 'negative') b.total = b.free = b.available = '-1';
  if (kind === 'null cash') b.available = null;
  if (kind === 'native locked') {
    b.locked = '1';
    b.free = '1';
  }
  if (kind === 'reflected credit') {
    const p = f.holdProofs[0]!;
    f.state.holds[0]!.reflected = true;
    if (p.lastEvent.type === 'COMMITMENT') p.lastEvent.hold.reflected = true;
    p.fingerprint = proofFor(p.lastEvent);
  }
  if (kind === 'oversubscribed') b.total = b.free = b.available = '0.499999999999999999';
  expect(() => projectPaperRiskCommitments(f)).toThrow(/^PAPER_COMMITMENT_/u);
});
it.each(['reservation', 'order', 'intent', 'hold proof', 'balance'])(
  'rejects duplicate %s identities',
  (kind) => {
    const f = commitmentFixture();
    if (kind === 'hold proof') f.holdProofs.push(structuredClone(f.holdProofs[0]!));
    else if (kind === 'balance') f.state.balances.push(structuredClone(f.state.balances[0]!));
    else {
      const r = structuredClone(f.reservations[0]!);
      if (kind !== 'reservation') r.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      if (kind === 'intent') r.orderId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      f.reservations.push(r);
    }
    expect(() => projectPaperRiskCommitments(f)).toThrow(/^PAPER_COMMITMENT_/u);
  },
);
it('uses the original capture deadline and never expires an old UNKNOWN liability by age', () => {
  const f = commitmentFixture();
  f.now += 100;
  f.maxEvidenceAgeMs = 100;
  expect(projectPaperRiskCommitments(f).validUntil).toBe(f.now + 1);
  f.now++;
  expect(() => projectPaperRiskCommitments(f)).toThrow('PAPER_COMMITMENT_STALE');
});
it('preserves a final decimal atom above Number precision', () => {
  const f = commitmentFixture();
  f.state.balances[1]!.total =
    f.state.balances[1]!.free =
    f.state.balances[1]!.available =
      '9007199254740993.000000000000000001';
  expect(projectPaperRiskCommitments(f).balances[1]!.available).toBe(
    '9007199254740993.000000000000000001',
  );
});
it.each(['root', 'reservation', 'proof', 'debit'])(
  'rejects caller authority overrides at %s',
  (kind) => {
    const f = commitmentFixture();
    const raw =
      kind === 'root'
        ? { ...f, certificateId: 'fake' }
        : kind === 'reservation'
          ? { ...f, reservations: [{ ...f.reservations[0], grant: 'fake' }] }
          : kind === 'proof'
            ? { ...f, holdProofs: [{ ...f.holdProofs[0], trusted: true }] }
            : {
                ...f,
                reservations: [
                  {
                    ...f.reservations[0],
                    debits: [{ ...f.reservations[0]!.debits[0], credit: '1' }],
                  },
                ],
              };
    expect(() => projectPaperRiskCommitments(raw)).toThrow('PAPER_COMMITMENT_INPUT');
  },
);
it.each([
  'future capture',
  'zero revision',
  'unsafe revision',
  'negative revision',
  'too old',
  'zero debit',
  'invalid status',
  'missing fee vector',
  'wrong base',
  'duplicate asset',
  'too many rows',
  'invalid event',
])('rejects malformed or conflicting content: %s', (kind) => {
  const f = commitmentFixture();
  let raw: unknown = f;
  if (kind === 'future capture') f.asOf++;
  if (kind === 'zero revision') f.revision = '0';
  if (kind === 'unsafe revision') f.revision = '9223372036854775808';
  if (kind === 'negative revision') f.revision = '-1';
  if (kind === 'too old') f.asOf -= 5001;
  if (kind === 'zero debit') f.reservations[0]!.debits[0]!.amount = '0';
  if (kind === 'invalid status')
    raw = { ...f, reservations: [{ ...f.reservations[0], status: 'ACK' }] };
  if (kind === 'missing fee vector') f.reservations[0]!.debits.pop();
  if (kind === 'wrong base') f.reservations[0]!.base = 'ETH';
  if (kind === 'duplicate asset') f.reservations[0]!.debits[1]!.asset = 'BTC';
  if (kind === 'too many rows')
    f.reservations = Array.from({ length: 1001 }, () => structuredClone(f.reservations[0]!));
  if (kind === 'invalid event')
    raw = {
      ...f,
      holdProofs: [{ ...f.holdProofs[0], lastEvent: { type: 'GAP', id: 'gap', timestamp: f.now } }],
    };
  expect(() => projectPaperRiskCommitments(raw)).toThrow(/^PAPER_COMMITMENT_/u);
});

it('exports a pure full-vector Portfolio commitment projection', () => {
  expect(projectPaperRiskCommitments).toBeTypeOf('function');
});

it('normalizes row order without changing any captured input', () => {
  const f = commitmentFixture(),
    expected = projectPaperRiskCommitments(f);
  f.state.balances.reverse();
  f.state.holds.reverse();
  f.holdProofs.reverse();
  f.reservations[0]!.debits.reverse();
  const before = JSON.stringify(f);
  expect(projectPaperRiskCommitments(f)).toEqual(expected);
  expect(JSON.stringify(f)).toBe(before);
});
it.each(['BUY', 'SELL'] as const)('accepts a proved single-asset %s allocation', (side) => {
  const f = commitmentFixture(),
    index = side === 'BUY' ? 1 : 0;
  f.reservations[0]!.side = side;
  f.reservations[0]!.debits = [f.reservations[0]!.debits[index]!];
  f.state.holds = [f.state.holds[index]!];
  f.holdProofs = [f.holdProofs[index]!];
  expect(projectPaperRiskCommitments(f).holds).toHaveLength(1);
});
it('does not confuse an empty current liability set with completeness certification', () => {
  const f = commitmentFixture();
  f.reservations = [];
  f.state.holds = [];
  f.holdProofs = [];
  const r = projectPaperRiskCommitments(f);
  expect(r.reservations).toEqual([]);
  expect('complete' in r).toBe(false);
});
it('cannot replace the certified source with a self-consistent commitment projection', () => {
  const f = commitmentFixture(),
    capture = projectPaperRiskCommitments(f);
  expect(
    calculatePaperRiskEvaluation({
      now: f.now,
      request: { owner: f.owner, intentId: f.reservations[0]!.intentId },
      capture,
    }).result.kind,
  ).toBe('REJECTED');
});
it('common COMMITMENT creates all holds with zero monetary postings', () => {
  const f = commitmentFixture(),
    balances = canonical(f.state.balances);
  let state = { ...f.state, holds: [] as typeof f.state.holds };
  for (const p of f.holdProofs) {
    const r = reducePortfolio(state, p.lastEvent, { now: () => f.now, holdWatermark: null });
    expect(r.postings).toEqual([]);
    state = r.state;
  }
  expect(canonical(state.balances)).toBe(balances);
  expect(state.holds).toHaveLength(2);
});
function twoAllocations() {
  const f = commitmentFixture(),
    second = structuredClone(f.reservations[0]!);
  second.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  second.orderId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  second.intentId = '99999999-9999-4999-8999-999999999999';
  for (const [i, d] of second.debits.entries()) {
    d.holdId += '-second';
    const h = { ...f.state.holds[i]!, id: d.holdId };
    const event: PortfolioEvent = {
      type: 'COMMITMENT',
      id: 'second-' + i,
      timestamp: second.updatedAt,
      hold: h,
    };
    f.state.holds.push(h);
    f.holdProofs.push({
      holdId: h.id,
      timestamp: event.timestamp,
      fingerprint: proofFor(event),
      released: false,
      unknown: true,
      lastEvent: event,
    });
  }
  f.reservations.push(second);
  return f;
}
it('aggregates distinct vectors before checking gross cash rather than checking each hold alone', () => {
  const f = twoAllocations();
  expect(projectPaperRiskCommitments(f).reservations).toHaveLength(2);
  f.state.balances[0]!.total =
    f.state.balances[0]!.free =
    f.state.balances[0]!.available =
      '0.999999999999999999';
  expect(() => projectPaperRiskCommitments(f)).toThrow('PAPER_COMMITMENT_BALANCE');
});
it('rejects conflicting assets for the same immutable instrument identity', () => {
  const f = twoAllocations();
  f.reservations[1]!.quote = 'USD';
  expect(() => projectPaperRiskCommitments(f)).toThrow('PAPER_COMMITMENT_SCOPE');
});
it.each(['event identity', 'valuation currency', 'future economic proof', 'timestamp overflow'])(
  'rejects ambiguous projection identity: %s',
  (kind) => {
    const f = commitmentFixture();
    if (kind === 'event identity') f.holdProofs[1]!.lastEvent.id = f.holdProofs[0]!.lastEvent.id;
    if (kind === 'valuation currency') f.reservations[0]!.notionalAsset = 'USD';
    if (kind === 'future economic proof') {
      f.holdProofs[0]!.lastEvent.timestamp = f.now + 1;
      f.holdProofs[0]!.timestamp = f.now + 1;
    }
    if (kind === 'timestamp overflow') f.now = f.asOf = Number.MAX_SAFE_INTEGER;
    expect(() => projectPaperRiskCommitments(f)).toThrow(/^PAPER_COMMITMENT_/u);
  },
);
