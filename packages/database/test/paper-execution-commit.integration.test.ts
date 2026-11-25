import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { decimalCompare, parseDecimal } from '@ctp/exchange-core';
import { canonical, valuePortfolio } from '@ctp/portfolio';
import type { PortfolioState } from '@ctp/portfolio';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as paper from '@ctp/paper-engine/risk';
import { calculatePaperCurrentRiskEvaluation } from '@ctp/paper-engine';
import { createPostgresPaperConfiguration } from '@ctp/paper-engine/configuration';
import { createPostgresPaperFunding } from '@ctp/paper-engine/funding';
import { createPostgresPaperPortfolioBootstrap } from '@ctp/paper-engine/portfolio';
import { paperRuntimeDependencies, type PaperRuntimePublication } from '@ctp/paper-engine/runtime';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import { waitForFixtureClock } from './fixtures/preview-clock.js';
import { createNativeDefaultFixturePort } from './fixtures/native-default-port.js';
import { verifyPaperCurrentOrderBudgetSql } from './fixtures/paper-current-order-budget-proof.js';
import { verifyPaperExecutionCommitStorage } from '../../../scripts/paper-execution-commit-upgrade.mjs';
import { verifyPaperExecutedValuationStorage } from '../../../scripts/paper-executed-valuation-upgrade.mjs';
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
beforeAll(verifyPaperCurrentOrderBudgetSql);
afterAll(async () => {
  for (const port of ports) await port.close();
  await closeStartFixture();
});
const open = createNativeDefaultFixturePort(openActual, startFixtureConnection);
async function openActual(connectionString: string) {
  const fn = (paper as unknown as Record<string, unknown>)['createPostgresPaperExecutionCommitter'];
  if (typeof fn !== 'function') throw Error('PAPER_EXECUTION_COMMITTER_MISSING');
  const port = await (fn as (o: unknown) => Promise<Port>)({
    connectionString,
    environment: 'test',
  });
  ports.push(port);
  return port;
}
async function ready() {
  const f = await readyExecutionStart();
  const snapshot = structuredClone(f.f.s),
    trade = structuredClone(f.f.p);
  const start = await f.journal.start(f.request, startIo());
  const now = await waitForFixtureClock(
    start.startedAt + f.c.model.latencyMs + f.c.model.latencyJitterMs,
    startIo(),
  );
  snapshot.id = randomUUID();
  // Genuine APPLIED receipts from setup are the expected heads. A concurrent
  // update still hits the publisher's CAS guard.
  snapshot.expectedRevision = f.snapshotReceipt.revision;
  snapshot.timestamp = now;
  if (snapshot.book.sourceSequence !== null)
    snapshot.book.sourceSequence = (BigInt(snapshot.book.sourceSequence) + 1n).toString();
  for (const v of [snapshot.book, snapshot.ticker]) v.receivedAt = v.exchangeTime = now;
  trade.id = randomUUID();
  trade.expectedRevision = f.tradeReceipt.revision;
  trade.timestamp = now;
  trade.trade.tradeId = 'commit-' + randomUUID();
  if (trade.trade.sourceSequence !== null)
    trade.trade.sourceSequence = (BigInt(trade.trade.sourceSequence) + 1n).toString();
  trade.trade.receivedAt = trade.trade.exchangeTime = now;
  const publications = await Promise.allSettled([
    f.snapshots.publish(snapshot, startIo()),
    f.trades.publish(trade, startIo()),
  ]);
  if (publications[0].status === 'rejected') throw publications[0].reason;
  if (publications[1].status === 'rejected') throw publications[1].reason;
  expect(publications[0].value.status).toBe('APPLIED');
  expect(publications[1].value.status).toBe('APPLIED');
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
const openExecutedBook = createNativeDefaultFixturePort(
  openActualExecutedBook,
  startFixtureConnection,
);
async function openActualExecutedBook(connectionString: string) {
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
const openExecutedValuation = createNativeDefaultFixturePort(
  openActualExecutedValuation,
  startFixtureConnection,
);
async function openActualExecutedValuation(connectionString: string) {
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

it('paper-historical-inventory: captures an actual executed book as complete supported tenant inventory without new monetary effects', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  await refreshValuationMark(f);
  const before = await startFixtureEffects(f.c.owner.tenantId);
  const fn = (paper as unknown as Record<string, unknown>)[
    'createPostgresPaperHistoricalInventorySource'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_HISTORICAL_INVENTORY_SOURCE_MISSING');
  const reader = await (
    fn as (o: unknown) => Promise<{
      read(
        r: unknown,
        io: ReturnType<typeof startIo>,
      ): Promise<{
        kind: string;
        source: { complete: boolean; accountIds: string[]; exposure: { openOrders: number } };
      }>;
      close(): Promise<void>;
    }>
  )({ connectionString: startFixtureConnection(), environment: 'test' });
  try {
    const result = await reader.read(
      { ...f.request, kind: 'PAPER_HISTORICAL_INVENTORY_CAPTURE' },
      startIo(),
    );
    expect(result.kind).toBe('CAPTURED');
    expect(result.source.complete).toBe(true);
    expect(result.source.accountIds).toEqual([f.c.owner.accountId]);
    expect(result.source.exposure.openOrders).toBe(0);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await reader.close();
  }
});
type HistoricalReader = {
  read(
    request: unknown,
    io: ReturnType<typeof startIo>,
  ): Promise<
    { kind: 'MISSING' } | { kind: 'CAPTURED'; source: paper.PaperHistoricalInventorySource }
  >;
  close(): Promise<void>;
};
const historicalReaders: HistoricalReader[] = [];
afterAll(async () => {
  for (const reader of historicalReaders) await reader.close();
});
const openHistorical = createNativeDefaultFixturePort(openActualHistorical, startFixtureConnection);
async function openActualHistorical(connectionString: string) {
  const reader: HistoricalReader = await paper.createPostgresPaperHistoricalInventorySource({
    connectionString,
    environment: 'test',
  });
  historicalReaders.push(reader);
  return reader;
}
const historicalRequest = (f: Awaited<ReturnType<typeof ready>>) => ({
  ...f.request,
  kind: 'PAPER_HISTORICAL_INVENTORY_CAPTURE',
});
async function historicalCapture(reader: HistoricalReader, f: Awaited<ReturnType<typeof ready>>) {
  const result = await reader.read(historicalRequest(f), startIo());
  if (result.kind !== 'CAPTURED') throw Error('HISTORICAL_INVENTORY_CAPTURE_REQUIRED');
  return result.source;
}
async function historicalAccount(f: Awaited<ReturnType<typeof ready>>, id = randomUUID()) {
  await startFixtureSql(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt")
    VALUES($1,$2,$3,'PAPER',$4,$5,'SIMULATED','ACTIVE','paper-historical-epoch',now())`,
    [id, f.c.owner.tenantId, f.c.source.exchange, 'paper:' + id, f.c.source.region],
  );
  return id;
}
it('paper-historical-inventory: includes a genuinely bootstrapped pristine sibling once and preserves unknown acquired-asset availability', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const id = await historicalAccount(f),
    configuration = {
      ...f.c,
      id: randomUUID(),
      owner: { ...f.c.owner, accountId: id },
    };
  const option = (key: string) => {
    const connectionString = process.env[key];
    if (!connectionString) throw Error('HISTORICAL_FIXTURE_CONNECTION_REQUIRED');
    return { connectionString, environment: 'test' as const };
  };
  const config = await createPostgresPaperConfiguration(option('DATABASE_PAPER_CONFIGURATION_URL'));
  const funding = await createPostgresPaperFunding(option('DATABASE_PAPER_FUNDING_URL'));
  const bootstrap = await createPostgresPaperPortfolioBootstrap(option('DATABASE_PAPER_BOOK_URL'));
  try {
    await config.register(configuration, startIo());
    await funding.initialize(
      {
        id: randomUUID(),
        owner: configuration.owner,
        configurationId: configuration.id,
        balances: [{ asset: configuration.valuationAsset, amount: parseDecimal('250') }],
      },
      startIo(),
    );
    await bootstrap.initialize(configuration.owner, startIo());
    await refreshValuationMark(f);
    const before = await startFixtureEffects(f.c.owner.tenantId),
      reader = await openHistorical();
    const source = await historicalCapture(reader, f);
    expect(source.accountIds).toEqual([f.c.owner.accountId, id].sort());
    expect(source.accounts).toHaveLength(2);
    expect(source.valuation.accounts.find((a) => a.accountId === id)?.equity).toBe('250');
    expect(source.availabilityComplete).toBe(false);
    expect(
      source.valuation.accounts
        .find((a) => a.accountId === f.c.owner.accountId)
        ?.balances.find((b) => b.asset === 'BTC')?.spendable,
    ).toBeNull();
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await bootstrap.close();
    await funding.close();
    await config.close();
  }
});
it('paper-historical-inventory: an UNKNOWN missing execution never becomes empty complete inventory or releases its hold', async () => {
  const f = await ready(),
    reader = await openHistorical();
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
  expect(await reader.read(historicalRequest(f), startIo())).toEqual({ kind: 'MISSING' });
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-historical-inventory: current permission epoch and exact immutable execution selection remain mandatory', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  await refreshValuationMark(f);
  const reader = await openHistorical(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  await expect(
    reader.read({ ...historicalRequest(f), startKey: 'wrong-start' }, startIo()),
  ).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  await startFixtureSql(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE id=$1',
    [f.c.owner.accountId],
  );
  await expect(reader.read(historicalRequest(f), startIo())).rejects.toThrow(
    'PAPER_ADMISSION_SCOPE',
  );
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-historical-inventory: lost readonly COMMIT and abort grant no source; restart recovers exactly one historical effect', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  await refreshValuationMark(f);
  const before = await startFixtureEffects(f.c.owner.tenantId),
    direct = await openHistorical();
  const original = await historicalCapture(direct, f),
    controller = new AbortController();
  controller.abort();
  await expect(direct.read(historicalRequest(f), startIo(controller.signal))).rejects.toThrow(
    'PAPER_ADMISSION_ABORTED',
  );
  const proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_EXECUTION_SOURCE');
  const lost = await openHistorical(proxy.connectionString);
  try {
    proxy.arm();
    await expect(lost.read(historicalRequest(f), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
    expect(proxy.dropped()).toBe(1);
    const restarted = await openHistorical();
    expect((await historicalCapture(restarted, f)).hash).toBe(original.hash);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await lost.close();
    await proxy.close();
  }
});
it('paper-historical-inventory: user FK locks close concurrent account insertion phantoms until the complete capture settles', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  await refreshValuationMark(f);
  const reader = await openHistorical();
  const blocker = new Pool({
    connectionString: process.env['DATABASE_MIGRATION_URL'],
    max: 1,
    query_timeout: 2000,
  });
  const connection = await blocker.connect();
  let capture: ReturnType<HistoricalReader['read']> | undefined;
  let insertion: ReturnType<typeof historicalAccount> | undefined;
  const observed: Promise<unknown>[] = [];
  async function waitingOn(pid: number, sqlPrefix: string) {
    const until = Date.now() + 700;
    while (Date.now() < until) {
      const rows = await startFixtureSql<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))`,
        [sqlPrefix + '%', pid],
      );
      if (rows.rows.length === 1) return rows.rows[0]!.pid;
      await delay(5);
    }
    throw Error('HISTORICAL_CATALOG_FK_LOCK_NOT_OBSERVED:' + sqlPrefix);
  }
  try {
    await connection.query('BEGIN');
    // A publisher's table lock conflicts with capture SHARE, while permitting
    // cold function/rowtype planning before the earlier user FK lock is taken.
    await connection.query('LOCK TABLE ctp_market.snapshot_head IN ROW EXCLUSIVE MODE');
    const { pid } = (await connection.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
      .rows[0]!;
    capture = reader.read(historicalRequest(f), startIo());
    observed.push(capture.catch(() => undefined));
    const capturePid = await waitingOn(pid, 'SELECT ctp_paper.reconcile_admission(');
    insertion = historicalAccount(f);
    observed.push(insertion.catch(() => undefined));
    await waitingOn(capturePid, 'INSERT INTO public.exchange_account(');
    await connection.query('COMMIT');
    const result = await capture;
    expect(result.kind).toBe('CAPTURED');
    if (result.kind !== 'CAPTURED') throw Error('HISTORICAL_INVENTORY_CAPTURE_REQUIRED');
    expect(result.source.accountIds).toEqual([f.c.owner.accountId]);
    await insertion;
    await expect(reader.read(historicalRequest(f), startIo())).rejects.toThrow(/PAPER_ADMISSION_/u);
  } finally {
    await connection.query('ROLLBACK');
    await Promise.all(observed);
    connection.release();
    await blocker.end();
  }
});
it('paper-historical-inventory: uninitialized disabled or over-capacity siblings reject the entire catalog instead of omission', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  await refreshValuationMark(f);
  const reader = await openHistorical(),
    id = await historicalAccount(f);
  await expect(reader.read(historicalRequest(f), startIo())).rejects.toThrow(/PAPER_ADMISSION_/u);
  await startFixtureSql("UPDATE public.exchange_account SET status='DISABLED' WHERE id=$1", [id]);
  await expect(reader.read(historicalRequest(f), startIo())).rejects.toThrow(
    'PAPER_ADMISSION_EVIDENCE',
  );
  await startFixtureSql(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt")
   SELECT gen_random_uuid(),$1,$2,'PAPER','paper-extra-'||n,$3,'SIMULATED','ACTIVE','paper-historical-epoch',now() FROM generate_series(1,99) n`,
    [f.c.owner.tenantId, f.c.source.exchange, f.c.source.region],
  );
  await expect(reader.read(historicalRequest(f), startIo())).rejects.toThrow(
    'PAPER_ADMISSION_LIMIT',
  );
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
it('paper-executed-valuation: preserves accepted started-source and Risk RPC security settings', async () => {
  await verifyPaperExecutedValuationStorage(
    { query: startFixtureSql },
    { ownership: 'STORAGE_ONLY' },
  );
});

it('paper-current-risk: certifies an actual executed inventory with durable current loss evidence without another financial effect', async () => {
  const writer = await open(),
    f = await ready();
  const execution = await writer.execute(f.request, startIo());
  expect(execution.order.executedQuantity).not.toBe('0');
  await refreshValuationMark(f);
  await refreshCurrentRiskEvidence(f);
  const inventory = await historicalCapture(await openHistorical(), f),
    before = await startFixtureEffects(f.c.owner.tenantId);
  expect(inventory.complete).toBe(true);
  expect(inventory.valuation.accounts[0]!.positions).toHaveLength(1);
  const factory = (paper as unknown as Record<string, unknown>)[
    'createPostgresPaperCurrentRiskCoordinator'
  ];
  expect(factory).toBeTypeOf('function');
  type Certificate = {
    kind: string;
    id: string;
    revision: string;
    inventory: paper.PaperHistoricalInventorySource;
    loss: { complete: boolean; actualEquity: string };
    snapshot: { lossBaselineComplete: boolean; userExposure: string };
  };
  const coordinator = await (
    factory as (options: unknown) => Promise<{
      certify(request: unknown, io: ReturnType<typeof startIo>): Promise<Certificate>;
      readCurrent(request: unknown, io: ReturnType<typeof startIo>): Promise<Certificate>;
      close(): Promise<void>;
    }>
  )({ connectionString: startFixtureConnection(), environment: 'test' });
  try {
    const request = { ...f.request, kind: 'PAPER_CURRENT_RISK_CERTIFY' },
      [certificate, concurrent] = await Promise.all([
        coordinator.certify(request, startIo()),
        coordinator.certify(request, startIo()),
      ]);
    expect(concurrent).toEqual(certificate);
    expect(certificate.kind).toBe('PAPER_CURRENT_RISK_CERTIFICATE');
    expect(certificate.inventory.accountIds).toEqual(inventory.accountIds);
    expect(certificate.inventory.accounts.map((a) => [a.bookId, a.revision, a.state])).toEqual(
      inventory.accounts.map((a) => [a.bookId, a.revision, a.state]),
    );
    expect(certificate.loss.complete).toBe(true);
    expect(certificate.loss.actualEquity).toBe(inventory.valuation.equity);
    expect(certificate.snapshot.lossBaselineComplete).toBe(true);
    expect(certificate.snapshot.userExposure).toBe(inventory.exposure.userExposure);
    expect(certificate).not.toHaveProperty('grant');
    expect(certificate).not.toHaveProperty('permit');
    const current = await coordinator.readCurrent(request, startIo());
    expect([current.id, current.revision]).toEqual([certificate.id, certificate.revision]);
    expect(current).toEqual(certificate);
    const evidenceCounts = () =>
      startFixtureSql(
        `SELECT (SELECT count(*)::int FROM ctp_paper.current_risk_certificate WHERE tenant_id=$1) certificates,
       (SELECT count(*)::int FROM ctp_paper.current_loss_checkpoint WHERE tenant_id=$1) checkpoints,
       (SELECT "clientIdHighWatermark"::text FROM public.exchange_account WHERE "tenantId"=$1 AND id=$2) client_ids,
       (SELECT last_value::text FROM ctp_paper.current_risk_revision) certificate_sequence,
       (SELECT last_value::text FROM ctp_paper.current_loss_revision) loss_sequence`,
        [f.c.owner.tenantId, f.c.owner.accountId],
      );
    const counts = (await evidenceCounts()).rows;
    expect(counts[0]).toMatchObject({ certificates: 1, checkpoints: 1 });
    expect(await coordinator.certify(request, startIo())).toEqual(certificate);
    expect((await evidenceCounts()).rows).toEqual(counts);
    // Cross-package proof over the actual immutable PostgreSQL certificate,
    // not a re-sealed mocked graph. This calculation grants no new admission.
    const sealed = await startFixtureSql<{ text: string; hash: string }>(
      `SELECT document_text text,encode(document_hash,'hex') hash
       FROM ctp_paper.current_risk_certificate WHERE tenant_id=$1 AND id=$2`,
      [f.c.owner.tenantId, certificate.id],
    );
    const evaluationInput: unknown = JSON.parse(
      canonical({
        now: Date.now(),
        sourceRequest: request,
        certificate: sealed.rows[0],
        target: {
          owner: f.c.owner,
          orderId: randomUUID(),
          intentId: randomUUID(),
          dbInstrumentId: f.f.s.key.dbInstrumentId,
          dbRuleId: f.f.s.key.dbRuleId,
          command: {
            ...f.prepared.request.admission.command,
            clientOrderId: 'calculation-only-' + randomUUID(),
            limitPrice: '12.05',
            size: { kind: 'BASE_QUANTITY', asset: f.f.s.record.instrument.baseAsset, value: '0.2' },
          },
        },
      }),
    );
    const evaluated = calculatePaperCurrentRiskEvaluation(evaluationInput);
    expect(evaluated).toMatchObject({
      source: { id: certificate.id, revision: certificate.revision, hash: sealed.rows[0]!.hash },
      result: {
        kind: 'EVALUATED',
        notional: '2.41',
        budget: {
          current: { instrument: '6.025', user: '6.025' },
          projected: { instrument: '8.435', user: '8.435' },
        },
      },
    });
    expect(evaluated).not.toHaveProperty('grant');
    expect(evaluated).not.toHaveProperty('permit');
    expect((await evidenceCounts()).rows).toEqual(counts);
    await coordinator.close();
    const restarted = await (
      factory as (options: unknown) => Promise<{
        readCurrent(request: unknown, io: ReturnType<typeof startIo>): Promise<Certificate>;
        close(): Promise<void>;
      }>
    )({ connectionString: startFixtureConnection(), environment: 'test' });
    try {
      expect(await restarted.readCurrent(request, startIo())).toEqual(certificate);
      expect((await evidenceCounts()).rows).toEqual(counts);
      expect(calculatePaperCurrentRiskEvaluation(evaluationInput)).toEqual(evaluated);
    } finally {
      await restarted.close();
    }
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await coordinator.close();
  }
});

const currentRiskPorts: paper.PaperCurrentRiskCoordinator[] = [];
afterAll(async () => {
  for (const port of currentRiskPorts) await port.close();
});
const openCurrentRisk = createNativeDefaultFixturePort(
  openActualCurrentRisk,
  startFixtureConnection,
);
async function openActualCurrentRisk(connectionString: string) {
  const port = await paper.createPostgresPaperCurrentRiskCoordinator({
    connectionString,
    environment: 'test',
  });
  currentRiskPorts.push(port);
  return port;
}
function currentRiskRequest(f: Awaited<ReturnType<typeof ready>>) {
  return { ...f.request, kind: 'PAPER_CURRENT_RISK_CERTIFY' as const };
}
async function refreshCurrentRiskEvidence(
  f: Awaited<ReturnType<typeof ready>>,
  knownTradeRevision?: string,
) {
  const trade = structuredClone(f.f.p);
  const reads = await Promise.allSettled([
    f.runtime.context(f.c.owner, startIo()),
    f.runtime.head(f.c.owner, startIo()),
    knownTradeRevision === undefined
      ? f.trades.read(trade.key, startIo())
      : Promise.resolve({ revision: knownTradeRevision }),
  ]);
  if (reads[0].status === 'rejected') throw reads[0].reason;
  if (reads[1].status === 'rejected') throw reads[1].reason;
  if (reads[2].status === 'rejected') throw reads[2].reason;
  const context = reads[0].value,
    head = reads[1].value,
    tradeHead = reads[2].value,
    publication: PaperRuntimePublication = {
      id: randomUUID(),
      expectedRevision: head?.revision ?? '0',
      observation: {
        owner: f.c.owner,
        configurationId: f.c.id,
        configurationHash: context.configurationHash,
        permissionEpoch: context.current.permissionEpoch,
        userSessionEpoch: context.current.userSessionEpoch,
        accountVersion: context.current.accountVersion,
        health: Object.fromEntries(
          paperRuntimeDependencies.map((name) => [
            name,
            { sourceId: 'current-risk-native:' + name, asOf: Date.now(), status: 'HEALTHY' },
          ]),
        ) as PaperRuntimePublication['observation']['health'],
      },
    };
  const now = Date.now();
  trade.id = randomUUID();
  trade.expectedRevision = tradeHead.revision;
  trade.timestamp = now;
  trade.trade.tradeId = 'current-risk-' + randomUUID();
  trade.trade.receivedAt = trade.trade.exchangeTime = now;
  if (trade.trade.sourceSequence !== null)
    trade.trade.sourceSequence = (
      BigInt(trade.trade.sourceSequence) +
      BigInt(tradeHead.revision) +
      1n
    ).toString();
  const publications = await Promise.allSettled([
    f.runtime.publish(publication, startIo()),
    f.trades.publish(trade, startIo()),
  ]);
  if (publications[0].status === 'rejected') throw publications[0].reason;
  if (publications[1].status === 'rejected') throw publications[1].reason;
  expect(publications[1].value.status).toBe('APPLIED');
}

interface CurrentOrderRiskSourcePort {
  capture(
    request: unknown,
    context: ReturnType<typeof startIo>,
  ): Promise<{
    kind: string;
    target: { orderId: string; intentId: string; commandHash: string; command: unknown };
    certificate: {
      id: string;
      revision: string;
      expiresAt: number;
      snapshot: { ordersInLastMinute: number };
    };
    evaluation: { result: { kind: string; reasons?: readonly string[] } };
  }>;
  readCurrent(
    request: unknown,
    context: ReturnType<typeof startIo>,
  ): ReturnType<CurrentOrderRiskSourcePort['capture']>;
  close(): Promise<void>;
}
const currentOrderRiskPorts: CurrentOrderRiskSourcePort[] = [];
afterAll(async () => {
  for (const p of currentOrderRiskPorts) await p.close();
});
async function openCurrentOrderRisk(connectionString = startFixtureConnection()) {
  const factory = (paper as unknown as Record<string, unknown>)[
    'createPostgresPaperCurrentOrderRiskSource'
  ];
  if (typeof factory !== 'function') throw Error('PAPER_CURRENT_ORDER_RISK_SOURCE_MISSING');
  const port = await (factory as (options: unknown) => Promise<CurrentOrderRiskSourcePort>)({
    connectionString,
    environment: 'test',
  });
  currentOrderRiskPorts.push(port);
  return port;
}
async function currentOrderTargetReady(replaceRules = false) {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  let ruleId = f.draft.dbRuleId,
    ruleVersion = f.draft.order.ruleVersion;
  let replacedHeadRevision: string | undefined;
  let replacedTradeRevision: string | undefined;
  if (replaceRules) {
    const p = structuredClone(f.f.s),
      old = p.key.dbRuleId;
    replacedHeadRevision = (await f.snapshots.read(p.key, startIo())).revision;
    replacedTradeRevision = (await f.trades.read(f.f.p.key, startIo())).revision;
    p.key.dbRuleId = randomUUID();
    p.record.rules.version = 'current-order-refresh-' + randomUUID();
    p.record.rules.effectiveAt = Date.now() - 1;
    p.record.rules.expiresAt = Date.now() + 60000;
    await startFixtureSql(
      'UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1',
      [old],
    );
    await startFixtureSql(
      `INSERT INTO public.instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",rules)
       SELECT $1,"instrumentId",version+1,true,$2,now(),"sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",$3::jsonb FROM public.instrument_rule_version WHERE id=$4`,
      [p.key.dbRuleId, new Date(p.record.rules.effectiveAt), JSON.stringify(p.record.rules), old],
    );
    // Only the next synthetic publication template changes; retained original
    // execution/source/command bytes stay in their immutable durable rows.
    f.f.s.key = p.key;
    f.f.s.record = p.record;
    f.f.p.key = structuredClone(p.key);
    f.f.p.record = structuredClone(p.record);
    ruleId = p.key.dbRuleId;
    ruleVersion = p.record.rules.version;
  }
  const target = await f.orders.create(
    f.binding,
    {
      ...f.draft,
      key: randomUUID(),
      dbRuleId: ruleId,
      order: {
        ...f.draft.order,
        ruleVersion,
        limitPrice: parseDecimal('12.05'),
        size: {
          kind: 'BASE_QUANTITY',
          asset: f.f.s.record.instrument.baseAsset,
          value: parseDecimal('0.2'),
        },
      },
    },
    startIo(),
  );
  const wire = (
    await startFixtureSql<{ hash: string; command: string }>(
      `SELECT encode("commandHash",'hex') hash,command FROM ctp_execution.command WHERE "tenantId"=$1 AND "intentId"=$2`,
      [f.c.owner.tenantId, target.intentId],
    )
  ).rows[0]!;
  await startFixturePolicy(f.c.owner.tenantId, 'USER', { maxOrdersPerMinute: 2 });
  const evidence = await Promise.allSettled([
    refreshValuationMark(f, f.f.s, replacedHeadRevision),
    refreshCurrentRiskEvidence(f, replacedTradeRevision),
  ]);
  if (evidence[0].status === 'rejected') throw evidence[0].reason;
  if (evidence[1].status === 'rejected') throw evidence[1].reason;
  return {
    f,
    target,
    wire,
    request: {
      kind: 'PAPER_CURRENT_ORDER_RISK_CAPTURE',
      source: currentRiskRequest(f),
      target: { orderId: target.id, intentId: target.intentId, commandHash: wire.hash },
    },
  };
}
it('paper-current-order-risk: authenticates a real second CREATED intent without weakening the old reader or reserving again', async () => {
  const { f, target, wire, request } = await currentOrderTargetReady();
  const old = await openCurrentRisk();
  await expect(old.certify(currentRiskRequest(f), startIo())).rejects.toThrow(/^PAPER_/u);
  const before = await startFixtureEffects(f.c.owner.tenantId),
    port = await openCurrentOrderRisk();
  const source = await port.capture(request, startIo());
  expect(source).toMatchObject({
    kind: 'PAPER_CURRENT_ORDER_RISK_SOURCE',
    target: {
      orderId: target.id,
      intentId: target.intentId,
      commandHash: wire.hash,
      command: JSON.parse(wire.command) as unknown,
    },
    certificate: { snapshot: { ordersInLastMinute: 2 } },
    evaluation: {
      result: {
        kind: 'EVALUATED',
        notional: '2.41',
        budget: {
          current: { instrument: '6.025', user: '6.025' },
          projected: { instrument: '8.435', user: '8.435' },
        },
      },
    },
  });
  expect(source).not.toHaveProperty('grant');
  expect(source).not.toHaveProperty('permit');
  expect(source).not.toHaveProperty('reservationId');
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  await port.close();
  const restarted = await openCurrentOrderRisk();
  const read = await restarted.readCurrent(request, startIo());
  expect(read.certificate).toEqual(source.certificate);
  expect(read.target).toEqual(source.target);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-current-order-risk: lost nonfinancial COMMIT returns no result and explicit restart read recovers one finite certificate', async () => {
  const { f, request } = await currentOrderTargetReady(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  const proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_EXECUTION_SOURCE');
  try {
    const port = await openCurrentOrderRisk(proxy.connectionString);
    proxy.arm();
    await expect(port.capture(request, startIo())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await port.close();
    const restarted = await openCurrentOrderRisk(),
      source = await restarted.readCurrent(request, startIo());
    expect(source.evaluation.result.kind).toBe('EVALUATED');
    const counts = await startFixtureSql<{ n: number }>(
      `SELECT count(*)::int n FROM ctp_paper.current_risk_certificate WHERE tenant_id=$1`,
      [f.c.owner.tenantId],
    );
    expect(counts.rows[0]!.n).toBe(1);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await proxy.close();
  }
});
it('paper-current-order-risk: current controls and exact authorization cannot be bypassed by a captured target', async () => {
  const { f, request } = await currentOrderTargetReady(),
    port = await openCurrentOrderRisk();
  await port.capture(request, startIo());
  await startFixturePause(f.c.owner.tenantId, 'PAUSED');
  const before = await startFixtureEffects(f.c.owner.tenantId),
    paused = await port.capture(request, startIo());
  expect(paused.evaluation.result).toMatchObject({ kind: 'REJECTED', reasons: ['RISK_PAUSED'] });
  await expect(
    port.capture(
      {
        ...request,
        source: {
          ...request.source,
          authorization: { ...request.source.authorization, permissionEpoch: '999' },
        },
      },
      startIo(),
    ),
  ).rejects.toThrow(/^PAPER_/u);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-current-order-risk: an additional unselected draft invalidates the narrow complete capture', async () => {
  const { f, request } = await currentOrderTargetReady(),
    port = await openCurrentOrderRisk();
  await port.capture(request, startIo());
  await f.orders.create(f.binding, { ...f.draft, key: randomUUID() }, startIo());
  const before = await startFixtureEffects(f.c.owner.tenantId);
  await expect(port.capture(request, startIo())).rejects.toThrow(/^PAPER_/u);
  await expect(port.readCurrent(request, startIo())).rejects.toThrow(/^PAPER_/u);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-current-order-risk: the executed original cannot masquerade as an untouched new target', async () => {
  const { f, request } = await currentOrderTargetReady(),
    port = await openCurrentOrderRisk(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  await expect(
    port.capture(
      {
        ...request,
        target: {
          orderId: f.request.admission.orderId,
          intentId: f.request.admission.intentId,
          commandHash: f.request.admission.commandHash,
        },
      },
      startIo(),
    ),
  ).rejects.toThrow(/^PAPER_/u);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-current-order-risk: a genuine current rule replacement admits a new v2 target over immutable v1 execution', async () => {
  const { f, target, request } = await currentOrderTargetReady(true),
    port = await openCurrentOrderRisk();
  const before = await startFixtureEffects(f.c.owner.tenantId),
    source = await port.capture(request, startIo());
  expect(source.target).toMatchObject({
    orderId: target.id,
    dbRuleId: f.f.s.key.dbRuleId,
    command: { ruleVersion: f.f.s.record.rules.version },
  });
  expect(source.evaluation.result.kind).toBe('EVALUATED');
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-current-order-risk: concurrent captures publish one finite certificate without reserving either time', async () => {
  const { f, request } = await currentOrderTargetReady(),
    first = await openCurrentOrderRisk(),
    second = await openCurrentOrderRisk();
  const before = await startFixtureEffects(f.c.owner.tenantId);
  const [a, b] = await Promise.all([
    first.capture(request, startIo()),
    second.capture(request, startIo()),
  ]);
  expect(a.certificate).toEqual(b.certificate);
  expect(a.target).toEqual(b.target);
  const count = await startFixtureSql<{ n: number }>(
    'SELECT count(*)::int n FROM ctp_paper.current_risk_certificate WHERE tenant_id=$1',
    [f.c.owner.tenantId],
  );
  expect(count.rows[0]!.n).toBe(1);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-current-order-risk: retired target rules invalidate capture and restart read instead of replaying stale authority', async () => {
  const { f, request } = await currentOrderTargetReady(),
    port = await openCurrentOrderRisk();
  await port.capture(request, startIo());
  const before = await startFixtureEffects(f.c.owner.tenantId);
  await startFixtureSql('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.s.key.dbRuleId,
  ]);
  await expect(port.capture(request, startIo())).rejects.toThrow(/^PAPER_/u);
  await port.close();
  const restarted = await openCurrentOrderRisk();
  await expect(restarted.readCurrent(request, startIo())).rejects.toThrow(/^PAPER_/u);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
async function publishCurrentRiskPrice(f: Awaited<ReturnType<typeof ready>>, price: string) {
  const p = structuredClone(f.f.s),
    head = await f.snapshots.read(p.key, startIo()),
    now = Date.now();
  p.id = randomUUID();
  p.expectedRevision = head.revision;
  p.timestamp = now;
  p.ticker.last = { state: 'AVAILABLE', value: parseDecimal(price) };
  for (const value of [p.book, p.ticker]) value.receivedAt = value.exchangeTime = now;
  if (p.book.sourceSequence !== null)
    p.book.sourceSequence = (BigInt(p.book.sourceSequence) + BigInt(head.revision) + 1n).toString();
  expect((await f.snapshots.publish(p, startIo())).status).toBe('APPLIED');
  await refreshCurrentRiskEvidence(f);
  return p;
}
it('paper-current-risk: preserves a real intermediate equity peak across a lower mark and coordinator restart', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const highMark = await publishCurrentRiskPrice(f, '16.05'),
    coordinator = await openCurrentRisk(),
    request = currentRiskRequest(f),
    before = await startFixtureEffects(f.c.owner.tenantId),
    high = await coordinator.certify(request, startIo());
  expect(high.loss.complete).toBe(true);
  expect(high.loss.actualEquity).toBe(high.inventory.valuation.equity);
  await publishCurrentRiskPrice(f, '12.05');
  await expect(coordinator.readCurrent(request, startIo())).rejects.toThrow(/^PAPER_/u);
  await coordinator.close();
  const restarted = await openCurrentRisk(),
    low = await restarted.certify(request, startIo());
  expect(low.loss.adjustedPeakEquity).toBe(high.loss.adjustedPeakEquity);
  expect(
    decimalCompare(parseDecimal(low.loss.actualEquity), parseDecimal(high.loss.actualEquity)),
  ).toBe(-1);
  expect(low.loss.baseline).toEqual(high.loss.baseline);
  expect(low.loss.dailyNetRealizedPnl).toBe(high.loss.dailyNetRealizedPnl);
  const retained = await startFixtureSql<{ count: number }>(
    `SELECT count(*)::int count FROM ctp_paper.current_loss_seen WHERE tenant_id=$1 AND event_id=$2`,
    [f.c.owner.tenantId, highMark.id],
  );
  expect(retained.rows[0]!.count).toBe(1);
  expect(await restarted.readCurrent(request, startIo())).toEqual(low);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-current-risk: uncertain certificate COMMIT grants nothing and restart reads its single durable nonfinancial result', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  await refreshValuationMark(f);
  await refreshCurrentRiskEvidence(f);
  const request = currentRiskRequest(f),
    before = await startFixtureEffects(f.c.owner.tenantId),
    proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_EXECUTION_SOURCE');
  try {
    const coordinator = await openCurrentRisk(proxy.connectionString);
    proxy.arm();
    await expect(coordinator.certify(request, startIo())).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
    expect(proxy.dropped()).toBe(1);
    await coordinator.close();
    const restarted = await openCurrentRisk(),
      current = await restarted.readCurrent(request, startIo());
    expect(current.kind).toBe('PAPER_CURRENT_RISK_CERTIFICATE');
    expect(current).not.toHaveProperty('grant');
    expect(current).not.toHaveProperty('permit');
    expect(await restarted.certify(request, startIo())).toEqual(current);
    expect(
      (
        await startFixtureSql<{ count: number }>(
          `SELECT count(*)::int count FROM ctp_paper.current_risk_certificate WHERE tenant_id=$1`,
          [f.c.owner.tenantId],
        )
      ).rows[0]!.count,
    ).toBe(1);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await proxy.close();
  }
});
it('paper-current-risk: current pause and permission epochs cannot be bypassed by a stored certificate', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  await refreshValuationMark(f);
  await refreshCurrentRiskEvidence(f);
  const coordinator = await openCurrentRisk(),
    request = currentRiskRequest(f),
    certificate = await coordinator.certify(request, startIo()),
    before = await startFixtureEffects(f.c.owner.tenantId);
  await startFixturePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' });
  await expect(coordinator.readCurrent(request, startIo())).rejects.toThrow(/^PAPER_/u);
  const refreshed = await coordinator.certify(request, startIo());
  expect(refreshed.policies.user.version).not.toBe(certificate.policies.user.version);
  expect(refreshed.policies.effective.maxOrderNotional).toBe('1');
  expect(refreshed.loss.adjustedPeakEquity).toBe(certificate.loss.adjustedPeakEquity);
  await startFixturePause(f.c.owner.tenantId, 'PAUSED');
  await expect(coordinator.readCurrent(request, startIo())).rejects.toThrow(/^PAPER_/u);
  const paused = await coordinator.certify(request, startIo());
  expect(paused.snapshot.pauses.user).toBe(true);
  expect(paused.id).not.toBe(refreshed.id);
  expect(paused).not.toHaveProperty('grant');
  await startFixtureSql(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.c.owner.accountId],
  );
  await expect(coordinator.readCurrent(request, startIo())).rejects.toThrow(/^PAPER_/u);
  await expect(coordinator.certify(request, startIo())).rejects.toThrow(/^PAPER_/u);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
async function prepareCurrentRiskBacklog() {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const high = await publishCurrentRiskPrice(f, '16.05'),
    head = await f.snapshots.read(high.key, startIo()),
    before = await startFixtureEffects(f.c.owner.tenantId),
    request = currentRiskRequest(f),
    roleConnection = process.env['DATABASE_MARKET_SNAPSHOT_URL'];
  if (!roleConnection) throw Error('CURRENT_RISK_PUBLIC_ROLE_REQUIRED');
  // Genuine restricted public publisher calls, not administrator row inserts.
  // Bounded publisher batches retain the same per-query deadlines and avoid
  // adding 1,001 connection handshakes to the fixture.
  const publisher = new Pool({
    connectionString: roleConnection,
    max: 1,
    connectionTimeoutMillis: 1000,
    query_timeout: 2500,
    statement_timeout: 2000,
  });
  try {
    let revision = head.revision,
      sequence = BigInt(high.book.sourceSequence ?? '0');
    for (let offset = 0; offset < 1001; offset += 100) {
      const fresh = structuredClone(high),
        now = Date.now();
      fresh.id = randomUUID();
      fresh.expectedRevision = revision;
      fresh.timestamp = now;
      for (const value of [fresh.book, fresh.ticker]) value.receivedAt = value.exchangeTime = now;
      if (fresh.book.sourceSequence !== null) fresh.book.sourceSequence = (++sequence).toString();
      const text = canonical(fresh),
        applied = await publisher.query<{ result: { status: string; revision: string } }>(
          'SELECT ctp_market.publish_snapshot($1,$2) result',
          [text, createHash('sha256').update(text).digest('hex')],
        );
      expect(applied.rows[0]!.result.status).toBe('APPLIED');
      revision = applied.rows[0]!.result.revision;
      const observations = Array.from({ length: Math.min(100, 1001 - offset) }, () => {
        const p = { ...fresh, id: randomUUID(), expectedRevision: revision },
          body = canonical(p);
        return { text: body, hash: createHash('sha256').update(body).digest('hex') };
      });
      const published = await publisher.query<{ result: { status: string } }>(
        `SELECT ctp_market.publish_snapshot(p->>'text',p->>'hash') result FROM jsonb_array_elements($1::jsonb) q(p)`,
        [JSON.stringify(observations)],
      );
      expect(published.rows).toHaveLength(observations.length);
      expect(published.rows.every((r) => r.result.status === 'DUPLICATE')).toBe(true);
    }
  } finally {
    await publisher.end();
  }
  await publishCurrentRiskPrice(f, '12.05');
  return { f, before, request };
}
describe('paper-current-risk: bounded DUPLICATE catch-up', () => {
  let fixture: Awaited<ReturnType<typeof prepareCurrentRiskBacklog>>;
  // Only immutable retained-history setup is in the existing bounded hook.
  // Every coordinator assertion remains under the unchanged 15-second test
  // limit; setup also remains inside the aggregate 90-second owner budget.
  beforeAll(async () => {
    fixture = await prepareCurrentRiskBacklog();
  });
  it('remains incomplete until durable restart consumes every retained observation', async () => {
    const { f, before, request } = fixture;
    const coordinator = await openCurrentRisk();
    await expect(coordinator.certify(request, startIo())).rejects.toThrow(/^PAPER_/u);
    expect(
      (
        await startFixtureSql<{ count: number }>(
          'SELECT count(*)::int count FROM ctp_paper.current_loss_checkpoint WHERE tenant_id=$1',
          [f.c.owner.tenantId],
        )
      ).rows[0]!.count,
    ).toBe(0);
    const partial = await coordinator.advanceLoss(request, startIo());
    expect(partial.complete).toBe(false);
    expect(partial).not.toHaveProperty('certificate');
    expect(partial).not.toHaveProperty('grant');
    await coordinator.close();
    await publishCurrentRiskPrice(f, '12.05');
    const restarted = await openCurrentRisk();
    let complete: paper.PaperCurrentLossProgress = partial;
    for (let batch = 0; batch < 16 && !complete.complete; batch++) {
      if (batch > 0 && batch % 2 === 0) await publishCurrentRiskPrice(f, '12.05');
      complete = await restarted.advanceLoss(request, startIo());
      expect(complete.loss.adjustedPeakEquity).toBe(partial.loss.adjustedPeakEquity);
    }
    expect(complete.complete).toBe(true);
    await expect(restarted.readCurrent(request, startIo())).rejects.toThrow(/^PAPER_/u);
    const certificate = await restarted.certify(request, startIo());
    expect(certificate.loss.adjustedPeakEquity).toBe(partial.loss.adjustedPeakEquity);
    expect(
      decimalCompare(
        parseDecimal(certificate.loss.adjustedPeakEquity),
        parseDecimal(certificate.loss.adjustedCurrentEquity),
      ),
    ).toBe(1);
    const consumed = await startFixtureSql<{ count: number }>(
      `SELECT count(*)::int count FROM ctp_paper.current_loss_seen s
    JOIN ctp_market.snapshot_event e ON e.id=s.event_id WHERE s.tenant_id=$1 AND e.status='DUPLICATE'`,
      [f.c.owner.tenantId],
    );
    expect(consumed.rows[0]!.count).toBe(1001);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  });
});
it('paper-current-risk: a newer ticker-only observation cannot be ignored in favour of an older current equity mark', async () => {
  const writer = await open(),
    f = await ready();
  await writer.execute(f.request, startIo());
  const high = await publishCurrentRiskPrice(f, '16.05'),
    head = await f.snapshots.read(high.key, startIo()),
    tickerOnly = structuredClone(high),
    now = Date.now();
  tickerOnly.id = randomUUID();
  tickerOnly.expectedRevision = head.revision;
  tickerOnly.timestamp = now;
  tickerOnly.ticker.receivedAt = tickerOnly.ticker.exchangeTime = now;
  tickerOnly.ticker.last = { state: 'AVAILABLE', value: parseDecimal('10.05') };
  // Keep the native book version and all book clocks unchanged. This is an
  // actual retained ticker observation, not a fresh-book liquidity receipt.
  expect((await f.snapshots.publish(tickerOnly, startIo())).status).toBe('DUPLICATE');
  const before = await startFixtureEffects(f.c.owner.tenantId),
    coordinator = await openCurrentRisk(),
    request = currentRiskRequest(f);
  await expect(coordinator.certify(request, startIo())).rejects.toThrow(/^PAPER_/u);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  await publishCurrentRiskPrice(f, '10.05');
  const coherent = await coordinator.certify(request, startIo());
  expect(coherent.loss.actualEquity).toBe(coherent.inventory.valuation.equity);
  expect(
    decimalCompare(
      parseDecimal(coherent.loss.adjustedPeakEquity),
      parseDecimal(coherent.loss.adjustedCurrentEquity),
    ),
  ).toBe(1);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});

export { currentOrderTargetReady, openActual };
