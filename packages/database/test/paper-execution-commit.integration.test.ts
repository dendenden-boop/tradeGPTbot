import { randomUUID } from 'node:crypto';
import { parseDecimal } from '@ctp/exchange-core';
import { valuePortfolio } from '@ctp/portfolio';
import type { PortfolioState } from '@ctp/portfolio';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import * as paper from '@ctp/paper-engine/risk';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import { waitForFixtureClock } from './fixtures/preview-clock.js';
import { verifyPaperExecutionCommitStorage } from '../../../scripts/paper-execution-commit-upgrade.mjs';
import {
  closeStartFixture,
  readyExecutionStart,
  startFixtureConnection,
  startFixtureEffects,
  startFixturePause,
  startFixturePolicy,
  startFixtureSql,
  startIo,
} from './fixtures/paper-execution-start.js';

interface Receipt {
  kind: 'PAPER_EXECUTION_COMMIT_RECEIPT';
  version: 'paper-pristine-execution-v1';
  executionKey: string;
  executionId: string;
  attemptId: string;
  orderId: string;
  intentId: string;
  reservationId: string;
  order: { status: string; executedQuantity: string; remainingQuantity: string };
  reservation: { status: string; revision: string };
  fillIds: string[];
  ledgerTransactionIds: string[];
}
interface Port {
  execute(request: unknown, io: ReturnType<typeof startIo>): Promise<Receipt>;
  read(
    request: unknown,
    io: ReturnType<typeof startIo>,
  ): Promise<{ kind: 'MISSING' } | { kind: 'COMMITTED'; receipt: Receipt }>;
  close(): Promise<void>;
}
const ports: Port[] = [];
afterAll(async () => {
  for (const port of ports) await port.close();
  await closeStartFixture();
});
async function open(connectionString?: string) {
  const fn = (paper as unknown as Record<string, unknown>)['createPostgresPaperExecutionCommitter'];
  if (typeof fn !== 'function') throw Error('PAPER_EXECUTION_COMMITTER_MISSING');
  const port = await (fn as (o: unknown) => Promise<Port>)({
    connectionString: connectionString ?? startFixtureConnection(),
    environment: 'test',
  });
  ports.push(port);
  return port;
}
async function ready() {
  const f = await readyExecutionStart(),
    start = await f.journal.start(f.request, startIo());
  const now = await waitForFixtureClock(
    start.startedAt + f.c.model.latencyMs + f.c.model.latencyJitterMs,
    startIo(),
  );
  const snapshot = structuredClone(f.f.s),
    trade = structuredClone(f.f.p);
  const snapshotHead = await f.snapshots.read(snapshot.key, startIo()),
    tradeHead = await f.trades.read(trade.key, startIo());
  if (!snapshotHead || !tradeHead) throw Error('EXECUTION_COMMIT_SOURCE_MISSING');
  snapshot.id = randomUUID();
  snapshot.expectedRevision = snapshotHead.revision;
  snapshot.timestamp = now;
  if (snapshot.book.sourceSequence !== null)
    snapshot.book.sourceSequence = (BigInt(snapshot.book.sourceSequence) + 1n).toString();
  for (const v of [snapshot.book, snapshot.ticker]) v.receivedAt = v.exchangeTime = now;
  trade.id = randomUUID();
  trade.expectedRevision = tradeHead.revision;
  trade.timestamp = now;
  trade.trade.tradeId = 'commit-' + randomUUID();
  if (trade.trade.sourceSequence !== null)
    trade.trade.sourceSequence = (BigInt(trade.trade.sourceSequence) + 1n).toString();
  trade.trade.receivedAt = trade.trade.exchangeTime = now;
  expect((await f.snapshots.publish(snapshot, startIo())).status).toBe('APPLIED');
  expect((await f.trades.publish(trade, startIo())).status).toBe('APPLIED');
  return {
    ...f,
    start,
    request: {
      ...f.request,
      kind: 'PAPER_EXECUTION_COMMIT',
      executionKey: 'execute-' + randomUUID(),
    },
  };
}
it('paper-execution-commit: commits one genuine START fill, balanced ledger, Portfolio and terminal collateral together', async () => {
  const port = await open(),
    f = await ready(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  const receipt = await port.execute(f.request, startIo());
  expect(receipt).toMatchObject({
    kind: 'PAPER_EXECUTION_COMMIT_RECEIPT',
    version: 'paper-pristine-execution-v1',
    executionKey: f.request.executionKey,
    attemptId: f.start.attemptId,
    orderId: f.admission.orderId,
    intentId: f.admission.intentId,
    reservationId: f.approval.reservationId,
    order: { status: 'FILLED', executedQuantity: '0.5', remainingQuantity: '0' },
    reservation: { status: 'RELEASED', revision: '2' },
  });
  expect(receipt.fillIds.length).toBeGreaterThan(0);
  expect(receipt.ledgerTransactionIds).toHaveLength(receipt.fillIds.length);
  const after = await startFixtureEffects(f.c.owner.tenantId);
  expect(after.ledger).toBe(before.ledger + receipt.fillIds.length);
  expect(after.decisions).toBe(before.decisions);
  expect(after.reservations).toBe(before.reservations);
  const order = await f.orders.read(f.binding, f.admission.orderId, startIo());
  expect(order).toMatchObject({
    status: 'FILLED',
    filledQuantity: '0.5',
    executedQuantity: '0.5',
    reconciliation: 'CONSISTENT',
    averageFillPrice: '10.05',
  });
  const conservation = await startFixtureSql<{ balanced: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM public.ledger_entry WHERE "tenantId"=$1 AND "transactionId"=ANY($2::uuid[]) GROUP BY "transactionId",asset HAVING sum(amount)<>0) balanced`,
    [f.c.owner.tenantId, receipt.ledgerTransactionIds],
  );
  expect(conservation.rows).toEqual([{ balanced: true }]);
  const causes = await startFixtureSql<{
    commits: number;
    allocations: number;
    fills: number;
    fees: number;
    orderEvents: number;
    notifications: number;
  }>(
    `SELECT
    (SELECT count(*)::int FROM ctp_paper.execution_commit WHERE tenant_id=$1) commits,
    (SELECT count(*)::int FROM ctp_paper.execution_liquidity WHERE tenant_id=$1) allocations,
    (SELECT count(*)::int FROM public.fill WHERE "tenantId"=$1 AND "orderId"=$2) fills,
    (SELECT count(*)::int FROM public.fee WHERE "tenantId"=$1 AND "fillId"=ANY($3::uuid[]) AND "ledgerTransactionId"=ANY($4::uuid[])) fees,
    (SELECT count(*)::int FROM public.order_event WHERE "tenantId"=$1 AND "orderId"=$2 AND source='PAPER_EXECUTION') "orderEvents",
    (SELECT count(*)::int FROM public.outbox_event WHERE "tenantId"=$1 AND "aggregateId"=$2 AND "eventType"='PaperOrderExecuted') notifications`,
    [f.c.owner.tenantId, f.admission.orderId, receipt.fillIds, receipt.ledgerTransactionIds],
  );
  expect(causes.rows).toEqual([
    {
      commits: 1,
      allocations: 1,
      fills: receipt.fillIds.length,
      fees: receipt.fillIds.length,
      orderEvents: 1,
      notifications: 1,
    },
  ]);
});
it('paper-execution-commit: exact durable replay survives metadata retirement, changed policy and a current pause', async () => {
  const port = await open(),
    f = await ready(),
    receipt = await port.execute(f.request, startIo()),
    after = await startFixtureEffects(f.c.owner.tenantId);
  await startFixtureSql('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  await startFixturePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' });
  await startFixturePause(f.c.owner.tenantId, 'PAUSED');
  expect(await port.execute(f.request, startIo())).toEqual(receipt);
  expect(await port.read(f.request, startIo())).toEqual({ kind: 'COMMITTED', receipt });
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(after);
});
it('paper-execution-commit: a new key rechecks current policy and cannot create a false UNKNOWN', async () => {
  const port = await open(),
    f = await ready(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  await startFixturePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' });
  await expect(port.execute(f.request, startIo())).rejects.toThrow('PAPER_ADMISSION_LIMIT');
  expect(await port.read(f.request, startIo())).toEqual({ kind: 'MISSING' });
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-execution-commit: authoritative UNKNOWN retains every debit and hold and prevents financial execution', async () => {
  const port = await open(),
    f = await ready();
  await f.lifecycle.markUnknown(
    {
      kind: 'PAPER_RESERVATION_UNKNOWN',
      admission: f.admission,
      reservationId: f.approval.reservationId,
      eventId: randomUUID(),
      expectedRevision: '1',
    },
    startIo(),
  );
  const before = await startFixtureEffects(f.c.owner.tenantId);
  await expect(port.execute(f.request, startIo())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(await port.read(f.request, startIo())).toEqual({ kind: 'MISSING' });
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-execution-commit: private storage and derivation stay inaccessible and committed effects cannot be rewritten', async () => {
  await verifyPaperExecutionCommitStorage(
    { query: startFixtureSql },
    { ownership: 'STORAGE_ONLY' },
  );
  const port = await open(),
    f = await ready(),
    receipt = await port.execute(f.request, startIo());
  const runtime = new Pool({
    connectionString: startFixtureConnection(),
    max: 1,
    query_timeout: 5000,
  });
  try {
    const p = await runtime.query<{ safe: boolean }>(`SELECT
      NOT has_table_privilege(current_user,'ctp_paper.execution_commit','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_table_privilege(current_user,'ctp_paper.execution_liquidity','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_function_privilege(current_user,'ctp_paper.execution_commit(jsonb,boolean)','EXECUTE')
      AND NOT has_function_privilege(current_user,'ctp_paper.derive_pristine_effects(jsonb)','EXECUTE') safe`);
    expect(p.rows).toEqual([{ safe: true }]);
  } finally {
    await runtime.end();
  }
  for (const sql of [
    'UPDATE ctp_paper.execution_commit SET effects=effects WHERE tenant_id=$1',
    'DELETE FROM ctp_paper.execution_commit WHERE tenant_id=$1',
    'UPDATE ctp_paper.execution_liquidity SET frame_after=frame_before WHERE tenant_id=$1',
    'DELETE FROM ctp_paper.execution_liquidity WHERE tenant_id=$1',
  ])
    await expect(startFixtureSql(sql, [f.c.owner.tenantId])).rejects.toThrow();
  expect(await port.read(f.request, startIo())).toEqual({ kind: 'COMMITTED', receipt });
});
it('paper-execution-commit: exact replay still authenticates current permission epochs', async () => {
  const port = await open(),
    f = await ready(),
    receipt = await port.execute(f.request, startIo());
  await startFixtureSql(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.c.owner.accountId],
  );
  await expect(port.read(f.request, startIo())).rejects.toThrow('PAPER_ADMISSION_SCOPE');
  const current = {
    ...f.request,
    authorization: {
      ...f.request.authorization,
      permissionEpoch: String(BigInt(f.request.authorization.permissionEpoch) + 1n),
    },
  };
  expect(await port.execute(current, startIo())).toEqual(receipt);
  expect(await port.read(current, startIo())).toEqual({ kind: 'COMMITTED', receipt });
});
it('paper-execution-commit: pre-aborted execution publishes neither journal nor monetary changes', async () => {
  const port = await open(),
    f = await ready(),
    before = await startFixtureEffects(f.c.owner.tenantId),
    c = new AbortController();
  c.abort();
  await expect(port.execute(f.request, startIo(c.signal))).rejects.toThrow(
    'PAPER_ADMISSION_ABORTED',
  );
  expect(await port.read(f.request, startIo())).toEqual({ kind: 'MISSING' });
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-execution-commit: permanent exact replay survives factory restart without another ledger effect', async () => {
  const first = await open(),
    f = await ready(),
    receipt = await first.execute(f.request, startIo()),
    after = await startFixtureEffects(f.c.owner.tenantId);
  await first.close();
  const next = await open();
  expect(await next.execute(f.request, startIo())).toEqual(receipt);
  expect(await next.read(f.request, startIo())).toEqual({ kind: 'COMMITTED', receipt });
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(after);
});
it('paper-execution-commit: concurrent exact key callers share one durable monetary result', async () => {
  const ports = [await open(), await open()],
    f = await ready(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  const [a, b] = await Promise.all(ports.map((p) => p.execute(f.request, startIo())));
  expect(b).toEqual(a);
  expect((await startFixtureEffects(f.c.owner.tenantId)).ledger).toBe(
    before.ledger + a!.fillIds.length,
  );
});
it('paper-execution-commit: another key cannot consume the same START twice', async () => {
  const port = await open(),
    f = await ready();
  await port.execute(f.request, startIo());
  const before = await startFixtureEffects(f.c.owner.tenantId);
  await expect(
    port.execute({ ...f.request, executionKey: 'another-' + randomUUID() }, startIo()),
  ).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-execution-commit: conflicting semantic reuse of an accepted key cannot run another transition', async () => {
  const port = await open(),
    f = await ready();
  await port.execute(f.request, startIo());
  const before = await startFixtureEffects(f.c.owner.tenantId);
  await expect(
    port.execute({ ...f.request, startKey: 'different-start' }, startIo()),
  ).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-execution-commit: current pause blocks before effect without false UNKNOWN', async () => {
  const port = await open(),
    f = await ready(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  await startFixturePause(f.c.owner.tenantId, 'PAUSED');
  try {
    await expect(port.execute(f.request, startIo())).rejects.toThrow('PAPER_ADMISSION_LIMIT');
    expect(await port.read(f.request, startIo())).toEqual({ kind: 'MISSING' });
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await startFixturePause(f.c.owner.tenantId, 'RUNNING');
  }
});
it('paper-execution-commit: lost COMMIT returns no success and readonly reconciliation finds the only complete effect', async () => {
  const direct = await open(),
    f = await ready(),
    proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_ADMISSION'),
    transport = await open(proxy.connectionString);
  try {
    proxy.arm();
    await expect(transport.execute(f.request, startIo())).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
    expect(proxy.dropped()).toBe(1);
    const after = await startFixtureEffects(f.c.owner.tenantId),
      view = await direct.read(f.request, startIo());
    expect(view.kind).toBe('COMMITTED');
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(after);
  } finally {
    await transport.close();
    await proxy.close();
  }
});

interface ExecutedBookView {
  kind: 'PAPER_EXECUTED_BOOK_SOURCE';
  asOf: number;
  hash: string;
  content: {
    evaluatedAt: number;
    receipt: Receipt;
    portfolio: unknown;
    book: { bookId: string; revision: string; hash: string };
    frame: unknown;
    reservation: { status: string; revision: string };
  };
}
interface ExecutedBookReader {
  read(
    request: unknown,
    io: ReturnType<typeof startIo>,
  ): Promise<{ kind: 'MISSING' } | { kind: 'CAPTURED'; source: ExecutedBookView }>;
  close(): Promise<void>;
}
const executedReaders: ExecutedBookReader[] = [];
afterAll(async () => {
  for (const reader of executedReaders) await reader.close();
});
async function openExecutedBook(connectionString = startFixtureConnection()) {
  const fn = (paper as unknown as Record<string, unknown>)['createPostgresPaperExecutedBookSource'];
  if (typeof fn !== 'function') throw Error('PAPER_EXECUTED_BOOK_SOURCE_MISSING');
  const reader = await (fn as (o: unknown) => Promise<ExecutedBookReader>)({
    connectionString,
    environment: 'test',
  });
  executedReaders.push(reader);
  return reader;
}
const executedRequest = (f: Awaited<ReturnType<typeof ready>>) => ({
  ...f.request,
  kind: 'PAPER_EXECUTED_BOOK_CAPTURE',
});
async function captureExecuted(reader: ExecutedBookReader, request: unknown) {
  const result = await reader.read(request, startIo());
  if (result.kind !== 'CAPTURED') throw Error('EXECUTED_BOOK_CAPTURE_REQUIRED');
  return result.source;
}
it('paper-executed-book: captures the real committed book and conserved ledger without another monetary effect', async () => {
  const writer = await open(),
    f = await ready(),
    receipt = await writer.execute(f.request, startIo());
  const before = await startFixtureEffects(f.c.owner.tenantId),
    reader = await openExecutedBook();
  const source = await captureExecuted(reader, executedRequest(f));
  const actual = await startFixtureSql<{
    bookId: string;
    revision: string;
    hash: string;
    state: string;
    evaluatedAt: string;
  }>(
    `SELECT b.id::text "bookId", b.revision::text revision, encode(b.state_hash,'hex') hash,
      b.state, x.evaluated_ms::text "evaluatedAt" FROM ctp_paper.execution_commit x
      JOIN ctp_portfolio.book b ON b."tenantId"=x.tenant_id AND b.id=x.book_id
      WHERE x.tenant_id=$1 AND x.execution_key=$2`,
    [f.c.owner.tenantId, f.request.executionKey],
  );
  const row = actual.rows[0]!;
  expect(actual.rows).toHaveLength(1);
  expect(source.content.book).toEqual({
    bookId: row.bookId,
    revision: row.revision,
    hash: row.hash,
  });
  expect(source.content.portfolio).toEqual(JSON.parse(row.state));
  expect(source.content.evaluatedAt).toBe(Number(row.evaluatedAt));
  expect(source.content.receipt).toEqual(receipt);
  expect(source.content.reservation).toMatchObject({ revision: '2', status: 'RELEASED' });
  expect(source.asOf).toBeGreaterThanOrEqual(source.content.evaluatedAt);
  expect(source.asOf).toBeLessThanOrEqual(Date.now());
  expect(Object.isFrozen(source.content.portfolio)).toBe(true);
  expect('grant' in source || 'permit' in source || 'validUntil' in source).toBe(false);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-executed-book: restart and repeated fresh captures preserve content and all historical timestamps', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const first = await openExecutedBook(),
    a = await captureExecuted(first, executedRequest(f));
  await first.close();
  const next = await openExecutedBook(),
    b = await captureExecuted(next, executedRequest(f));
  expect(b.content).toEqual(a.content);
  expect(b.hash).toBe(a.hash);
  expect(b.asOf).toBeGreaterThanOrEqual(a.asOf);
});
it('paper-executed-book: retired rules changed policy and pause do not erase proven historical economic state', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const reader = await openExecutedBook(),
    before = await captureExecuted(reader, executedRequest(f));
  await startFixtureSql('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  await startFixturePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' });
  await startFixturePause(f.c.owner.tenantId, 'PAUSED');
  const after = await captureExecuted(reader, executedRequest(f));
  expect(after.content).toEqual(before.content);
  expect(after.hash).toBe(before.hash);
});
it('paper-executed-book: missing UNKNOWN execution never produces a book or releases retained holds', async () => {
  const f = await ready();
  await f.lifecycle.markUnknown(
    {
      kind: 'PAPER_RESERVATION_UNKNOWN',
      admission: f.admission,
      reservationId: f.approval.reservationId,
      eventId: randomUUID(),
      expectedRevision: '1',
    },
    startIo(),
  );
  const before = await startFixtureEffects(f.c.owner.tenantId),
    reader = await openExecutedBook();
  expect(await reader.read(executedRequest(f), startIo())).toEqual({ kind: 'MISSING' });
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-executed-book: current permission epoch remains mandatory despite permanent historical content', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const reader = await openExecutedBook(),
    original = await captureExecuted(reader, executedRequest(f));
  await startFixtureSql(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.c.owner.accountId],
  );
  await expect(reader.read(executedRequest(f), startIo())).rejects.toThrow('PAPER_ADMISSION_SCOPE');
  const current = {
    ...executedRequest(f),
    authorization: {
      ...f.request.authorization,
      permissionEpoch: String(BigInt(f.request.authorization.permissionEpoch) + 1n),
    },
  };
  const recovered = await captureExecuted(reader, current);
  expect(recovered.content).toEqual(original.content);
  expect(recovered.hash).toBe(original.hash);
});
it('paper-executed-book: semantic conflicts and wrong account scope cannot read another execution', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const reader = await openExecutedBook(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  await expect(
    reader.read({ ...executedRequest(f), startKey: 'conflicting-start' }, startIo()),
  ).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  const request = executedRequest(f);
  await expect(
    reader.read(
      {
        ...request,
        admission: {
          ...request.admission,
          binding: { ...request.admission.binding, accountId: randomUUID() },
        },
      },
      startIo(),
    ),
  ).rejects.toThrow(/PAPER_ADMISSION_(SCOPE|EVIDENCE)/u);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-executed-book: lost read COMMIT and abort return no capture and restart recovers without another effect', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const before = await startFixtureEffects(f.c.owner.tenantId),
    direct = await openExecutedBook();
  const expected = await captureExecuted(direct, executedRequest(f));
  const controller = new AbortController();
  controller.abort();
  await expect(direct.read(executedRequest(f), startIo(controller.signal))).rejects.toThrow(
    'PAPER_ADMISSION_ABORTED',
  );
  const proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_EXECUTION_SOURCE'),
    reader = await openExecutedBook(proxy.connectionString);
  try {
    proxy.arm();
    await expect(reader.read(executedRequest(f), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
    expect(proxy.dropped()).toBe(1);
    expect((await captureExecuted(direct, executedRequest(f))).content).toEqual(expected.content);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await reader.close();
    await proxy.close();
  }
});

interface ExecutedValuationReader {
  read(
    request: unknown,
    io: ReturnType<typeof startIo>,
  ): Promise<
    | { kind: 'MISSING' }
    | {
        kind: 'CAPTURED';
        source: {
          asOf: number;
          validUntil: number;
          hash: string;
          book: { content: { portfolio: PortfolioState; evaluatedAt: number }; hash: string };
          valuation: {
            equity: string;
            positions: { unrealizedGross: string; netRealized: string }[];
          };
        };
      }
  >;
  close(): Promise<void>;
}
const valuationReaders: ExecutedValuationReader[] = [];
afterAll(async () => {
  for (const reader of valuationReaders) await reader.close();
});
async function openExecutedValuation(connectionString = startFixtureConnection()) {
  const fn = (paper as unknown as Record<string, unknown>)[
    'createPostgresPaperExecutedValuationSource'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_EXECUTED_VALUATION_SOURCE_MISSING');
  const reader = await (fn as (options: unknown) => Promise<ExecutedValuationReader>)({
    connectionString,
    environment: 'test',
  });
  valuationReaders.push(reader);
  return reader;
}
const valuationRequest = (f: Awaited<ReturnType<typeof ready>>) => ({
  ...f.request,
  kind: 'PAPER_EXECUTED_VALUATION_CAPTURE',
});
async function refreshValuationMark(
  f: Awaited<ReturnType<typeof ready>>,
  publication = f.f.s,
  capturedRevision?: string,
) {
  const p = structuredClone(publication),
    revision = capturedRevision ?? (await f.snapshots.read(p.key, startIo())).revision;
  const now = Date.now();
  p.id = randomUUID();
  p.expectedRevision = revision;
  p.timestamp = now;
  p.ticker.last = { state: 'AVAILABLE', value: parseDecimal('12.05') };
  for (const v of [p.book, p.ticker]) v.receivedAt = v.exchangeTime = now;
  if (p.book.sourceSequence !== null)
    p.book.sourceSequence = (BigInt(p.book.sourceSequence) + BigInt(revision) + 1n).toString();
  expect((await f.snapshots.publish(p, startIo())).status).toBe('APPLIED');
  return p;
}
it('paper-executed-valuation: current public marks value the genuine committed Spot book once without new financial effects', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const p = await refreshValuationMark(f),
    before = await startFixtureEffects(f.c.owner.tenantId),
    reader = await openExecutedValuation();
  const result = await reader.read(valuationRequest(f), startIo());
  if (result.kind !== 'CAPTURED') throw Error('EXECUTED_VALUATION_CAPTURE_REQUIRED');
  const s = result.source,
    oracle = valuePortfolio(
      [s.book.content.portfolio],
      [
        {
          asset: p.record.instrument.baseAsset,
          quote: p.record.instrument.quoteAsset,
          price: '12.05',
          kind: 'LAST',
          fresh: true,
          asOf: p.timestamp,
          sourceId: p.id,
        },
      ],
      { quote: p.record.instrument.quoteAsset, now: s.asOf, reconciledAfterRestart: true },
    );
  expect(s.valuation.equity).toBe(oracle.estimate);
  expect(s.valuation.positions[0]).toMatchObject({
    unrealizedGross: oracle.accounts[0]!.positions[0]!.unrealizedGross,
    netRealized: oracle.accounts[0]!.positions[0]!.netRealized,
  });
  expect(s.valuation.positions[0]!.unrealizedGross).not.toBe('0');
  expect(s.validUntil).toBeGreaterThan(Date.now());
  expect(s.asOf).toBeGreaterThanOrEqual(s.book.content.evaluatedAt);
  expect('grant' in s || 'permit' in s).toBe(false);
  await reader.close();
  const restarted = await openExecutedValuation(),
    again = await restarted.read(valuationRequest(f), startIo());
  if (again.kind !== 'CAPTURED') throw Error('EXECUTED_VALUATION_CAPTURE_REQUIRED');
  expect(again.source.hash).toBe(s.hash);
  expect(again.source.book.content).toEqual(s.book.content);
  expect(again.source.book.hash).toBe(s.book.hash);
  expect(again.source.validUntil).toBe(s.validUntil);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-executed-valuation: MISSING and UNKNOWN never become a valued executed book or release collateral', async () => {
  const f = await ready(),
    reader = await openExecutedValuation();
  const before = await startFixtureEffects(f.c.owner.tenantId);
  expect(await reader.read(valuationRequest(f), startIo())).toEqual({ kind: 'MISSING' });
  await f.lifecycle.markUnknown(
    {
      kind: 'PAPER_RESERVATION_UNKNOWN',
      admission: f.admission,
      reservationId: f.approval.reservationId,
      eventId: randomUUID(),
      expectedRevision: '1',
    },
    startIo(),
  );
  const unknown = await startFixtureEffects(f.c.owner.tenantId);
  expect(unknown.ledger).toBe(before.ledger);
  expect(await reader.read(valuationRequest(f), startIo())).toEqual({ kind: 'MISSING' });
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(unknown);
});
it('paper-executed-valuation: a retired current rule blocks marking without erasing the historical book', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  await refreshValuationMark(f);
  const reader = await openExecutedValuation(),
    book = await openExecutedBook(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  await startFixtureSql('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  await expect(reader.read(valuationRequest(f), startIo())).rejects.toThrow(
    'PAPER_ADMISSION_EVIDENCE',
  );
  expect((await book.read(executedRequest(f), startIo())).kind).toBe('CAPTURED');
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-executed-valuation: a GAP head fails closed instead of valuing at the old execution price', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const reader = await openExecutedValuation(),
    head = await f.snapshots.read(f.f.s.key, startIo()),
    before = await startFixtureEffects(f.c.owner.tenantId);
  expect(
    (
      await f.snapshots.publish(
        {
          kind: 'GAP',
          id: randomUUID(),
          key: f.f.s.key,
          expectedRevision: head.revision,
          timestamp: Date.now(),
          reason: 'VALUATION_RESYNC',
        },
        startIo(),
      )
    ).status,
  ).toBe('APPLIED');
  await expect(reader.read(valuationRequest(f), startIo())).rejects.toThrow(
    'PAPER_ADMISSION_EVIDENCE',
  );
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-executed-valuation: current permission epochs and exact execution semantics remain mandatory', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  await refreshValuationMark(f);
  const reader = await openExecutedValuation(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  await expect(
    reader.read({ ...valuationRequest(f), startKey: 'other' }, startIo()),
  ).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  await startFixtureSql(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.c.owner.accountId],
  );
  await expect(reader.read(valuationRequest(f), startIo())).rejects.toThrow(
    'PAPER_ADMISSION_SCOPE',
  );
  const current = {
    ...valuationRequest(f),
    authorization: {
      ...f.request.authorization,
      permissionEpoch: String(BigInt(f.request.authorization.permissionEpoch) + 1n),
    },
  };
  expect((await reader.read(current, startIo())).kind).toBe('CAPTURED');
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-executed-valuation: lost readonly COMMIT and abort return no valuation and never re-execute money', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  await refreshValuationMark(f);
  const direct = await openExecutedValuation(),
    before = await startFixtureEffects(f.c.owner.tenantId),
    controller = new AbortController();
  controller.abort();
  await expect(direct.read(valuationRequest(f), startIo(controller.signal))).rejects.toThrow(
    'PAPER_ADMISSION_ABORTED',
  );
  const proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_EXECUTION_SOURCE'),
    reader = await openExecutedValuation(proxy.connectionString);
  try {
    proxy.arm();
    await expect(reader.read(valuationRequest(f), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
    expect(proxy.dropped()).toBe(1);
    expect((await direct.read(valuationRequest(f), startIo())).kind).toBe('CAPTURED');
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await reader.close();
    await proxy.close();
  }
});
it('paper-executed-valuation: genuine current rule replacement marks the historical v1 book without rewriting it', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const book = await openExecutedBook(),
    original = await captureExecuted(book, executedRequest(f)),
    p = structuredClone(f.f.s);
  const old = p.key.dbRuleId,
    head = await f.snapshots.read(p.key, startIo());
  p.key.dbRuleId = randomUUID();
  p.record.rules.version = 'valuation-refresh-' + randomUUID();
  p.record.rules.effectiveAt = Date.now() - 1;
  p.record.rules.expiresAt = Date.now() + 60000;
  await startFixtureSql('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    old,
  ]);
  await startFixtureSql(
    `INSERT INTO public.instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",rules)
    SELECT $1,"instrumentId",version+1,true,$2,now(),"sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",$3::jsonb FROM public.instrument_rule_version WHERE id=$4`,
    [p.key.dbRuleId, new Date(p.record.rules.effectiveAt), JSON.stringify(p.record.rules), old],
  );
  await refreshValuationMark(f, p, head.revision);
  const before = await startFixtureEffects(f.c.owner.tenantId),
    reader = await openExecutedValuation(),
    result = await reader.read(valuationRequest(f), startIo());
  if (result.kind !== 'CAPTURED') throw Error('EXECUTED_VALUATION_CAPTURE_REQUIRED');
  expect(result.source.book.content).toEqual(original.content);
  expect(result.source.book.hash).toBe(original.hash);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
