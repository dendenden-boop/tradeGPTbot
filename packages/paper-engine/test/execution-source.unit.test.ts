import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { executionSourceWire } from './execution-source-fixtures.js';
import { wireNow } from './admission-wire-fixtures.js';
const fake = vi.hoisted<{
  payload: unknown;
  queries: string[];
  duplicate: boolean;
  afterCommit: (() => void) | null;
}>(() => ({ payload: null, queries: [], duplicate: false, afterCommit: null }));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    query(text: string) {
      fake.queries.push(text);
      if (text === 'COMMIT') fake.afterCommit?.();
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
interface Port {
  read(raw: unknown, io: ReturnType<typeof io>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
function factory() {
  const value = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperExecutionSource'
  ];
  if (typeof value !== 'function') throw Error('PAPER_EXECUTION_SOURCE_MISSING');
  return value as (options: unknown) => Promise<Port>;
}
const open = () => factory()(options);
beforeEach(() => {
  factory();
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.queries = [];
  fake.duplicate = false;
  fake.afterCommit = null;
});
afterEach(() => vi.restoreAllMocks());
function set(value: unknown, path: string, replacement: unknown) {
  const keys = path.split('.');
  let current = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) current = current[key] as Record<string, unknown>;
  current[keys.at(-1)!] = replacement;
}
it('exports only a server reader and returns immutable source after the fixed readonly RPC and COMMIT', async () => {
  expect(pure).not.toHaveProperty('createPostgresPaperExecutionSource');
  const f = executionSourceWire(),
    port = await open();
  fake.payload = f.packet;
  fake.queries = [];
  try {
    const result = await port.read(f.request, io());
    expect(result.kind).toBe('PAPER_EXECUTION_SOURCE');
    expect(result.candidates).toEqual(f.packet.candidates);
    expect(result.portfolio).toEqual(f.portfolio);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(fake.queries).toContain('SELECT ctp_paper.reconcile_admission($1::jsonb) AS result');
    expect(fake.queries.some((q) => q.includes('evaluate_and_reserve($1'))).toBe(false);
    expect(fake.queries.at(-1)).toBe('COMMIT');
    for (const key of [
      'grant',
      'permit',
      'certificate',
      'committed',
      'fills',
      'postings',
      'allocation',
      'frame',
    ])
      expect(result).not.toHaveProperty(key);
  } finally {
    await port.close();
  }
});
it('keeps all 300 supplied candidate priorities lossless above Number precision', async () => {
  const f = executionSourceWire(300),
    port = await open();
  fake.payload = f.packet;
  try {
    const result = await port.read(f.request, io());
    expect(result.candidates).toEqual(f.packet.candidates);
    expect(f.packet.candidates.at(-1)!.admissionSequence).toBe('9007199254741292');
  } finally {
    await port.close();
  }
});
it.each([
  ['asOf', wireNow + 1],
  ['validUntil', wireNow],
  ['maxEvidenceAgeMs', 0],
  ['configurationId', 'bad'],
  ['portfolio.hash', 'f'.repeat(64)],
  ['portfolio.revision', '9007199254740992'],
  ['market.record.rules.version', 'replacement'],
  ['market.record.instrument.scope.exchange', 'HTX'],
  ['market.book.stale', true],
  ['market.trade.receivedAt', wireNow + 1],
  ['market.snapshotAt', wireNow + 1],
  ['market.snapshot.revision', '0'],
  ['market.tradeReference.hash', 'bad'],
  ['candidates.0.orderId', '00000000-0000-4000-8000-000000009999'],
  ['candidates.0.commandHash', 'f'.repeat(64)],
  ['candidates.0.command.ruleVersion', 'replacement'],
  ['candidates.0.command.side', 'SELL'],
  ['candidates.0.command.reduceOnly', true],
  ['candidates.0.dbRuleId', '00000000-0000-4000-8000-000000009998'],
  ['candidates.0.admissionSequence', '9223372036854775808'],
  ['candidates.0.admissionSequence', '01'],
  ['candidates.0.admittedAt', wireNow + 1],
  ['candidates.0.original.expiresAt', 0],
  ['candidates.0.original.executionBounds.feeRate', '1'],
  ['candidates.0.debits.0.amount', '1'],
  ['candidates.0.debits.0.holdId', '00000000-0000-4000-8000-000000009997'],
  ['request.authorization.userSessionEpoch', '1'],
  ['grant', {}],
])('rejects corrupted %s content before COMMIT', async (path, replacement) => {
  const f = executionSourceWire(),
    port = await open();
  set(f.packet, path as string, replacement);
  fake.payload = f.packet;
  fake.queries = [];
  try {
    await expect(port.read(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    expect(fake.queries).toContain('ROLLBACK');
    expect(fake.queries).not.toContain('COMMIT');
  } finally {
    await port.close();
  }
});
it.each([
  'orderId',
  'intentId',
  'reservationId',
  'admissionSequence',
  'debits.0.holdId',
  'command.clientOrderId',
])('rejects duplicate %s rather than dropping a contender', async (key) => {
  const f = executionSourceWire(2),
    port = await open();
  const value = key
    .split('.')
    .reduce((v, k) => (v as Record<string, unknown>)[k], f.packet.candidates[0] as unknown);
  set(f.packet.candidates[1], key, value);
  fake.payload = f.packet;
  try {
    await expect(port.read(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  } finally {
    await port.close();
  }
});
it('rejects reversed priorities instead of silently sorting potentially incomplete SQL evidence', async () => {
  const f = executionSourceWire(2),
    port = await open();
  f.packet.candidates.reverse();
  fake.payload = f.packet;
  try {
    await expect(port.read(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  } finally {
    await port.close();
  }
});
it.each(['candidates', 'permit', 'fills', 'tenantId'])(
  'rejects caller-added %s before operation SQL',
  async (key) => {
    const f = executionSourceWire(),
      port = await open();
    fake.queries = [];
    try {
      await expect(port.read({ ...f.request, [key]: [] }, io())).rejects.toThrow(
        'PAPER_ADMISSION_INPUT',
      );
      expect(fake.queries).toEqual([]);
    } finally {
      await port.close();
    }
  },
);
it('rejects duplicate RPC rows', async () => {
  const f = executionSourceWire(),
    port = await open();
  fake.payload = f.packet;
  fake.duplicate = true;
  try {
    await expect(port.read(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  } finally {
    await port.close();
  }
});
it('returns no expired evidence if cleanup crosses freshness after COMMIT', async () => {
  const f = executionSourceWire(),
    port = await open();
  fake.payload = f.packet;
  fake.afterCommit = () => vi.mocked(Date.now).mockReturnValue(f.packet.validUntil);
  try {
    await expect(
      port.read(f.request, { ...io(), deadline: f.packet.validUntil + 1000 }),
    ).rejects.toThrow('PAPER_ADMISSION_EXPIRED');
  } finally {
    await port.close();
  }
});
