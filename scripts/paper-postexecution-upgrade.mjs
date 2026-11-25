import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { capturePaperExecutionStartUpgrade } from './paper-execution-start-upgrade.mjs';
import { publishCurrentFixtureEvidence } from './paper-current-order-risk-upgrade.mjs';

const table = '"ctp_paper"."postexecution_commitment"';
const aliases = ['evaluate_and_reserve', 'reconcile_admission'];
const privateFunctions = [
  'check_postexecution_commitment',
  'derive_postexecution_risk',
  'postexecution_receipt',
  'postexecution_reserve',
  'validate_postexecution_commitment',
  ...aliases.map((name) => name + '_before_postexecution'),
];
const one = async (db, query, params) => {
  const { rows } = await db.query(query, params);
  assert.equal(rows.length, 1);
  return rows[0];
};

export async function verifyPaperPostexecutionStorage(db, { nonBypass, empty }) {
  const relation = await one(
    db,
    `SELECT relrowsecurity AND relforcerowsecurity fenced,
    NOT (r.rolsuper OR r.rolbypassrls) non_bypass,
    has_table_privilege('ctp_paper_risk_admission',c.oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') runtime_access,
    EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polcmd='*'
      AND pg_get_expr(p.polqual,p.polrelid) = pg_get_expr(p.polwithcheck,p.polrelid)
      AND pg_get_expr(p.polqual,p.polrelid) LIKE '%tenant_id%current_setting%app.tenant_id%') tenant
    FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    WHERE c.oid='ctp_paper.postexecution_commitment'::regclass`,
  );
  assert.equal(relation.fenced, true);
  assert.equal(relation.tenant, true);
  assert.equal(relation.runtime_access, false);
  if (nonBypass) assert.equal(relation.non_bypass, true);
  const { rows: triggers } =
    await db.query(`SELECT tgname,tgdeferrable,tginitdeferred FROM pg_trigger
    WHERE tgrelid='ctp_paper.postexecution_commitment'::regclass AND NOT tgisinternal
    ORDER BY tgname`);
  assert.deepEqual(
    triggers.map((t) => [t.tgname, t.tgdeferrable, t.tginitdeferred]),
    [
      ['postexecution_causality', true, true],
      ['postexecution_immutable', false, false],
      ['postexecution_no_truncate', false, false],
    ],
  );
  const known = [...privateFunctions, ...aliases];
  const { rows: functions } = await db.query(
    `SELECT p.proname,p.prosecdef,p.proconfig,
    NOT (r.rolsuper OR r.rolbypassrls) non_bypass,
    has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') runtime_access,
    EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_access
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE ns.nspname='ctp_paper' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,
    [known],
  );
  assert.deepEqual(
    functions.map((f) => f.proname),
    known.sort(),
  );
  for (const f of functions) {
    assert.equal(f.public_access, false);
    assert.equal(f.runtime_access, aliases.includes(f.proname));
    assert.ok(f.proconfig.includes('search_path=pg_catalog'));
    assert.equal(
      f.prosecdef,
      f.proname === 'check_postexecution_commitment' ||
        aliases.includes(f.proname.replace('_before_postexecution', '')),
    );
    if (nonBypass) assert.equal(f.non_bypass, true);
  }
  if (empty)
    assert.equal(
      (await one(db, 'SELECT count(*)::int AS n FROM ctp_paper.postexecution_commitment')).n,
      0,
    );
}

export async function verifyPaperPostexecutionUpgrade(db, before) {
  assert.ok(
    before.retained.rows.some(
      (t) => t.name === '"ctp_paper"."execution_commit"' && t.rows.length > 0,
    ),
  );
  assert.ok(
    before.retained.rows.some(
      (t) => t.name === '"ctp_paper"."current_risk_certificate"' && t.rows.length > 0,
    ),
  );
  assert.ok(!before.retained.rows.some((t) => t.name === table));
  const after = await capturePaperExecutionStartUpgrade(db);
  assert.deepEqual(
    after.retained.rows.filter((t) => t.name !== table),
    before.retained.rows,
  );
  assert.deepEqual(
    after.retained.rows.find((t) => t.name === table),
    { name: table, rows: [] },
  );
  assert.equal(after.retained.functions.length, before.retained.functions.length + 7);
  for (const f of before.retained.functions) {
    const alias = aliases.find((name) => f.signature === 'ctp_paper.' + name + '(jsonb)');
    const renamed = alias ? alias + '_before_postexecution' : null;
    const expected = alias
      ? {
          signature: 'ctp_paper.' + renamed + '(jsonb)',
          definition: f.definition.replace(
            'FUNCTION ctp_paper.' + alias + '(',
            'FUNCTION ctp_paper.' + renamed + '(',
          ),
        }
      : f;
    const actual = after.retained.functions.find((entry) => entry.signature === expected.signature);
    if (f.signature.startsWith('ctp_paper.validate_committed_execution(')) {
      assert.ok(
        actual?.definition.includes('ctp_paper.validate_postexecution_commitment(x,successor)'),
      );
    } else {
      assert.deepEqual(actual, expected);
    }
  }
  for (const f of before.security) {
    const current = after.security.find((entry) => entry.oid === f.oid);
    assert.ok(current);
    assert.deepEqual(
      current,
      aliases.includes(f.proname)
        ? { ...f, proname: f.proname + '_before_postexecution', acl: current.acl }
        : f,
    );
  }
  await verifyPaperPostexecutionStorage(db, { nonBypass: true, empty: true });
}

export async function verifyCompiledPaperPostexecution(db, env, deployBasis) {
  const { createPostgresPaperPostexecutionReservation } =
    await import('../packages/paper-engine/dist/postgres-postexecution-reservation.js');
  const { createPostgresPaperExecutionCommitter } =
    await import('../packages/paper-engine/dist/risk.js');
  const row = await one(
    db,
    `SELECT x.request,x.authorization_epochs, x.tenant_id,
    o.id "orderId",o."intentId",encode(c."commandHash",'hex') "commandHash"
    FROM ctp_paper.execution_commit x JOIN public."order" o ON o."tenantId"=x.tenant_id
      AND o."accountId"=x.account_id AND o.mode='PAPER' AND o.id<>x.order_id AND o.status='CREATED'
    JOIN ctp_execution.command c ON c."tenantId"=o."tenantId" AND c."intentId"=o."intentId"
      AND c."orderId"=o.id AND c.operation='PLACE'`,
  );
  const source = {
    ...row.request,
    authorization: row.authorization_epochs,
    kind: 'PAPER_CURRENT_RISK_CERTIFY',
  };
  const original = { ...source, kind: 'PAPER_EXECUTION_COMMIT' };
  const request = {
    key: randomUUID(),
    source,
    target: { orderId: row.orderId, intentId: row.intentId, commandHash: row.commandHash },
  };
  const options = { connectionString: env.DATABASE_PAPER_ADMISSION_URL, environment: 'test' };
  const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
  const effects = () =>
    one(
      db,
      `SELECT
    (SELECT count(*)::int FROM public.ledger_transaction WHERE "tenantId"=$1) ledger,
    (SELECT count(*)::int FROM public.ledger_entry WHERE "tenantId"=$1) entries,
    (SELECT count(*)::int FROM public.submission_attempt WHERE "tenantId"=$1) attempts,
    (SELECT count(*)::int FROM public.risk_reservation WHERE "tenantId"=$1) reservations,
    (SELECT count(*)::int FROM ctp_paper.postexecution_commitment WHERE tenant_id=$1) causes`,
      [row.tenant_id],
    );
  const writer = await createPostgresPaperExecutionCommitter(options);
  let reservation;
  try {
    const history = await writer.read(original, io());
    assert.equal(history.kind, 'COMMITTED');
    const before = await effects();
    assert.equal(before.causes, 0);
    reservation = await createPostgresPaperPostexecutionReservation(options);
    assert.equal(await reservation.read(request, io()), null);
    await publishCurrentFixtureEvidence(db, env, source);
    const receipt = await reservation.reserve(request, io());
    assert.equal(receipt.kind, 'PAPER_POSTEXECUTION_RESERVED');
    assert.equal(receipt.intentId, row.intentId);
    await reservation.close();
    reservation = await createPostgresPaperPostexecutionReservation(options);
    assert.deepEqual(await reservation.read(request, io()), receipt);
    assert.deepEqual(await reservation.reserve(request, io()), receipt);
    assert.deepEqual(await writer.read(original, io()), history);
    assert.deepEqual(await effects(), {
      ...before,
      reservations: before.reservations + 1,
      causes: 1,
    });
    if (deployBasis) {
      await reservation.close();
      await deployBasis();
      reservation = await createPostgresPaperPostexecutionReservation(options);
      const basis = await reservation.readPreparationBasis(request, io());
      assert.equal(basis.kind, 'PAPER_POSTEXECUTION_PREPARATION_BASIS');
      assert.deepEqual(basis.receipt, receipt);
      assert.equal(basis.target.commandHash, row.commandHash);
      assert.equal(basis.originalValidUntil > basis.appliedAt, true);
      assert.deepEqual(
        basis.book.state.holds.find((hold) => hold.id === basis.hold.id),
        basis.hold,
      );
      assert.equal(basis.book.revision, receipt.revision);
      await reservation.close();
      reservation = await createPostgresPaperPostexecutionReservation(options);
      assert.deepEqual(await reservation.readPreparationBasis(request, io()), basis);
      assert.deepEqual(await reservation.read(request, io()), receipt);
      assert.deepEqual(await writer.read(original, io()), history);
      assert.deepEqual(await effects(), {
        ...before,
        reservations: before.reservations + 1,
        causes: 1,
      });
    }
    return {
      status: 'PASS',
      restart: true,
      oneHold: true,
      historicalReplay: true,
      monetaryRowsUnchanged: true,
      ...(deployBasis ? { preparationBasis: 'PASS' } : {}),
    };
  } finally {
    await reservation?.close();
    await writer.close();
  }
}
