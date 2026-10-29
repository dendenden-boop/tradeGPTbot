import assert from 'node:assert/strict';
import { capturePaperAdmissionUpgrade } from './paper-admission-upgrade.mjs';
/** Real populated60 deploy/redeploy: no inferred preparation or authority. */
export async function verifyPreparationInventoryUpgrade(db, before) {
  assert.equal(before.functions.length, 223);
  const after = await capturePaperAdmissionUpgrade(db);
  assert.equal(after.functions.length, 225);
  for (const f of before.functions) {
    const expected =
      f.signature === 'ctp_paper.reconcile_admission(jsonb)'
        ? {
            signature: 'ctp_paper.reconcile_admission_v60(jsonb)',
            definition: f.definition.replace(
              'FUNCTION ctp_paper.reconcile_admission(',
              'FUNCTION ctp_paper.reconcile_admission_v60(',
            ),
          }
        : f;
    assert.deepEqual(
      after.functions.find((x) => x.signature === expected.signature),
      expected,
    );
  }
  assert.deepEqual(after.rows, before.rows);
  for (const signature of [
    'ctp_paper.capture_preparation_inventory(jsonb)',
    'ctp_paper.reconcile_admission_v60(jsonb)',
  ]) {
    assert.equal(
      (
        await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
          'ctp_paper_risk_admission',
          signature,
        ])
      ).rows[0].allowed,
      false,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'",
          [signature],
        )
      ).rows[0].n,
      0,
    );
  }
  for (const signature of [
    'ctp_paper.evaluate_and_reserve(jsonb)',
    'ctp_paper.reconcile_admission(jsonb)',
  ])
    assert.equal(
      (
        await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
          'ctp_paper_risk_admission',
          signature,
        ])
      ).rows[0].allowed,
      true,
    );
}
