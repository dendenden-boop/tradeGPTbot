import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, expect, it } from 'vitest';
import { canonical } from '@ctp/portfolio';
import * as paper from '@ctp/paper-engine/risk';
import type { PaperStartedRiskSource } from '../../paper-engine/src/postgres-started-risk.js';
import type { PaperStartedExecutionPortfolioCalculation } from '../../paper-engine/src/started-execution.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
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

afterAll(closeStartFixture);
interface Preview {
  kind: string;
  source: PaperStartedRiskSource;
  execution: PaperStartedExecutionPortfolioCalculation;
}
interface Port {
  preview(request: unknown, io: ReturnType<typeof startIo>): Promise<Preview>;
  close(): Promise<void>;
}
function open(connectionString = startFixtureConnection()) {
  const fn = (paper as unknown as Record<string, unknown>)[
    'createPostgresPaperStartedExecutionPreview'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_STARTED_PREVIEW_FACTORY_MISSING');
  return (fn as (o: unknown) => Promise<Port>)({ connectionString, environment: 'test' });
}
const requestFor = (r: Awaited<ReturnType<typeof readyExecutionStart>>['request']) => ({
  ...r,
  kind: 'PAPER_STARTED_RISK_CAPTURE',
});
it('paper-started-preview: composes actual locked START/Risk with calculation without writing money, holds or the journal', async () => {
  const port = await open();
  try {
    const f = await readyExecutionStart(),
      receipt = await f.journal.start(f.request, startIo()),
      before = await startFixtureEffects(f.c.owner.tenantId),
      view = await f.journal.read(f.request, startIo()),
      r = await port.preview(requestFor(f.request), startIo());
    expect(r.kind).toBe('PAPER_STARTED_EXECUTION_PREVIEW');
    expect(r.source.started.journal.receipt).toEqual(receipt);
    expect(r.source.risk.evaluation.kind).toBe('EVALUATED');
    expect(r.execution.calculation.fills).toEqual([]);
    expect(r.execution.calculation.state).toEqual(r.execution.calculation.before);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
    expect(await f.journal.read(f.request, startIo())).toEqual(view);
    expect('grant' in r || 'permit' in r || 'committed' in r).toBe(false);
  } finally {
    await port.close();
  }
});
it('paper-started-preview: fresh post-START public evidence yields repeatable economic projections after factory reopen without durable consumption', async () => {
  const ports = [await open(), await open()];
  try {
    const f = await readyExecutionStart(),
      receipt = await f.journal.start(f.request, startIo());
    const eligible = receipt.startedAt + f.c.model.latencyMs + f.c.model.latencyJitterMs;
    const wait = eligible - Date.now();
    if (wait > 0) await delay(wait);
    const now = Date.now(),
      snapshot = structuredClone(f.f.s),
      trade = structuredClone(f.f.p);
    const snapshotHead = await f.snapshots.read(snapshot.key, startIo()),
      tradeHead = await f.trades.read(trade.key, startIo());
    expect(snapshotHead).not.toBeNull();
    expect(tradeHead).not.toBeNull();
    snapshot.id = randomUUID();
    snapshot.expectedRevision = snapshotHead.revision;
    snapshot.timestamp = now;
    if (snapshot.book.sourceSequence !== null)
      snapshot.book.sourceSequence = (BigInt(snapshot.book.sourceSequence) + 1n).toString();
    for (const v of [snapshot.book, snapshot.ticker]) v.receivedAt = v.exchangeTime = now;
    trade.id = randomUUID();
    trade.expectedRevision = tradeHead.revision;
    trade.timestamp = now;
    trade.trade.tradeId = 'preview-' + randomUUID();
    if (trade.trade.sourceSequence !== null)
      trade.trade.sourceSequence = (BigInt(trade.trade.sourceSequence) + 1n).toString();
    trade.trade.receivedAt = trade.trade.exchangeTime = now;
    expect((await f.snapshots.publish(snapshot, startIo())).status).toBe('APPLIED');
    expect((await f.trades.publish(trade, startIo())).status).toBe('APPLIED');
    const before = await startFixtureEffects(f.c.owner.tenantId),
      results = [];
    for (const port of ports) {
      const r = await port.preview(requestFor(f.request), startIo());
      expect(r.execution.calculation.fills.length).toBeGreaterThan(0);
      expect(r.source.started.journal.receipt).toEqual(receipt);
      expect(r.execution.calculation.state.holds).toEqual(r.execution.calculation.before.holds);
      results.push(r);
    }
    expect(
      results[1]!.execution.calculation.fills.map((x) => ({
        id: x.fillId,
        quantity: x.event.quantity,
        price: x.event.price,
        fees: x.event.fees,
        postings: x.postings,
      })),
    ).toEqual(
      results[0]!.execution.calculation.fills.map((x) => ({
        id: x.fillId,
        quantity: x.event.quantity,
        price: x.event.price,
        fees: x.event.fees,
        postings: x.postings,
      })),
    );
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
    expect(canonical(results[0]!.source.started.source.portfolio)).toBe(
      canonical(results[1]!.source.started.source.portfolio),
    );
  } finally {
    await Promise.all(ports.map((p) => p.close()));
  }
});
it('paper-started-preview: current policy and pause changes block a known START without modifying its receipt or economic effects', async () => {
  const port = await open();
  try {
    const f = await readyExecutionStart(),
      receipt = await f.journal.start(f.request, startIo()),
      before = await startFixtureEffects(f.c.owner.tenantId);
    await startFixturePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '0.01' });
    await expect(port.preview(requestFor(f.request), startIo())).rejects.toThrow(
      /PAPER_ADMISSION_(LIMIT|EVIDENCE)/u,
    );
    await startFixturePolicy(f.c.owner.tenantId, 'USER');
    await startFixturePause(f.c.owner.tenantId, 'PAUSED');
    await expect(port.preview(requestFor(f.request), startIo())).rejects.toThrow(
      /PAPER_ADMISSION_(LIMIT|EVIDENCE)/u,
    );
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
    const view = await f.journal.read(f.request, startIo());
    expect(view.kind === 'COMMITTED' && view.receipt).toEqual(receipt);
  } finally {
    await port.close();
  }
});
it('paper-started-preview: UNKNOWN keeps the whole reservation and cannot produce execution output', async () => {
  const port = await open();
  try {
    const f = await readyExecutionStart();
    await f.journal.start(f.request, startIo());
    const before = await startFixtureEffects(f.c.owner.tenantId);
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
    await expect(port.preview(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_EVIDENCE',
    );
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await port.close();
  }
});
it('paper-started-preview: current ownership epochs are authenticated before any calculation', async () => {
  const port = await open();
  try {
    const f = await readyExecutionStart();
    await f.journal.start(f.request, startIo());
    const before = await startFixtureEffects(f.c.owner.tenantId);
    await startFixtureSql(
      'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE "tenantId"=$1 AND id=$2',
      [f.c.owner.tenantId, f.c.owner.accountId],
    );
    await expect(port.preview(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_SCOPE',
    );
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await port.close();
  }
});
it('paper-started-preview: physically lost readonly COMMIT returns uncertainty, never output or retry, and explicit recapture has no monetary effect', async () => {
  const proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_EXECUTION_SOURCE'),
    port = await open(proxy.connectionString),
    direct = await open();
  try {
    const f = await readyExecutionStart();
    await f.journal.start(f.request, startIo());
    const before = await startFixtureEffects(f.c.owner.tenantId);
    proxy.arm();
    await expect(port.preview(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
    expect(proxy.dropped()).toBe(1);
    expect((await direct.preview(requestFor(f.request), startIo())).kind).toBe(
      'PAPER_STARTED_EXECUTION_PREVIEW',
    );
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await port.close();
    await direct.close();
    await proxy.close();
  }
});
