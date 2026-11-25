import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { createPostgresPaperPostexecutionReservation } from '../../../paper-engine/src/postgres-postexecution-reservation.js';
import { currentOrderTargetReady, openActual } from '../paper-execution-commit.integration.test.js';
import {
  startFixtureConnection,
  startFixtureEffects,
  startFixturePolicy,
  startFixtureSql,
  startIo,
} from './paper-execution-start.js';
import { registryCommitProxy } from './registry-commit-proxy.js';

beforeAll(async () => {
  const { rows } = await startFixtureSql<{ ready: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM _prisma_migrations WHERE migration_name='202611250001_paper_postexecution_preparation_basis'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL
  ) AND to_regprocedure('ctp_paper.postexecution_basis(jsonb)') IS NOT NULL AS ready`);
  expect(rows).toEqual([{ ready: true }]);
});

const open = (connectionString = startFixtureConnection()) =>
  createPostgresPaperPostexecutionReservation({ connectionString, environment: 'test' });

it('phase13 successor basis reopens the exact reserved book without renewing Risk or writing effects', async () => {
  const { f, request } = await currentOrderTargetReady();
  const input = { source: request.source, target: request.target, key: 'basis-' + randomUUID() };
  const tenant = f.c.owner.tenantId;
  const writer = await open();
  let reader: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const receipt = await writer.reserve(input, startIo());
    const original = await openActual(startFixtureConnection());
    const executed = await original.read(f.request, startIo());
    expect(executed.kind).toBe('COMMITTED');
    const effects = await startFixtureEffects(tenant);
    const basis = await writer.readPreparationBasis(input, startIo());
    expect(basis).toMatchObject({
      kind: 'PAPER_POSTEXECUTION_PREPARATION_BASIS',
      receipt,
      target: { ...input.target, status: 'CREATED', orderVersion: 0 },
      book: { id: receipt.bookId, revision: receipt.revision },
      hold: { id: receipt.debits[0].holdId, amount: receipt.debits[0].amount },
    });
    expect(basis?.book.state.holds).toContainEqual(basis?.hold);
    await writer.close();
    await startFixturePolicy(tenant, 'USER', { maxOrderNotional: '1' });
    reader = await open();
    expect(await reader.readPreparationBasis(input, startIo())).toEqual(basis);
    expect(await reader.read(input, startIo())).toEqual(receipt);
    expect(await original.read(f.request, startIo())).toEqual(executed);
    expect(await startFixtureEffects(tenant)).toEqual(effects);
    await expect(
      reader.readPreparationBasis({ ...input, key: 'different' }, startIo()),
    ).rejects.toThrow('PAPER_ADMISSION_CONFLICT');
  } finally {
    await reader?.close();
    await writer.close();
  }
});

it('phase13 successor basis exposes neither missing evidence nor an uncertain COMMIT', async () => {
  const { f, request } = await currentOrderTargetReady();
  const input = { source: request.source, target: request.target, key: 'basis-' + randomUUID() };
  const writer = await open();
  const proxy = await registryCommitProxy(startFixtureConnection(), 'PAPER_EXECUTION_SOURCE');
  let reader: Awaited<ReturnType<typeof open>> | undefined;
  try {
    expect(await writer.readPreparationBasis(input, startIo())).toBeNull();
    const receipt = await writer.reserve(input, startIo());
    const effects = await startFixtureEffects(f.c.owner.tenantId);
    reader = await open(proxy.connectionString);
    proxy.arm();
    await expect(reader.readPreparationBasis(input, startIo())).rejects.toThrow(
      'PAPER_ADMISSION_UNCERTAIN',
    );
    expect(proxy.dropped()).toBe(1);
    expect(await writer.readPreparationBasis(input, startIo())).toMatchObject({ receipt });
    expect(await startFixtureEffects(f.c.owner.tenantId)).toEqual(effects);
  } finally {
    await reader?.close();
    await proxy.close();
    await writer.close();
  }
});
