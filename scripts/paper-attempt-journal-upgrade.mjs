import assert from 'node:assert/strict';
import { capturePaperAdmissionUpgrade } from './paper-admission-upgrade.mjs';

/** Actual populated58 deploy/redeploy: no inferred attempt or authority. */
export async function verifyPaperAttemptJournalUpgrade(db, before) {
  assert.equal(before.functions.length, 216);
  const after = await capturePaperAdmissionUpgrade(db);
  assert.equal(after.functions.length, 221);
  for (const f of before.functions) {
    const name = ['evaluate_and_reserve', 'reconcile_admission'].find(
      (n) => f.signature === `ctp_paper.${n}(jsonb)`,
    );
    const expected = name
      ? {
          signature: `ctp_paper.${name}_v58(jsonb)`,
          definition: f.definition.replace(
            `FUNCTION ctp_paper.${name}(`,
            `FUNCTION ctp_paper.${name}_v58(`,
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
  const added = after.rows.filter((x) => !before.rows.some((old) => old.name === x.name));
  assert.deepEqual(added.map((x) => x.name).sort(), [
    '"ctp_paper"."attempt_not_sent"',
    '"ctp_paper"."attempt_preparation"',
  ]);
  assert(
    added.every((x) => x.rows.length === 0),
    'No historical attempt may be inferred',
  );
  for (const name of ['attempt_preparation', 'attempt_not_sent']) {
    assert.deepEqual(
      (
        await db.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          ['ctp_paper.' + name],
        )
      ).rows,
      [{ relrowsecurity: true, relforcerowsecurity: true }],
    );
    assert.equal(
      (
        await db.query(
          "SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') allowed",
          ['ctp_paper_risk_admission', 'ctp_paper.' + name],
        )
      ).rows[0].allowed,
      false,
    );
  }
  for (const signature of [
    'ctp_paper.prepared_attempt(jsonb,uuid,bigint)',
    'ctp_paper.check_attempt_journal_cause()',
    'ctp_paper.attempt_journal(jsonb,boolean)',
    'ctp_paper.evaluate_and_reserve_v58(jsonb)',
    'ctp_paper.reconcile_admission_v58(jsonb)',
  ])
    assert.equal(
      (
        await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
          'ctp_paper_risk_admission',
          signature,
        ])
      ).rows[0].allowed,
      false,
    );
}
