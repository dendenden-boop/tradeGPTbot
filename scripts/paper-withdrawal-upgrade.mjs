// Private additive55 proof. No historical no-send authority can be backfilled.
import assert from 'node:assert/strict';
import { capturePaperAdmissionUpgrade } from './paper-admission-upgrade.mjs';
export async function verifyPaperWithdrawalUpgrade(db, before) {
  assert.equal(before.functions.length, 193);
  const after = await capturePaperAdmissionUpgrade(db);
  assert.equal(after.functions.length, 198);
  for (const f of before.functions) {
    const legacy = ['evaluate_and_reserve', 'reconcile_admission'].find(
      (name) => f.signature === `ctp_paper.${name}(jsonb)`,
    );
    const expected = legacy
      ? {
          signature: `ctp_paper.${legacy}_v54(jsonb)`,
          definition: f.definition.replace(
            `FUNCTION ctp_paper.${legacy}(`,
            `FUNCTION ctp_paper.${legacy}_v54(`,
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
    [{ name: '"ctp_paper"."withdrawal_barrier"', rows: [] }],
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ctp_paper.withdrawal_barrier'::regclass",
      )
    ).rows,
    [{ relrowsecurity: true, relforcerowsecurity: true }],
  );
  for (const role of ['ctp_paper_risk_admission', 'ctp_execution', 'ctp_portfolio', 'ctp_api'])
    assert.equal(
      (
        await db.query('SELECT has_table_privilege($1,$2,$3) allowed', [
          role,
          'ctp_paper.withdrawal_barrier',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES',
        ])
      ).rows[0].allowed,
      false,
    );
  for (const signature of [
    'ctp_paper.evaluate_and_reserve_v54(jsonb)',
    'ctp_paper.reconcile_admission_v54(jsonb)',
    'ctp_paper.withdraw_before_dispatch(jsonb,boolean)',
    'ctp_paper.guard_withdrawal()',
    'ctp_paper.check_withdrawal_cause()',
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
  const triggers = (
    await db.query(
      "SELECT count(*)::int n FROM pg_trigger WHERE tgname='aaa_paper_withdrawal_barrier' AND NOT tgisinternal AND tgenabled='O'",
    )
  ).rows;
  assert.deepEqual(triggers, [{ n: 13 }]);
}
