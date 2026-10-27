import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical } from '@ctp/portfolio';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { executionSourceWire } from './execution-source-fixtures.js';
import { wireNow } from './admission-wire-fixtures.js';

const fake = vi.hoisted<{
  payload: unknown;
  queries: string[];
  duplicate: boolean;
  commitError: boolean;
  afterCommit: (() => void) | null;
}>(() => ({ payload: null, queries: [], duplicate: false, commitError: false, afterCommit: null }));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    query(text: string) {
      fake.queries.push(text);
      if (text === 'COMMIT') {
        fake.afterCommit?.();
        if (fake.commitError) return Promise.reject(Error('private COMMIT failure'));
      }
      return Promise.resolve({
        rows: text.includes(' AS safe')
          ? [{ safe: true }]
          : text.includes(' AS result')
            ? Array.from({ length: fake.duplicate ? 2 : 1 }, () => ({ result: fake.payload }))
            : [],
      });
    }
  },
}));
const options = {
  connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
  environment: 'test',
};
const io = () => ({ signal: new AbortController().signal, deadline: wireNow + 2000 });
type State = ReturnType<typeof pure.preparePaperExecutionAttempt>;
interface View {
  kind: 'MISSING' | 'COMMITTED';
  request: unknown;
  preparation?: State;
  state?: State;
  withdrawal?: unknown;
}
interface Journal {
  prepare(raw: unknown, context: ReturnType<typeof io>): Promise<State>;
  read(raw: unknown, context: ReturnType<typeof io>): Promise<View>;
  stopBeforeStart(raw: unknown, context: ReturnType<typeof io>): Promise<State>;
  reconcileStop(raw: unknown, context: ReturnType<typeof io>): Promise<View>;
  close(): Promise<void>;
}
function factory() {
  const fn = (server as unknown as Record<string, unknown>)['createPostgresPaperAttemptJournal'];
  if (typeof fn !== 'function') throw Error('PAPER_ATTEMPT_JOURNAL_MISSING');
  return fn as (options: unknown) => Promise<Journal>;
}
const open = () => factory()(options);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const f = executionSourceWire(),
    c = f.packet.candidates[0]!;
  const request = {
    kind: 'PAPER_ATTEMPT_PREPARE',
    key: 'journal-preparation-1',
    admission: f.request.admission,
    authorization: f.request.authorization,
  };
  const preparation = pure.preparePaperExecutionAttempt({
    attemptId: id(9001),
    preparedAt: wireNow,
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
  });
  const stop = {
    ...request,
    kind: 'PAPER_ATTEMPT_STOP',
    stopKey: 'journal-stop-1',
    reason: 'CANCELLED',
  };
  const event = {
    id: id(9002),
    kind: 'NOT_SENT',
    expectedRevision: '1',
    at: wireNow,
    reason: 'CANCELLED',
  };
  const state = pure.reducePaperExecutionAttempt({ state: preparation, event }).state;
  const withdrawal = {
    outcome: 'NOT_SENT',
    collateral: 'RETAINED',
    eventId: event.id,
    reservationId: c.reservationId,
    orderId: c.orderId,
    intentId: c.intentId,
    decisionId: c.decisionId,
    commandHash: c.commandHash,
    stateRevision: '1',
    observedAt: event.at,
    bookId: f.packet.portfolio.bookId,
    bookRevision: '2',
    bookHash: f.packet.portfolio.hash,
  };
  return {
    request,
    stop,
    preparation,
    state,
    withdrawal,
    packet: { kind: 'PREPARED', request, preparation, state: preparation, withdrawal: null },
    stopped: { kind: 'STOPPED', request: stop, preparation, state, withdrawal },
  };
}
beforeEach(() => {
  factory();
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.queries = [];
  fake.duplicate = false;
  fake.commitError = false;
  fake.afterCommit = null;
});
afterEach(() => vi.restoreAllMocks());
function changed(raw: unknown, path: string, value: unknown) {
  const x = structuredClone(raw) as Record<string, unknown>,
    keys = path.split('.');
  let at = x;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[keys.at(-1)!] = value;
  return x;
}
it('exports a server-only journal over the fixed mutation RPC and returns no permit or financial result', async () => {
  expect(pure).not.toHaveProperty('createPostgresPaperAttemptJournal');
  const f = fixture(),
    port = await open();
  fake.payload = f.packet;
  fake.queries = [];
  try {
    const result = await port.prepare(f.request, io());
    expect(result).toEqual(f.preparation);
    expect(Object.isFrozen(result.request.admission.command)).toBe(true);
    expect(fake.queries).toContain('SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result');
    expect(fake.queries.at(-1)).toBe('COMMIT');
    for (const key of ['permit', 'grant', 'fills', 'postings', 'committed', 'submittedAt'])
      expect(key in result).toBe(false);
  } finally {
    await port.close();
  }
});
it('uses only readonly reconciliation for MISSING and does not create or retry preparation', async () => {
  const f = fixture(),
    port = await open();
  fake.payload = { kind: 'MISSING', request: f.request };
  fake.queries = [];
  try {
    expect(await port.read(f.request, io())).toEqual(fake.payload);
    expect(fake.queries).toContain('SELECT ctp_paper.reconcile_admission($1::jsonb) AS result');
    expect(fake.queries.some((q) => q.includes('evaluate_and_reserve'))).toBe(false);
  } finally {
    await port.close();
  }
});
it('validates historical PREPARED after expiry without minting a renewed grant', async () => {
  const f = fixture(),
    port = await open();
  fake.payload = f.packet;
  vi.mocked(Date.now).mockReturnValue(f.preparation.request.admission.expiresAt + 100);
  try {
    const context = { signal: new AbortController().signal, deadline: Date.now() + 2000 };
    expect(await port.prepare(f.request, context)).toEqual(f.preparation);
  } finally {
    await port.close();
  }
});
it('returns original PREPARED on permanent replay while readonly head exposes terminal NOT_SENT', async () => {
  const f = fixture(),
    port = await open();
  try {
    fake.payload = { ...f.stopped, kind: 'PREPARED', request: f.request };
    expect(await port.prepare(f.request, io())).toEqual(f.preparation);
    fake.payload = { ...f.stopped, kind: 'COMMITTED', request: f.request };
    expect(await port.read(f.request, io())).toMatchObject({
      kind: 'COMMITTED',
      preparation: f.preparation,
      state: f.state,
      withdrawal: f.withdrawal,
    });
  } finally {
    await port.close();
  }
});
it('projects STOP only from the real retained-collateral withdrawal cause and exposes readonly STOP replay', async () => {
  const f = fixture(),
    port = await open();
  try {
    fake.payload = f.stopped;
    expect(await port.stopBeforeStart(f.stop, io())).toEqual(f.state);
    fake.payload = { ...f.stopped, kind: 'COMMITTED' };
    fake.queries = [];
    expect(await port.reconcileStop(f.stop, io())).toMatchObject({
      kind: 'COMMITTED',
      state: f.state,
      withdrawal: f.withdrawal,
    });
    expect(fake.queries.some((q) => q.includes('evaluate_and_reserve'))).toBe(false);
  } finally {
    await port.close();
  }
});
it.each([
  ['key', ''],
  ['key', 'x'.repeat(129)],
  ['key', 'caller key'],
  ['admission.operation', 'AMEND'],
  ['admission.binding.connectionId', id(700)],
  ['admission.binding.mode', 'LIVE'],
  ['admission.binding.profile.accountMode', 'CROSS'],
  ['authorization.permissionEpoch', '01'],
  ['authorization.permissionEpoch', '9223372036854775808'],
  ['authorization.userSessionEpoch', '2147483648'],
  ['attemptId', id(9009)],
  ['preparedAt', wireNow],
  ['state', {}],
  ['permit', {}],
  ['command', {}],
  ['transport', {}],
  ['url', 'https://example.invalid'],
  ['credentials', {}],
] as const)(
  'rejects caller-supplied or invalid request field %s before SQL',
  async (path, value) => {
    const f = fixture(),
      port = await open();
    fake.queries = [];
    try {
      await expect(port.prepare(changed(f.request, path, value), io())).rejects.toThrow(
        /PAPER_ADMISSION/u,
      );
      expect(fake.queries).toEqual([]);
    } finally {
      await port.close();
    }
  },
);
it.each([
  ['request.key', 'other'],
  ['request.admission.orderId', id(90)],
  ['preparation.request.admission.commandHash', 'f'.repeat(64)],
  ['preparation.request.attemptId', id(91)],
  ['preparation.requestHash', 'f'.repeat(64)],
  ['preparation.phase', 'STARTED'],
  ['preparation.startedAt', wireNow],
  ['preparation.request.preparedAt', wireNow + 1],
  ['state', null],
  ['state.phase', 'UNKNOWN'],
  ['withdrawal', {}],
  ['permit', {}],
] as const)('rejects incoherent or positive preparation packet field %s', async (path, value) => {
  const f = fixture(),
    port = await open();
  fake.payload = changed(f.packet, path, value);
  try {
    await expect(port.prepare(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    expect(fake.queries).toContain('ROLLBACK');
  } finally {
    await port.close();
  }
});
it.each([
  ['withdrawal', null],
  ['withdrawal.collateral', 'RELEASED'],
  ['withdrawal.eventId', id(77)],
  ['withdrawal.commandHash', 'f'.repeat(64)],
  ['withdrawal.observedAt', wireNow - 1],
  ['withdrawal.reservationId', id(78)],
  ['state.lastEvent.reason', 'CONTROL'],
  ['state.phase', 'STARTED'],
  ['state.startedAt', wireNow],
  ['state.revision', '3'],
] as const)(
  'rejects STOP evidence mismatch %s without granting financial effects',
  async (path, value) => {
    const f = fixture(),
      port = await open();
    fake.payload = changed(f.stopped, path, value);
    try {
      await expect(port.stopBeforeStart(f.stop, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    } finally {
      await port.close();
    }
  },
);
it('rejects a coherently formed STARTED response from this negative-only journal', async () => {
  const f = fixture(),
    port = await open();
  const state = pure.reducePaperExecutionAttempt({
    state: f.preparation,
    event: { id: id(9444), kind: 'START', expectedRevision: '1', at: wireNow },
  }).state;
  fake.payload = { ...f.packet, state };
  try {
    await expect(port.prepare(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  } finally {
    await port.close();
  }
});
it('fails closed on duplicate RPC rows', async () => {
  const f = fixture(),
    port = await open();
  fake.payload = f.packet;
  fake.duplicate = true;
  try {
    await expect(port.prepare(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  } finally {
    await port.close();
  }
});
it('never emits preparation after an uncertain COMMIT and does not retry the mutation', async () => {
  const f = fixture(),
    port = await open();
  fake.payload = f.packet;
  fake.queries = [];
  fake.commitError = true;
  try {
    await expect(port.prepare(f.request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(fake.queries.filter((q) => q.includes('evaluate_and_reserve'))).toHaveLength(1);
    expect(fake.queries.filter((q) => q === 'COMMIT')).toHaveLength(1);
  } finally {
    fake.commitError = false;
    await port.close();
  }
});
it('retains physical post-COMMIT deadline guards and does not mutate the request', async () => {
  const f = fixture(),
    port = await open(),
    before = canonical(f.request);
  fake.payload = f.packet;
  fake.afterCommit = () => {
    vi.mocked(Date.now).mockReturnValue(wireNow + 3000);
  };
  try {
    await expect(port.prepare(f.request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(canonical(f.request)).toBe(before);
  } finally {
    await port.close();
  }
});
