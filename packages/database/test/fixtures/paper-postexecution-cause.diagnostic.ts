import { randomUUID } from 'node:crypto';
import { createPostgresPaperCurrentOrderRiskSource } from '@ctp/paper-engine/risk';
import { canonical } from '@ctp/portfolio';
import { beforeAll, expect, it } from 'vitest';
import { openPaperAdmissionDatabase } from '../../../paper-engine/src/admission-database.js';
import { createPostgresPaperPostexecutionReservation } from '../../../paper-engine/src/postgres-postexecution-reservation.js';
import { currentOrderTargetReady, openActual } from '../paper-execution-commit.integration.test.js';
import { verifyPaperPostexecutionCause } from './paper-postexecution-cause-native.js';
import { registryCommitProxy } from './registry-commit-proxy.js';
import {
  startFixtureConnection,
  startFixtureEffects,
  startFixturePolicy,
  startFixtureSql,
  startIo,
} from './paper-execution-start.js';

beforeAll(async () => {
  const installed = await startFixtureSql<{ ready: boolean }>(`SELECT
    to_regclass('ctp_paper.postexecution_commitment') IS NOT NULL AND EXISTS (
      SELECT 1 FROM _prisma_migrations
      WHERE migration_name='202611240001_paper_postexecution_reservation'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
    ) AS ready`);
  expect(installed.rows).toEqual([{ ready: true }]);
});

function payloadFor(request: Awaited<ReturnType<typeof currentOrderTargetReady>>['request']) {
  return { source: request.source, target: request.target, key: 'reserve-' + randomUUID() };
}

function openPostexecutionPort(connectionString = startFixtureConnection()) {
  return createPostgresPaperPostexecutionReservation({ connectionString, environment: 'test' });
}

async function rejectAmountAtSql(tenantId: string, payload: ReturnType<typeof payloadFor>) {
  const transport = await openPaperAdmissionDatabase({
    connectionString: startFixtureConnection(),
    environment: 'test',
  });
  try {
    await expect(
      transport.transaction(tenantId, startIo(), (sql) =>
        sql.query('SELECT ctp_paper.evaluate_and_reserve($1::jsonb)', [
          canonical({ ...payload, kind: 'PAPER_POSTEXECUTION_RESERVE', amount: '0.01' }),
        ]),
      ),
    ).rejects.toThrow('PAPER_ADMISSION_INPUT');
  } finally {
    await transport.close();
  }
}

it('phase13 successor writer reserves once and reconciles the permanent key', async () => {
  const { f, request } = await currentOrderTargetReady();
  const tenantId = f.c.owner.tenantId;
  const before = await startFixtureEffects(tenantId);
  const port = await openPostexecutionPort();
  const payload = payloadFor(request);
  const operation = (wire: typeof payload) => port.reserve(wire, startIo());
  try {
    const receipt = await operation(payload);
    expect(receipt).toMatchObject({
      kind: 'PAPER_POSTEXECUTION_RESERVED',
      key: payload.key,
      intentId: request.target.intentId,
    });
    await startFixturePolicy(tenantId, 'USER', { maxOrderNotional: '1' });
    expect(await operation(payload)).toEqual(receipt);
    expect(await port.read(payload, startIo())).toEqual(receipt);
    await expect(
      operation({ ...payload, target: { ...payload.target, commandHash: '0'.repeat(64) } }),
    ).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
    await expect(operation({ ...payload, key: 'different-' + randomUUID() })).rejects.toThrow(
      'PAPER_ADMISSION_CONFLICT',
    );
    await rejectAmountAtSql(tenantId, payload);
    const after = await startFixtureEffects(tenantId);
    expect(after).toMatchObject({
      ledger: before.ledger,
      entries: before.entries,
      decisions: before.decisions + 1,
      reservations: before.reservations + 1,
    });
  } finally {
    await port.close();
  }
});

it('phase13 successor writer rolls back the fresh certificate and hold when current policy declines', async () => {
  const { f, request } = await currentOrderTargetReady();
  const tenantId = f.c.owner.tenantId;
  await startFixturePolicy(tenantId, 'USER', { maxOrderNotional: '1' });
  const before = await startFixtureEffects(tenantId);
  const port = await openPostexecutionPort();
  const payload = payloadFor(request);
  try {
    await expect(port.reserve(payload, startIo())).rejects.toThrow('PAPER_ADMISSION_LIMIT');
    expect(await port.read(payload, startIo())).toBeNull();
    expect(await startFixtureEffects(tenantId)).toEqual(before);
    const rows = await startFixtureSql<{ certificates: number; causes: number }>(
      `SELECT (SELECT count(*)::int FROM ctp_paper.current_risk_certificate WHERE tenant_id=$1) certificates,
        (SELECT count(*)::int FROM ctp_paper.postexecution_commitment WHERE tenant_id=$1) causes`,
      [tenantId],
    );
    expect(rows.rows).toEqual([{ certificates: 0, causes: 0 }]);
  } finally {
    await port.close();
  }
});

