import { beforeEach, expect, it } from 'vitest';
import { immutable } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import * as paper from '../src/index.js';
import { executionSourceWire } from './execution-source-fixtures.js';
import { wireHash } from './admission-wire-fixtures.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function input() {
  const f = executionSourceWire(),
    c = f.packet.candidates[0]!;
  return {
    attemptId: id(9001),
    preparedAt: f.packet.asOf,
    admission: {
      binding: f.request.admission.binding,
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
  };
}
interface State {
  kind: 'PAPER_EXECUTION_ATTEMPT';
  version: 'paper-pristine-attempt-v1';
  request: ReturnType<typeof input>;
  requestHash: string;
  revision: '1' | '2' | '3';
  phase: 'PREPARED' | 'STARTED' | 'NOT_SENT' | 'UNKNOWN';
  startedAt: number | null;
  lastEvent: Record<string, unknown>;
}
function entry<T>(name: string) {
  const fn = (paper as unknown as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw Error('PAPER_ATTEMPT_CONTRACT_MISSING:' + name);
  return fn as T;
}
const prepare = (raw: unknown = input()) =>
  entry<(raw: unknown) => State>('preparePaperExecutionAttempt')(raw);
const reduce = (state: State, event: unknown) =>
  entry<(raw: unknown) => { state: State; ignored: boolean }>('reducePaperExecutionAttempt')({
    state,
    event,
  });
const project = (state: State, now = state.startedAt ?? state.request.preparedAt) =>
  entry<
    (raw: unknown) => {
      orderId: string;
      admissionSequence: string;
      order: ReturnType<typeof input>['admission']['command'];
      submittedAt: number;
      executedQuantity: string;
      triggeredAt: null;
    }
  >('projectPristinePaperExecutionAttempt')({ state, now });
function start(at = input().preparedAt + 1) {
  return { id: id(9002), kind: 'START', expectedRevision: '1', at };
}
function stop(reason = 'CONTROL', at = input().preparedAt + 1) {
  return { id: id(9003), kind: 'NOT_SENT', expectedRevision: '1', at, reason };
}
function unknown(afterStart = false, at = input().preparedAt + 2) {
  return {
    id: id(9004),
    kind: 'UNKNOWN',
    expectedRevision: afterStart ? '2' : '1',
    at,
    reason: afterStart ? 'AFTER_START' : 'AMBIGUOUS_START_COMMIT',
  };
}
beforeEach(() => {
  entry('preparePaperExecutionAttempt');
  entry('reducePaperExecutionAttempt');
  entry('projectPristinePaperExecutionAttempt');
});
function corrupt(raw: unknown, path: string, value: unknown) {
  const x = structuredClone(raw) as Record<string, unknown>,
    keys = path.split('.');
  let at = x;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[keys.at(-1)!] = value;
  return x;
}
it('prepares deterministic immutable content without inventing submission, authority or effects', () => {
  const x = input(),
    before = canonical(x),
    s = prepare(immutable(x));
  expect(s).toEqual({
    kind: 'PAPER_EXECUTION_ATTEMPT',
    version: 'paper-pristine-attempt-v1',
    request: x,
    requestHash: wireHash(x),
    revision: '1',
    phase: 'PREPARED',
    startedAt: null,
    lastEvent: { id: x.attemptId, kind: 'PREPARE', at: x.preparedAt },
  });
  expect(prepare(JSON.parse(before))).toEqual(s);
  expect(canonical(x)).toBe(before);
  expect(Object.isFrozen(s.request.admission.command.size)).toBe(true);
  for (const key of ['permit', 'submittedAt', 'fills', 'postings', 'grant', 'replayed', 'dispatch'])
    expect(key in s).toBe(false);
});
it.each([
  ['attemptId', 'bad'],
  ['preparedAt', -1],
  ['preparedAt', NaN],
  ['preparedAt', '100'],
  ['admission.admissionSequence', '0'],
  ['admission.admissionSequence', '01'],
  ['admission.admissionSequence', 9007199254740992],
  ['admission.admissionSequence', '9223372036854775808'],
  ['admission.commandHash', 'a'.repeat(64)],
  ['admission.orderId', 'bad'],
  ['admission.intentId', 'bad'],
  ['admission.decisionId', 'bad'],
  ['admission.reservationId', 'bad'],
  ['admission.dbInstrumentId', 'bad'],
  ['admission.dbRuleId', 'bad'],
  ['admission.admittedAt', input().preparedAt + 1],
  ['admission.expiresAt', input().preparedAt],
  ['admission.binding.connectionId', id(777)],
  ['admission.binding.profile.accountMode', 'CROSS'],
  ['admission.binding.profile.endpointProfileId', 'caller-endpoint'],
  ['admission.binding.profile.profileVersion', 'caller-model'],
  ['admission.command.side', 'SELL'],
  ['admission.command.reduceOnly', true],
  ['admission.command.timeInForce', 'POST_ONLY'],
  ['admission.command.type', 'STOP_MARKET'],
  ['permit', {}],
  ['source', {}],
  ['admission.transport', {}],
  ['admission.authorization', {}],
  ['admission.command.limitPrice', '9'],
] as const)('rejects unsupported or caller-added preparation field %s', (path, value) => {
  expect(() => prepare(corrupt(input(), path, value))).toThrow(/PAPER_ATTEMPT/u);
});
it.each(['TESTNET', 'DEMO', 'LIVE'])('rejects a coherently rehashed %s binding', (mode) => {
  const x = corrupt(input(), 'admission.binding.mode', mode) as ReturnType<typeof input>;
  x.admission.binding.connectionId = id(777) as never;
  x.admission.binding.profile.environment = mode as never;
  x.admission.commandHash = wireHash({
    operation: 'createOrder',
    command: x.admission.command,
    binding: x.admission.binding,
  });
  expect(() => prepare(x)).toThrow(/PAPER_ATTEMPT/u);
});
it('retains lossless original admission priority and original PLACE identities', () => {
  const x = input(),
    s = reduce(prepare(x), start()).state,
    c = project(s);
  expect(c.admissionSequence).toBe('9007199254740993');
  expect(c.order).toEqual(x.admission.command);
  expect(c.orderId).toBe(x.admission.orderId);
  expect(s.request.admission.intentId).toBe(x.admission.intentId);
  expect(s.request.admission.reservationId).toBe(x.admission.reservationId);
  expect(s.requestHash).toBe(wireHash(x));
});
it('records START once and derives submission exclusively from START time', () => {
  const s = prepare(),
    e = start(s.request.preparedAt + 150),
    r = reduce(s, e);
  expect(r.ignored).toBe(false);
  expect(r.state.phase).toBe('STARTED');
  expect(r.state.revision).toBe('2');
  expect(r.state.startedAt).toBe(e.at);
  expect(r.state.lastEvent).toEqual(e);
  expect(project(r.state).submittedAt).toBe(e.at);
  expect(project(r.state).submittedAt).not.toBe(s.request.admission.admittedAt);
  expect(project(r.state).submittedAt).not.toBe(s.request.preparedAt);
  expect(project(r.state)).toMatchObject({ executedQuantity: '0', triggeredAt: null });
});
it('orders distinct events in the same millisecond by revision without inventing a timestamp', () => {
  const s = prepare(),
    r = reduce(s, start(s.request.preparedAt));
  expect(r.state.startedAt).toBe(s.request.preparedAt);
  expect(reduce(r.state, unknown(true, s.request.preparedAt)).state.revision).toBe('3');
});
it.each(['CONTROL', 'DEADLINE', 'AUTHORIZATION', 'RULES', 'HEALTH', 'CANCELLED'])(
  'records pre-start %s as terminal NOT_SENT without weakening collateral',
  (reason) => {
    const s = prepare(),
      e = stop(reason, s.request.admission.expiresAt + 100),
      r = reduce(s, e);
    expect(r.state.phase).toBe('NOT_SENT');
    expect(r.state.startedAt).toBe(null);
    expect(r.state.request).toEqual(s.request);
    expect(() => reduce(r.state, start())).toThrow(/PAPER_ATTEMPT/u);
    expect(() => project(r.state)).toThrow(/PAPER_ATTEMPT/u);
    expect('released' in r.state).toBe(false);
  },
);
it('quarantines ambiguous START COMMIT without fabricating a known submission time', () => {
  const r = reduce(prepare(), unknown()).state;
  expect(r.phase).toBe('UNKNOWN');
  expect(r.startedAt).toBe(null);
  expect(r.revision).toBe('2');
  expect(() => project(r)).toThrow(/PAPER_ATTEMPT/u);
  expect(() => reduce(r, stop())).toThrow(/PAPER_ATTEMPT/u);
});
it('retains UNKNOWN and original start after dispatch ambiguity, including after expiry', () => {
  const s = reduce(prepare(), start()).state,
    r = reduce(s, unknown(true, s.request.admission.expiresAt + 100)).state;
  expect(r.phase).toBe('UNKNOWN');
  expect(r.startedAt).toBe(s.startedAt);
  expect(r.revision).toBe('3');
  expect(() => project(r)).toThrow(/PAPER_ATTEMPT/u);
  for (const e of [start(), stop(), unknown(true)])
    expect(() => reduce(r, e)).toThrow(/PAPER_ATTEMPT/u);
});
it.each(['START', 'NOT_SENT', 'UNKNOWN'])(
  'preserves exact %s replay through JSON restore without new identity',
  (kind) => {
    const s = prepare(),
      e = kind === 'START' ? start() : kind === 'NOT_SENT' ? stop() : unknown(),
      next = reduce(s, e).state;
    const replay = reduce(JSON.parse(JSON.stringify(next)) as State, structuredClone(e));
    expect(replay.ignored).toBe(true);
    expect(replay.state).toEqual(next);
  },
);
it.each(['id', 'at', 'reason', 'expectedRevision'])(
  'rejects conflicting replay field %s rather than accepting equal revision',
  (field) => {
    const e = unknown(),
      s = reduce(prepare(), e).state;
    const different = {
      ...e,
      [field]:
        field === 'id'
          ? id(999)
          : field === 'at'
            ? e.at + 1
            : field === 'reason'
              ? 'AFTER_START'
              : '2',
    };
    expect(() => reduce(s, different)).toThrow(/PAPER_ATTEMPT/u);
  },
);
it.each([
  { ...start(), expectedRevision: '2' },
  { ...start(), expectedRevision: 1 },
  { ...start(), expectedRevision: '01' },
  { ...start(), at: input().preparedAt - 1 },
  { ...start(), at: input().admission.expiresAt },
  { ...start(), id: input().attemptId },
  { ...start(), permit: {} },
  { ...start(), kind: 'ACK' },
  { ...start(), kind: 'FILLED' },
  { ...start(), kind: 'RESOLVE' },
  { ...start(), kind: 'START', reason: 'HEALTHY' },
  unknown(true),
])('rejects unsupported initial transition %#', (e) => {
  expect(() => reduce(prepare(), e)).toThrow(/PAPER_ATTEMPT/u);
});
it('rejects NOT_SENT and stale START after known START; never manufactures false UNKNOWN', () => {
  const s = reduce(prepare(), start()).state;
  expect(() => reduce(s, { ...stop(), expectedRevision: '2' })).toThrow(/PAPER_ATTEMPT/u);
  expect(() => reduce(s, { ...start(), id: id(999), expectedRevision: '2' })).toThrow(
    /PAPER_ATTEMPT/u,
  );
  expect(() => reduce(s, unknown(false))).toThrow(/PAPER_ATTEMPT/u);
});
it('rejects reuse of the START event identity for a different later event', () => {
  const s = reduce(prepare(), start()).state;
  expect(() => reduce(s, { ...unknown(true), id: start().id })).toThrow(/PAPER_ATTEMPT/u);
});
it.each([
  ['phase', 'FILLED'],
  ['revision', '99'],
  ['startedAt', input().preparedAt],
  ['requestHash', 'f'.repeat(64)],
  ['request.admission.orderId', id(999)],
  ['request.admission.admissionSequence', '2'],
  ['lastEvent.id', id(999)],
  ['lastEvent.at', input().preparedAt + 1],
  ['lastEvent.kind', 'START'],
  ['permit', {}],
] as const)(
  'rejects torn or caller-extended previous state field %s after restore',
  (path, value) => {
    const s = corrupt(prepare(), path, value) as unknown as State;
    expect(() => reduce(s, start())).toThrow(/PAPER_ATTEMPT/u);
    expect(() => project(s)).toThrow(/PAPER_ATTEMPT/u);
  },
);
it('projects only known STARTED and rejects a future observation or caller-supplied partial history', () => {
  expect(() => project(prepare())).toThrow(/PAPER_ATTEMPT/u);
  const s = reduce(prepare(), start()).state;
  expect(() => project(s, s.startedAt! - 1)).toThrow(/PAPER_ATTEMPT/u);
  const fn = entry<(raw: unknown) => unknown>('projectPristinePaperExecutionAttempt');
  expect(() => fn({ state: s, now: s.startedAt, executedQuantity: '0.1' })).toThrow(
    /PAPER_ATTEMPT/u,
  );
});
it('does not reinterpret historical approval expiry as proof that a known START was never sent', () => {
  const s = reduce(prepare(), start()).state;
  expect(project(s, s.request.admission.expiresAt + 100).submittedAt).toBe(s.startedAt);
});
it('preserves latency and forbids using pre-start public evidence as an execution price', () => {
  const f = executionSourceWire(),
    s = reduce(prepare(), start(input().preparedAt + 150)).state,
    c = project(s, s.startedAt! + 100);
  const before = {
    now: s.startedAt! + 99,
    model: f.packet.model,
    record: f.packet.market.record,
    book: f.packet.market.book,
    trade: f.packet.market.trade,
  };
  const frame = paper.preparePaperFrame(before);
  expect(
    paper.calculatePaperCompetition({ now: before.now, frame, orders: [c] }).executions[0]!.reason,
  ).toBe('LATENCY');
  expect(
    paper.calculatePaperCompetition({ now: s.startedAt! + 100, frame, orders: [c] }).executions[0]!
      .fills,
  ).toEqual([]);
  const now = s.startedAt! + 100,
    current = {
      ...before,
      now,
      book: { ...before.book, receivedAt: now, exchangeTime: now },
      trade: { ...before.trade, receivedAt: now, exchangeTime: now },
    };
  const r = paper.calculatePaperCompetition({
    now,
    frame: paper.preparePaperFrame(current),
    orders: [c],
  });
  expect(r.executions[0]!.fills.length).toBeGreaterThan(0);
});
it('does not mint different fill identities solely because the attempt identity changes', () => {
  const f = executionSourceWire(),
    x = input(),
    s = reduce(prepare(x), start()).state;
  const other = reduce(prepare({ ...x, attemptId: id(9999) }), start()).state;
  expect(project(other)).toEqual(project(s));
  expect(f.packet.candidates[0]!.command).toEqual(s.request.admission.command);
});
it('replays 300 independent lossless priorities deterministically without allocation or cross-order mutation', () => {
  const all = Array.from({ length: 300 }, (_, index) => {
    const x = input();
    x.attemptId = id(10000 + index);
    x.admission.admissionSequence = (9007199254740993n + BigInt(index)).toString();
    const s = reduce(prepare(x), start()).state;
    expect(reduce(JSON.parse(JSON.stringify(s)) as State, start()).ignored).toBe(true);
    return project(s).admissionSequence;
  });
  expect(new Set(all).size).toBe(300);
});
it('rejects unexpected collections before walking their poisoned members', () => {
  let visits = 0;
  const collection = new Array<unknown>(1000000);
  Object.defineProperty(collection, '0', {
    get() {
      visits++;
      return 'poison';
    },
  });
  expect(() => prepare({ ...input(), collection })).toThrow(/PAPER_ATTEMPT/u);
  expect(visits).toBe(0);
});
it('rejects accessor-bearing content without invoking caller code', () => {
  let visits = 0;
  const extra = Object.defineProperty({}, 'field', {
    enumerable: true,
    get() {
      visits++;
      return 'secret';
    },
  });
  expect(() => prepare({ ...input(), extra })).toThrow(/PAPER_ATTEMPT/u);
  expect(visits).toBe(0);
});
it('bounds depth, cycles and large strings without changing any previous state', () => {
  const s = prepare(),
    before = canonical(s),
    cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  expect(() => prepare(cyclic)).toThrow(/PAPER_ATTEMPT/u);
  expect(() => reduce(s, { ...start(), extra: 'x'.repeat(20000) })).toThrow(/PAPER_ATTEMPT/u);
  expect(canonical(s)).toBe(before);
});
it('rejects excessive depth before visiting a far accessor', () => {
  let visits = 0;
  let deep: unknown = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      visits++;
      return 1;
    },
  });
  for (let i = 0; i < 40; i++) deep = { next: deep };
  expect(() => prepare({ ...input(), deep })).toThrow(/PAPER_ATTEMPT/u);
  expect(visits).toBe(0);
});
it('preserves exact post-start UNKNOWN replay after JSON restore beyond historical expiry', () => {
  const s = reduce(prepare(), start()).state,
    e = unknown(true, s.request.admission.expiresAt + 100);
  const next = reduce(s, e).state;
  expect(reduce(JSON.parse(JSON.stringify(next)) as State, e)).toEqual({
    state: next,
    ignored: true,
  });
});
