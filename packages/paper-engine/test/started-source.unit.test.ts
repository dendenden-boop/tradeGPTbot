import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { canonical } from '@ctp/portfolio';
import type { PaperExecutionSource } from '../src/postgres-execution-source.js';
import type { PaperExecutionAttempt } from '../src/execution-attempt.js';
import { startedSourceFixture } from './started-source-fixtures.js';
import { wireNow } from './admission-wire-fixtures.js';
const fake = vi.hoisted<{
  payload: unknown;
  queries: { text: string; values: readonly unknown[] }[];
  duplicate: boolean;
  commitError: boolean;
  afterCommit: null | (() => void);
}>(() => ({ payload: null, queries: [], duplicate: false, commitError: false, afterCommit: null }));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    query(text: string, values: readonly unknown[] = []) {
      fake.queries.push({ text, values });
      if (text === 'COMMIT') {
        fake.afterCommit?.();
        if (fake.commitError) return Promise.reject(Error('private COMMIT loss'));
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
interface Source {
  kind: string;
  asOf: number;
  validUntil: number;
  hash: string;
  request: unknown;
  source: PaperExecutionSource;
  journal: { state: PaperExecutionAttempt; receipt: unknown };
  entries: readonly unknown[];
}
interface Reader {
  read(request: unknown, io: { signal: AbortSignal; deadline: number }): Promise<Source>;
  close(): Promise<void>;
}
function factory() {
  const fn = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperStartedExecutionSource'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_STARTED_SOURCE_FACTORY_MISSING');
  return fn as (options: unknown) => Promise<Reader>;
}
const options = {
  connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
  environment: 'test',
};
const io = (signal = new AbortController().signal) => ({ signal, deadline: Date.now() + 2000 });
beforeEach(() => {
  factory();
  vi.spyOn(Date, 'now').mockReturnValue(wireNow + 1);
  fake.payload = null;
  fake.queries = [];
  fake.duplicate = false;
  fake.commitError = false;
  fake.afterCommit = null;
});
afterEach(() => vi.restoreAllMocks());
const changed = (raw: unknown, path: string, value: unknown) => {
  const result = structuredClone(raw) as Record<string, unknown>,
    keys = path.split('.');
  let at = result;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[keys.at(-1)!] = value;
  return result;
};
async function read(payload: unknown, request: unknown = startedSourceFixture().request) {
  const port = await factory()(options);
  fake.payload = payload;
  fake.queries = [];
  try {
    return await port.read(request, io());
  } finally {
    await port.close();
  }
}
it('reads one coherent known START and current source via one fixed readonly RPC; pure root exposes no factory', async () => {
  const f = startedSourceFixture(),
    r = await read(f.packet, f.request);
  expect(pure).not.toHaveProperty('createPostgresPaperStartedExecutionSource');
  expect(r.kind).toBe('PAPER_STARTED_EXECUTION_SOURCE');
  expect(r.journal.state).toEqual(f.started);
  expect(r.entries).toEqual(f.packet.entries);
  expect(r.source.candidates[0]!.admissionSequence).toBe('9007199254740993');
  expect(r.validUntil).toBe(f.packet.validUntil);
  const calls = fake.queries.filter((q) => q.text.includes(' AS result'));
  expect(calls).toEqual([
    {
      text: 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
      values: [canonical(f.request)],
    },
  ]);
  for (const key of ['permit', 'grant', 'fills', 'postings', 'dispatch'])
    expect(r).not.toHaveProperty(key);
  expect(Object.isFrozen(r)).toBe(true);
  expect(Object.isFrozen(r.source.portfolio)).toBe(true);
});
it('retains the entire FIFO queue, with one real STARTED target and later PREPARED entries', async () => {
  const f = startedSourceFixture(2),
    r = await read(f.packet, f.request);
  expect(r.entries).toHaveLength(2);
  expect(r.entries).toEqual(f.packet.entries);
  expect(r.source.book.revision).toBe('3');
});
it.each([
  ['request.startKey', 'other'],
  ['journal.request.preparationKey', 'other'],
  ['journal.kind', 'MISSING'],
  ['journal.state.phase', 'PREPARED'],
  ['capture.request.admission.orderId', '88888888-8888-4888-8888-888888888888'],
  ['capture.configurationId', '88888888-8888-4888-8888-888888888888'],
  ['capture.portfolio.bookId', '88888888-8888-4888-8888-888888888888'],
  ['capture.portfolio.revision', '1'],
  ['capture.portfolio.hash', '0'.repeat(64)],
  ['entries.0.kind', 'PREPARED'],
  ['entries.0.key', 'other'],
  ['entries.0.state.requestHash', '0'.repeat(64)],
  ['entries.0.preparation.requestHash', '0'.repeat(64)],
  ['validUntil', wireNow + 5000],
  ['asOf', wireNow - 1],
  ['context.current.permissionEpoch', '0'],
  ['context.configuration.hash', '0'.repeat(64)],
  ['context.owner.accountId', '88888888-8888-4888-8888-888888888888'],
])('rejects contradictory coherent source %s', async (path, value) => {
  const f = startedSourceFixture();
  await expect(read(changed(f.packet, path, value), f.request)).rejects.toThrow();
});
it('rejects durable UNKNOWN instead of turning reconciliation history into executable input', async () => {
  const f = startedSourceFixture();
  const payload = {
    ...f.packet,
    journal: { ...f.packet.journal, state: f.unknown, unknown: f.cause },
  };
  await expect(read(payload, f.request)).rejects.toThrow();
});
it('rejects incomplete, duplicated and reordered preparations rather than dropping contenders', async () => {
  const f = startedSourceFixture(2);
  for (const entries of [
    f.packet.entries.slice(0, 1),
    [f.packet.entries[0], f.packet.entries[0]],
    [...f.packet.entries].reverse(),
  ])
    await expect(read({ ...f.packet, entries }, f.request)).rejects.toThrow();
});
it('preserves historical START authorization while matching both current request authorization selectors', async () => {
  const f = startedSourceFixture(),
    auth = { permissionEpoch: '9007199254740994', userSessionEpoch: '1' };
  const request = { ...f.request, authorization: auth };
  const payload = {
    ...f.packet,
    request,
    journal: { ...f.packet.journal, request: { ...f.packet.journal.request, authorization: auth } },
    capture: { ...f.packet.capture, request: { ...f.packet.capture.request, authorization: auth } },
    context: { ...f.packet.context, current: { ...f.packet.context.current, ...auth } },
  };
  const r = await read(payload, request);
  expect(r.journal.receipt).toEqual(f.receipt);
});
it('does not accept an earlier contender even when the target START content is otherwise valid', async () => {
  const f = startedSourceFixture(2),
    capture = { ...f.packet.capture, candidates: [...f.packet.capture.candidates].reverse() };
  await expect(read({ ...f.packet, capture }, f.request)).rejects.toThrow();
});
it('rechecks evidence expiry after the actual COMMIT', async () => {
  const f = startedSourceFixture();
  fake.afterCommit = () => vi.mocked(Date.now).mockReturnValue(f.packet.validUntil);
  await expect(read(f.packet, f.request)).rejects.toThrow('PAPER_ADMISSION_EXPIRED');
});
it('rejects abort while COMMIT is being confirmed without yielding a source or grant', async () => {
  const f = startedSourceFixture(),
    controller = new AbortController(),
    port = await factory()(options);
  fake.payload = f.packet;
  fake.afterCommit = () => controller.abort();
  try {
    await expect(port.read(f.request, io(controller.signal))).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
  } finally {
    await port.close();
  }
});
it('uncertain COMMIT yields no result; explicit reopen performs another read with zero mutation calls', async () => {
  const f = startedSourceFixture();
  fake.commitError = true;
  await expect(read(f.packet, f.request)).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
  fake.commitError = false;
  expect((await read(f.packet, f.request)).journal.receipt).toEqual(f.receipt);
  expect(fake.queries.some((q) => q.text.includes('evaluate_and_reserve'))).toBe(false);
});
it('requires exactly one database result row', async () => {
  const f = startedSourceFixture();
  fake.duplicate = true;
  await expect(read(f.packet, f.request)).rejects.toThrow();
});
it('rejects untrusted source/clock/credential fields before source IO', async () => {
  const f = startedSourceFixture(),
    port = await factory()(options);
  fake.queries = [];
  try {
    for (const extra of [
      { source: f.packet.capture },
      { now: wireNow },
      { connectionString: options.connectionString },
    ])
      await expect(port.read({ ...f.request, ...extra }, io())).rejects.toThrow(
        'PAPER_ADMISSION_INPUT',
      );
    expect(fake.queries.some((q) => q.text.includes(' AS result'))).toBe(false);
  } finally {
    await port.close();
  }
});
it('rejects request accessors before executing them', async () => {
  const f = startedSourceFixture(),
    request = { ...f.request };
  let visited = false;
  Object.defineProperty(request, 'admission', {
    enumerable: true,
    get() {
      visited = true;
      throw Error('ACCESSOR');
    },
  });
  await expect(read(f.packet, request)).rejects.toThrow();
  expect(visited).toBe(false);
});
