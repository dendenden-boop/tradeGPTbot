import assert from 'node:assert/strict';
import { capturePaperAdmissionUpgrade } from './paper-admission-upgrade.mjs';

/** Published57 rows and all original implementations survive additive58.
 * This deployment creates no capture, book head, row or financial authority. */
export async function verifyPaperExecutionSourceUpgrade(db, before) {
  assert.equal(before.functions.length, 214);
  const after = await capturePaperAdmissionUpgrade(db);
  assert.equal(after.functions.length, 216);
  for (const f of before.functions) {
    const renamed = f.signature === 'ctp_paper.reconcile_admission(jsonb)';
    const expected = renamed
      ? {
          signature: 'ctp_paper.reconcile_admission_v57(jsonb)',
          definition: f.definition.replace(
            'FUNCTION ctp_paper.reconcile_admission(',
            'FUNCTION ctp_paper.reconcile_admission_v57(',
          ),
        }
      : f;
    assert.deepEqual(
      after.functions.find((x) => x.signature === expected.signature),
      expected,
    );
  }
  assert.deepEqual(after.rows, before.rows, 'No adopted heads, inferred authority or monetary row');
  const source = after.functions.find(
    (x) => x.signature === 'ctp_paper.capture_execution_candidates(jsonb)',
  );
  assert(source);
  assert(!/INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[a-z_."]+\s+SET/iu.test(source.definition));
  for (const signature of [
    'ctp_paper.capture_execution_candidates(jsonb)',
    'ctp_paper.reconcile_admission_v57(jsonb)',
  ])
    assert.deepEqual(
      (
        await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
          'ctp_paper_risk_admission',
          signature,
        ])
      ).rows,
      [{ allowed: false }],
    );
  for (const signature of [
    'ctp_paper.evaluate_and_reserve(jsonb)',
    'ctp_paper.reconcile_admission(jsonb)',
  ])
    assert.deepEqual(
      (
        await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
          'ctp_paper_risk_admission',
          signature,
        ])
      ).rows,
      [{ allowed: true }],
    );
}
