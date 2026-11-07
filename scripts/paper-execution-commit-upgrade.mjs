import assert from 'node:assert/strict';
import { capturePaperExecutionStartUpgrade } from './paper-execution-start-upgrade.mjs';

export const executionMathFunctions = Object.freeze([
  'execution_math_number',
  'execution_math_amount',
  'execution_math_id',
  'execution_math_time',
  'execution_math_seed',
  'derive_pristine_buy',
  'execution_math_aggregate',
  'execution_math_cash',
  'derive_pristine_effects',
]);
export const executionCommitFunctions = Object.freeze([
  ...executionMathFunctions,
  'validate_execution_commit',
  'execution_commit_seal',
  'derive_execution_commit',
  'execution_average',
  'apply_execution_commit',
  'validate_committed_execution',
  'execution_commit',
  'check_execution_cause',
  'check_admission_book',
  'check_reservation_state',
  'evaluate_and_reserve_v65',
  'reconcile_admission_v65',
  'evaluate_and_reserve',
  'reconcile_admission',
]);
export async function verifyPaperExecutionCommitStorage(db, options) {
  assert.ok(
    options && ['STORAGE_ONLY', 'REQUIRE_NON_BYPASS'].includes(options.ownership),
    'EXECUTION_COMMIT_OWNER_SCOPE_REQUIRED',
  );
  const tables = (
    await db.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolsuper,r.rolbypassrls,
    has_table_privilege('ctp_paper_risk_admission',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed,
    EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polcmd='*'
      AND pg_get_expr(p.polqual,p.polrelid)=pg_get_expr(p.polwithcheck,p.polrelid)
      AND pg_get_expr(p.polqual,p.polrelid) LIKE '%tenant_id%current_setting%app.tenant_id%') isolated
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='ctp_paper' AND c.relname IN('execution_commit','execution_liquidity') ORDER BY c.relname`)
  ).rows;
  assert.deepEqual(
    tables.map((t) => t.relname),
    ['execution_commit', 'execution_liquidity'],
  );
  for (const t of tables) {
    assert.equal(t.relrowsecurity, true);
    assert.equal(t.relforcerowsecurity, true);
    assert.equal(t.allowed, false);
    assert.equal(t.isolated, true);
    if (options.ownership === 'REQUIRE_NON_BYPASS') {
      assert.equal(t.rolsuper, false);
      assert.equal(t.rolbypassrls, false);
    }
  }
  const functions = (
    await db.query(
      `SELECT p.proname,p.prosecdef,p.provolatile,p.proconfig,r.rolsuper,r.rolbypassrls,
    has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') allowed,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='ctp_paper' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,
      [executionCommitFunctions],
    )
  ).rows;
  assert.deepEqual(
    functions.map((f) => f.proname),
    [...executionCommitFunctions].sort(),
  );
  const definers = [
    'derive_execution_commit',
    'apply_execution_commit',
    'check_execution_cause',
    'check_admission_book',
    'evaluate_and_reserve',
    'reconcile_admission',
    'evaluate_and_reserve_v65',
    'reconcile_admission_v65',
  ];
  for (const f of functions) {
    assert.equal(f.public, false);
    assert.equal(f.allowed, ['evaluate_and_reserve', 'reconcile_admission'].includes(f.proname));
    assert.equal(f.prosecdef, definers.includes(f.proname));
    assert.ok(f.proconfig.includes('search_path=pg_catalog'));
    if (
      executionMathFunctions.includes(f.proname) ||
      ['execution_commit_seal', 'execution_average'].includes(f.proname)
    )
      assert.equal(f.provolatile, 'i');
    if (options.ownership === 'REQUIRE_NON_BYPASS') {
      assert.equal(f.rolsuper, false);
      assert.equal(f.rolbypassrls, false);
    }
  }
  assert.deepEqual(
    (
      await db.query(`SELECT c.relname,t.tgname,t.tgdeferrable,t.tginitdeferred
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='ctp_paper' AND c.relname IN('execution_commit','execution_liquidity') AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)
    ).rows,
    [
      {
        relname: 'execution_commit',
        tgname: 'apply_execution_commit',
        tgdeferrable: false,
        tginitdeferred: false,
      },
      {
        relname: 'execution_commit',
        tgname: 'derive_execution_commit',
        tgdeferrable: false,
        tginitdeferred: false,
      },
      {
        relname: 'execution_commit',
        tgname: 'execution_immutable',
        tgdeferrable: false,
        tginitdeferred: false,
      },
      {
        relname: 'execution_commit',
        tgname: 'execution_no_truncate',
        tgdeferrable: false,
        tginitdeferred: false,
      },
      {
        relname: 'execution_commit',
        tgname: 'paper_execution_cause',
        tgdeferrable: true,
        tginitdeferred: true,
      },
      {
        relname: 'execution_liquidity',
        tgname: 'execution_immutable',
        tgdeferrable: false,
        tginitdeferred: false,
      },
      {
        relname: 'execution_liquidity',
        tgname: 'execution_no_truncate',
        tgdeferrable: false,
        tginitdeferred: false,
      },
      {
        relname: 'execution_liquidity',
        tgname: 'paper_execution_cause',
        tgdeferrable: true,
        tginitdeferred: true,
      },
    ],
  );
}

/** Populated64 ->65 ->66, including a repeat deploy. No financial backfill. */
export async function verifyPaperExecutionCommitUpgrade(db, before) {
  assert.equal(before.retained.functions.length, 238);
  assert.ok(
    before.retained.rows.some(
      (t) => t.name === '"ctp_paper"."admission_issuance"' && t.rows.length,
    ),
  );
  const after = await capturePaperExecutionStartUpgrade(db);
  assert.equal(after.retained.functions.length, 257);
  for (const table of before.retained.rows)
    assert.deepEqual(
      after.retained.rows.find((t) => t.name === table.name),
      table,
      'Retain all populated historical rows',
    );
  assert.deepEqual(
    after.retained.rows.filter((t) => !before.retained.rows.some((old) => old.name === t.name)),
    [
      { name: '"ctp_paper"."execution_commit"', rows: [] },
      { name: '"ctp_paper"."execution_liquidity"', rows: [] },
    ],
  );
  for (const f of before.retained.functions) {
    const rpc = [
      'ctp_paper.evaluate_and_reserve(jsonb)',
      'ctp_paper.reconcile_admission(jsonb)',
    ].includes(f.signature);
    const expected = rpc
      ? {
          signature: f.signature.replace('(jsonb)', '_v65(jsonb)'),
          definition: f.definition.replace('(p jsonb)', '_v65(p jsonb)'),
        }
      : f;
    const current = after.retained.functions.find((x) => x.signature === expected.signature);
    assert.ok(current);
    if (f.signature === 'ctp_paper.check_admission_book()') {
      const branch = ` IF EXISTS(SELECT 1 FROM ctp_paper.execution_commit WHERE tenant_id=t AND book_id=target_book) THEN\n  PERFORM ctp_paper.validate_committed_execution(t,execution_key) FROM ctp_paper.execution_commit WHERE tenant_id=t AND book_id=target_book;\n  RETURN NULL;\n END IF;\n`;
      assert.equal(
        current.definition.replace(branch, ''),
        f.definition,
        'Only the authenticated execution branch may change',
      );
    } else if (f.signature === 'ctp_paper.check_reservation_state()') {
      const branch = `OR (NEW.status IS DISTINCT FROM 'UNKNOWN' AND NOT EXISTS(\n    SELECT 1 FROM ctp_paper.execution_commit x WHERE x.tenant_id=NEW.tenant_id AND x.reservation_id=NEW.reservation_id\n     AND x.execution_id=NEW.event_id AND x.evaluated_ms=NEW.observed_ms AND x.effects->'reservation'->>'status'=NEW.status))`;
      assert.equal(
        current.definition.replace(branch, "OR NEW.status IS DISTINCT FROM 'UNKNOWN'"),
        f.definition,
        'Retain all UNKNOWN ordering checks',
      );
    } else assert.deepEqual(current, expected, 'All unrelated function definitions stay unchanged');
  }
  for (const old of before.security) {
    const rpc = ['evaluate_and_reserve', 'reconcile_admission'].includes(old.proname),
      current = after.security.find((f) => f.oid === old.oid);
    assert.ok(current);
    assert.deepEqual(
      current,
      {
        ...old,
        proname: rpc ? old.proname + '_v65' : old.proname,
        acl: rpc ? current.acl : old.acl,
      },
      'Retain OIDs, owners, settings and unrelated ACLs',
    );
  }
  await verifyPaperExecutionCommitStorage(db, { ownership: 'REQUIRE_NON_BYPASS' });
}
