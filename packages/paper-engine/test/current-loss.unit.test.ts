import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { projectPaperCurrentLoss } from '../src/current-loss-domain.js';
import * as pure from '../src/index.js';

const day = Date.UTC(2026, 10, 14),
  start = day + 1000,
  at = day + 10000,
  h = 'a'.repeat(64);
function fixture() {
  const fundingId = randomUUID();
  return {
    scope: { tenantId: randomUUID(), mode: 'PAPER' as const, valuationAsset: 'USDT' },
    executionId: randomUUID(),
    capturedAt: at,
    validUntil: at + 1000,
    maxEvidenceAgeMs: 1000,
    baseline: {
      kind: 'PAPER_INCEPTION' as const,
      id: randomUUID(),
      sourceHash: h,
      utcDayStart: day,
      at: start,
      equity: '100',
      expiresAt: day + 86400000,
      fundingId,
    },
    flows: [
      {
        id: fundingId,
        sourceHash: h,
        accountId: randomUUID(),
        at: start,
        asset: 'USDT',
        amount: '100',
      },
    ],
    realized: [{ id: randomUUID(), sourceHash: h, at: start + 1, asset: 'USDT', amount: '-1' }],
    points: [
      {
        id: randomUUID(),
        sourceHash: h,
        at: start + 2,
        equity: '150',
        revision: '9007199254740993',
        status: 'APPLIED' as const,
      },
      {
        id: randomUUID(),
        sourceHash: h,
        at: start + 3,
        equity: '110',
        revision: '9007199254740994',
        status: 'DUPLICATE' as const,
      },
    ],
    current: { id: randomUUID(), sourceHash: h, at, sourceAt: at - 1, equity: '109' },
    coverage: {
      id: randomUUID(),
      sourceHash: h,
      from: start,
      through: at,
      complete: true,
      previousHash: null as string | null,
    },
    previous: null as ReturnType<typeof projectPaperCurrentLoss> | null,
  };
}
it('keeps a witnessed intermediate peak when current equity has fallen', () => {
  const f = fixture(),
    p = projectPaperCurrentLoss(f, at);
  expect(p.adjustedOpeningEquity).toBe('100');
  expect(p.adjustedCurrentEquity).toBe('109');
  expect(p.adjustedPeakEquity).toBe('150');
  expect(p.dailyNetRealizedPnl).toBe('-1');
  expect(p.actualEquity).toBe('109');
  expect(p.complete).toBe(true);
  expect(p.baseline.at).toBe(start);
  expect(p.baseline.at).not.toBe(day);
  expect(p.validUntil).toBe(at + 1000);
  expect(Object.isFrozen(p)).toBe(true);
});
it('adjusts each point by its original external flows and never subtracts realized fees twice', () => {
  const f = fixture();
  f.flows.push({ ...f.flows[0]!, id: randomUUID(), at: start + 3, amount: '100' });
  f.points[1]!.equity = '210';
  f.current.equity = '209';
  const p = projectPaperCurrentLoss(f, at);
  expect(p.externalFlows).toBe('100');
  expect(p.adjustedCurrentEquity).toBe('109');
  expect(p.adjustedPeakEquity).toBe('150');
  expect(p.dailyNetRealizedPnl).toBe('-1');
  expect(p.actualEquity).toBe('209');
});
it('accounts for signed withdrawals without inventing an economic gain', () => {
  const f = fixture();
  f.flows.push({ ...f.flows[0]!, id: randomUUID(), at: start + 3, amount: '-10' });
  f.points[1]!.equity = '100';
  f.current.equity = '99';
  const p = projectPaperCurrentLoss(f, at);
  expect(p.externalFlows).toBe('-10');
  expect(p.adjustedCurrentEquity).toBe('109');
  expect(p.adjustedPeakEquity).toBe('150');
});
it('retains the durable peak across replay, serialization and restart with an empty next batch', () => {
  const f = fixture(),
    first = projectPaperCurrentLoss(f, at);
  f.previous = JSON.parse(JSON.stringify(first)) as typeof first;
  f.coverage.previousHash = first.hash;
  f.points = [];
  f.capturedAt += 10;
  f.current.at += 10;
  f.coverage.through += 10;
  const next = projectPaperCurrentLoss(f, at + 10);
  expect(next.adjustedPeakEquity).toBe('150');
  expect(next.adjustedCurrentEquity).toBe('109');
  expect(next.dailyNetRealizedPnl).toBe('-1');
  expect(next.externalFlows).toBe('0');
  expect(next.baseline).toEqual(first.baseline);
});
it('does not certify an incomplete catch-up interval or lower the retained peak', () => {
  const f = fixture(),
    first = projectPaperCurrentLoss(f, at);
  f.previous = first;
  f.coverage.previousHash = first.hash;
  f.coverage.complete = false;
  f.points = [];
  f.current.equity = '80';
  f.capturedAt += 10;
  f.current.at += 10;
  f.coverage.through += 10;
  const partial = projectPaperCurrentLoss(f, at + 10);
  expect(partial.complete).toBe(false);
  expect(partial.coveredThrough).toBe(first.coveredThrough);
  expect(partial.adjustedPeakEquity).toBe('150');
  expect(partial.adjustedCurrentEquity).toBe('80');
  expect(partial).not.toHaveProperty('certificate');
  expect(partial).not.toHaveProperty('grant');
});
it('accepts an older previously unprocessed native mark without losing its peak', () => {
  const f = fixture(),
    first = projectPaperCurrentLoss(f, at);
  f.previous = first;
  f.coverage.previousHash = first.hash;
  f.points = [{ ...f.points[0]!, id: randomUUID(), equity: '170' }];
  expect(projectPaperCurrentLoss(f, at).adjustedPeakEquity).toBe('170');
});
it('accepts equal-clock identical receipts without assigning economic meaning to UUID order', () => {
  const f = fixture();
  f.points.push({ ...f.points[0]!, id: randomUUID() });
  const first = projectPaperCurrentLoss(f, at);
  f.points.reverse();
  expect(projectPaperCurrentLoss(f, at)).toEqual(first);
});
it('rejects conflicting equal-clock observations and reused event IDs', () => {
  const f = fixture();
  f.points.push({ ...f.points[0]!, id: randomUUID(), equity: '151' });
  expect(() => projectPaperCurrentLoss(f, at)).toThrow('PAPER_CURRENT_LOSS_HISTORY');
  f.points.pop();
  f.points.push({ ...f.points[0]! });
  expect(() => projectPaperCurrentLoss(f, at)).toThrow('PAPER_CURRENT_LOSS_HISTORY');
});
it('rejects missing or reminted inception provenance and nonquote flow guesses', () => {
  const f = fixture();
  f.baseline.fundingId = randomUUID();
  expect(() => projectPaperCurrentLoss(f, at)).toThrow('PAPER_CURRENT_LOSS_BASELINE');
  f.baseline.fundingId = f.flows[0]!.id;
  f.flows[0]!.asset = 'BTC';
  expect(() => projectPaperCurrentLoss(f, at)).toThrow('PAPER_CURRENT_LOSS_EVIDENCE');
});
it('rejects a changed prior baseline, retroactive flow or realized rewrite after restart', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.baseline.equity = '101';
    },
    (f: ReturnType<typeof fixture>) => {
      f.flows.push({ ...f.flows[0]!, id: randomUUID(), at: start + 4, amount: '1' });
    },
    (f: ReturnType<typeof fixture>) => {
      f.realized[0]!.amount = '-2';
    },
  ]) {
    const f = fixture(),
      first = projectPaperCurrentLoss(f, at);
    f.previous = first;
    f.coverage.previousHash = first.hash;
    change(f);
    expect(() => projectPaperCurrentLoss(f, at)).toThrow(
      /^PAPER_CURRENT_LOSS_(BASELINE|HISTORY)$/u,
    );
  }
});
it('rejects a forged durable checkpoint hash and cross-tenant transplantation', () => {
  const f = fixture(),
    first = projectPaperCurrentLoss(f, at);
  f.previous = structuredClone(first);
  f.coverage.previousHash = first.hash;
  Object.assign(f.previous, { adjustedPeakEquity: '1' });
  expect(() => projectPaperCurrentLoss(f, at)).toThrow('PAPER_CURRENT_LOSS_HISTORY');
  f.previous = first;
  f.scope.tenantId = randomUUID();
  expect(() => projectPaperCurrentLoss(f, at)).toThrow('PAPER_CURRENT_LOSS_HISTORY');
});
it('does not renew original freshness or the exclusive UTC midnight boundary', () => {
  const f = fixture();
  expect(() => projectPaperCurrentLoss(f, at + 1000)).toThrow('PAPER_CURRENT_LOSS_EXPIRED');
  expect(() => projectPaperCurrentLoss(f, day + 86400000)).toThrow('PAPER_CURRENT_LOSS_EXPIRED');
});
it('rejects gaps, unsafe numeric revisions, future clocks and oversized evidence', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.points[0]!, { status: 'RESYNC_REQUIRED' });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.points[0]!, { revision: 9007199254740992 });
    },
    (f: ReturnType<typeof fixture>) => {
      f.points[0]!.at = at + 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.points = Array.from({ length: 1001 }, () => ({ ...f.points[0]! }));
    },
  ]) {
    const f = fixture();
    change(f);
    expect(() => projectPaperCurrentLoss(f, at)).toThrow(/^PAPER_CURRENT_LOSS_/u);
  }
});
it('keeps loss projection private and does not expose certificate or monetary authority', () => {
  expect(pure).not.toHaveProperty('projectPaperCurrentLoss');
  const p = projectPaperCurrentLoss(fixture(), at);
  expect(p.kind).toBe('PAPER_CURRENT_LOSS_PROJECTION');
  expect(p).not.toHaveProperty('permit');
  expect(p).not.toHaveProperty('reservation');
});
it('rejects noncanonical source hashes with a trailing line terminator', () => {
  const f = fixture();
  f.points[0]!.sourceHash += '\n';
  expect(() => projectPaperCurrentLoss(f, at)).toThrow('PAPER_CURRENT_LOSS_INPUT');
});
it('uses a genuine UTC opening and excludes earlier funding from current-day external flows', () => {
  const f = fixture();
  f.flows[0]!.at = day - 1000;
  const raw = {
    ...f,
    baseline: { ...f.baseline, kind: 'UTC_EQUITY', at: day, fundingId: null },
    coverage: { ...f.coverage, from: day },
  };
  const p = projectPaperCurrentLoss(raw, at);
  expect(p.externalFlows).toBe('0');
  expect(p.adjustedOpeningEquity).toBe('100');
  expect(p.adjustedCurrentEquity).toBe('109');
  expect(p.baseline.at).toBe(day);
  expect(() =>
    projectPaperCurrentLoss(
      {
        ...raw,
        baseline: { ...raw.baseline, at: start },
        coverage: { ...raw.coverage, from: start },
      },
      at,
    ),
  ).toThrow('PAPER_CURRENT_LOSS_BASELINE');
});
it('requires a genuine next UTC opening instead of reminting an inception reference', () => {
  const f = fixture(),
    previous = projectPaperCurrentLoss(f, at),
    nextDay = day + 86400000;
  const raw = {
    ...f,
    previous,
    capturedAt: nextDay + 10,
    validUntil: nextDay + 1010,
    baseline: {
      ...f.baseline,
      id: randomUUID(),
      sourceHash: 'b'.repeat(64),
      kind: 'UTC_EQUITY',
      utcDayStart: nextDay,
      at: nextDay,
      equity: '109',
      expiresAt: nextDay + 86400000,
      fundingId: null,
    },
    points: [{ ...f.points[0]!, id: randomUUID(), at: nextDay + 9, equity: '110' }],
    current: { ...f.current, at: nextDay + 10, sourceAt: nextDay + 9, equity: '110' },
    coverage: { ...f.coverage, from: nextDay, through: nextDay + 10, previousHash: previous.hash },
  };
  const next = projectPaperCurrentLoss(raw, nextDay + 10);
  expect(next.adjustedOpeningEquity).toBe('109');
  expect(next.adjustedPeakEquity).toBe('110');
  expect(next.dailyNetRealizedPnl).toBe('0');
  expect(next.externalFlows).toBe('0');
  expect(() =>
    projectPaperCurrentLoss(
      {
        ...raw,
        baseline: {
          ...raw.baseline,
          kind: 'PAPER_INCEPTION',
          fundingId: f.flows[0]!.id,
        },
      },
      nextDay + 10,
    ),
  ).toThrow(/^PAPER_CURRENT_LOSS_(BASELINE|HISTORY)$/u);
});
it('can finish bounded catch-up without dropping a previously witnessed peak', () => {
  const f = fixture();
  f.coverage.complete = false;
  const partial = projectPaperCurrentLoss(f, at);
  expect(partial.coveredThrough).toBe(start);
  f.previous = partial;
  f.coverage.previousHash = partial.hash;
  f.coverage.complete = true;
  f.points = [{ ...f.points[0]!, id: randomUUID(), equity: '170' }];
  f.capturedAt += 10;
  f.current.at += 10;
  f.coverage.through += 10;
  const complete = projectPaperCurrentLoss(f, at + 10);
  expect(complete.complete).toBe(true);
  expect(complete.coveredThrough).toBe(at + 10);
  expect(complete.adjustedPeakEquity).toBe('170');
  expect(complete.dailyNetRealizedPnl).toBe('-1');
});
it('rejects accessors and cycles before reading values or hashing evidence', () => {
  const f = fixture();
  let reads = 0;
  Object.defineProperty(f.current, 'equity', {
    enumerable: true,
    get() {
      reads++;
      return '100';
    },
  });
  expect(() => projectPaperCurrentLoss(f, at)).toThrow('PAPER_CURRENT_LOSS_INPUT');
  expect(reads).toBe(0);
  const cyclic = fixture();
  Object.assign(cyclic, { previous: cyclic });
  expect(() => projectPaperCurrentLoss(cyclic, at)).toThrow('PAPER_CURRENT_LOSS_INPUT');
});
