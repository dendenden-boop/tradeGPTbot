import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { capturePaperExecutionStartUpgrade } from './paper-execution-start-upgrade.mjs';
import { verifyPaperExecutedValuationStorage } from './paper-executed-valuation-upgrade.mjs';

export async function verifyPaperHistoricalInventoryStorage(db, options) {
  await verifyPaperExecutedValuationStorage(db, options);
  const rows = (
    await db.query(`SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,
   has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') allowed,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
   WHERE n.nspname='ctp_paper' AND p.proname IN('capture_historical_inventory','reconcile_admission_v67','reconcile_admission') ORDER BY p.proname`)
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.proname),
    ['capture_historical_inventory', 'reconcile_admission', 'reconcile_admission_v67'],
  );
  for (const r of rows) {
    assert.equal(r.prosecdef, true);
    assert.equal(r.public, false);
    assert.equal(r.allowed, r.proname === 'reconcile_admission');
    assert.deepEqual(
      r.proconfig,
      r.proname === 'capture_historical_inventory'
        ? ['search_path=pg_catalog', 'TimeZone=UTC']
        : ['search_path=pg_catalog'],
    );
    if (options.ownership === 'REQUIRE_NON_BYPASS') {
      assert.equal(r.rolsuper, false);
      assert.equal(r.rolbypassrls, false);
    }
  }
}
export async function verifyPaperHistoricalInventoryUpgrade(db, before) {
  assert.equal(before.retained.functions.length, 259);
  assert(
    before.retained.rows.some((t) => t.name === '"ctp_paper"."execution_commit"' && t.rows.length),
  );
  const after = await capturePaperExecutionStartUpgrade(db);
  assert.equal(after.retained.functions.length, 261);
  assert.deepEqual(after.retained.rows, before.retained.rows);
  for (const f of before.retained.functions) {
    const expected =
      f.signature === 'ctp_paper.reconcile_admission(jsonb)'
        ? {
            signature: 'ctp_paper.reconcile_admission_v67(jsonb)',
            definition: f.definition.replace('(p jsonb)', '_v67(p jsonb)'),
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
      proname: f.proname === 'reconcile_admission' ? 'reconcile_admission_v67' : f.proname,
      acl: f.proname === 'reconcile_admission' ? current.acl : f.acl,
    });
  }
  await verifyPaperHistoricalInventoryStorage(db, { ownership: 'REQUIRE_NON_BYPASS' });
}
/** Uses the retained genuine execution and a new actual current price
 * publication after migration/redeploy; never rewrites economic history. */
export async function verifyCompiledHistoricalInventory(db, env) {
  const { createPostgresPaperHistoricalInventorySource } =
    await import('../packages/paper-engine/dist/risk.js');
  const { createPostgresMarketSnapshots } = await import('../packages/market-data/dist/index.js');
  const x = (
    await db.query(
      'SELECT request,authorization_epochs,source FROM ctp_paper.execution_commit ORDER BY tenant_id,execution_key LIMIT 1',
    )
  ).rows[0];
  assert(x);
  const request = {
    ...x.request,
    authorization: x.authorization_epochs,
    kind: 'PAPER_HISTORICAL_INVENTORY_CAPTURE',
  };
  const options = { connectionString: env.DATABASE_PAPER_ADMISSION_URL, environment: 'test' };
  const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
  const current = (
    await db.query(
      `SELECT e.payload,h.revision::text revision
    FROM ctp_market.snapshot_head h JOIN ctp_market.snapshot_event e ON e.id=h.native
    WHERE h.key=(SELECT key-'dbRuleId' FROM ctp_market.snapshot_event WHERE id=$1)`,
      [x.source.started.capture.market.snapshot.id],
    )
  ).rows[0];
  assert(current);
  const p = JSON.parse(current.payload),
    now = Date.now();
  p.id = randomUUID();
  p.expectedRevision = current.revision;
  p.timestamp = now;
  for (const v of [p.book, p.ticker]) v.receivedAt = v.exchangeTime = now;
  if (p.book.sourceSequence !== null)
    p.book.sourceSequence = (
      BigInt(p.book.sourceSequence) +
      BigInt(current.revision) +
      1n
    ).toString();
  const snapshots = await createPostgresMarketSnapshots({
    connectionString: env.DATABASE_MARKET_SNAPSHOT_URL,
    environment: 'test',
  });
  let reader;
  try {
    assert.equal((await snapshots.publish(p, io())).status, 'APPLIED');
    const before = await capturePaperExecutionStartUpgrade(db);
    reader = await createPostgresPaperHistoricalInventorySource(options);
    const a = await reader.read(request, io());
    assert.equal(a.kind, 'CAPTURED');
    assert.equal(a.source.complete, true);
    assert.equal(a.source.coverage, 'ONE_EXECUTED_BOOK_WITH_PRISTINE_SIBLINGS');
    await reader.close();
    reader = await createPostgresPaperHistoricalInventorySource(options);
    const b = await reader.read(request, io());
    assert.equal(b.kind, 'CAPTURED');
    assert.equal(a.source.hash, b.source.hash);
    assert.deepEqual(
      (await capturePaperExecutionStartUpgrade(db)).retained.rows,
      before.retained.rows,
    );
    return {
      status: 'PASS',
      pre68Execution: true,
      compiledSource: true,
      restart: true,
      financialRowsUnchanged: true,
    };
  } finally {
    await reader?.close();
    await snapshots.close();
  }
}