it('phase13 successor writer serializes competing keys for the same execution and target', async () => {
  const { f, request } = await currentOrderTargetReady();
  const tenantId = f.c.owner.tenantId;
  const before = await startFixtureEffects(tenantId);
  const port = await openPostexecutionPort();
  try {
    const payloads = [payloadFor(request), payloadFor(request)];
    const results = await Promise.allSettled(
      payloads.map((payload) => port.reserve(payload, startIo())),
    );
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ message: 'PAPER_ADMISSION_CONFLICT' });
    expect(await startFixtureEffects(tenantId)).toMatchObject({
      ledger: before.ledger,
      entries: before.entries,
      decisions: before.decisions + 1,
      reservations: before.reservations + 1,
    });
  } finally {
    await port.close();
  }
});

it('phase13 successor writer returns no receipt when COMMIT is lost and reconciles after reopen', async () => {
  const { f, request } = await currentOrderTargetReady();
  const tenantId = f.c.owner.tenantId;
  const before = await startFixtureEffects(tenantId);
  const payload = payloadFor(request);
  const proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_ADMISSION');
  try {
    const port = await openPostexecutionPort(proxy.connectionString);
    try {
      proxy.arm();
      await expect(port.reserve(payload, startIo())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
      expect(proxy.dropped()).toBe(1);
    } finally {
      await port.close();
    }
    const restarted = await openPostexecutionPort();
    try {
      expect(await restarted.read(payload, startIo())).toMatchObject({
        kind: 'PAPER_POSTEXECUTION_RESERVED',
        key: payload.key,
      });
    } finally {
      await restarted.close();
    }
    expect(await startFixtureEffects(tenantId)).toMatchObject({
      ledger: before.ledger,
      entries: before.entries,
      decisions: before.decisions + 1,
      reservations: before.reservations + 1,
    });
  } finally {
    await proxy.close();
  }
});

it('phase13 successor writer rolls back native writes when the server Portfolio proof disagrees', async () => {
  const { f, request } = await currentOrderTargetReady();
  const tenantId = f.c.owner.tenantId;
  const before = await startFixtureEffects(tenantId);
  const payload = { ...payloadFor(request), key: 'diagnostic-corrupt-written-book' };
  const definition = await startFixtureSql<{ ddl: string }>(
    "SELECT pg_get_functiondef('ctp_paper.evaluate_and_reserve(jsonb)'::regprocedure) ddl",
  );
  const original = definition.rows[0]!.ddl;
  const branch = "IF p->>'kind'='PAPER_POSTEXECUTION_RESERVE'";
  expect(original.split(branch)).toHaveLength(2);
  const tampered = original.replace(
    branch,
    `IF p->>'kind'='PAPER_POSTEXECUTION_RESERVE' AND p->>'key'='diagnostic-corrupt-written-book'
    THEN RETURN jsonb_set(ctp_paper.postexecution_reserve(p,false),'{book,stateHash}',to_jsonb(repeat('0',64)));
    END IF;
    ${branch}`,
  );
  const port = await openPostexecutionPort();
  try {
    await startFixtureSql(tampered);
    await expect(port.reserve(payload, startIo())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    expect(await port.read(payload, startIo())).toBeNull();
    expect(await startFixtureEffects(tenantId)).toEqual(before);
    const rows = await startFixtureSql<{ certificates: number; causes: number }>(
      `SELECT (SELECT count(*)::int FROM ctp_paper.current_risk_certificate WHERE tenant_id=$1) certificates,
        (SELECT count(*)::int FROM ctp_paper.postexecution_commitment WHERE tenant_id=$1) causes`,
      [tenantId],
    );
    expect(rows.rows).toEqual([{ certificates: 0, causes: 0 }]);
  } finally {
    await startFixtureSql(original);
    await port.close();
  }
});

it('phase13 successor causality preserves the exact original receipt on a populated database', async () => {
  const connectionString = process.env['DATABASE_MIGRATION_URL'];
  if (!connectionString) throw Error('ISOLATED_EXECUTION_START_RUNNER_REQUIRED');
  const { f, target, request } = await currentOrderTargetReady();
  const restricted = startFixtureConnection();
  const original = await (await openActual(restricted)).read(f.request, startIo());
  expect(original.kind).toBe('COMMITTED');
  const risk = await createPostgresPaperCurrentOrderRiskSource({
    connectionString: restricted,
    environment: 'test',
  });
  try {
    const captured = await risk.capture(
      { ...request, kind: 'PAPER_CURRENT_ORDER_RISK_CAPTURE' },
      startIo(),
    );
    if (!captured.commitmentBasis || captured.evaluation.result.kind !== 'EVALUATED')
      throw Error('EXPECTED_CURRENT_COMMITMENT_BASIS');
    await verifyPaperPostexecutionCause({
      connectionString,
      tenantId: f.c.owner.tenantId,
      executionKey: f.request.executionKey,
      orderId: target.id,
      intentId: target.intentId,
      commandHash: request.target.commandHash,
      certificateId: captured.certificate.id,
      debit: captured.commitmentBasis.hold.amount,
      notional: captured.evaluation.result.notional,
      verifyOriginal: async () => {
        await startFixturePolicy(f.c.owner.tenantId, 'USER', { maxOrderNotional: '1' });
        const restarted = await openActual(restricted);
        expect(await restarted.read(f.request, startIo())).toEqual(original);
      },
    });
  } finally {
    await risk.close();
  }
});
