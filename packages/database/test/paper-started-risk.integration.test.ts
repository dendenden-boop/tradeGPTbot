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
interface Port {
  read(
    request: unknown,
    io: ReturnType<typeof startIo>,
  ): Promise<{
    kind: string;
    started: { journal: { receipt: unknown; state: { phase: string } } };
    risk: { evaluation: { kind: string } };
  }>;
  close(): Promise<void>;
}
function open(connectionString = startFixtureConnection()) {
  const fn = (paper as unknown as Record<string, unknown>)['createPostgresPaperStartedRiskSource'];
  if (typeof fn !== 'function') throw Error('PAPER_STARTED_RISK_FACTORY_MISSING');
  return (fn as (o: unknown) => Promise<Port>)({ connectionString, environment: 'test' });
}
const requestFor = (r: Awaited<ReturnType<typeof readyExecutionStart>>['request']) => ({
  ...r,
  kind: 'PAPER_STARTED_RISK_CAPTURE',
});
it('paper-started-risk: fixed readonly RPC evaluates current Risk for an actual START without a second financial effect', async () => {
  const f = await readyExecutionStart(),
    receipt = await f.journal.start(f.request, startIo()),
    before = await startFixtureEffects(f.c.owner.tenantId),
    pool = new Pool({ connectionString: startFixtureConnection(), max: 1, query_timeout: 5000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    const row = await client.query<{ result: { started: { journal: { receipt: unknown } } } }>(
      'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
      [canonical(requestFor(f.request))],
    );
    await client.query('COMMIT');
    expect(row.rows[0]!.result.started.journal.receipt).toEqual(receipt);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
it('paper-started-risk: factory reopen rereads durable current Risk and preserves the immutable START receipt', async () => {
  const ports = [await open(), await open()];
  try {
    const f = await readyExecutionStart(),
      receipt = await f.journal.start(f.request, startIo()),
      before = await startFixtureEffects(f.c.owner.tenantId);
    for (const port of ports) {
      const r = await port.read(requestFor(f.request), startIo());
      expect(r.kind).toBe('PAPER_STARTED_RISK_SOURCE');
      expect(r.risk.evaluation.kind).toBe('EVALUATED');
      expect(r.started.journal.receipt).toEqual(receipt);
      expect(r.started.journal.state.phase).toBe('STARTED');
    }
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await Promise.all(ports.map((p) => p.close()));
  }
});
it('paper-started-risk: a current policy refresh blocks known START while original receipt and money remain unchanged', async () => {
  const port = await open();
  try {
    const f = await readyExecutionStart(),
      receipt = await f.journal.start(f.request, startIo()),
      before = await startFixtureEffects(f.c.owner.tenantId);
    await startFixturePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '0.01' });
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_LIMIT',
    );
    const view = await f.journal.read(f.request, startIo());
    expect(view.kind === 'COMMITTED' && view.receipt).toEqual(receipt);
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await port.close();
  }
});
it('paper-started-risk: current tenant pause and failed executor health block a previously started order', async () => {
  const port = await open();
  try {
    const f = await readyExecutionStart();
    await f.journal.start(f.request, startIo());
    await startFixturePause(f.c.owner.tenantId, 'PAUSED');
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_LIMIT',
    );
    await startFixturePause(f.c.owner.tenantId, 'RUNNING');
    await f.runtime.publish(
      {
        ...f.publication,
        id: randomUUID(),
        expectedRevision: '1',
        observation: {
          ...f.publication.observation,
          health: {
            ...f.publication.observation.health,
            executor: {
              ...f.publication.observation.health.executor,
              status: 'FAILED',
              asOf: Date.now(),
            },
          },
        },
      },
      startIo(),
    );
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_LIMIT',
    );
  } finally {
    await port.close();
  }
});
it('paper-started-risk: UNKNOWN retains the whole hold and cannot yield current execution Risk', async () => {
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
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_EVIDENCE',
    );
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await port.close();
  }
});
it('paper-started-risk: current ownership epochs precede lookup and metadata replacement cannot rewrite START history', async () => {
  const port = await open();
  try {
    const f = await readyExecutionStart(),
      receipt = await f.journal.start(f.request, startIo());
    await startFixtureSql(
      'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE "tenantId"=$1 AND id=$2',
      [f.c.owner.tenantId, f.c.owner.accountId],
    );
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_SCOPE',
    );
    const request = {
      ...f.request,
      authorization: {
        ...f.request.authorization,
        permissionEpoch: String(BigInt(f.request.authorization.permissionEpoch) + 1n),
      },
    };
    expect((await port.read(requestFor(request), startIo())).started.journal.receipt).toEqual(
      receipt,
    );
    await startFixtureSql(
      'UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1',
      [f.f.p.key.dbRuleId],
    );
    await expect(port.read(requestFor(request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_EVIDENCE',
    );
  } finally {
    await port.close();
  }
});
it('paper-started-risk: physically lost readonly COMMIT gives no result; explicit recapture has no monetary effect', async () => {
  const proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_EXECUTION_SOURCE'),
    port = await open(proxy.connectionString),
    direct = await open();
  try {
    const f = await readyExecutionStart();
    await f.journal.start(f.request, startIo());
    const before = await startFixtureEffects(f.c.owner.tenantId);
    proxy.arm();
    await expect(port.read(requestFor(f.request), startIo())).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
    expect(proxy.dropped()).toBe(1);
    expect((await direct.read(requestFor(f.request), startIo())).risk.evaluation.kind).toBe(
      'EVALUATED',
    );
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await port.close();
    await direct.close();
    await proxy.close();
  }
});
it('paper-started-risk: runtime cannot execute private helper/alias or write the immutable journal', async () => {
  const pool = new Pool({
    connectionString: startFixtureConnection(),
    max: 1,
    query_timeout: 5000,
  });
  try {
    const row = await pool.query<{ helper: boolean; alias: boolean; write: boolean }>(
      "SELECT has_function_privilege(current_user,'ctp_paper.capture_started_risk(jsonb)','EXECUTE') helper,has_function_privilege(current_user,'ctp_paper.reconcile_admission_v63(jsonb)','EXECUTE') alias,has_table_privilege(current_user,'ctp_paper.attempt_start','INSERT,UPDATE,DELETE,TRUNCATE') write",
    );
    expect(row.rows[0]).toEqual({ helper: false, alias: false, write: false });
  } finally {
    await pool.end();
  }
});
