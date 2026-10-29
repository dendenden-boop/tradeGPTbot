import assert from 'node:assert/strict';
import { capturePaperAdmissionUpgrade } from './paper-admission-upgrade.mjs';

/** Actual populated59 deploy/redeploy: readonly source, no inferred authority. */
export async function verifyPaperExecutionRiskUpgrade(db, before) {
  assert.equal(before.functions.length, 221);
  const after = await capturePaperAdmissionUpgrade(db);
  assert.equal(after.functions.length, 223);
  for (const f of before.functions) {
    const expected =
      f.signature === 'ctp_paper.reconcile_admission(jsonb)'
        ? {
            signature: 'ctp_paper.reconcile_admission_v59(jsonb)',
            definition: f.definition.replace(
              'FUNCTION ctp_paper.reconcile_admission(',
              'FUNCTION ctp_paper.reconcile_admission_v59(',
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
    'ctp_paper.capture_execution_risk(jsonb)',
    'ctp_paper.reconcile_admission_v59(jsonb)',
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
    const publicGrants = await db.query(
      `SELECT count(*)::integer n FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'`,
      [signature],
    );
    assert.equal(publicGrants.rows[0].n, 0);
  }
  for (const signature of [
    'ctp_paper.reconcile_admission(jsonb)',
    'ctp_paper.evaluate_and_reserve(jsonb)',
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
