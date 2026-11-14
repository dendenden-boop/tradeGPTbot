import assert from 'node:assert/strict';
import { capturePaperExecutionStartUpgrade } from './paper-execution-start-upgrade.mjs';
import { verifyPaperCurrentRiskStorage } from './paper-current-risk-upgrade.mjs';

export async function verifyPaperCurrentRiskMarketStorage(db, options) {
  await verifyPaperCurrentRiskStorage(db, options);
  const functions = (
    await db.query(`SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,
   has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') allowed,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
   WHERE n.nspname='ctp_paper' AND p.proname IN('current_risk_facts','current_risk_facts_v69') ORDER BY p.proname`)
  ).rows;
  assert.deepEqual(
    functions.map((f) => f.proname),
    ['current_risk_facts', 'current_risk_facts_v69'],
  );
  for (const f of functions) {
    assert.equal(f.prosecdef, false);
    assert.equal(f.allowed, false);
    assert.equal(f.public, false);
    assert.deepEqual(f.proconfig, ['search_path=pg_catalog', 'TimeZone=UTC']);
    if (options.ownership === 'REQUIRE_NON_BYPASS') {
      assert.equal(f.rolsuper, false);
      assert.equal(f.rolbypassrls, false);
    }
  }
  const index = (
    await db.query(`SELECT i.indisvalid,i.indnkeyatts,pg_get_indexdef(i.indexrelid,2,true) native_clock,
   pg_get_expr(i.indpred,i.indrelid) predicate FROM pg_index i
   WHERE i.indexrelid='ctp_market.snapshot_current_risk_latest_ticker'::regclass
    AND i.indrelid='ctp_market.snapshot_event'::regclass`)
  ).rows;
  assert.equal(index.length, 1);
  assert.equal(index[0].indisvalid, true);
  assert.equal(index[0].indnkeyatts, 4);
  assert(index[0].native_clock.includes("'exchangeTime'::text"));
  assert(index[0].native_clock.includes('bigint'));
  for (const text of ['APPLIED', 'DUPLICATE', 'SNAPSHOT'])
    assert(index[0].predicate.includes(text));
}
export async function verifyPaperCurrentRiskMarketUpgrade(db, before) {
  assert.equal(before.retained.functions.length, 272);
  assert(
    before.retained.rows.some(
      (t) => t.name === '"ctp_paper"."current_risk_certificate"' && t.rows.length,
    ),
  );
  const after = await capturePaperExecutionStartUpgrade(db);
  assert.equal(after.retained.functions.length, 273);
  assert.deepEqual(
    after.retained.rows,
    before.retained.rows,
    'No old certificate, checkpoint, account or financial row is rewritten',
  );
  for (const f of before.retained.functions) {
    const expected =
      f.signature === 'ctp_paper.current_risk_facts(jsonb)'
        ? {
            signature: 'ctp_paper.current_risk_facts_v69(jsonb)',
            definition: f.definition.replace(
              'FUNCTION ctp_paper.current_risk_facts(',
              'FUNCTION ctp_paper.current_risk_facts_v69(',
            ),
          }
        : f;
    assert.deepEqual(
      after.retained.functions.find((v) => v.signature === expected.signature),
      expected,
    );
  }
  for (const f of before.security) {
    const current = after.security.find((v) => v.oid === f.oid);
    assert(current);
    assert.deepEqual(current, {
      ...f,
      proname: f.proname === 'current_risk_facts' ? 'current_risk_facts_v69' : f.proname,
    });
  }
  await verifyPaperCurrentRiskMarketStorage(db, { ownership: 'REQUIRE_NON_BYPASS' });
}
