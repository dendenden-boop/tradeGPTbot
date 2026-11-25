import assert from 'node:assert/strict';
import { capturePaperExecutionStartUpgrade } from './paper-execution-start-upgrade.mjs';

const rpc = 'ctp_paper.reconcile_admission(jsonb)';
const helper = 'ctp_paper.postexecution_basis(jsonb)';
const route =
  " IF p->>'kind'='PAPER_POSTEXECUTION_BASIS_READ' THEN RETURN ctp_paper.postexecution_basis(p); END IF;\n";

export async function verifyPaperPostexecutionBasisStorage(db, nonBypass) {
  const { rows } = await db.query(
    `SELECT p.oid::regprocedure::text signature,p.proowner::text owner,p.prosecdef,
    p.proconfig,NOT (r.rolsuper OR r.rolbypassrls) non_bypass,
    has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') runtime_access,
    EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_access
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    WHERE p.oid IN ($1::regprocedure,$2::regprocedure) ORDER BY signature`,
    [helper, rpc],
  );
  assert.deepEqual(
    rows.map((row) => row.signature),
    [helper, rpc],
  );
  assert.equal(rows[0].owner, rows[1].owner);
  for (const row of rows) {
    assert.equal(row.public_access, false);
    assert.equal(row.runtime_access, row.signature === rpc);
    assert.equal(row.prosecdef, row.signature === rpc);
    assert.ok(row.proconfig.includes('search_path=pg_catalog'));
    if (nonBypass) assert.equal(row.non_bypass, true);
  }
}

export async function verifyPaperPostexecutionBasisUpgrade(db, before) {
  assert.ok(
    before.retained.rows.some(
      (row) => row.name === '"ctp_paper"."postexecution_commitment"' && row.rows.length > 0,
    ),
    'The upgrade fixture must already hold a genuine successor reservation',
  );
  const after = await capturePaperExecutionStartUpgrade(db);
  assert.deepEqual(after.retained.rows, before.retained.rows);
  assert.deepEqual(
    after.retained.functions.filter((fn) => fn.signature !== helper),
    before.retained.functions.map((fn) =>
      fn.signature === rpc
        ? {
            ...fn,
            definition: fn.definition.replace(
              " IF p->>'kind'='PAPER_POSTEXECUTION_READ'",
              route + " IF p->>'kind'='PAPER_POSTEXECUTION_READ'",
            ),
          }
        : fn,
    ),
  );
  assert.deepEqual(
    after.security.filter((fn) => fn.proname !== 'postexecution_basis'),
    before.security,
  );
  await verifyPaperPostexecutionBasisStorage(db, true);
}
