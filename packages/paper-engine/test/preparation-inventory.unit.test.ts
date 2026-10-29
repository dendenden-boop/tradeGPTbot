import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { canonical } from '@ctp/portfolio';
import { executionSourceWire } from './execution-source-fixtures.js';
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
      if (text.includes(' AS safe')) return Promise.resolve({ rows: [{ safe: true }] });
      if (text.includes(' AS result'))
        return Promise.resolve({
          rows: Array.from({ length: fake.duplicate ? 2 : 1 }, () => ({ result: fake.payload })),
        });
      if (text === 'COMMIT') {
        fake.afterCommit?.();
        if (fake.commitError) return Promise.reject(Error('private commit failure'));
      }
      return Promise.resolve({ rows: [] });
    }
  },
}));
interface Port {
  read(
    raw: unknown,
    io: { signal: AbortSignal; deadline: number },
  ): Promise<{
    kind: string;
    source: { candidates: unknown[] };
    entries: unknown[];
    validUntil: number;
  }>;
  close(): Promise<void>;
}
function factory() {
  const f = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperPreparationInventorySource'
  ];
  if (typeof f !== 'function') throw Error('PAPER_PREPARATION_INVENTORY_SOURCE_MISSING');
  return f as (options: unknown) => Promise<Port>;
}
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(count = 2, expired = false) {
  const f = executionSourceWire(count);
  const request = { ...f.request, kind: 'PAPER_PREPARATION_INVENTORY_CAPTURE' };
  if (expired) for (const c of f.packet.candidates) c.original.expiresAt = wireNow - 1;
  const entries = f.packet.candidates.map((c, index) =>
    index % 2
      ? { kind: 'MISSING', intentId: c.intentId }
      : {
          kind: 'PREPARED',
          intentId: c.intentId,
          key: 'prepare:' + index,
          preparation: pure.preparePaperExecutionAttempt({
            attemptId: id(index),
            preparedAt: wireNow - 2,
            admission: {
              binding: f.request.admission.binding,
              orderId: c.orderId,
              intentId: c.intentId,
              reservationId: c.reservationId,
              decisionId: c.decisionId,
              dbInstrumentId: c.dbInstrumentId,
              dbRuleId: c.dbRuleId,
              command: c.command,
              commandHash: c.commandHash,
              admissionSequence: c.admissionSequence,
              admittedAt: c.admittedAt,
              expiresAt: c.original.expiresAt,
            },
          }),
        },
  );
  return {
    request,
    packet: {
      kind: 'PAPER_PREPARATION_INVENTORY_CAPTURE',
      request,
      asOf: wireNow,
      capture: f.packet,
      entries,
    },
  };
}
const io = () => ({ signal: new AbortController().signal, deadline: wireNow + 2000 });
const open = () =>
  factory()({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
beforeEach(() => {
  factory();
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.queries = [];
  fake.duplicate = false;
  fake.commitError = false;
  fake.afterCommit = null;
});
afterEach(() => vi.restoreAllMocks());
function set(raw: unknown, path: string, value: unknown) {
  const keys = path.split('.');
  let node = raw as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>;
  node[keys.at(-1)!] = value;
}
async function rejects(packet: unknown, request = fixture().request) {
  const p = await open();
  fake.payload = packet;
  fake.queries = [];
  try {
    await expect(p.read(request, io())).rejects.toThrow(/PAPER_ADMISSION_/u);
    expect(
      fake.queries.some((q) => q.text.startsWith('SELECT ctp_paper.evaluate_and_reserve(')),
    ).toBe(false);
  } finally {
    await p.close();
  }
}
it.each([1, 2, 300])(
  'joins every one of %s original FIFO candidates, preserving explicit MISSING and lossless priorities without authority',
  async (count) => {
    const f = fixture(count),
      p = await open();
    fake.payload = f.packet;
    fake.queries = [];
    try {
      const v = await p.read(f.request, io());
      expect(v.kind).toBe('PAPER_PREPARATION_INVENTORY_SOURCE');
      expect(v.entries).toEqual(f.packet.entries);
      expect(v.source.candidates).toEqual(f.packet.capture.candidates);
      expect(Object.isFrozen(v)).toBe(true);
      expect(Object.isFrozen(v.entries)).toBe(true);
      expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toEqual([
        {
          text: 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
          values: [canonical(f.request)],
        },
      ]);
      expect(fake.queries.filter((q) => q.text.startsWith('BEGIN'))).toHaveLength(1);
      expect(fake.queries.at(-1)?.text).toBe('COMMIT');
      for (const k of [
        'grant',
        'certificate',
        'permit',
        'startedAt',
        'submittedAt',
        'allocation',
        'fills',
        'postings',
      ])
        expect(v).not.toHaveProperty(k);
      expect(pure).not.toHaveProperty('createPostgresPaperPreparationInventorySource');
    } finally {
      await p.close();
    }
  },
);
it('retains expired historical preparation without renewing its expiry or converting it into permission', async () => {
  const f = fixture(2, true),
    p = await open();
  fake.payload = f.packet;
  try {
    expect((await p.read(f.request, io())).entries).toEqual(f.packet.entries);
  } finally {
    await p.close();
  }
});
it.each([
  ['kind', 'OTHER'],
  ['asOf', wireNow + 1],
  ['asOf', wireNow - 20],
  ['request.authorization.permissionEpoch', '99'],
  ['entries.0.kind', 'STARTED'],
  ['entries.0.intentId', id(77)],
  ['entries.1.intentId', id(78)],
  ['entries.0.key', ''],
  ['entries.0.key', 'x'.repeat(129)],
  ['entries.0.preparation.phase', 'STARTED'],
  ['entries.0.preparation.startedAt', wireNow],
  ['entries.0.preparation.revision', '2'],
  ['entries.0.preparation.request.preparedAt', wireNow + 1],
  ['entries.0.preparation.request.admission.orderId', id(42)],
  ['entries.0.preparation.request.admission.intentId', id(43)],
  ['entries.0.preparation.request.admission.reservationId', id(44)],
  ['entries.0.preparation.request.admission.decisionId', id(45)],
  ['entries.0.preparation.request.admission.dbRuleId', id(46)],
  ['entries.0.preparation.request.admission.admissionSequence', '9007199254740992'],
  ['entries.0.preparation.request.admission.expiresAt', wireNow + 9999],
  ['entries.0.preparation.requestHash', 'f'.repeat(64)],
  ['entries.0.grant', true],
  ['entries.1.preparation', null],
  ['capture.candidates.1.admissionSequence', '1'],
] as const)('rejects conflicting or caller-added inventory content %s', async (path, value) => {
  const f = fixture();
  set(f.packet, path, value);
  await rejects(f.packet);
});
it.each(['omit', 'extra', 'reverse', 'duplicate', 'duplicate-key', 'duplicate-attempt'] as const)(
  'rejects incomplete/ambiguous inventory: %s',
  async (mode) => {
    const f = fixture(4);
    const e = f.packet.entries;
    if (mode === 'omit') e.pop();
    if (mode === 'extra') e.push(e[0]!);
    if (mode === 'reverse') e.reverse();
    if (mode === 'duplicate') e[1] = structuredClone(e[0]!);
    if (mode === 'duplicate-key') set(f.packet, 'entries.2.key', 'prepare:0');
    if (mode === 'duplicate-attempt')
      set(f.packet, 'entries.2.preparation.request.attemptId', id(0));
    await rejects(f.packet);
  },
);
it.each(['tenantId', 'connectionId', 'sql', 'url', 'credentials'] as const)(
  'rejects caller request option %s before SQL',
  async (key) => {
    const f = fixture(),
      p = await open();
    fake.payload = f.packet;
    fake.queries = [];
    try {
      await expect(p.read({ ...f.request, [key]: 'untrusted' }, io())).rejects.toThrow(
        /PAPER_ADMISSION_/u,
      );
      expect(fake.queries).toHaveLength(0);
    } finally {
      await p.close();
    }
  },
);
it('returns no evidence on uncertain COMMIT; readonly recapture preserves original missing/prepared history', async () => {
  const f = fixture(),
    p = await open();
  fake.payload = f.packet;
  fake.commitError = true;
  try {
    await expect(p.read(f.request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    fake.commitError = false;
    expect((await p.read(f.request, io())).entries).toEqual(f.packet.entries);
  } finally {
    await p.close();
  }
});
it.each(['expiry', 'abort', 'deadline'] as const)(
  'returns no source after COMMIT delivery crosses %s',
  async (mode) => {
    const f = fixture(),
      p = await open(),
      ctx = io(),
      abort = new AbortController();
    ctx.signal = abort.signal;
    fake.payload = f.packet;
    fake.afterCommit = () => {
      if (mode === 'abort') abort.abort();
      else
        vi.mocked(Date.now).mockReturnValue(
          mode === 'expiry' ? f.packet.capture.validUntil : ctx.deadline,
        );
    };
    try {
      await expect(p.read(f.request, ctx)).rejects.toThrow(/PAPER_ADMISSION_/u);
    } finally {
      await p.close();
    }
  },
);
it('rejects duplicate SQL results', async () => {
  fake.duplicate = true;
  await rejects(fixture().packet);
});
it('rejects accessor/cycle/excessive arrays before visiting unexpected members', async () => {
  const f = fixture();
  let calls = 0;
  const poison = {
    ...f.packet,
    unexpected: Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        calls++;
        throw Error('poison');
      },
    }),
  };
  await rejects(poison);
  expect(calls).toBe(0);
  await rejects({ ...f.packet, entries: Array(301).fill(f.packet.entries[0]) });
  const cycle: Record<string, unknown> = { ...f.packet };
  cycle['cycle'] = cycle;
  await rejects(cycle);
});
