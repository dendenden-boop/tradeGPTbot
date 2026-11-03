import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { canonical } from '@ctp/portfolio';
import { wireNow } from './admission-wire-fixtures.js';
import { startedRiskFixture } from './started-risk-fixtures.js';

const fake = vi.hoisted<{
  payload: unknown;
  queries: { text: string; values: readonly unknown[] }[];
  duplicate: boolean;
  commitError: boolean;
  afterCommit: null | (() => void);
}>(() => ({
  payload: null,
  queries: [],
  duplicate: false,
  commitError: false,
  afterCommit: null,
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    query(text: string, values: readonly unknown[] = []) {
      fake.queries.push({ text, values });
      if (text === 'COMMIT') {
        fake.afterCommit?.();
        if (fake.commitError) return Promise.reject(Error('private commit loss'));
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
interface View {
  kind: string;
  validUntil: number;
  started: { journal: { receipt: unknown; state: { phase: string } } };
  risk: {
    evaluation: { kind: string };
    retained: { reservationId: string; budget: { orders: { current: number; projected: number } } };
  };
}
interface Port {
  read(request: unknown, io: { signal: AbortSignal; deadline: number }): Promise<View>;
  close(): Promise<void>;
}
function factory() {
  const fn = (server as unknown as Record<string, unknown>)['createPostgresPaperStartedRiskSource'];
  if (typeof fn !== 'function') throw Error('PAPER_STARTED_RISK_FACTORY_MISSING');
  return fn as (options: unknown) => Promise<Port>;
}
const open = () =>
  factory()({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
const io = (signal = new AbortController().signal) => ({ signal, deadline: Date.now() + 2000 });
beforeEach(() => {
  factory();
  vi.spyOn(Date, 'now').mockReturnValue(wireNow + 1);
  fake.queries = [];
  fake.duplicate = false;
  fake.commitError = false;
  fake.afterCommit = null;
});
afterEach(() => vi.restoreAllMocks());
async function read(f: ReturnType<typeof startedRiskFixture>, request: unknown = f.request) {
  const commitError = fake.commitError,
    afterCommit = fake.afterCommit;
  fake.commitError = false;
  fake.afterCommit = null;
  const port = await open();
  fake.commitError = commitError;
  fake.afterCommit = afterCommit;
  fake.payload = f.packet;
  fake.queries = [];
  try {
    return await port.read(request, io());
  } finally {
    await port.close();
  }
}
function change(raw: unknown, path: string, value: unknown) {
  const keys = path.split('.');
  let at = raw as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[keys.at(-1)!] = value;
}
it('re-evaluates a real known START in one readonly transaction without renewing its lease or reserving twice', async () => {
  const f = startedRiskFixture(),
    original = canonical(f.packet),
    r = await read(f);
  expect(r.kind).toBe('PAPER_STARTED_RISK_SOURCE');
  expect(r.started.journal.state.phase).toBe('STARTED');
  expect(r.started.journal.receipt).toEqual(f.started.receipt);
  expect(r.risk.evaluation.kind).toBe('EVALUATED');
  expect(r.risk.retained.reservationId).toBe(f.packet.risk.reservation.id);
  expect(r.risk.retained.budget.orders).toEqual({ current: 0, projected: 1 });
  expect(r.validUntil).toBeLessThanOrEqual(f.packet.started.validUntil);
  expect(canonical(f.packet)).toBe(original);
  expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toEqual([
    {
      text: 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
      values: [canonical(f.request)],
    },
  ]);
  expect(
    fake.queries.filter((q) => q.text === 'BEGIN ISOLATION LEVEL READ COMMITTED'),
  ).toHaveLength(1);
  expect(fake.queries.filter((q) => q.text === 'COMMIT')).toHaveLength(1);
  expect(fake.queries.some((q) => /evaluate_and_reserve|INSERT|UPDATE|DELETE/u.test(q.text))).toBe(
    false,
  );
  expect(pure).not.toHaveProperty('createPostgresPaperStartedRiskSource');
  for (const key of ['grant', 'permit', 'dispatch', 'fills', 'postings'])
    expect(r).not.toHaveProperty(key);
  expect(Object.isFrozen(r)).toBe(true);
});
it('retains all 300 FIFO candidates and counts the original target only once', async () => {
  const r = await read(startedRiskFixture(300));
  expect(r.risk.retained.budget.orders).toEqual({ current: 299, projected: 300 });
});
it.each([
  ['started.journal.state.phase', 'PREPARED'],
  ['started.journal.unknown', {}],
  ['risk.journal.state.phase', 'PREPARED'],
  ['risk.request.preparationKey', 'foreign'],
  ['risk.reservation.status', 'UNKNOWN'],
  ['risk.reservation.revision', '2'],
  ['risk.capture.candidates.0.commandHash', 'f'.repeat(64)],
  ['risk.market.dbRuleId', '00000000-0000-4000-8000-000000000999'],
  ['risk.runtime.current.permissionEpoch', '999'],
  ['risk.runtime.current.userSessionEpoch', '999'],
  ['risk.asOf', wireNow - 1],
  ['asOf', wireNow + 100],
  ['started.request.startKey', 'foreign'],
  ['risk.loss.utcDayStart', 0],
])('rejects conflicting or stale known-START Risk evidence at %s', async (path, value) => {
  const f = startedRiskFixture();
  change(f.packet, path, value);
  await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_/u);
});
it('current stricter policy blocks a previously accepted START', async () => {
  const f = startedRiskFixture();
  f.packet.risk.policies[0]!.limits.maxOrderNotional = '0.01';
  f.seal();
  await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_(LIMIT|EVIDENCE)/u);
});
it('a current global pause blocks a previously accepted START', async () => {
  const f = startedRiskFixture();
  f.controls.global[0]!.state = 'PAUSED';
  f.seal();
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_LIMIT');
});
function refreshEpoch(f: ReturnType<typeof startedRiskFixture>) {
  const authorization = { ...f.request.authorization, permissionEpoch: '2' };
  f.request = { ...f.request, authorization };
  for (const path of [
    'request.authorization',
    'started.request.authorization',
    'started.capture.request.authorization',
    'started.journal.request.authorization',
    'risk.request.authorization',
    'risk.journal.request.authorization',
  ])
    change(f.packet, path, authorization);
  f.packet.risk.runtime.current.permissionEpoch = '2';
}
it('a current request cannot refresh stale runtime publication epochs', async () => {
  const f = startedRiskFixture();
  refreshEpoch(f);
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
});
it('a genuine current runtime publication restores Risk evidence without rewriting START history', async () => {
  const f = startedRiskFixture(),
    receipt = canonical(f.packet.started.journal.receipt);
  refreshEpoch(f);
  f.publication.observation.permissionEpoch = '2';
  f.seal();
  expect((await read(f)).risk.evaluation.kind).toBe('EVALUATED');
  expect(canonical(f.packet.started.journal.receipt)).toBe(receipt);
});
it.each(['FAILED', 'UNKNOWN'] as const)(
  'current executor health %s blocks a known START',
  async (status) => {
    const f = startedRiskFixture();
    f.publication.observation.health.executor.status = status;
    f.seal();
    await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_/u);
  },
);
it('expired evidence after known COMMIT delivers no result', async () => {
  const f = startedRiskFixture();
  expect(f.packet.started.validUntil).toBeLessThan(wireNow + 2000);
  fake.afterCommit = () => vi.mocked(Date.now).mockReturnValue(f.packet.started.validUntil);
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_EXPIRED');
});
it('uncertain COMMIT delivers no result and does not retry the read', async () => {
  const f = startedRiskFixture();
  fake.commitError = true;
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
  expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toHaveLength(1);
});
it('requires exactly one SQL result', async () => {
  fake.duplicate = true;
  await expect(read(startedRiskFixture())).rejects.toThrow(/PAPER_ADMISSION_/u);
});
it('rejects caller evidence, clocks or credentials before source I/O', async () => {
  const f = startedRiskFixture();
  for (const extra of [
    { source: f.packet },
    { now: wireNow },
    { connectionString: 'https://example.invalid' },
  ])
    await expect(read(f, { ...f.request, ...extra })).rejects.toThrow('PAPER_ADMISSION_INPUT');
  expect(fake.queries.some((q) => q.text.includes(' AS result'))).toBe(false);
});
it('does not execute request accessors', async () => {
  const f = startedRiskFixture();
  let visited = false;
  Object.defineProperty(f.request, 'admission', {
    enumerable: true,
    get() {
      visited = true;
      throw Error('accessor');
    },
  });
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_INPUT');
  expect(visited).toBe(false);
});
