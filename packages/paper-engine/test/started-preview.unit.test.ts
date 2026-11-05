import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical } from '@ctp/portfolio';
import { decimalAdd, parseDecimal } from '@ctp/exchange-core';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import type { PaperStartedRiskSource } from '../src/postgres-started-risk.js';
import type * as startedExecution from '../src/started-execution.js';
import { startedPreviewFixture } from './started-preview-fixtures.js';

interface Fake {
  payload: unknown;
  trace: string[];
  queries: { text: string; values: readonly unknown[] }[];
  duplicate: boolean;
  commitError: boolean;
  afterCommit: null | (() => void);
  afterCalculate: null | (() => void);
  calculationError: boolean;
  gate: null | Promise<void>;
}
const fake = vi.hoisted<Fake>(() => ({
  payload: null,
  trace: [],
  queries: [],
  duplicate: false,
  commitError: false,
  afterCommit: null,
  afterCalculate: null,
  calculationError: false,
  gate: null,
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    async query(text: string, values: readonly unknown[] = []) {
      fake.trace.push(text);
      fake.queries.push({ text, values });
      if (text.includes(' AS result')) await fake.gate;
      if (text === 'COMMIT') {
        fake.afterCommit?.();
        if (fake.commitError) throw Error('private uncertain commit');
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
vi.mock('../src/started-execution.js', async () => {
  const actual = await vi.importActual<typeof startedExecution>('../src/started-execution.js');
  return {
    ...actual,
    calculatePaperStartedExecutionPortfolio(raw: unknown) {
      fake.trace.push('CALCULATE');
      if (fake.calculationError) throw Error('private calculation detail');
      const result = actual.calculatePaperStartedExecutionPortfolio(raw);
      fake.afterCalculate?.();
      return result;
    },
  };
});
interface Preview {
  kind: string;
  evaluatedAt: number;
  validUntil: number;
  hash: string;
  source: PaperStartedRiskSource;
  execution: startedExecution.PaperStartedExecutionPortfolioCalculation;
}
interface Port {
  preview(request: unknown, io: { signal: AbortSignal; deadline: number }): Promise<Preview>;
  close(): Promise<void>;
}
function factory() {
  const fn = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperStartedExecutionPreview'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_STARTED_PREVIEW_FACTORY_MISSING');
  return fn as (o: unknown) => Promise<Port>;
}
const open = () =>
  factory()({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
const io = (signal = new AbortController().signal) => ({ signal, deadline: Date.now() + 2000 });
beforeEach(() => {
  factory();
  fake.payload = null;
  fake.trace = [];
  fake.queries = [];
  fake.duplicate = false;
  fake.commitError = false;
  fake.afterCommit = null;
  fake.afterCalculate = null;
  fake.calculationError = false;
  fake.gate = null;
});
afterEach(() => vi.restoreAllMocks());
async function preview(
  f: ReturnType<typeof startedPreviewFixture>,
  request: unknown = f.request,
  signal = new AbortController().signal,
) {
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  const hooks = { commitError: fake.commitError, afterCommit: fake.afterCommit };
  fake.commitError = false;
  fake.afterCommit = null;
  const port = await open();
  Object.assign(fake, hooks);
  fake.payload = f.packet;
  fake.trace = [];
  fake.queries = [];
  try {
    return await port.preview(request, io(signal));
  } finally {
    await port.close();
  }
}
it('uses one fixed current-Risk RPC and computes from its actual START before the same COMMIT', async () => {
  const f = startedPreviewFixture(),
    before = canonical(f.packet),
    r = await preview(f);
  expect(r.kind).toBe('PAPER_STARTED_EXECUTION_PREVIEW');
  expect(r.evaluatedAt).toBe(f.now);
  expect(r.source.risk.evaluation.kind).toBe('EVALUATED');
  expect(r.source.started.journal.receipt).toEqual(f.started.receipt);
  expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toEqual([
    {
      text: 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
      values: [canonical(f.request)],
    },
  ]);
  expect(
    fake.trace.filter(
      (t) => t === 'BEGIN ISOLATION LEVEL READ COMMITTED' || t === 'CALCULATE' || t === 'COMMIT',
    ),
  ).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED', 'CALCULATE', 'COMMIT']);
  expect(canonical(f.packet)).toBe(before);
  expect(r.validUntil).toBe(r.source.validUntil);
  expect(fake.trace.some((t) => /INSERT|UPDATE|DELETE|evaluate_and_reserve/.test(t))).toBe(false);
});
it('calculates a partial fill, exact balanced postings and Portfolio projection without consuming holds or frame', async () => {
  const f = startedPreviewFixture(),
    r = await preview(f),
    c = r.execution.calculation;
  expect(c.fills[0]!.event).toMatchObject({
    internalOrderId: f.request.admission.orderId,
    quantity: '0.5',
    price: '10.05',
    fees: [{ amount: '0.005025' }],
  });
  expect(c.state.holds).toEqual(c.before.holds);
  expect(c.before).toEqual(r.source.started.source.portfolio);
  expect(c.state).not.toEqual(c.before);
  expect(r.source.started.source.portfolio.lastEconomicAt).toBeNull();
  for (const fill of c.fills) {
    const totals = new Map<string, string>();
    for (const p of fill.postings)
      totals.set(
        p.asset,
        decimalAdd(parseDecimal(totals.get(p.asset) ?? '0'), parseDecimal(p.amount)),
      );
    expect([...totals.values()]).toEqual([...totals.values()].map(() => '0'));
  }
  expect('permit' in r || 'grant' in r || 'committed' in r || 'reservation' in r).toBe(false);
});
it('waits for genuine post-START evidence and latency instead of inventing a fill', async () => {
  const r = await preview(startedPreviewFixture(1, false));
  expect(r.execution.calculation.fills).toEqual([]);
  expect(r.execution.calculation.state).toEqual(r.execution.calculation.before);
});
it('retains 300 contenders and holds while previewing only the earliest actual START exactly once', async () => {
  const r = await preview(startedPreviewFixture(300));
  expect(r.source.started.entries).toHaveLength(300);
  expect(r.source.risk.retained.budget.orders.projected).toBe(300);
  expect(r.execution.calculation.ledger.orders).toHaveLength(1);
  expect(r.execution.calculation.state.holds).toHaveLength(300);
});
it('returns deterministic immutable projection content for the same capture/clock, without caching authority', async () => {
  const f = startedPreviewFixture(),
    a = await preview(f),
    b = await preview(f);
  expect(b).toEqual(a);
  expect(Object.isFrozen(a)).toBe(true);
  expect(Object.isFrozen(a.execution.calculation.state)).toBe(true);
  expect(Object.isFrozen(a.source)).toBe(true);
});
it.each([
  'policy',
  'pause',
  'health',
  'unknown',
  'metadata',
  'scope',
  'expiry',
  'source-conflict',
] as const)('rejects %s evidence before executing the calculation', async (kind) => {
  const f = startedPreviewFixture();
  if (kind === 'policy') {
    f.packet.risk.policies[1]!.limits.maxOrderNotional = '0.01';
    f.seal();
  }
  if (kind === 'pause') {
    f.controls.activePauses.push('00000000-0000-4000-8000-000000009999');
    f.seal();
  }
  if (kind === 'health') {
    f.publication.observation.health['executor'].status = 'FAILED';
    f.seal();
  }
  if (kind === 'unknown') f.packet.risk.reservation.status = 'UNKNOWN';
  if (kind === 'metadata') f.packet.risk.market.record.rules.version = 'replaced';
  if (kind === 'scope')
    f.packet.request.admission.binding.accountId = '00000000-0000-4000-8000-000000009999';
  if (kind === 'expiry') f.now = f.packet.started.validUntil;
  if (kind === 'source-conflict')
    f.packet.risk.capture = {
      ...f.packet.risk.capture,
      configurationId: '00000000-0000-4000-8000-000000009999',
    };
  await expect(preview(f)).rejects.toThrow(/PAPER_ADMISSION_/);
  expect(fake.trace).not.toContain('CALCULATE');
  expect(fake.trace).not.toContain('COMMIT');
});
it.each(['now', 'frame', 'portfolio', 'source', 'risk', 'command', 'tenantId', 'sql'])(
  'rejects caller %s before SQL and calculation',
  async (key) => {
    const f = startedPreviewFixture();
    await expect(preview(f, { ...f.request, [key]: {} })).rejects.toThrow('PAPER_ADMISSION_INPUT');
    expect(fake.queries).toEqual([]);
  },
);
it('rejects accessors before reading values', async () => {
  const f = startedPreviewFixture(),
    getter = vi.fn(() => f.request.admission),
    request = { ...f.request };
  Object.defineProperty(request, 'admission', { enumerable: true, get: getter });
  await expect(preview(f, request)).rejects.toThrow('PAPER_ADMISSION_INPUT');
  expect(getter).not.toHaveBeenCalled();
  expect(fake.queries).toEqual([]);
});
it('rejects duplicated backend rows without calculation', async () => {
  fake.duplicate = true;
  await expect(preview(startedPreviewFixture())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(fake.trace).not.toContain('CALCULATE');
});
it('rolls back and sanitizes a calculation failure before COMMIT', async () => {
  fake.calculationError = true;
  await expect(preview(startedPreviewFixture())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(fake.trace).not.toContain('COMMIT');
  expect(fake.trace).toContain('ROLLBACK');
});
it('rejects lease expiry during calculation before COMMIT', async () => {
  const f = startedPreviewFixture();
  fake.afterCalculate = () => vi.mocked(Date.now).mockReturnValue(f.packet.started.validUntil);
  await expect(preview(f)).rejects.toThrow('PAPER_ADMISSION_EXPIRED');
  expect(fake.trace).not.toContain('COMMIT');
});
it('rejects abort during calculation before COMMIT without false UNKNOWN', async () => {
  const c = new AbortController();
  fake.afterCalculate = () => c.abort();
  await expect(preview(startedPreviewFixture(), undefined, c.signal)).rejects.toThrow(
    'PAPER_ADMISSION_ABORTED',
  );
  expect(fake.trace).not.toContain('COMMIT');
});
it('returns no stale result if lease expires after a known COMMIT', async () => {
  const f = startedPreviewFixture();
  fake.afterCommit = () => vi.mocked(Date.now).mockReturnValue(f.packet.started.validUntil);
  await expect(preview(f)).rejects.toThrow('PAPER_ADMISSION_EXPIRED');
  expect(fake.trace.filter((t) => t === 'COMMIT')).toHaveLength(1);
});
it('does not retry an uncertain read COMMIT and permits explicit later recapture only', async () => {
  const f = startedPreviewFixture();
  fake.commitError = true;
  await expect(preview(f)).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
  expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toHaveLength(1);
  fake.commitError = false;
  expect((await preview(f)).kind).toBe('PAPER_STARTED_EXECUTION_PREVIEW');
});
it('bounds pending capacity at four physical transactions without queuing or dropping active reads', async () => {
  const f = startedPreviewFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  const port = await open();
  fake.payload = f.packet;
  fake.queries = [];
  let release!: () => void;
  fake.gate = new Promise<void>((r) => {
    release = r;
  });
  const pending = Array.from({ length: 4 }, () => port.preview(f.request, io()));
  try {
    for (
      let n = 0;
      n < 30 && fake.queries.filter((q) => q.text.includes(' AS result')).length < 4;
      n++
    )
      await new Promise<void>((r) => setImmediate(r));
    await expect(port.preview(f.request, io())).rejects.toThrow('PAPER_ADMISSION_BUSY');
    release();
    expect(await Promise.all(pending)).toHaveLength(4);
  } finally {
    release();
    await Promise.allSettled(pending);
    await port.close();
  }
});
it('exposes the server factory only and never exposes internal SQL/decoder entry points', () => {
  for (const name of [
    'createPostgresPaperStartedExecutionPreview',
    'decodePaperStartedRiskWire',
    'lookupPaperStartedRiskRequest',
  ])
    expect(name in pure).toBe(false);
  for (const name of ['decodePaperStartedRiskWire', 'lookupPaperStartedRiskRequest'])
    expect(name in server).toBe(false);
});
