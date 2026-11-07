import { randomUUID } from 'node:crypto';
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
