import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical } from '@ctp/portfolio';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { executedBookFixture } from './executed-book-fixtures.js';

const fake = vi.hoisted<{
  payload: unknown;
  capturedMs: string;
  trace: string[];
  queries: { text: string; values: readonly unknown[] }[];
  duplicate: boolean;
  duplicateClock: boolean;
  commitError: boolean;
  afterCommit: null | (() => void);
}>(() => ({
  payload: null,
  capturedMs: '0',
  trace: [],
  queries: [],
  duplicate: false,
  duplicateClock: false,
  commitError: false,
  afterCommit: null,
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    async query(text: string, values: readonly unknown[] = []) {
      await Promise.resolve();
      fake.trace.push(text);
      fake.queries.push({ text, values });
      if (text === 'COMMIT') {
        fake.afterCommit?.();
        if (fake.commitError) throw Error('private lost read COMMIT');
      }
      return {
        rows: text.includes(' AS safe')
          ? [{ safe: true }]
          : text.includes(' AS result')
            ? Array.from({ length: fake.duplicate ? 2 : 1 }, () => ({ result: fake.payload }))
            : text.includes(' AS captured_ms')
              ? Array.from({ length: fake.duplicateClock ? 2 : 1 }, () => ({
                  captured_ms: fake.capturedMs,
                }))
              : [],
      };
    }
  },
}));
interface Reader {
  read(request: unknown, io: { signal: AbortSignal; deadline: number }): Promise<unknown>;
  close(): Promise<void>;
}
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
async function open() {
  const fn = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperExecutedBookSource'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_EXECUTED_BOOK_SOURCE_MISSING');
  return (fn as (options: unknown) => Promise<Reader>)({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
}
const requestOf = (f: ReturnType<typeof executedBookFixture>) => ({
  ...f.request,
  kind: 'PAPER_EXECUTED_BOOK_CAPTURE',
});
beforeEach(() => {
  Object.assign(fake, {
    payload: null,
    capturedMs: '0',
    trace: [],
    queries: [],
    duplicate: false,
    duplicateClock: false,
    commitError: false,
    afterCommit: null,
  });
});
afterEach(() => vi.restoreAllMocks());
async function read(f: ReturnType<typeof executedBookFixture>, request: unknown = requestOf(f)) {
  vi.spyOn(Date, 'now').mockReturnValue(f.now + 10);
  const reader = await open();
  fake.payload ??= f.packet;
  if (fake.capturedMs === '0') fake.capturedMs = String(f.now + 10);
  fake.trace = [];
  fake.queries = [];
  try {
    return await reader.read(request, io());
  } finally {
    await reader.close();
  }
}
it('captures the actual committed book, exact remaining collateral and consumed frame through only reconciliation', async () => {
  const f = executedBookFixture(),
    result = (await read(f)) as { kind: string; source: Record<string, unknown> };
  expect(result.kind).toBe('CAPTURED');
  expect(result.source).toMatchObject({
    kind: 'PAPER_EXECUTED_BOOK_SOURCE',
    request: requestOf(f),
    asOf: f.now + 10,
    content: {
      receipt: f.receipt,
      evaluatedAt: f.now,
      portfolio: f.packet.effects.state,
      order: f.packet.effects.order,
      reservation: f.packet.effects.reservation,
      holdChanges: f.packet.effects.holdChanges,
      frame: f.packet.effects.execution.frame,
    },
  });
  const content = result.source['content'];
  expect(result.source['hash']).toBe(createHash('sha256').update(canonical(content)).digest('hex'));
  expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toEqual([
    {
      text: 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
      values: [canonical(f.request)],
    },
  ]);
  expect(fake.trace.some((t) => t.includes('evaluate_and_reserve'))).toBe(false);
  expect(fake.trace.filter((t) => t === 'COMMIT')).toHaveLength(1);
  expect(Object.isFrozen(result.source)).toBe(true);
  expect(Object.isFrozen(content)).toBe(true);
  expect(['grant', 'permit', 'validUntil'].some((k) => k in result.source)).toBe(false);
});
it('keeps historical economic and market timestamps while fresh capture time changes without changing content identity', async () => {
  const f = executedBookFixture();
  const first = await read(f);
  fake.capturedMs = String(f.now + 11);
  vi.mocked(Date.now).mockReturnValue(f.now + 11);
  const reader = await open();
  try {
    const next = (await reader.read(requestOf(f), io())) as { source: Record<string, unknown> };
    expect(next.source['asOf']).toBe(f.now + 11);
    expect(next.source['hash']).toBe((first as typeof next).source['hash']);
    expect(next.source['content']).toEqual((first as typeof next).source['content']);
  } finally {
    await reader.close();
  }
});
it('returns exact MISSING without a captured book, clock query, grant or mutation', async () => {
  const f = executedBookFixture();
  fake.payload = { kind: 'MISSING', request: f.request };
  expect(await read(f)).toEqual({ kind: 'MISSING' });
  expect(
    fake.trace.some((t) => t.includes('captured_ms') || t.includes('evaluate_and_reserve')),
  ).toBe(false);
});
it.each(['effects', 'receipt', 'source', 'frame', 'reservation', 'request', 'evaluatedAt'])(
  'rejects conflicting committed %s before read COMMIT',
  async (field) => {
    const f = executedBookFixture();
    const p = f.packet as unknown as Record<string, unknown>;
    if (field === 'evaluatedAt') p[field] = f.now + 100;
    else if (field === 'frame' || field === 'reservation')
      (p['input'] as Record<string, unknown>)[field] = {};
    else p[field] = {};
    await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    expect(fake.trace).not.toContain('COMMIT');
  },
);
it.each(['-1', '01', '1.5', '9007199254740993', 'NaN'])(
  'rejects noncanonical or unsafe server capture timestamp %s',
  async (time) => {
    const f = executedBookFixture();
    fake.capturedMs = time;
    await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  },
);
it.each(['duplicate-result', 'duplicate-clock', 'future-clock', 'stale-clock'])(
  'rejects %s capture evidence',
  async (fault) => {
    const f = executedBookFixture();
    if (fault === 'duplicate-result') fake.duplicate = true;
    else if (fault === 'duplicate-clock') fake.duplicateClock = true;
    else fake.capturedMs = String(fault === 'future-clock' ? f.now + 11 : f.now - 6000);
    await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_(EVIDENCE|EXPIRED)/u);
  },
);
it('returns no capture after an uncertain read COMMIT and never retries', async () => {
  const f = executedBookFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now + 10);
  const reader = await open();
  fake.payload = f.packet;
  fake.capturedMs = String(f.now + 10);
  fake.trace = [];
  fake.commitError = true;
  try {
    await expect(reader.read(requestOf(f), io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(fake.trace.filter((t) => t.includes(' AS result'))).toHaveLength(1);
  } finally {
    await reader.close();
  }
});
it('rejects capture that becomes stale after COMMIT without renewing historical timestamps', async () => {
  const f = executedBookFixture();
  // Begin with a 4.9-second-old capture, then cross its freshness boundary
  // within the transport's stricter three-second operation deadline.
  vi.spyOn(Date, 'now').mockReturnValue(f.now + 4910);
  const reader = await open();
  fake.payload = f.packet;
  fake.capturedMs = String(f.now + 10);
  fake.afterCommit = () => vi.mocked(Date.now).mockReturnValue(f.now + 5210);
  try {
    await expect(
      reader.read(requestOf(f), { signal: new AbortController().signal, deadline: f.now + 20000 }),
    ).rejects.toThrow('PAPER_ADMISSION_EXPIRED');
  } finally {
    await reader.close();
  }
});
it('retains historical economic content after the original source lease expires without issuing fresh Risk authority', async () => {
  const f = executedBookFixture(),
    now = f.now + 86400000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const reader = await open();
  fake.payload = f.packet;
  fake.capturedMs = String(now);
  try {
    const result = (await reader.read(requestOf(f), io())) as {
      source: {
        asOf: number;
        content: { evaluatedAt: number; portfolio: unknown; frame: unknown };
      };
    };
    expect(result.source.asOf).toBe(now);
    expect(result.source.content).toMatchObject({
      evaluatedAt: f.now,
      portfolio: f.packet.effects.state,
      frame: f.packet.effects.execution.frame,
    });
    expect('validUntil' in result.source || 'grant' in result.source).toBe(false);
  } finally {
    await reader.close();
  }
});
it('pre-aborted capture performs no SQL and returns no source', async () => {
  const f = executedBookFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now + 10);
  const reader = await open(),
    controller = new AbortController();
  controller.abort();
  fake.trace = [];
  try {
    await expect(
      reader.read(requestOf(f), { signal: controller.signal, deadline: f.now + 2000 }),
    ).rejects.toThrow('PAPER_ADMISSION_ABORTED');
    expect(fake.trace).toEqual([]);
  } finally {
    await reader.close();
  }
});
it('abort during read COMMIT returns UNCERTAIN without a capture or retry', async () => {
  const f = executedBookFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now + 10);
  const reader = await open(),
    controller = new AbortController();
  fake.payload = f.packet;
  fake.capturedMs = String(f.now + 10);
  fake.trace = [];
  fake.afterCommit = () => controller.abort();
  try {
    await expect(
      reader.read(requestOf(f), { signal: controller.signal, deadline: f.now + 2000 }),
    ).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(fake.trace.filter((t) => t.includes(' AS result'))).toHaveLength(1);
  } finally {
    await reader.close();
  }
});
it.each([
  { kind: 'PAPER_EXECUTION_COMMIT' },
  { tenantId: 'caller' },
  { projection: {} },
  { asOf: 1 },
  { rpc: 'execute' },
])('rejects wrong kind or caller-added authority %j before SQL', async (patch) => {
  const f = executedBookFixture();
  await expect(read(f, { ...requestOf(f), ...patch })).rejects.toThrow('PAPER_ADMISSION_INPUT');
  expect(fake.queries).toEqual([]);
});
it('rejects accessors without invoking them', async () => {
  const f = executedBookFixture(),
    getter = vi.fn(() => f.request.admission);
  const request = requestOf(f);
  Object.defineProperty(request, 'admission', { enumerable: true, get: getter });
  await expect(read(f, request)).rejects.toThrow('PAPER_ADMISSION_INPUT');
  expect(getter).not.toHaveBeenCalled();
});
it('keeps economic capture absent from the public calculator root', () => {
  expect('createPostgresPaperExecutedBookSource' in pure).toBe(false);
});
