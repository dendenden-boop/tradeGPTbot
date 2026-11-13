import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Decimal } from 'decimal.js';
import { parseDecimal } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { historicalInventoryFixture } from './historical-inventory-fixtures.js';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { lookupPaperExecutionCommitRequest } from '../src/postgres-execution-commit.js';
import { decodePaperExecutedValuationContents } from '../src/postgres-executed-valuation.js';
import { decodePaperBookSource } from '../src/book-source-domain.js';
import { decodePaperHistoricalInventoryContents } from '../src/postgres-historical-inventory.js';

const fake = vi.hoisted<{
  payload: unknown;
  trace: string[];
  values: unknown[][];
  duplicate: boolean;
  lostCommit: boolean;
  afterCommit: null | (() => void);
}>(() => ({
  payload: null,
  trace: [],
  values: [],
  duplicate: false,
  lostCommit: false,
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
      if (text.includes(' AS result')) fake.values.push([...values]);
      if (text === 'COMMIT' && fake.values.length) {
        fake.afterCommit?.();
        if (fake.lostCommit) throw Error('private lost COMMIT');
      }
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
interface Source {
  kind: string;
  asOf: number;
  validUntil: number;
  hash: string;
  complete: true;
  accountIds: string[];
  accounts: { accountId: string; state: { snapshotAt: number; lastEconomicAt: number | null } }[];
  valuation: { quote: string; equity: string; accounts: { accountId: string; equity: string }[] };
  exposure: {
    instrumentExposure: string;
    accountExposure: string;
    userExposure: string;
    openOrders: number;
  };
}
interface Reader {
  read(
    raw: unknown,
    io: { signal: AbortSignal; deadline: number },
  ): Promise<{ kind: string; source: Source }>;
  close(): Promise<void>;
}
function entry() {
  const fn = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperHistoricalInventorySource'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_HISTORICAL_INVENTORY_SOURCE_MISSING');
  return fn as (o: unknown) => Promise<Reader>;
}
beforeEach(() => {
  entry();
  Object.assign(fake, {
    payload: null,
    trace: [],
    values: [],
    duplicate: false,
    lostCommit: false,
    afterCommit: null,
  });
});
afterEach(() => vi.restoreAllMocks());
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
it('builds component content accepted by the unchanged valuation, bootstrap and execution contracts', () => {
  const f = historicalInventoryFixture();
  const request = lookupPaperExecutionCommitRequest(
    f.request,
    'PAPER_HISTORICAL_INVENTORY_CAPTURE',
  );
  const valuation = decodePaperExecutedValuationContents(f.wire.executed, request, f.now);
  const config = JSON.parse(f.packet.source.started.context.configuration.receiptText) as {
    configuration: { id: string };
  };
  expect(config.configuration.id).toBe(valuation.book.content.configurationId);
  for (const b of f.wire.books)
    expect(() =>
      decodePaperBookSource(b.book, { ...f.owner, accountId: b.accountId }, f.now),
    ).not.toThrow();
  expect(() =>
    pure.calculatePaperExecutedExposure({
      now: f.now,
      asOf: f.now,
      executionInput: f.packet.input,
      currentMarket: f.publication,
    }),
  ).not.toThrow();
  const result = decodePaperHistoricalInventoryContents(f.wire, request, f.now);
  expect(result.complete).toBe(true);
});
async function read(f: ReturnType<typeof historicalInventoryFixture>, raw: unknown = f.request) {
  vi.spyOn(Date, 'now').mockImplementation(() => f.now);
  const port = await entry()({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
  fake.payload ??= f.wire;
  fake.trace = [];
  fake.values = [];
  try {
    return await port.read(raw, io());
  } finally {
    await port.close();
  }
}
it('captures the complete supported catalog and values executed and pristine books once', async () => {
  const f = historicalInventoryFixture(),
    r = await read(f);
  expect(r.kind).toBe('CAPTURED');
  expect(r.source.kind).toBe('PAPER_HISTORICAL_INVENTORY_SOURCE');
  expect(r.source.complete).toBe(true);
  expect(r.source.accountIds).toEqual(f.wire.accountIds);
  expect(r.source.accounts.map((a) => a.accountId)).toEqual(f.wire.accountIds);
  const state = f.packet.effects.state;
  const expected = state.balances.reduce(
    (n, b) => n.add(new Decimal(b.total).mul(b.asset === 'USDT' ? '1' : '12.05')),
    new Decimal(100),
  );
  expect(r.source.valuation.equity).toBe(expected.toFixed());
  expect(r.source.exposure.openOrders).toBe(0);
  expect(r.source.exposure.instrumentExposure).toBe(
    new Decimal(f.receipt.order.executedQuantity).mul('12.05').toFixed(),
  );
  expect(fake.values).toEqual([[canonical(f.request)]]);
  expect(fake.trace.filter((s) => s.includes(' AS result'))).toEqual([
    'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
  ]);
  expect(fake.trace.some((s) => /evaluate_and_reserve|INSERT|UPDATE|DELETE/u.test(s))).toBe(false);
  expect(Object.isFrozen(r.source)).toBe(true);
  expect(Object.isFrozen(r.source.accounts)).toBe(true);
  expect(r.source).not.toHaveProperty('grant');
  expect(r.source).not.toHaveProperty('permit');
});
it('supports 100 complete accounts without truncation', async () => {
  const f = historicalInventoryFixture(100),
    r = await read(f);
  expect(r.source.accountIds).toHaveLength(100);
  expect(r.source.accounts).toHaveLength(100);
  expect(r.source.valuation.accounts).toHaveLength(100);
});
it('preserves unknown available/free for the newly acquired asset instead of inferring spendable from total', () => {
  const f = historicalInventoryFixture();
  const request = lookupPaperExecutionCommitRequest(
    f.request,
    'PAPER_HISTORICAL_INVENTORY_CAPTURE',
  );
  const result = decodePaperHistoricalInventoryContents(f.wire, request, f.now);
  const account = result.valuation.accounts.find((a) => a.accountId === f.owner.accountId)!;
  const asset = account.balances.find((b) => b.asset === 'BTC')!;
  expect(asset.total).not.toBe('0');
  expect(asset.available).toBeNull();
  expect(asset.free).toBeNull();
  expect(asset.spendable).toBeNull();
  expect(result.availabilityComplete).toBe(false);
  expect(result).not.toHaveProperty('grant');
});
it('fresh recapture does not renew prices or economic clocks', async () => {
  const f = historicalInventoryFixture(),
    a = await read(f);
  f.now += 10;
  f.wire.asOf += 10;
  f.wire.executed.asOf += 10;
  for (const b of f.wire.books) b.book.asOf += 10;
  const b = await read(f);
  expect(b.source.hash).toBe(a.source.hash);
  expect(b.source.validUntil).toBe(a.source.validUntil);
  expect(b.source.accounts.map((a) => a.state.snapshotAt)).toEqual(
    a.source.accounts.map((a) => a.state.snapshotAt),
  );
});
it.each([
  'missing-sibling',
  'missing-target',
  'extra-sibling',
  'duplicate',
  'ordering',
  'catalog',
  'epoch',
  'sibling-epoch',
  'owner',
  'book-hash',
])('rejects incomplete or conflicting %s inventory', async (kind) => {
  const f = historicalInventoryFixture();
  if (kind === 'missing-sibling') f.wire.books = [];
  if (kind === 'missing-target')
    f.wire.accountIds = f.wire.accountIds.filter((id) => id !== f.owner.accountId);
  if (kind === 'extra-sibling') {
    const extra = structuredClone(f.wire.books[0]!);
    Object.assign(extra, { accountId: '77777777-7777-4777-8777-777777777777' });
    f.wire.books.push(extra);
  }
  if (kind === 'duplicate') f.wire.accountIds.push(f.wire.accountIds[0]!);
  if (kind === 'ordering') f.wire.accountIds.reverse();
  if (kind === 'catalog') f.wire.catalog.pop();
  if (kind === 'epoch')
    f.wire.catalog.find((c) => c.accountId === f.owner.accountId)!.permissionEpoch = '0';
  if (kind === 'sibling-epoch') f.wire.books[0]!.book.accountState.permissionEpoch = '1';
  if (kind === 'owner') Object.assign(f.wire.books[0]!, { accountId: f.owner.accountId });
  if (kind === 'book-hash') f.wire.books[0]!.book.origin.hash = '0'.repeat(64);
  await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_/u);
});
it.each([
  'missing',
  'hash',
  'revision',
  'duplicate',
  'scope',
  'stale',
  'future',
  'rule-expiry',
  'extra',
])('fails closed on %s current price evidence', async (kind) => {
  const f = historicalInventoryFixture();
  if (kind === 'missing') f.wire.markets = [];
  if (kind === 'hash') f.wire.markets[0]!.hash = '0'.repeat(64);
  if (kind === 'revision') f.wire.markets[0]!.revision = f.publication.expectedRevision;
  if (kind === 'duplicate') f.wire.markets.push(f.wire.markets[0]!);
  if (kind === 'scope') {
    f.publication.key.scope = { ...f.publication.key.scope, environment: 'DEMO' };
    f.wire.markets = [f.market()];
  }
  if (kind === 'stale') {
    f.publication.ticker.receivedAt = f.now - 5001;
    f.wire.markets = [f.market()];
  }
  if (kind === 'future') {
    f.publication.timestamp = f.now + 1;
    f.wire.markets = [f.market()];
  }
  if (kind === 'rule-expiry') {
    f.publication.record.rules.expiresAt = f.now;
    f.wire.markets = [f.market()];
  }
  if (kind === 'extra')
    f.wire.markets.push({ ...f.wire.markets[0]!, id: '77777777-7777-4777-8777-777777777777' });
  await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_/u);
});
it('requires the target valuation and aggregate to use the same locked market content', async () => {
  const f = historicalInventoryFixture();
  f.publication.ticker.last = { state: 'AVAILABLE', value: parseDecimal('11') };
  f.wire.markets = [f.market()];
  await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_/u);
});
it('returns exact MISSING without inventing an empty complete inventory', async () => {
  const f = historicalInventoryFixture();
  fake.payload = { kind: 'MISSING', request: f.request };
  expect(await read(f)).toEqual({ kind: 'MISSING' });
});
it('rejects mismatched or embellished MISSING packets', async () => {
  const f = historicalInventoryFixture();
  fake.payload = { kind: 'MISSING', request: { ...f.request, executionKey: 'other' } };
  await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_/u);
});
it.each(['tenantId', 'accountIds', 'prices', 'now', 'grant'])(
  'rejects caller-added %s before business SQL',
  async (field) => {
    const f = historicalInventoryFixture();
    await expect(read(f, { ...f.request, [field]: 'caller' })).rejects.toThrow(
      /PAPER_ADMISSION_INPUT/u,
    );
    expect(fake.values).toEqual([]);
  },
);
it('lost read COMMIT returns no source and never retries', async () => {
  const f = historicalInventoryFixture();
  fake.lostCommit = true;
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
  expect(fake.values).toHaveLength(1);
});
it('deadline crossed after read COMMIT returns no source', async () => {
  const f = historicalInventoryFixture();
  fake.afterCommit = () => {
    f.now += 5001;
  };
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
  expect(fake.values).toHaveLength(1);
});
it('price expiry after read COMMIT within the transport deadline returns no source', async () => {
  const f = historicalInventoryFixture(),
    at = f.now - 5000;
  f.publication.timestamp = at;
  for (const p of [f.publication.ticker, f.publication.book]) p.receivedAt = p.exchangeTime = at;
  f.wire.markets = [f.market()];
  f.wire.executed.markets = [f.market()];
  fake.afterCommit = () => {
    f.now += 2;
  };
  await expect(read(f)).rejects.toThrow('PAPER_ADMISSION_EXPIRED');
  expect(fake.values).toHaveLength(1);
});
it('rejects duplicate result rows', async () => {
  const f = historicalInventoryFixture();
  fake.duplicate = true;
  await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_EVIDENCE/u);
});
it('rejects malformed nested history and UNKNOWN content instead of shrinking exposure', async () => {
  const f = historicalInventoryFixture();
  Object.assign(f.wire.executed.execution.input.attempt, { phase: 'UNKNOWN' });
  await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_/u);
});
it('bounds excessive catalogs and rejects accessors before visiting them', async () => {
  const f = historicalInventoryFixture(101);
  await expect(read(f)).rejects.toThrow(/PAPER_ADMISSION_/u);
  const next = historicalInventoryFixture();
  let calls = 0;
  Object.defineProperty(next.wire, 'hostile', {
    enumerable: true,
    get() {
      calls++;
      throw Error('private');
    },
  });
  fake.payload = next.wire;
  await expect(read(next)).rejects.toThrow(/PAPER_ADMISSION_/u);
  expect(calls).toBe(0);
});
it('keeps server capture and internal decoders absent from the calculator root', () => {
  expect(pure).not.toHaveProperty('createPostgresPaperHistoricalInventorySource');
  expect(server).not.toHaveProperty('decodePaperHistoricalInventory');
  expect(server).not.toHaveProperty('decodePaperExecutedValuationContents');
});
