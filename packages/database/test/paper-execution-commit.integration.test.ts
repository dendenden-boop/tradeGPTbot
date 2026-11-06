import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import * as paper from '@ctp/paper-engine/risk';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import { waitForFixtureClock } from './fixtures/preview-clock.js';
import {
  closeStartFixture,
  readyExecutionStart,
  startFixtureConnection,
  startFixtureEffects,
  startFixturePause,
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
  });
  const conservation = await startFixtureSql<{ balanced: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM public.ledger_entry WHERE "tenantId"=$1 AND "transactionId"=ANY($2::uuid[]) GROUP BY "transactionId",asset HAVING sum(amount)<>0) balanced`,
    [f.c.owner.tenantId, receipt.ledgerTransactionIds],
  );
  expect(conservation.rows).toEqual([{ balanced: true }]);
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
