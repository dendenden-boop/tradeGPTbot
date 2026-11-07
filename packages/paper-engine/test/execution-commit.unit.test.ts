import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical } from '@ctp/portfolio';
import { calculatePaperStartedTransition } from '../src/started-transition.js';
import { preparePaperFrame } from '../src/model.js';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import type { PaperExecutionCommitRequest } from '../src/postgres-execution-commit.js';
import { startedPreviewFixture } from './started-preview-fixtures.js';
import { admissionWire, wireHash } from './admission-wire-fixtures.js';

const fake = vi.hoisted<{
  payload: unknown;
  trace: string[];
  queries: { text: string; values: readonly unknown[] }[];
  duplicate: boolean;
  commitError: boolean;
  afterCommit: null | (() => void);
}>(() => ({
  payload: null,
  trace: [] as string[],
  queries: [] as { text: string; values: readonly unknown[] }[],
  duplicate: false,
  commitError: false,
  afterCommit: null as null | (() => void),
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
        if (fake.commitError) throw Error('private lost COMMIT');
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
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
const open = () =>
  server.createPostgresPaperExecutionCommitter({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
function fixture() {
  const f = startedPreviewFixture(),
    c = f.packet.started.capture,
    attempt = f.packet.started.journal.state,
    a = attempt.request.admission;
  const request: PaperExecutionCommitRequest = {
    ...f.request,
    kind: 'PAPER_EXECUTION_COMMIT',
    executionKey: 'first-execution',
  };
  const portfolio = JSON.parse(c.portfolio.stateText) as ReturnType<
    typeof admissionWire
  >['packet']['portfolio']['before'];
  const { model, record, book, trade } = admissionWire(a.admittedAt).packet.budget;
  const hold = portfolio.holds[0]!;
  const input = {
    now: f.now,
    attempt,
    frame: preparePaperFrame({
      now: f.now,
      model: c.model,
      record: c.market.record,
      book: c.market.book,
      trade: c.market.trade,
    }),
    portfolio,
    original: { now: a.admittedAt, model, record, book, trade },
    reservation: {
      id: a.reservationId,
      decisionId: a.decisionId,
      orderId: a.orderId,
      intentId: a.intentId,
      revision: '1',
      status: 'ACTIVE',
      debits: c.candidates[0]!.debits,
      watermarks: [
        {
          holdId: hold.id,
          timestamp: a.admittedAt,
          fingerprint: wireHash({ type: 'COMMITMENT', hold }),
          released: false,
          unknown: false,
        },
      ],
    },
  };
  const value = calculatePaperStartedTransition(input),
    e = value.execution.calculation.ledger.execution.executions[0]!;
  const effects = {
    execution: {
      status: e.status,
      reason: e.reason,
      eligibleAfter: e.eligibleAfter,
      triggeredAt: e.triggeredAt,
      quantity: e.quantity,
      fills: e.fills,
      frame: value.execution.calculation.ledger.execution.frame,
    },
    order: value.order,
    reservation: value.reservation,
    fills: value.execution.calculation.fills,
    holdChanges: value.holdChanges,
    state: value.state,
  };
  const receipt = {
    kind: 'PAPER_EXECUTION_COMMIT_RECEIPT',
    version: 'paper-pristine-execution-v1',
    executionKey: request.executionKey,
    executionId: randomUUID(),
    attemptId: attempt.request.attemptId,
    orderId: a.orderId,
    intentId: a.intentId,
    reservationId: a.reservationId,
    order: {
      status: value.order.status,
      executedQuantity: value.order.executedQuantity,
      remainingQuantity: value.order.remainingQuantity,
    },
    reservation: { status: value.reservation.status, revision: value.reservation.revision },
    fillIds: effects.fills.map(() => randomUUID()),
    ledgerTransactionIds: effects.fills.map(() => randomUUID()),
  };
  const packet = {
    kind: 'COMMITTED',
    request,
    authorization: f.request.authorization,
    evaluatedAt: f.now,
    source: f.packet,
    input,
    effects,
    receipt,
  };
  return { ...f, request, packet, receipt };
}
beforeEach(() => {
  fake.payload = null;
  fake.trace = [];
  fake.queries = [];
  fake.duplicate = false;
  fake.commitError = false;
  fake.afterCommit = null;
});
afterEach(() => vi.restoreAllMocks());
async function execute(f: ReturnType<typeof fixture>, request: unknown = f.request, read = false) {
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
    return read
      ? await port.read(request as PaperExecutionCommitRequest, io())
      : await port.execute(request as PaperExecutionCommitRequest, io());
  } finally {
    await port.close();
  }
}
it('uses one fixed mutation RPC, verifies exact SQL effects before COMMIT and exposes no grant', async () => {
  const f = fixture(),
    r = await execute(f);
  expect(r).toEqual(f.receipt);
  expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toEqual([
    {
      text: 'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
      values: [canonical(f.request)],
    },
  ]);
  expect(fake.trace.filter((t) => t === 'COMMIT')).toHaveLength(1);
  expect('grant' in r || 'permit' in r || 'source' in r || 'input' in r).toBe(false);
  expect(Object.isFrozen(r)).toBe(true);
});
it('reconciles only through the fixed readonly RPC without another mutation', async () => {
  const f = fixture();
  expect(await execute(f, undefined, true)).toEqual({ kind: 'COMMITTED', receipt: f.receipt });
  expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toEqual([
    {
      text: 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
      values: [canonical(f.request)],
    },
  ]);
});
it.each([
  'effects',
  'receipt',
  'source',
  'attempt',
  'frame',
  'portfolio',
  'debits',
  'fillIds',
  'ledgerIds',
  'time',
])('rolls back conflicting backend %s evidence before COMMIT', async (field) => {
  const f = fixture();
  if (field === 'effects') f.packet.effects.state = { ...f.packet.effects.state, status: 'GAP' };
  else if (field === 'receipt') f.receipt.order.executedQuantity = '0';
  else if (field === 'source') f.packet.source.started.capture.portfolio.hash = '0'.repeat(64);
  else if (field === 'attempt')
    f.packet.input.attempt = { ...f.packet.input.attempt, startedAt: f.now };
  else if (field === 'frame')
    Object.assign(f.packet.input, { frame: { ...f.packet.input.frame, volumeUsed: '1' } });
  else if (field === 'portfolio') f.packet.input.portfolio.balances[0]!.total = '999';
  else if (field === 'debits')
    f.packet.input.reservation.debits = [{ ...f.packet.input.reservation.debits[0]!, amount: '1' }];
  else if (field === 'fillIds') f.receipt.fillIds = [];
  else if (field === 'ledgerIds') f.receipt.ledgerTransactionIds = [f.receipt.fillIds[0]!];
  else f.packet.evaluatedAt = f.now + 1;
  await expect(execute(f)).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(fake.trace).toContain('ROLLBACK');
  expect(fake.trace).not.toContain('COMMIT');
});
it.each(['afterText', 'amount', 'tenantId', 'callback', 'now', 'proposal'])(
  'rejects caller-supplied %s before dispatch',
  async (field) => {
    const f = fixture();
    await expect(execute(f, { ...f.request, [field]: 'untrusted' })).rejects.toThrow(
      'PAPER_ADMISSION_INPUT',
    );
    expect(fake.queries).toEqual([]);
  },
);
it('does not execute request accessors while checking the fixed selector', async () => {
  const f = fixture(),
    getter = vi.fn(() => f.request.admission),
    request = { ...f.request };
  Object.defineProperty(request, 'admission', { enumerable: true, get: getter });
  await expect(execute(f, request)).rejects.toThrow('PAPER_ADMISSION_INPUT');
  expect(getter).not.toHaveBeenCalled();
  expect(fake.queries).toEqual([]);
});
it('rejects duplicate backend rows instead of selecting an arbitrary monetary receipt', async () => {
  fake.duplicate = true;
  await expect(execute(fixture())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(fake.trace).not.toContain('COMMIT');
});
it('uncertain COMMIT returns no success and never automatically retries the mutation', async () => {
  const f = fixture();
  fake.commitError = true;
  await expect(execute(f)).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
  expect(fake.queries.filter((q) => q.text.includes(' AS result'))).toHaveLength(1);
  expect(fake.trace.filter((t) => t === 'COMMIT')).toHaveLength(1);
});
it('known durable success remains replayable when metadata lease expires after acknowledged COMMIT', async () => {
  const f = fixture();
  fake.afterCommit = () => vi.mocked(Date.now).mockReturnValue(f.packet.source.started.validUntil);
  expect(await execute(f)).toEqual(f.receipt);
});
it('keeps the financial writer server-only and does not expose its transport or decoding helpers', () => {
  expect('createPostgresPaperExecutionCommitter' in pure).toBe(false);
  for (const n of [
    'openPaperAdmissionDatabase',
    'decodePaperStartedRiskWire',
    'lookupPaperStartedRiskRequest',
  ])
    expect(n in server).toBe(false);
});
