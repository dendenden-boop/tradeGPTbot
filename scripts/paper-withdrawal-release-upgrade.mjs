import assert from 'node:assert/strict';
import { capturePaperAdmissionUpgrade } from './paper-admission-upgrade.mjs';

/** Actual populated55 retention, not inferred release authority. */
export async function verifyPaperWithdrawalReleaseUpgrade(db, before) {
  assert.equal(before.functions.length, 198);
  const after = await capturePaperAdmissionUpgrade(db);
  assert.equal(after.functions.length, 205);
  const changed = new Set([
    'evaluate_and_reserve',
    'reconcile_admission',
    'admission_book',
    'admission_inventory',
    'check_admission_book',
  ]);
  for (const f of before.functions) {
    const name = /^ctp_paper\.([a-z_]+)\(/u.exec(f.signature)?.[1];
    const legacy = name && changed.has(name);
    const expected = legacy
      ? {
          signature: f.signature.replace(`ctp_paper.${name}(`, `ctp_paper.${name}_v55(`),
          definition: f.definition.replace(
            `FUNCTION ctp_paper.${name}(`,
            `FUNCTION ctp_paper.${name}_v55(`,
          ),
        }
      : f;
    assert.deepEqual(
      after.functions.find((x) => x.signature === expected.signature),
      expected,
    );
  }
  for (const table of before.rows)
    assert.deepEqual(
      after.rows.find((x) => x.name === table.name),
      table,
    );
  assert.deepEqual(
    after.rows.filter((x) => !before.rows.some((old) => old.name === x.name)),
    [{ name: '"ctp_paper"."withdrawal_release"', rows: [] }],
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ctp_paper.withdrawal_release'::regclass",
      )
    ).rows,
    [{ relrowsecurity: true, relforcerowsecurity: true }],
  );
  for (const role of ['ctp_paper_risk_admission', 'ctp_execution', 'ctp_portfolio', 'ctp_api'])
    assert.equal(
      (
        await db.query('SELECT has_table_privilege($1,$2,$3) allowed', [
          role,
          'ctp_paper.withdrawal_release',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES',
        ])
      ).rows[0].allowed,
      false,
    );
  for (const signature of [
    'ctp_paper.evaluate_and_reserve_v55(jsonb)',
    'ctp_paper.reconcile_admission_v55(jsonb)',
    'ctp_paper.admission_book_v55(jsonb)',
    'ctp_paper.admission_inventory_v55(jsonb,bigint)',
    'ctp_paper.check_admission_book_v55()',
    'ctp_paper.validate_withdrawal_release(uuid,uuid)',
    'ctp_paper.release_withdrawn(jsonb,boolean)',
  ])
    assert.equal(
      (
        await db.query(
          "SELECT has_function_privilege('ctp_paper_risk_admission',$1,'EXECUTE') allowed",
          [signature],
        )
      ).rows[0].allowed,
      false,
    );
  assert.deepEqual(
    (
      await db.query(
        "SELECT count(*)::int n FROM pg_trigger WHERE tgname='aaa_paper_withdrawal_barrier' AND NOT tgisinternal AND tgenabled='O'",
      )
    ).rows,
    [{ n: 13 }],
  );
}
