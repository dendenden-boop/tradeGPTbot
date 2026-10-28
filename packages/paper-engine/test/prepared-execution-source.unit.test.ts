import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical } from '@ctp/portfolio';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import {
  preparedSourceFixture,
  preparedSourceId as id,
} from './prepared-execution-source-fixtures.js';
import { wireNow } from './admission-wire-fixtures.js';
const fake = vi.hoisted<{
  payloads: unknown[];
  queries: { text: string; values: readonly unknown[] }[];
  index: number;
  duplicateAt: number;
  failAt: number;
  commitError: boolean;
  onResult: ((n: number) => void) | null;
  afterCommit: (() => void) | null;
}>(() => ({
  payloads: [],
  queries: [],
  index: 0,
  duplicateAt: -1,
  failAt: -1,
  commitError: false,
  onResult: null,
  afterCommit: null,
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    query(text: string, values: readonly unknown[] = []) {
      fake.queries.push({ text, values });
      if (text.includes(' AS safe')) return Promise.resolve({ rows: [{ safe: true }] });
      if (text.includes(' AS result')) {
        const n = fake.index++;
        fake.onResult?.(n);
        if (fake.failAt === n) return Promise.reject(Error('PAPER_ADMISSION_EVIDENCE'));
        return Promise.resolve({
          rows: Array.from({ length: fake.duplicateAt === n ? 2 : 1 }, () => ({
            result: fake.payloads[n],
          })),
        });
      }
      if (text === 'COMMIT') {
        fake.afterCommit?.();
        if (fake.commitError) return Promise.reject(Error('private COMMIT failure'));
      }
      return Promise.resolve({ rows: [] });
    }
  },
}));
type Attempt = ReturnType<typeof pure.preparePaperExecutionAttempt>;
interface View {
  kind: string;
  hash: string;
  asOf: number;
  validUntil: number;
  request: unknown;
  preparation: Attempt;
  source: { candidates: unknown[]; portfolio: unknown; hash: string };
}
interface Port {
  read(raw: unknown, io: { signal: AbortSignal; deadline: number }): Promise<View>;
  close(): Promise<void>;
}
function factory() {
  const f = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperPreparedExecutionSource'
  ];
  if (typeof f !== 'function') throw Error('PAPER_PREPARED_EXECUTION_SOURCE_MISSING');
  return f as (options: unknown) => Promise<Port>;
}
const open = () =>
  factory()({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
const io = () => ({ signal: new AbortController().signal, deadline: wireNow + 2000 });
beforeEach(() => {
  factory();
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.queries = [];
  fake.payloads = [];
  fake.index = 0;
  fake.duplicateAt = -1;
  fake.failAt = -1;
  fake.commitError = false;
  fake.onResult = null;
  fake.afterCommit = null;
});
afterEach(() => vi.restoreAllMocks());
function load(f: ReturnType<typeof preparedSourceFixture>) {
  fake.payloads = [f.packet, f.journal];
}
async function rejects(f: ReturnType<typeof preparedSourceFixture>, code = /PAPER_ADMISSION_/u) {
  load(f);
  const p = await open();
  try {
    await expect(p.read(f.request, io())).rejects.toThrow(code);
    expect(fake.queries.some((q) => q.text.includes('evaluate_and_reserve('))).toBe(false);
  } finally {
    await p.close();
  }
}

it('uses one bounded transaction and two fixed readonly RPCs, binding actual preparation to the complete source', async () => {
  const f = preparedSourceFixture(2);
  load(f);
  const p = await open();
  fake.queries = [];
  try {
    const v = await p.read(f.request, io());
    expect(v.kind).toBe('PAPER_PREPARED_EXECUTION_SOURCE');
    expect(v.request).toEqual(f.request);
    expect(v.preparation).toEqual(f.preparation);
    expect(v.source.candidates).toEqual(f.packet.candidates);
    expect(v.source.portfolio).toEqual(f.portfolio);
    expect(v.asOf).toBe(f.packet.asOf);
    expect(v.validUntil).toBe(f.packet.validUntil);
    expect(v.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.source.candidates)).toBe(true);
    expect(Object.isFrozen(v.preparation.request.admission)).toBe(true);
    const reads = fake.queries.filter((q) => q.text.includes(' AS result'));
    expect(reads.map((q) => q.text)).toEqual(
      Array(2).fill('SELECT ctp_paper.reconcile_admission($1::jsonb) AS result'),
    );
    expect(reads.map((q) => JSON.parse(String(q.values[0])) as unknown)).toEqual([
      f.captureRequest,
      f.journal.request,
    ]);
    expect(fake.queries.filter((q) => q.text.startsWith('BEGIN'))).toHaveLength(1);
    expect(fake.queries.filter((q) => q.text === 'COMMIT')).toHaveLength(1);
    expect(fake.queries.at(-1)?.text).toBe('COMMIT');
    expect(pure).not.toHaveProperty('createPostgresPaperPreparedExecutionSource');
    for (const key of [
      'grant',
      'permit',
      'startedAt',
      'submittedAt',
      'fills',
      'allocation',
      'certificate',
      'postings',
    ])
      expect(v).not.toHaveProperty(key);
    expect(v.preparation.phase).toBe('PREPARED');
    expect(v.preparation.startedAt).toBeNull();
  } finally {
    await p.close();
  }
});
it('retains all300 FIFO candidates and lossless priorities without manufacturing preparations for other orders', async () => {
  const f = preparedSourceFixture(300);
  load(f);
  const p = await open();
  try {
    const v = await p.read(f.request, io());
    expect(v.source.candidates).toEqual(f.packet.candidates);
    expect(v.preparation.request.admission.admissionSequence).toBe('9007199254740993');
    expect(f.packet.candidates.at(-1)?.admissionSequence).toBe('9007199254741292');
    expect(v).not.toHaveProperty('attempts');
  } finally {
    await p.close();
  }
});
it('keeps original expiry historical and never renews it using the market freshness deadline', async () => {
  const f = preparedSourceFixture();
  f.packet.candidates[0]!.original.expiresAt = wireNow - 1;
  const r = {
    ...f.preparation.request,
    preparedAt: wireNow - 2,
    admission: { ...f.preparation.request.admission, expiresAt: wireNow - 1 },
  };
  f.journal.preparation = f.journal.state = pure.preparePaperExecutionAttempt(r);
  load(f);
  const p = await open();
  try {
    const v = await p.read(f.request, io());
    expect(v.preparation.request.admission.expiresAt).toBe(wireNow - 1);
    expect(v.validUntil).toBeGreaterThan(wireNow);
    expect(v).not.toHaveProperty('permit');
  } finally {
    await p.close();
  }
});
it('keeps preparation identity through reader close/reopen and performs both current reads again', async () => {
  const f = preparedSourceFixture();
  load(f);
  let p = await open();
  const first = await p.read(f.request, io());
  await p.close();
  fake.index = 0;
  p = await open();
  try {
    const second = await p.read(f.request, io());
    expect(second.preparation).toEqual(first.preparation);
    expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toHaveLength(4);
  } finally {
    await p.close();
  }
});
it.each([
  'tenantId',
  'connectionString',
  'credentials',
  'sql',
  'client',
  'role',
  'attemptId',
  'preparedAt',
  'grant',
  'permit',
  'state',
  'result',
])('rejects caller-added %s before source SQL', async (key) => {
  const f = preparedSourceFixture();
  const p = await open();
  fake.queries = [];
  try {
    await expect(p.read({ ...f.request, [key]: 'caller' }, io())).rejects.toThrow(
      'PAPER_ADMISSION_INPUT',
    );
    expect(fake.queries).toEqual([]);
  } finally {
    await p.close();
  }
});
it.each(['', 'bad key', 'x'.repeat(129)])(
  'rejects invalid preparation key %s before source SQL',
  async (preparationKey) => {
    const f = preparedSourceFixture(),
      p = await open();
    fake.queries = [];
    try {
      await expect(p.read({ ...f.request, preparationKey }, io())).rejects.toThrow(
        'PAPER_ADMISSION_INPUT',
      );
      expect(fake.queries).toEqual([]);
    } finally {
      await p.close();
    }
  },
);
it.each([null, [], {}, { kind: 'PAPER_ATTEMPT_PREPARE' }])(
  'rejects incomplete prepared source request %#',
  async (raw) => {
    const p = await open();
    fake.queries = [];
    try {
      await expect(p.read(raw, io())).rejects.toThrow('PAPER_ADMISSION_INPUT');
      expect(fake.queries).toEqual([]);
    } finally {
      await p.close();
    }
  },
);
it.each(['LIVE', 'TESTNET', 'DEMO'])('rejects native %s scope', async (mode) => {
  const f = preparedSourceFixture();
  await rejects({
    ...f,
    request: {
      ...f.request,
      admission: { ...f.request.admission, binding: { ...f.request.admission.binding, mode } },
    },
  } as ReturnType<typeof preparedSourceFixture>);
});
it('fails closed on MISSING without preparing or adopting anything', async () => {
  const f = preparedSourceFixture();
  load(f);
  fake.payloads[1] = { kind: 'MISSING', request: f.journal.request };
  const p = await open();
  try {
    await expect(p.read(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    expect(fake.queries.some((q) => q.text.includes('evaluate_and_reserve('))).toBe(false);
  } finally {
    await p.close();
  }
});
it.each(['STARTED', 'NOT_SENT', 'UNKNOWN'])(
  'does not accept a %s journal head as a pristine preparation',
  async (phase) => {
    const f = preparedSourceFixture();
    f.journal.state = { ...f.preparation, phase } as Attempt;
    await rejects(f);
  },
);
it.each([
  'reservationId',
  'decisionId',
  'dbInstrumentId',
  'dbRuleId',
  'admissionSequence',
  'admittedAt',
  'expiresAt',
])('rejects coherently hashed journal %s inconsistent with current source', async (key) => {
  const f = preparedSourceFixture();
  const a = { ...f.preparation.request.admission };
  if (['admittedAt', 'expiresAt'].includes(key))
    (a as unknown as Record<string, unknown>)[key] =
      Number(a[key as 'admittedAt' | 'expiresAt']) + (key === 'admittedAt' ? -1 : 1);
  else
    (a as unknown as Record<string, unknown>)[key] =
      key === 'admissionSequence' ? '9007199254740994' : id(9999);
  f.journal.preparation = f.journal.state = pure.preparePaperExecutionAttempt({
    ...f.preparation.request,
    admission: a,
  });
  await rejects(f);
});
it('rejects a future preparation even when its content hashes agree', async () => {
  const f = preparedSourceFixture();
  f.journal.preparation = f.journal.state = pure.preparePaperExecutionAttempt({
    ...f.preparation.request,
    preparedAt: wireNow + 1,
  });
  await rejects(f);
});
it('rejects future preparation relative to captured source even if client clock is later', async () => {
  const f = preparedSourceFixture();
  f.journal.preparation = f.journal.state = pure.preparePaperExecutionAttempt({
    ...f.preparation.request,
    preparedAt: wireNow + 1,
  });
  vi.mocked(Date.now).mockReturnValue(wireNow + 2);
  await rejects(f);
});
it.each([0, 1])('rejects duplicate SQL result rows at readonly step%i', async (n) => {
  const f = preparedSourceFixture();
  fake.duplicateAt = n;
  await rejects(f);
});
it.each([0, 1])('preserves failure at readonly step%i and never calls mutation SQL', async (n) => {
  const f = preparedSourceFixture();
  fake.failAt = n;
  await rejects(f);
  if (n === 0) expect(fake.index).toBe(1);
});
it('does not query the journal after invalid current source evidence', async () => {
  const f = preparedSourceFixture();
  f.packet.candidates = [];
  await rejects(f);
  expect(fake.index).toBe(1);
});
it('rolls back and never issues COMMIT after journal mismatch', async () => {
  const f = preparedSourceFixture();
  f.journal.request.key = 'different';
  await rejects(f);
  expect(fake.queries.some((q) => q.text === 'COMMIT')).toBe(false);
  expect(fake.queries.some((q) => q.text === 'ROLLBACK')).toBe(true);
});
it('returns no source after lost COMMIT and performs no automatic retry', async () => {
  const f = preparedSourceFixture();
  fake.commitError = true;
  await rejects(f, /PAPER_ADMISSION_UNCERTAIN/u);
  expect(fake.index).toBe(2);
  expect(fake.queries.filter((q) => q.text === 'COMMIT')).toHaveLength(1);
});
it('checks abort between the two readonly RPCs', async () => {
  const f = preparedSourceFixture();
  load(f);
  const p = await open(),
    controller = new AbortController();
  fake.onResult = () => controller.abort();
  try {
    await expect(p.read(f.request, { ...io(), signal: controller.signal })).rejects.toThrow(
      'PAPER_ADMISSION_ABORTED',
    );
    expect(fake.index).toBe(1);
    expect(fake.queries.some((q) => q.text === 'COMMIT')).toBe(false);
  } finally {
    await p.close();
  }
});
it('does not return a source that expires during COMMIT delivery', async () => {
  const f = preparedSourceFixture();
  f.packet.market.record.rules.expiresAt = wireNow + 10;
  f.packet.validUntil = wireNow + 10;
  load(f);
  const p = await open();
  fake.afterCommit = () => vi.mocked(Date.now).mockReturnValue(wireNow + 10);
  try {
    await expect(p.read(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EXPIRED');
  } finally {
    await p.close();
  }
});
it('rejects oversized current candidate inventory without reading a journal', async () => {
  const f = preparedSourceFixture(300);
  f.packet.candidates.push(structuredClone(f.packet.candidates[0]!));
  await rejects(f);
  expect(fake.index).toBe(1);
});
it('does not treat an echoed preparation key as grant or source authority', async () => {
  const f = preparedSourceFixture();
  f.journal.request.key = 'other-key';
  expect(canonical(f.packet.request)).toContain('PAPER_EXECUTION_CAPTURE');
  await rejects(f);
});
