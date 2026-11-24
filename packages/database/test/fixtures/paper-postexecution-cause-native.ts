import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { expect } from 'vitest';

interface SuccessorFixture {
  connectionString: string;
  tenantId: string;
  executionKey: string;
  orderId: string;
  intentId: string;
  commandHash: string;
  certificateId: string;
  debit: string;
  notional: string;
  verifyOriginal: () => Promise<void>;
}

async function ledger(client: PoolClient, tenantId: string) {
  return (
    await client.query<{ entries: number; transactions: number }>(
      `SELECT (SELECT count(*)::int FROM public.ledger_entry WHERE "tenantId"=$1) entries,
        (SELECT count(*)::int FROM public.ledger_transaction WHERE "tenantId"=$1) transactions`,
      [tenantId],
    )
  ).rows[0];
}

export async function verifyPaperPostexecutionCause(fixture: SuccessorFixture) {
  const pool = new Pool({ connectionString: fixture.connectionString, max: 1 });
  const client = await pool.connect();
  const { tenantId, executionKey, orderId, intentId, commandHash, certificateId } = fixture;
  const key = 'successor-' + randomUUID();
  const stage = (amount: string) =>
    client.query('SELECT pg_temp.stage_paper_postexecution_successor($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      tenantId,
      executionKey,
      orderId,
      intentId,
      commandHash,
      certificateId,
      amount,
      fixture.notional,
      key,
    ]);
  const start = async () => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
  };
  try {
    const seedSql = await readFile(
      new URL('./paper-postexecution-cause-seed.sql', import.meta.url),
      'utf8',
    );
    await client.query(seedSql);
    await start();
    const before = await ledger(client, tenantId);
    const authority = await client.query<{ exposed: boolean }>(
      `SELECT has_table_privilege('ctp_paper_risk_admission','ctp_paper.postexecution_commitment',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_function_privilege('ctp_paper_risk_admission',
        'ctp_paper.check_postexecution_commitment()','EXECUTE') AS exposed`,
    );
    expect(authority.rows).toEqual([{ exposed: false }]);

    await client.query('SAVEPOINT unwitnessed_head');
    const advanced = await client.query(
      `INSERT INTO ctp_paper.admission_book_event
        (tenant_id,account_id,book_id,revision,cause_id,kind,previous_revision,previous_hash,state_text,state_hash)
       SELECT e.tenant_id,e.account_id,e.book_id,e.revision+1,gen_random_uuid(),'RESERVE',
        e.revision,e.state_hash,e.state_text,e.state_hash
       FROM ctp_paper.admission_book_event e JOIN ctp_paper.execution_commit x
        ON x.tenant_id=e.tenant_id AND x.execution_id=e.cause_id
       WHERE x.tenant_id=$1 AND x.execution_key=$2`,
      [tenantId, executionKey],
    );
    expect(advanced.rowCount).toBe(1);
    await client.query(
      `UPDATE ctp_paper.admission_book_head h SET revision=h.revision+1 FROM ctp_paper.execution_commit x
       WHERE x.tenant_id=$1 AND x.execution_key=$2 AND h.tenant_id=x.tenant_id AND h.book_id=x.book_id`,
      [tenantId, executionKey],
    );
    await client.query(
      `UPDATE ctp_portfolio.book b SET revision=b.revision+1 FROM ctp_paper.execution_commit x
       WHERE x.tenant_id=$1 AND x.execution_key=$2 AND b."tenantId"=x.tenant_id AND b.id=x.book_id`,
      [tenantId, executionKey],
    );
    await expect(
      client.query('SELECT ctp_paper.validate_committed_execution($1,$2)', [
        tenantId,
        executionKey,
      ]),
    ).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    await client.query('ROLLBACK TO SAVEPOINT unwitnessed_head');
    await client.query('RELEASE SAVEPOINT unwitnessed_head');

    for (const [amount, error] of [
      ['1000000000', 'PAPER_ADMISSION_LIMIT'],
      ['0.000000000000000001', 'PAPER_ADMISSION_EVIDENCE'],
    ] as const) {
      await client.query('SAVEPOINT rejected_successor');
      await stage(amount);
      await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(error);
      await client.query('ROLLBACK TO SAVEPOINT rejected_successor');
      await client.query('RELEASE SAVEPOINT rejected_successor');
    }
    expect(
      (
        await client.query('SELECT 1 FROM ctp_paper.postexecution_commitment WHERE tenant_id=$1', [
          tenantId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await ledger(client, tenantId)).toEqual(before);

    await stage(fixture.debit);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    expect(await ledger(client, tenantId)).toEqual(before);
    await client.query('COMMIT');
    await fixture.verifyOriginal();

    await start();
    const retained = await client.query<{ revisions: boolean; mode: string; kind: string }>(
      `SELECT s.revision=old.revision+1 AND s.previous_hash=old.state_hash AND b.revision=s.revision AS revisions,
       b.mode::text, e.kind
       FROM ctp_paper.postexecution_commitment s
       JOIN ctp_paper.execution_commit old USING(tenant_id,execution_id)
       JOIN ctp_portfolio.book b ON b."tenantId"=s.tenant_id AND b.id=s.book_id
       JOIN ctp_paper.admission_book_event e ON e.tenant_id=s.tenant_id AND e.book_id=s.book_id AND e.revision=s.revision
       WHERE s.tenant_id=$1 AND s.idempotency_key=$2`,
      [tenantId, key],
    );
    expect(retained.rows).toEqual([{ revisions: true, mode: 'PAPER', kind: 'RESERVE' }]);
    expect(await ledger(client, tenantId)).toEqual(before);
    await expect(
      client.query(
        'UPDATE ctp_paper.postexecution_commitment SET idempotency_key=$2 WHERE tenant_id=$1',
        [tenantId, 'replacement-key'],
      ),
    ).rejects.toThrow();
    await client.query('ROLLBACK');

    await start();
    await expect(
      client.query(
        `INSERT INTO ctp_paper.postexecution_commitment
       SELECT * FROM ctp_paper.postexecution_commitment WHERE tenant_id=$1 AND idempotency_key=$2`,
        [tenantId, key],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}
