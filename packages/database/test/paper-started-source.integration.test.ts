import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { canonical } from '@ctp/portfolio';
import * as paper from '@ctp/paper-engine/risk';
import type { PaperExecutionSource } from '@ctp/paper-engine/risk';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import {
  closeStartFixture,
  readyExecutionStart,
  startFixtureConnection,
  startFixtureEffects,
  startFixtureSql,
  startIo,
} from './fixtures/paper-execution-start.js';
afterAll(closeStartFixture);
interface Reader {
  read(
    request: unknown,
    io: ReturnType<typeof startIo>,
  ): Promise<{
    kind: string;
    source: PaperExecutionSource;
    entries: readonly { kind: string }[];
    journal: { receipt: unknown; state: { phase: string } };
  }>;
  close(): Promise<void>;
}
function factory() {
  const fn = (paper as unknown as Record<string, unknown>)[
    'createPostgresPaperStartedExecutionSource'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_STARTED_SOURCE_FACTORY_MISSING');
  return fn as (options: unknown) => Promise<Reader>;
}
const requestFor = (request: Awaited<ReturnType<typeof readyExecutionStart>>['request']) => ({
  ...request,
  kind: 'PAPER_STARTED_EXECUTION_CAPTURE' as const,
});
const open = (connectionString = startFixtureConnection()) =>
  factory()({ connectionString, environment: 'test' });
it('paper-started-source: real fixed readonly RPC joins known START and current book without a financial effect', async () => {
  const f = await readyExecutionStart(),
    receipt = await f.journal.start(f.request, startIo());
  const before = await startFixtureEffects(f.c.owner.tenantId),
    pool = new Pool({ connectionString: startFixtureConnection(), max: 1, query_timeout: 5000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    const result = await client.query<{
      result: { journal: { receipt: unknown }; entries: { kind: string }[] };
    }>('SELECT ctp_paper.reconcile_admission($1::jsonb) AS result', [
      canonical(requestFor(f.request)),
    ]);
    await client.query('COMMIT');
    expect(result.rows[0]!.result.journal.receipt).toEqual(receipt);
    expect(result.rows[0]!.result.entries.map((e) => e.kind)).toEqual(['STARTED']);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
it('paper-started-source: factory reopen rereads actual durable data while old pristine readers remain closed', async () => {
  const f = await readyExecutionStart(),
    receipt = await f.journal.start(f.request, startIo()),
    before = await startFixtureEffects(f.c.owner.tenantId);
  for (let n = 0; n < 2; n++) {
    const port = await open();
    try {
      const r = await port.read(requestFor(f.request), startIo());
      expect(r.kind).toBe('PAPER_STARTED_EXECUTION_SOURCE');
      expect(r.journal.receipt).toEqual(receipt);
      expect(r.source.portfolio.binding.accountId).toBe(f.c.owner.accountId);
      expect(r.source.candidates[0]!.intentId).toBe(f.order.intentId);
    } finally {
      await port.close();
    }
  }
  await expect(f.preparation.read(f.prepareRequest, startIo())).rejects.toThrow(
    'PAPER_ADMISSION_EVIDENCE',
  );
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-started-source: prepared or conflicting START selectors cannot establish a started source', async () => {
  const f = await readyExecutionStart(),
    port = await open();
  try {
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_EVIDENCE',
    );
    await f.journal.start(f.request, startIo());
    await expect(
      port.read({ ...requestFor(f.request), preparationKey: 'different' }, startIo()),
    ).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
    await expect(
      port.read({ ...requestFor(f.request), startKey: 'different' }, startIo()),
    ).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  } finally {
    await port.close();
  }
});
it('paper-started-source: UNKNOWN remains a full hold and cannot become a current execution source', async () => {
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
  const port = await open();
  try {
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_EVIDENCE',
    );
  } finally {
    await port.close();
  }
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  const view = await f.journal.read(f.request, startIo());
  expect(view.kind === 'COMMITTED' && view.state.phase).toBe('UNKNOWN');
});
it('paper-started-source: current ownership epochs precede lookup while the original START receipt stays immutable', async () => {
  const f = await readyExecutionStart(),
    receipt = await f.journal.start(f.request, startIo()),
    port = await open();
  await startFixtureSql(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.c.owner.accountId],
  );
  const request = {
    ...requestFor(f.request),
    authorization: {
      ...f.request.authorization,
      permissionEpoch: String(BigInt(f.request.authorization.permissionEpoch) + 1n),
    },
  };
  try {
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_SCOPE',
    );
    expect((await port.read(request, startIo())).journal.receipt).toEqual(receipt);
  } finally {
    await port.close();
  }
});
it('paper-started-source: current metadata replacement rejects without rewriting historical START', async () => {
  const f = await readyExecutionStart(),
    receipt = await f.journal.start(f.request, startIo()),
    port = await open();
  await startFixtureSql('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  try {
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_EVIDENCE',
    );
  } finally {
    await port.close();
  }
  const view = await f.journal.read(f.request, startIo());
  expect(view.kind === 'COMMITTED' && view.receipt).toEqual(receipt);
});
it('paper-started-source: complete FIFO retains later preparations and fails closed on newly unprepared contenders', async () => {
  const port = await open();
  let secondOrder: Awaited<ReturnType<typeof readyExecutionStart>>['order'] | undefined,
    third: typeof secondOrder;
  const hashes = new Map<string, string>();
  const f = await readyExecutionStart(async ({ orders, binding, draft }) => {
    const outcomes = await Promise.allSettled([
      orders.create(binding, { ...draft, key: randomUUID() }, startIo()),
      orders.create(binding, { ...draft, key: randomUUID() }, startIo()),
    ]);
    const [secondResult, thirdResult] = outcomes;
    if (secondResult!.status === 'rejected') throw secondResult!.reason;
    if (thirdResult!.status === 'rejected') throw thirdResult!.reason;
    secondOrder = secondResult!.value;
    third = thirdResult!.value;
    const commands = await startFixtureSql<{ intent: string; hash: string }>(
      'SELECT "intentId" intent,encode("commandHash",\'hex\') hash FROM ctp_execution.command WHERE "tenantId"=$1 AND "intentId"=ANY($2::uuid[])',
      [binding.tenantId, [secondOrder.intentId, third.intentId]],
    );
    for (const command of commands.rows) hashes.set(command.intent, command.hash);
    expect(hashes.size).toBe(2);
  });
  const enqueue = async (order: NonNullable<typeof secondOrder>) => {
    const hash = hashes.get(order.intentId)!;
    await f.admissionPort.approve(
      {
        binding: f.binding,
        state: { id: order.id },
        intentId: order.intentId,
        operation: 'PLACE',
        commandHash: hash,
      },
      startIo(),
    );
    return { ...f.admission, orderId: order.id, intentId: order.intentId, commandHash: hash };
  };
  const second = await enqueue(secondOrder!);
  await f.preparation.prepare(
    { ...f.prepareRequest, key: 'second-' + randomUUID(), admission: second },
    startIo(),
  );
  await f.journal.start(f.request, startIo());
  try {
    const r = await port.read(requestFor(f.request), startIo());
    expect(r.entries.map((e) => e.kind)).toEqual(['STARTED', 'PREPARED']);
    await enqueue(third!);
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_EVIDENCE',
    );
  } finally {
    await port.close();
  }
});
it('paper-started-source: physically dropped read COMMIT yields no source and an explicit reread has no money effect', async () => {
  const proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_EXECUTION_SOURCE'),
    port = await open(proxy.connectionString),
    direct = await open();
  try {
    const f = await readyExecutionStart(),
      receipt = await f.journal.start(f.request, startIo()),
      before = await startFixtureEffects(f.c.owner.tenantId);
    proxy.arm();
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
    expect(proxy.dropped()).toBe(1);
    expect((await direct.read(requestFor(f.request), startIo())).journal.receipt).toEqual(receipt);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await port.close();
    await direct.close();
    await proxy.close();
  }
});
it('paper-started-source: runtime has no direct helper execution or table mutation authority', async () => {
  const f = await readyExecutionStart();
  await f.journal.start(f.request, startIo());
  const pool = new Pool({
    connectionString: startFixtureConnection(),
    max: 1,
    query_timeout: 5000,
  });
  try {
    const privileges = await pool.query<{ helper: boolean; alias: boolean; write: boolean }>(
      "SELECT has_function_privilege(current_user,'ctp_paper.capture_started_execution(jsonb)','EXECUTE') helper,has_function_privilege(current_user,'ctp_paper.reconcile_admission_v62(jsonb)','EXECUTE') alias,has_table_privilege(current_user,'ctp_paper.attempt_start','INSERT,UPDATE,DELETE,TRUNCATE') write",
    );
    expect(privileges.rows[0]).toEqual({ helper: false, alias: false, write: false });
    await expect(
      pool.query('SELECT ctp_paper.capture_started_execution($1::jsonb)', [
        canonical(requestFor(f.request)),
      ]),
    ).rejects.toThrow();
  } finally {
    await pool.end();
  }
});
