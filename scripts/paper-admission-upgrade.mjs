// Private additive53 acceptance. Text rows preserve numeric scale and bigint
// values; no JavaScript JSON number conversion is used for retained evidence.
import assert from 'node:assert/strict';
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
export async function capturePaperAdmissionUpgrade(db) {
  const tables = (
    await db.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND (n.nspname='public' OR left(n.nspname,4)='ctp_')
    AND c.relname<>'_prisma_migrations' ORDER BY n.nspname,c.relname`)
  ).rows;
  const rows = [];
  for (const { nspname, relname } of tables) {
    const name = quote(nspname) + '.' + quote(relname);
    rows.push({
      name,
      rows: (
        await db.query(`SELECT to_jsonb(t)::text raw FROM ${name} t ORDER BY to_jsonb(t)::text`)
      ).rows,
    });
  }
  const functions = (
    await db.query(`SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,4)='ctp_' ORDER BY p.oid::regprocedure::text`)
  ).rows;
  return { rows, functions };
}
export async function verifyPaperAdmissionUpgrade(db, before) {
  assert.equal(before.functions.length, 180);
  const after = await capturePaperAdmissionUpgrade(db);
  assert.equal(after.functions.length, 190);
  for (const f of before.functions)
    assert.deepEqual(
      after.functions.find((x) => x.signature === f.signature),
      f,
    );
  for (const table of before.rows)
    assert.deepEqual(
      after.rows.find((x) => x.name === table.name),
      table,
    );
  const added = after.rows.filter((x) => !before.rows.some((old) => old.name === x.name));
  assert.deepEqual(
    added.map((x) => x.name).sort(),
    ['admission_book_event', 'admission_book_head', 'admission_genesis', 'admission_issuance']
      .map((n) => '"ctp_paper".' + quote(n))
      .sort(),
  );
  assert.ok(
    added.every((x) => x.rows.length === 0),
    'No historical authority may be inferred/backfilled',
  );
  for (const name of [
    'admission_book_event',
    'admission_book_head',
    'admission_genesis',
    'admission_issuance',
  ]) {
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
        await db.query('SELECT has_table_privilege($1,$2,$3) allowed', [
          'ctp_paper_risk_admission',
          'ctp_paper.' + name,
          'SELECT,INSERT,UPDATE,DELETE',
        ])
      ).rows[0].allowed,
      false,
    );
  }
}
