import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { executionStartFixture } from './execution-start-fixtures.js';
import { wireHash, wireNow } from './admission-wire-fixtures.js';
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
interface Journal {
  start(request: unknown, io: { signal: AbortSignal; deadline: number }): Promise<unknown>;
  read(request: unknown, io: { signal: AbortSignal; deadline: number }): Promise<unknown>;
  close(): Promise<void>;
}
const options = {
  connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
  environment: 'test',
};
function factory() {
  const fn = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperExecutionStartJournal'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_EXECUTION_START_FACTORY_MISSING');
  return fn as (options: unknown) => Promise<Journal>;
}
const io = (signal = new AbortController().signal) => ({ signal, deadline: Date.now() + 2000 });
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.payload = null;
  fake.queries = [];
  fake.duplicate = false;
  fake.commitError = false;
  fake.afterCommit = null;
});
afterEach(() => vi.restoreAllMocks());
const changed = (raw: unknown, path: string, value: unknown) => {
  const output = structuredClone(raw) as Record<string, unknown>,
    keys = path.split('.');
  let at = output;
  for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
  at[keys.at(-1)!] = value;
  return output;
};
it('exports only a server journal and returns the immutable original START receipt through the fixed RPC', async () => {
  expect(pure).not.toHaveProperty('createPostgresPaperExecutionStartJournal');
  const f = executionStartFixture(),
    port = await factory()(options);
  fake.payload = f.packet;
  fake.queries = [];
  try {
    const receipt = await port.start(f.request, io());
    expect(receipt).toEqual(f.receipt);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(fake.queries.filter((q) => q.text.includes(' AS result')).map((q) => q.text)).toEqual([
      'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
    ]);
    for (const key of ['permit', 'grant', 'fills', 'postings', 'dispatch'])
      expect(receipt).not.toHaveProperty(key);
  } finally {
    await port.close();
  }
});
it('permanent replay preserves the same receipt after original expiry and current epoch replacement', async () => {
  const f = executionStartFixture(),
    request = changed(f.request, 'authorization.permissionEpoch', '7'),
    port = await factory()(options);
  fake.payload = { ...f.packet, kind: 'REPLAY', request };
  vi.spyOn(Date, 'now').mockReturnValue(wireNow + 100000);
  try {
    expect(await port.start(request, io())).toEqual(f.receipt);
  } finally {
    await port.close();
  }
});
it('readonly MISSING never creates or retries a start', async () => {
  const f = executionStartFixture(),
    port = await factory()(options);
  fake.payload = { kind: 'MISSING', request: f.request };
  fake.queries = [];
  try {
    expect(await port.read(f.request, io())).toEqual(fake.payload);
    expect(fake.queries.filter((q) => q.text.includes(' AS result')).map((q) => q.text)).toEqual([
      'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
    ]);
  } finally {
    await port.close();
  }
});
it('a missing or multiple mutation result is not an accepted START receipt', async () => {
  const f = executionStartFixture(),
    port = await factory()(options);
  try {
    fake.payload = { kind: 'MISSING', request: f.request };
    await expect(port.start(f.request, io())).rejects.toThrow();
    fake.payload = f.packet;
    fake.duplicate = true;
    await expect(port.start(f.request, io())).rejects.toThrow();
  } finally {
    await port.close();
  }
});
it('UNKNOWN read retains the original receipt and requires its exact durable reservation cause', async () => {
  const f = executionStartFixture(),
    port = await factory()(options);
  fake.payload = { ...f.packet, kind: 'COMMITTED', state: f.unknown, unknown: f.cause };
  try {
    const result = await port.read(f.request, io());
    expect(result).toEqual(fake.payload);
    expect(Object.isFrozen(result)).toBe(true);
  } finally {
    await port.close();
  }
});
it.each(['now', 'eventId', 'risk', 'permit', 'snapshot', 'sql', 'credentials', 'endpointUrl'])(
  'rejects caller-added %s before dispatching an RPC',
  async (key) => {
    const f = executionStartFixture(),
      port = await factory()(options);
    fake.queries = [];
    try {
      await expect(port.start({ ...f.request, [key]: 'caller-value' }, io())).rejects.toThrow();
      expect(fake.queries).toEqual([]);
    } finally {
      await port.close();
    }
  },
);
it.each(['TESTNET', 'DEMO', 'LIVE'])(
  'rejects non-PAPER %s without an admission RPC',
  async (mode) => {
    const f = executionStartFixture(),
      port = await factory()(options);
    fake.queries = [];
    try {
      await expect(
        port.start(changed(f.request, 'admission.binding.mode', mode), io()),
      ).rejects.toThrow();
      expect(fake.queries).toEqual([]);
    } finally {
      await port.close();
    }
  },
);
it('rejects accessors without executing them and bounds request strings', async () => {
  const f = executionStartFixture(),
    port = await factory()(options),
    getter = vi.fn(() => 'caller');
  fake.queries = [];
  try {
    await expect(
      port.start(
        Object.defineProperty({ ...f.request }, 'startKey', { enumerable: true, get: getter }),
        io(),
      ),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    await expect(port.start({ ...f.request, startKey: 'x'.repeat(20000) }, io())).rejects.toThrow();
    expect(fake.queries).toEqual([]);
  } finally {
    await port.close();
  }
});
it.each([
  ['receipt.requestHash', '0'.repeat(64)],
  ['receipt.preparationHash', '0'.repeat(64)],
  ['receipt.validationHash', '0'.repeat(64)],
  ['receipt.eventId', 'not-a-uuid'],
  ['receipt.attemptId', '00000000-0000-4000-8000-999999999999'],
  ['receipt.validation.metadata.ruleId', '00000000-0000-4000-8000-999999999999'],
  ['receipt.validation.validatedAt', wireNow - 1],
  ['receipt.validation.validUntil', wireNow],
  ['preparation.request.admission.commandHash', '0'.repeat(64)],
  ['state.phase', 'NOT_SENT'],
])('rejects a contradictory retained %s', async (path, value) => {
  const f = executionStartFixture(),
    port = await factory()(options);
  fake.payload = changed(f.packet, path, value);
  try {
    await expect(port.start(f.request, io())).rejects.toThrow();
  } finally {
    await port.close();
  }
});
it('rejects foreign policy ownership even when a caller recomputes the plain witness checksum', async () => {
  const f = executionStartFixture(),
    port = await factory()(options);
  const packet = structuredClone(f.packet);
  packet.receipt.validation.policyHeads[1]!.tenantId = '00000000-0000-4000-8000-999999999999';
  packet.receipt.validationHash = wireHash(packet.receipt.validation);
  fake.payload = packet;
  try {
    await expect(port.start(f.request, io())).rejects.toThrow();
  } finally {
    await port.close();
  }
});
it('rejects an UNKNOWN without its actual matching cause or with time before START', async () => {
  const f = executionStartFixture(),
    port = await factory()(options);
  try {
    for (const cause of [
      null,
      { ...f.cause, reservationId: '00000000-0000-4000-8000-999999999999' },
      { ...f.cause, observedAt: wireNow - 1 },
    ]) {
      fake.payload = { ...f.packet, kind: 'COMMITTED', state: f.unknown, unknown: cause };
      await expect(port.read(f.request, io())).rejects.toThrow();
    }
  } finally {
    await port.close();
  }
});
it('pre-abort sends no RPC and post-COMMIT abort returns no receipt', async () => {
  const f = executionStartFixture(),
    port = await factory()(options),
    aborted = new AbortController();
  aborted.abort();
  fake.payload = f.packet;
  fake.queries = [];
  try {
    await expect(port.start(f.request, io(aborted.signal))).rejects.toThrow();
    expect(fake.queries).toEqual([]);
    const late = new AbortController();
    fake.afterCommit = () => late.abort();
    await expect(port.start(f.request, io(late.signal))).rejects.toThrow();
  } finally {
    await port.close();
  }
});
it('uncertain COMMIT grants no receipt and recovery performs only the explicit readonly lookup', async () => {
  const f = executionStartFixture(),
    port = await factory()(options);
  fake.payload = f.packet;
  fake.commitError = true;
  fake.queries = [];
  try {
    await expect(port.start(f.request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(fake.queries.filter((q) => q.text.includes('evaluate_and_reserve'))).toHaveLength(1);
    fake.commitError = false;
    fake.payload = { ...f.packet, kind: 'COMMITTED' };
    fake.queries = [];
    expect(await port.read(f.request, io())).toEqual(fake.payload);
    expect(fake.queries.some((q) => q.text.includes('evaluate_and_reserve'))).toBe(false);
  } finally {
    await port.close();
  }
});
it('a reopened factory obtains the same durable content by readonly lookup rather than an in-memory grant', async () => {
  const f = executionStartFixture();
  fake.payload = f.packet;
  const first = await factory()(options);
  const receipt = await first.start(f.request, io());
  await first.close();
  const second = await factory()(options);
  fake.payload = { ...f.packet, kind: 'COMMITTED' };
  fake.queries = [];
  try {
    expect(((await second.read(f.request, io())) as { receipt: unknown }).receipt).toEqual(receipt);
    expect(fake.queries.some((q) => q.text.includes('evaluate_and_reserve'))).toBe(false);
  } finally {
    await second.close();
  }
});
