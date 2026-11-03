import assert from 'node:assert/strict';
import { capturePaperExecutionStartUpgrade } from './paper-execution-start-upgrade.mjs';

export async function verifyPaperStartedRiskUpgrade(db, before) {
  assert.equal(before.retained.functions.length, 236);
  assert.ok(
    before.retained.rows.some(
      (t) => t.name === '"ctp_paper"."admission_issuance"' && t.rows.length,
    ),
  );
  const after = await capturePaperExecutionStartUpgrade(db);
  assert.equal(after.retained.functions.length, 238);
  assert.deepEqual(
    after.retained.rows,
    before.retained.rows,
    'No rows or tables are introduced, inferred or rewritten',
  );
  for (const f of before.retained.functions) {
    const renamed = f.signature === 'ctp_paper.reconcile_admission(jsonb)';
    const expected = renamed
      ? {
          signature: 'ctp_paper.reconcile_admission_v63(jsonb)',
          definition: f.definition.replace(
            'FUNCTION ctp_paper.reconcile_admission(',
            'FUNCTION ctp_paper.reconcile_admission_v63(',
          ),
        }
      : f;
    assert.deepEqual(
      after.retained.functions.find((x) => x.signature === expected.signature),
      expected,
    );
  }
  for (const old of before.security) {
    const renamed = old.proname === 'reconcile_admission';
    const current = after.security.find((x) => x.oid === old.oid);
    assert.ok(current);
    assert.deepEqual(
      current,
      {
        ...old,
        proname: renamed ? 'reconcile_admission_v63' : old.proname,
        acl: renamed ? current.acl : old.acl,
      },
      'Retain OIDs, owners, settings, definer boundaries and all unrelated ACLs',
    );
  }
  await verifyPaperStartedRiskStorage(db, { ownership: 'REQUIRE_NON_BYPASS' });
}

export async function verifyPaperStartedRiskStorage(db, options) {
  assert.ok(
    options && ['STORAGE_ONLY', 'REQUIRE_NON_BYPASS'].includes(options.ownership),
    'STARTED_RISK_OWNER_SCOPE_REQUIRED',
  );
  const functions = (
    await db.query(
      `SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,
    has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') allowed,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='ctp_paper' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,
      [['capture_started_risk', 'reconcile_admission', 'reconcile_admission_v63']],
    )
  ).rows;
  assert.deepEqual(
    functions.map((f) => f.proname),
    ['capture_started_risk', 'reconcile_admission', 'reconcile_admission_v63'],
  );
  for (const f of functions) {
    if (options.ownership === 'REQUIRE_NON_BYPASS') {
      assert.equal(f.rolsuper, false);
      assert.equal(f.rolbypassrls, false);
    }
    assert.equal(f.public, false);
    assert.equal(f.allowed, f.proname === 'reconcile_admission');
    assert.equal(f.prosecdef, f.proname !== 'capture_started_risk');
    assert.deepEqual(
      f.proconfig,
      f.proname === 'capture_started_risk'
        ? ['search_path=pg_catalog', 'TimeZone=UTC']
        : ['search_path=pg_catalog'],
    );
  }
}
