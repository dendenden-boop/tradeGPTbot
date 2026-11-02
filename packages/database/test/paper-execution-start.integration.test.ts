import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { canonical } from '@ctp/portfolio';
import * as paper from '@ctp/paper-engine/risk';
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
it('paper-start: real fixed RPC derives one immutable START without a second financial effect', async () => {
  const f = await readyExecutionStart(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  const runtime = new Pool({
      connectionString: startFixtureConnection(),
      max: 1,
      query_timeout: 5000,
    }),
    client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    const result = await client.query<{ result: { receipt: unknown } }>(
      'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
      [canonical(f.request)],
    );
    await client.query('COMMIT');
    const receipt = result.rows[0]!.result.receipt;
    expect(receipt).toEqual(await f.journal.start(f.request, startIo()));
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await runtime.end();
  }
});
it('paper-start: concurrent exact replay is one event; permanent conflicting keys reject without new authority', async () => {
  const f = await readyExecutionStart(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  const replies = await Promise.all([
    f.journal.start(f.request, startIo()),
    f.journal.start(f.request, startIo()),
  ]);
  expect(replies[0]).toEqual(replies[1]);
  await expect(
    f.journal.start({ ...f.request, startKey: 'another-' + randomUUID() }, startIo()),
  ).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  const reopened = await paper.createPostgresPaperExecutionStartJournal({
    connectionString: startFixtureConnection(),
    environment: 'test',
  });
  try {
    const view = await reopened.read(f.request, startIo());
    expect(view.kind).toBe('COMMITTED');
    if (view.kind === 'COMMITTED') expect(view.receipt).toEqual(replies[0]);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await reopened.close();
  }
});
it('paper-start: current policy and pause reject a prepared request before START without claiming UNKNOWN', async () => {
  const f = await readyExecutionStart();
  await startFixturePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' });
  await expect(f.journal.start(f.request, startIo())).rejects.toThrow('PAPER_ADMISSION_LIMIT');
  expect((await f.journal.read(f.request, startIo())).kind).toBe('MISSING');
  await startFixturePolicy(f.c.owner.tenantId, 'USER');
  await startFixturePause(f.c.owner.tenantId, 'PAUSED');
  await expect(f.journal.start(f.request, startIo())).rejects.toThrow('PAPER_ADMISSION_LIMIT');
  expect((await f.journal.read(f.request, startIo())).kind).toBe('MISSING');
});
it('paper-start: START prevents legacy NOT_SENT and UNKNOWN retains the complete original hold', async () => {
  const f = await readyExecutionStart(),
    before = await startFixtureEffects(f.c.owner.tenantId),
    receipt = await f.journal.start(f.request, startIo());
  await expect(
    f.preparation.stopBeforeStart(
      {
        ...f.prepareRequest,
        kind: 'PAPER_ATTEMPT_STOP',
        stopKey: 'stop-' + randomUUID(),
        reason: 'CANCELLED',
      },
      startIo(),
    ),
  ).rejects.toThrow();
  const cause = await f.lifecycle.markUnknown(
    {
      kind: 'PAPER_RESERVATION_UNKNOWN',
      admission: f.admission,
      reservationId: f.approval.reservationId,
      eventId: randomUUID(),
      expectedRevision: '1',
    },
    startIo(),
  );
  const view = await f.journal.read(f.request, startIo());
  expect(view.kind).toBe('COMMITTED');
  if (view.kind === 'COMMITTED') {
    expect(view.receipt).toEqual(receipt);
    expect(view.state.phase).toBe('UNKNOWN');
    expect(view.unknown?.eventId).toBe(cause.eventId);
  }
  expect(await f.journal.start(f.request, startIo())).toEqual(receipt);
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-start: physically lost COMMIT grants nothing; readonly recovery finds the only actual START', async () => {
  const f = await readyExecutionStart(),
    before = await startFixtureEffects(f.c.owner.tenantId),
    proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_ADMISSION');
  const transport = await paper.createPostgresPaperExecutionStartJournal({
    connectionString: proxy.connectionString,
    environment: 'test',
  });
  try {
    proxy.arm();
    await expect(transport.start(f.request, startIo())).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
    expect(proxy.dropped()).toBe(1);
    const view = await f.journal.read(f.request, startIo());
    expect(view.kind).toBe('COMMITTED');
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await transport.close();
    await proxy.close();
  }
});
it('paper-start: private table denies runtime writes and immutable START survives policy/epoch history changes', async () => {
  const f = await readyExecutionStart(),
    receipt = await f.journal.start(f.request, startIo());
  const runtime = new Pool({
    connectionString: startFixtureConnection(),
    max: 1,
    query_timeout: 5000,
  });
  try {
    const privileges = await runtime.query<{ direct: boolean }>(
      "SELECT has_table_privilege(current_user,'ctp_paper.attempt_start','INSERT,UPDATE,DELETE,TRUNCATE') direct",
    );
    expect(privileges.rows[0]!.direct).toBe(false);
  } finally {
    await runtime.end();
  }
  await expect(
    startFixtureSql("UPDATE ctp_paper.attempt_start SET start_key='forged' WHERE tenant_id=$1", [
      f.c.owner.tenantId,
    ]),
  ).rejects.toThrow();
  await expect(
    startFixtureSql('DELETE FROM ctp_paper.attempt_start WHERE tenant_id=$1', [f.c.owner.tenantId]),
  ).rejects.toThrow();
  await expect(startFixtureSql('TRUNCATE ctp_paper.attempt_start')).rejects.toThrow();
  await startFixtureSql('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  await startFixturePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' });
  await startFixturePause(f.c.owner.tenantId, 'PAUSED');
  expect(await f.journal.start(f.request, startIo())).toEqual(receipt);
  await startFixtureSql(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE "tenantId"=$1 AND id=$2',
    [f.c.owner.tenantId, f.c.owner.accountId],
  );
  await expect(f.journal.read(f.request, startIo())).rejects.toThrow('PAPER_ADMISSION_SCOPE');
  const updated = {
    ...f.request,
    authorization: {
      ...f.request.authorization,
      permissionEpoch: String(BigInt(f.request.authorization.permissionEpoch) + 1n),
    },
  };
  const view = await f.journal.read(updated, startIo());
  expect(view.kind).toBe('COMMITTED');
  if (view.kind === 'COMMITTED') expect(view.receipt).toEqual(receipt);
});
it('paper-start: STOP and START have exactly one winner under their shared native lock boundary', async () => {
  const f = await readyExecutionStart(),
    before = await startFixtureEffects(f.c.owner.tenantId);
  const results = await Promise.allSettled([
    f.journal.start(f.request, startIo()),
    f.preparation.stopBeforeStart(
      {
        ...f.prepareRequest,
        kind: 'PAPER_ATTEMPT_STOP',
        stopKey: 'race-stop-' + randomUUID(),
        reason: 'CANCELLED',
      },
      startIo(),
    ),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const view = await f.journal.read(f.request, startIo());
  expect(view.kind).toBe(results[0].status === 'fulfilled' ? 'COMMITTED' : 'MISSING');
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
it('paper-start: current rules replacement and failed executor health reject without a positive journal row', async () => {
  const f = await readyExecutionStart();
  await startFixtureSql('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    f.f.p.key.dbRuleId,
  ]);
  await expect(f.journal.start(f.request, startIo())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect((await f.journal.read(f.request, startIo())).kind).toBe('MISSING');
  const g = await readyExecutionStart(),
    publication = structuredClone(g.publication);
  publication.id = randomUUID();
  publication.expectedRevision = (await g.runtime.head(g.c.owner, startIo()))!.revision;
  publication.observation.health.executor = {
    ...publication.observation.health.executor,
    status: 'FAILED',
    asOf: Date.now(),
  };
  await g.runtime.publish(publication, startIo());
  await expect(g.journal.start(g.request, startIo())).rejects.toThrow('PAPER_ADMISSION_LIMIT');
  expect((await g.journal.read(g.request, startIo())).kind).toBe('MISSING');
});
it('paper-start: complete preparation and earliest FIFO cannot be bypassed; old pristine views fail closed after START', async () => {
  const f = await readyExecutionStart();
  const second = await f.orders.create(f.binding, { ...f.draft, key: randomUUID() }, startIo());
  const hash = (
    await startFixtureSql<{ hash: string }>(
      'SELECT encode("commandHash",\'hex\') hash FROM ctp_execution.command WHERE "tenantId"=$1 AND "intentId"=$2',
      [f.c.owner.tenantId, second.intentId],
    )
  ).rows[0]!.hash;
  const admission = {
    ...f.admission,
    orderId: second.id,
    intentId: second.intentId,
    commandHash: hash,
  };
  await f.admissionPort.approve(
    {
      binding: f.binding,
      state: { id: second.id },
      intentId: second.intentId,
      operation: 'PLACE',
      commandHash: hash,
    },
    startIo(),
  );
  const request = {
    ...f.request,
    admission,
    preparationKey: 'prepare-second-' + randomUUID(),
    startKey: 'start-second-' + randomUUID(),
  };
  await expect(f.journal.start(f.request, startIo())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  await f.preparation.prepare(
    {
      kind: 'PAPER_ATTEMPT_PREPARE',
      key: request.preparationKey,
      admission,
      authorization: request.authorization,
    },
    startIo(),
  );
  await expect(f.journal.start(request, startIo())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  const before = await startFixtureEffects(f.c.owner.tenantId);
  await f.journal.start(f.request, startIo());
  await expect(f.preparation.read(f.prepareRequest, startIo())).rejects.toThrow(
    'PAPER_ADMISSION_EVIDENCE',
  );
  expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
});
