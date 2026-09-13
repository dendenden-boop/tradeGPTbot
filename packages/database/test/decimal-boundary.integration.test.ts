import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/index.js';
import { Prisma } from '../src/generated/client.js';

const project = process.env['CTP_TEST_PROJECT'];
if (!project || !/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(project)) {
  throw new Error('Decimal integration requires the isolated project runner');
}
function requiredUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Missing isolated database connection');
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/ctp_p2_fresh_[a-f0-9]+$/u.test(url.pathname)
  )
    throw new Error('Expected an isolated disposable database');
  return value;
}
const adminUrl = requiredUrl('DATABASE_MIGRATION_URL');
const runtimeUrl = requiredUrl('DATABASE_RUNTIME_URL');
if (new URL(adminUrl).pathname !== new URL(runtimeUrl).pathname) {
  throw new Error('Decimal connections must target the same disposable database');
}
const admin = new Pool({ connectionString: adminUrl, max: 2, query_timeout: 7000 });
const ids = {
  tenant: randomUUID(),
  account: randomUUID(),
  state: randomUUID(),
  balance: randomUUID(),
};
let database: Awaited<ReturnType<typeof createDatabase>> | undefined;

beforeAll(async () => {
  await admin.query('INSERT INTO "user" (id,"updatedAt") VALUES ($1,now())', [ids.tenant]);
  await admin.query(
    `INSERT INTO exchange_account
    (id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode","clientIdEpoch","updatedAt")
    VALUES ($1::uuid,$2,'BINANCE','PAPER',$1::text,'GLOBAL','PAPER','decimal-audit',now())`,
    [ids.account, ids.tenant],
  );
  await admin.query(
    `INSERT INTO account_state_version
    (id,"tenantId","accountId",mode,version,"sourceCursor","sourceAt","receivedAt","reconciliationEpoch","stateHash")
    VALUES ($1,$2,$3,'PAPER',0,'decimal-audit',now(),now(),0,$4)`,
    [ids.state, ids.tenant, ids.account, Buffer.alloc(32, 23)],
  );
  await admin.query(
    `INSERT INTO balance_snapshot
    (id,"tenantId","accountId",mode,"stateVersionId",asset,total,available,reserved,"sourceAt","receivedAt")
    VALUES ($1,$2,$3,'PAPER',$4,'USDT',0,0,0,now(),now())`,
    [ids.balance, ids.tenant, ids.account, ids.state],
  );
  database = await createDatabase({ connectionString: runtimeUrl, environment: 'test' });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
beforeEach(async () => {
  await admin.query(
    'UPDATE balance_snapshot SET total=0,available=0,reserved=0,borrowed=0 WHERE id=$1',
    [ids.balance],
  );
  await admin.query('UPDATE exchange_account SET version=0 WHERE id=$1', [ids.account]);
});

function db(): Awaited<ReturnType<typeof createDatabase>> {
  if (!database) throw new Error('Database helper was not initialized');
  return database;
}

function balanceData(asset: string, total: string | number | Prisma.Decimal) {
  return {
    tenantId: ids.tenant,
    accountId: ids.account,
    mode: 'PAPER' as const,
    stateVersionId: ids.state,
    asset,
    total,
    available: '0',
    reserved: '0',
    sourceAt: new Date(),
    receivedAt: new Date(),
  };
}

describe('typed transaction decimal boundary', () => {
  it('rejects binary float money before a typed update can persist it', async () => {
    if (!database) throw new Error('Database helper was not initialized');
    await expect(
      database.withTenant(ids.tenant, (tx) =>
        tx.balanceSnapshot.update({
          where: { id: ids.balance },
          data: { total: 0.1 + 0.2 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_DECIMAL_INVALID' });
    const value = await admin.query<{ total: string }>(
      'SELECT total::text FROM balance_snapshot WHERE id=$1',
      [ids.balance],
    );
    expect(value.rows[0]?.total).toBe('0');
  });
  it('persists canonical string and Prisma Decimal values exactly', async () => {
    const result = await db().withTenant(ids.tenant, (tx) =>
      tx.balanceSnapshot.update({
        where: { id: ids.balance },
        data: { total: '0.300000000000000001', available: new Prisma.Decimal('0.1') },
      }),
    );
    expect(result.total.toFixed()).toBe('0.300000000000000001');
    expect(result.available.toFixed()).toBe('0.1');
    const stored = await admin.query<{ total: string; available: string }>(
      'SELECT total::text,available::text FROM balance_snapshot WHERE id=$1',
      [ids.balance],
    );
    expect(stored.rows[0]).toEqual({ total: '0.300000000000000001', available: '0.1' });
  });
  it('accepts exact atomic operands and rejects numeric atomic operands', async () => {
    await db().withTenant(ids.tenant, async (tx) => {
      await tx.balanceSnapshot.update({
        where: { id: ids.balance },
        data: { total: { increment: '0.1' } },
      });
      await tx.balanceSnapshot.update({
        where: { id: ids.balance },
        data: { total: { increment: new Prisma.Decimal('0.2') } },
      });
    });
    await expect(
      db().withTenant(ids.tenant, (tx) =>
        tx.balanceSnapshot.updateMany({
          where: { id: ids.balance },
          data: { total: { increment: 0.1 } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_DECIMAL_INVALID' });
    const stored = await admin.query<{ total: string }>(
      'SELECT total::text FROM balance_snapshot WHERE id=$1',
      [ids.balance],
    );
    expect(stored.rows[0]?.total).toBe('0.3');
  });
  it('rejects nested relation writes and rolls back earlier statements in the transaction', async () => {
    await expect(
      db().withTenant(ids.tenant, async (tx) => {
        await tx.balanceSnapshot.update({ where: { id: ids.balance }, data: { total: '5' } });
        await tx.exchangeAccount.update({
          where: { id: ids.account },
          data: {
            version: { increment: 1 },
            balanceSnapshotRecords: {
              update: { where: { id: ids.balance }, data: { total: 0.1 + 0.2 } },
            },
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_DECIMAL_INVALID' });
    const stored = await admin.query<{ total: string; version: number }>(
      'SELECT b.total::text,a.version FROM balance_snapshot b JOIN exchange_account a ON a.id=b."accountId" WHERE b.id=$1',
      [ids.balance],
    );
    expect(stored.rows[0]).toEqual({ total: '0', version: 0 });
  });
  it('rejects a mixed bulk insert without persisting any row', async () => {
    await expect(
      db().withTenant(ids.tenant, (tx) =>
        tx.balanceSnapshot.createMany({
          data: [balanceData('AUDIT_BAD_A', '1'), balanceData('AUDIT_BAD_B', 0.3)],
        }),
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_DECIMAL_INVALID' });
    const stored = await admin.query<{ count: string }>(
      "SELECT count(*)::text FROM balance_snapshot WHERE \"accountId\"=$1 AND asset IN ('AUDIT_BAD_A','AUDIT_BAD_B')",
      [ids.account],
    );
    expect(stored.rows[0]?.count).toBe('0');
  });
  it('accepts exact bulk values and integer pagination and nested update counters', async () => {
    const inserted = await db().withTenant(ids.tenant, (tx) =>
      tx.balanceSnapshot.createMany({
        data: [
          balanceData('AUDIT_GOOD_A', '0.1'),
          balanceData('AUDIT_GOOD_B', new Prisma.Decimal('0.2')),
        ],
      }),
    );
    expect(inserted.count).toBe(2);
    const account = await db().withTenant(ids.tenant, (tx) =>
      tx.exchangeAccount.update({
        where: { id: ids.account },
        data: {
          version: { increment: 1 },
          balanceSnapshotRecords: {
            update: { where: { id: ids.balance }, data: { total: '0.3' } },
          },
        },
        include: {
          balanceSnapshotRecords: {
            where: { total: { gte: '0.1' } },
            take: 10,
            orderBy: { asset: 'asc' },
          },
        },
      }),
    );
    expect(account.version).toBe(1);
    expect(account.balanceSnapshotRecords.map((row) => row.total.toFixed())).toEqual([
      '0.1',
      '0.2',
      '0.3',
    ]);
  });
  it('guards relation queries and group aggregate predicates', async () => {
    await expect(
      db().withTenant(ids.tenant, (tx) =>
        tx.exchangeAccount.findMany({
          where: { id: ids.account },
          include: { balanceSnapshotRecords: { where: { total: { in: [0, 0.3] } } } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_DECIMAL_INVALID' });
    await expect(
      db().withTenant(ids.tenant, (tx) =>
        tx.balanceSnapshot.groupBy({
          by: ['asset'],
          where: { accountId: ids.account },
          having: { total: { _sum: { gt: 0.3 } } },
          _sum: { total: true },
        }),
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_DECIMAL_INVALID' });
    const grouped = await db().withTenant(ids.tenant, (tx) =>
      tx.balanceSnapshot.groupBy({
        by: ['asset'],
        where: { id: ids.balance },
        having: { total: { _sum: { gte: '0' } } },
        _sum: { total: true },
        _count: { total: true },
      }),
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?._count.total).toBe(1);
  });
});
