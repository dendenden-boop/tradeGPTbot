import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical, valuePortfolio } from '@ctp/portfolio';
import { marketSnapshotPublicationSchema } from '@ctp/market-data';
import { normalizedFixtures } from '../../exchange-core/test/fixtures/domain.js';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { executedBookFixture } from './executed-book-fixtures.js';

const fake = vi.hoisted<{
  payload: unknown;
  trace: string[];
  values: unknown[][];
  duplicate: boolean;
  commitError: boolean;
  afterCommit: null | (() => void);
}>(() => ({
  payload: null,
  trace: [],
  values: [],
  duplicate: false,
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
      if (text === 'COMMIT') {
        fake.afterCommit?.();
        if (fake.commitError && fake.values.length > 0) throw Error('private lost read COMMIT');
      }
      if (text.includes(' AS result')) fake.values = [...fake.values, [...values]];
      return {
        rows: text.includes(' AS safe')
          ? [{ safe: true }]
          : text.includes(' AS result')
            ? Array.from({ length: fake.duplicate ? 2 : 1 }, () => ({ result: fake.payload }))
            : [],
      };
    }
  },
}));
interface Result {
  kind: string;
  source: {
    kind: string;
    asOf: number;
    validUntil: number;
    hash: string;
    book: { content: { portfolio: unknown; evaluatedAt: number }; hash: string };
    valuation: {
      quote: string;
      equity: string;
      positions: { unrealizedGross: string; netRealized: string }[];
    };
  };
}
interface Reader {
  read(request: unknown, io: { signal: AbortSignal; deadline: number }): Promise<Result>;
  close(): Promise<void>;
}
async function open() {
  const fn = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperExecutedValuationSource'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_EXECUTED_VALUATION_SOURCE_MISSING');
  return (fn as (options: unknown) => Promise<Reader>)({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const f = executedBookFixture(),
    now = f.now + 20000,
    c = f.packet.source.started.capture,
    native = normalizedFixtures();
  const publication = marketSnapshotPublicationSchema.parse({
    id: randomUUID(),
    kind: 'SNAPSHOT',
    expectedRevision: '9007199254740993',
    timestamp: now,
    key: {
      scope: c.market.record.instrument.scope,
      instrumentId: c.market.record.instrument.id,
      dbInstrumentId: c.market.dbInstrumentId,
      dbRuleId: c.market.dbRuleId,
    },
    record: c.market.record,
    ticker: {
      ...native.ticker,
      last: { state: 'AVAILABLE', value: '12.05' },
      receivedAt: now,
      exchangeTime: now,
    },
    book: { ...c.market.book, receivedAt: now, exchangeTime: now },
  });
  if (publication.kind !== 'SNAPSHOT') throw Error('VALUATION_FIXTURE');
  const request = { ...f.request, kind: 'PAPER_EXECUTED_VALUATION_CAPTURE' };
  const market = {
    id: publication.id,
    revision: '9007199254740994',
    hash: '',
    publicationText: JSON.stringify(publication),
  };
  market.hash = digest(market.publicationText);
  const wire = { kind: request.kind, request, asOf: now, execution: f.packet, markets: [market] };
  return { ...f, now, request, wire, publication, market };
}
function reseal(f: ReturnType<typeof fixture>) {
  f.market.publicationText = JSON.stringify(f.publication);
  f.market.hash = digest(f.market.publicationText);
}
beforeEach(() =>
  Object.assign(fake, {
    payload: null,
    trace: [],
    values: [],
    duplicate: false,
    commitError: false,
    afterCommit: null,
  }),
);
afterEach(() => vi.restoreAllMocks());
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
async function read(f: ReturnType<typeof fixture>, request: unknown = f.request) {
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  const reader = await open();
  fake.payload ??= f.wire;
  fake.trace = [];
  fake.values = [];
  try {
    return await reader.read(request, io());
  } finally {
    await reader.close();
  }
}
it('values a genuinely evolved Spot book once using current marks without adding unrealized PnL to equity', async () => {
  const f = fixture(),
    result = await read(f),
    state = f.packet.effects.state;
  const oracle = valuePortfolio(
    [state],
    [
      {
        asset: 'BTC',
        quote: 'USDT',
        price: '12.05',
        kind: 'LAST',
        fresh: true,
        asOf: f.now,
        sourceId: f.market.id,
      },
    ],
    { quote: 'USDT', now: f.now, reconciledAfterRestart: true },
  );
  expect(result.kind).toBe('CAPTURED');
  expect(result.source.kind).toBe('PAPER_EXECUTED_VALUATION_SOURCE');
  expect(result.source.valuation.equity).toBe(oracle.estimate);
  expect(result.source.valuation.positions[0]).toMatchObject({
    unrealizedGross: oracle.accounts[0]!.positions[0]!.unrealizedGross,
    netRealized: oracle.accounts[0]!.positions[0]!.netRealized,
  });
  expect(result.source.valuation.positions[0]!.unrealizedGross).not.toBe('0');
  expect(result.source.book.content.portfolio).toEqual(state);
  expect(f.now - state.snapshotAt!).toBeGreaterThan(15000);
  expect(result.source.validUntil).toBe(f.now + 5001);
  expect(fake.values).toEqual([[canonical(f.request)]]);
  expect(fake.trace.filter((t) => t.includes(' AS result'))).toEqual([
    'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
  ]);
  expect(fake.trace.some((t) => t.includes('evaluate_and_reserve'))).toBe(false);
  expect(Object.isFrozen(result.source.book.content.portfolio)).toBe(true);
  expect('grant' in result.source || 'permit' in result.source).toBe(false);
});
it('does not renew price expiry or historical economic timestamps when capture time advances', async () => {
  const f = fixture(),
    first = await read(f);
  f.now += 10;
  f.wire.asOf += 10;
  const next = await read(f);
  expect(next.source.hash).toBe(first.source.hash);
  expect(next.source.book.content).toEqual(first.source.book.content);
  expect(next.source.validUntil).toBe(first.source.validUntil);
});
it.each([
  'missing-price',
  'hash',
  'duplicate',
  'revision',
  'instrument',
  'scope',
  'future-price',
  'stale-price',
  'retired-rule',
  'execution',
  'echo',
  'future-capture',
  'stale-capture',
])('fails closed on %s evidence before read COMMIT', async (fault) => {
  const f = fixture();
  if (fault === 'missing-price') f.wire.markets = [];
  else if (fault === 'hash') f.market.hash = 'a'.repeat(64);
  else if (fault === 'duplicate') f.wire.markets.push(f.market);
  else if (fault === 'revision') f.market.revision = f.publication.expectedRevision;
  else if (fault === 'instrument') {
    f.publication.key.dbInstrumentId = randomUUID();
    reseal(f);
  } else if (fault === 'scope') {
    f.publication.key.scope = { ...f.publication.key.scope, environment: 'LIVE' };
    reseal(f);
  } else if (fault === 'future-price' || fault === 'stale-price') {
    f.publication.timestamp = f.now + (fault === 'future-price' ? 1 : -5001);
    reseal(f);
  } else if (fault === 'retired-rule') {
    f.publication.record.rules.expiresAt = f.now;
    reseal(f);
  } else if (fault === 'execution') {
    f.packet.effects.state = structuredClone(f.packet.effects.state);
    f.packet.effects.state.balances[0]!.total = '123';
  } else if (fault === 'echo') f.wire.request = { ...f.request, executionKey: 'other' };
  else f.wire.asOf = f.now + (fault === 'future-capture' ? 1 : -5001);
  await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_(EVIDENCE|EXPIRED)/u);
  expect(fake.trace).not.toContain('COMMIT');
});
it('returns MISSING without market evidence and without creating execution or holds', async () => {
  const f = fixture();
  fake.payload = { kind: 'MISSING', request: f.request };
  expect(await read(f)).toEqual({ kind: 'MISSING' });
});
it.each([
  { prices: [] },
  { asOf: 1 },
  { tenantId: 'caller' },
  { rpc: 'execute' },
  { kind: 'PAPER_EXECUTION_COMMIT' },
])('rejects caller-supplied authority %j before SQL', async (patch) => {
  const f = fixture();
  await expect(read(f, { ...f.request, ...patch })).rejects.toThrow('PAPER_ADMISSION_INPUT');
  expect(fake.values).toEqual([]);
});
it('returns no valuation on uncertain read COMMIT and never retries', async () => {
  const f = fixture();
  fake.commitError = true;
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
  expect(fake.values).toHaveLength(1);
});
it('rejects prices that expire during read COMMIT', async () => {
  const f = fixture();
  f.publication.timestamp -= 4900;
  reseal(f);
  fake.afterCommit = () => vi.mocked(Date.now).mockReturnValue(f.now + 200);
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_EXPIRED');
});
it('keeps the server source absent from the public calculator entrypoint', () => {
  expect('createPostgresPaperExecutedValuationSource' in pure).toBe(false);
});
it('accepts current v2 marking metadata while preserving the original v1 execution and timestamps', async () => {
  const f = fixture();
  f.publication.key.dbRuleId = randomUUID();
  f.publication.record.rules.version = 'marking-v2';
  f.publication.record.rules.effectiveAt = f.now - 1;
  reseal(f);
  const result = await read(f);
  expect(result.source.book.content.portfolio).toEqual(f.packet.effects.state);
  expect(result.source.book.content.evaluatedAt).toBe(f.packet.evaluatedAt);
});
it('rejects source accessors without invoking them', async () => {
  const f = fixture(),
    getter = vi.fn(() => f.packet);
  Object.defineProperty(f.wire, 'execution', { enumerable: true, get: getter });
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(getter).not.toHaveBeenCalled();
});
it('rejects cyclic source packets before parsing or hashing', async () => {
  const f = fixture();
  fake.payload = { kind: f.request.kind, cycle: null };
  (fake.payload as { cycle: unknown }).cycle = fake.payload;
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
});
it('bounds the public head array before decoding its entries', async () => {
  const f = fixture();
  f.wire.markets = Array.from({ length: 65 }, () => f.market);
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_LIMIT');
});
it('rejects ambiguous RPC cardinality', async () => {
  const f = fixture();
  fake.duplicate = true;
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
});
it('rejects a conflicting MISSING echo', async () => {
  const f = fixture();
  fake.payload = { kind: 'MISSING', request: { ...f.request, executionKey: 'other' } };
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
});
it('pre-aborted capture performs no read SQL', async () => {
  const f = fixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  const reader = await open(),
    controller = new AbortController();
  controller.abort();
  fake.trace = [];
  try {
    await expect(
      reader.read(f.request, { signal: controller.signal, deadline: f.now + 2000 }),
    ).rejects.toThrow('PAPER_ADMISSION_ABORTED');
    expect(fake.trace).toEqual([]);
  } finally {
    await reader.close();
  }
});
it('abort during COMMIT returns no valuation or retry', async () => {
  const f = fixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  const reader = await open(),
    controller = new AbortController();
  fake.payload = f.wire;
  fake.afterCommit = () => controller.abort();
  try {
    await expect(
      reader.read(f.request, { signal: controller.signal, deadline: f.now + 2000 }),
    ).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(fake.values).toHaveLength(1);
  } finally {
    await reader.close();
  }
});
