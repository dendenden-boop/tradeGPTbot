import assert from 'node:assert/strict';
import { capturePaperAdmissionUpgrade } from './paper-admission-upgrade.mjs';

const renamed = [
  'capture_execution_candidates',
  'attempt_journal',
  'evaluate_and_reserve',
  'reconcile_admission',
];
export const executionStartFunctions = Object.freeze([
  'execution_start_auth',
  'validate_execution_start',
  'derive_execution_start',
  'execution_start',
  'capture_execution_candidates_v61',
  'capture_execution_candidates',
  'attempt_journal_v61',
  'attempt_journal',
  'start_prevents_not_sent',
  'evaluate_and_reserve_v61',
  'reconcile_admission_v61',
  'evaluate_and_reserve',
  'reconcile_admission',
]);
export async function capturePaperExecutionStartUpgrade(db) {
  const retained = await capturePaperAdmissionUpgrade(db);
  const security = (
    await db.query(`SELECT p.oid::text oid,p.proname,p.proowner::text owner,p.prosecdef,p.proconfig,p.proacl::text acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,4)='ctp_' ORDER BY p.oid`)
  ).rows;
  return { retained, security };
}
/** Actual populated61 ->62 deploy/redeploy. No historical START backfill. */
export async function verifyPaperExecutionStartUpgrade(db, before) {
  assert.equal(before.retained.functions.length, 225);
  assert.ok(
    before.retained.rows.some(
      (t) => t.name === '"ctp_paper"."admission_issuance"' && t.rows.length > 0,
    ),
  );
  const after = await capturePaperExecutionStartUpgrade(db);
  assert.equal(after.retained.functions.length, 234);
  for (const f of before.retained.functions) {
    const name = renamed.find((name) => f.signature.startsWith('ctp_paper.' + name + '('));
    const expected = name
      ? {
          signature: f.signature.replace(name + '(', name + '_v61('),
          definition: f.definition.replace(
            'FUNCTION ctp_paper.' + name + '(',
            'FUNCTION ctp_paper.' + name + '_v61(',
          ),
        }
      : f;
    assert.deepEqual(
      after.retained.functions.find((x) => x.signature === expected.signature),
      expected,
    );
  }
  for (const old of before.security) {
    const name = renamed.includes(old.proname) ? old.proname + '_v61' : old.proname;
    const current = after.security.find((x) => x.oid === old.oid);
    // The four old RPC/helper bodies keep their OIDs/settings/owners, but their
    // private aliases deliberately lose the runtime EXECUTE grant. The new
    // public pair is the only executable admission surface (checked below).
    assert.deepEqual(
      current,
      { ...old, proname: name, acl: renamed.includes(old.proname) ? current.acl : old.acl },
      'Retained settings, definer boundary, OID and owner unchanged; unrelated ACLs unchanged',
    );
  }
  for (const table of before.retained.rows)
    assert.deepEqual(
      after.retained.rows.find((t) => t.name === table.name),
      table,
    );
  assert.deepEqual(
    after.retained.rows.filter((t) => !before.retained.rows.some((old) => old.name === t.name)),
    [{ name: '"ctp_paper"."attempt_start"', rows: [] }],
  );
  await verifyPaperExecutionStartStorage(db, { ownership: 'REQUIRE_NON_BYPASS' });
}
export async function verifyPaperExecutionStartStorage(db, options) {
  assert.ok(
    options && ['STORAGE_ONLY', 'REQUIRE_NON_BYPASS'].includes(options.ownership),
    'EXECUTION_START_OWNER_SCOPE_REQUIRED',
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ctp_paper.attempt_start'::regclass",
      )
    ).rows,
    [{ relrowsecurity: true, relforcerowsecurity: true }],
  );
  assert.equal(
    (
      await db.query(
        "SELECT has_table_privilege('ctp_paper_risk_admission','ctp_paper.attempt_start','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed",
      )
    ).rows[0].allowed,
    false,
  );
  const functions = (
    await db.query(
      `SELECT p.oid::regprocedure::text signature,p.proname,r.rolsuper,r.rolbypassrls,
    has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') allowed,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='ctp_paper' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,
      [executionStartFunctions],
    )
  ).rows;
  assert.equal(functions.length, 13);
  for (const f of functions) {
    if (options.ownership === 'REQUIRE_NON_BYPASS') {
      assert.equal(f.rolsuper, false);
      assert.equal(f.rolbypassrls, false);
    }
    assert.equal(f.public, false);
    assert.equal(f.allowed, ['evaluate_and_reserve', 'reconcile_admission'].includes(f.proname));
  }
  assert.deepEqual(
    (
      await db.query(
        "SELECT tgname FROM pg_trigger WHERE tgrelid='ctp_paper.attempt_start'::regclass AND NOT tgisinternal ORDER BY tgname",
      )
    ).rows.map((x) => x.tgname),
    ['derive_execution_start', 'execution_start_immutable', 'execution_start_no_truncate'],
  );
}
