// Private additive54 acceptance. Preserve exact numeric/bigint text and all
// pre-existing rows. No historical UNKNOWN authority may be inferred/backfilled.
import assert from 'node:assert/strict';
import { capturePaperAdmissionUpgrade } from './paper-admission-upgrade.mjs';
export async function verifyPaperUnknownUpgrade(db, before) {
  assert.equal(before.functions.length, 190);
  const after = await capturePaperAdmissionUpgrade(db);
  assert.equal(after.functions.length, 193);
  const checks = (
    await db.query(
      "SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='ctp_paper.admission_book_event'::regclass AND contype='c'",
    )
  ).rows;
  assert.ok(
    checks.some(
      (r) =>
        r.definition.includes('state_hash') &&
        r.definition.includes('sha256') &&
        r.definition.includes('state_text'),
    ),
  );
  assert.ok(
    checks.some(
      (r) =>
        r.definition.includes('previous_revision') &&
        r.definition.includes('UNKNOWN') &&
        r.definition.includes('previous_hash'),
    ),
  );
  const changed = ['ctp_paper.admission_book(jsonb)', 'ctp_paper.check_admission_book()'];
  for (const f of before.functions) {
    if (changed.includes(f.signature)) {
      assert.notEqual(
        after.functions.find((x) => x.signature === f.signature)?.definition,
        f.definition,
      );
      continue;
    }
    const legacy = ['evaluate_and_reserve', 'reconcile_admission'].find(
      (name) => f.signature === `ctp_paper.${name}(jsonb)`,
    );
    const expected = legacy
      ? {
          signature: `ctp_paper.${legacy}_v53(jsonb)`,
          definition: f.definition.replace(
            `FUNCTION ctp_paper.${legacy}(`,
            `FUNCTION ctp_paper.${legacy}_v53(`,
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
    [{ name: '"ctp_paper"."admission_unknown_event"', rows: [] }],
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ctp_paper.admission_unknown_event'::regclass",
      )
    ).rows,
    [{ relrowsecurity: true, relforcerowsecurity: true }],
  );
  assert.equal(
    (
      await db.query(
        "SELECT has_table_privilege('ctp_paper_risk_admission','ctp_paper.admission_unknown_event','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') allowed",
      )
    ).rows[0].allowed,
    false,
  );
  for (const signature of [
    'ctp_paper.evaluate_and_reserve_v53(jsonb)',
    'ctp_paper.reconcile_admission_v53(jsonb)',
    'ctp_paper.reservation_unknown(jsonb,boolean)',
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
}
