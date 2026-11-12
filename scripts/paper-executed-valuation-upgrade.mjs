import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { capturePaperExecutionStartUpgrade } from './paper-execution-start-upgrade.mjs';
import { verifyPaperExecutionCommitStorage } from './paper-execution-commit-upgrade.mjs';

export async function verifyPaperExecutedValuationStorage(db, options) {
  await verifyPaperExecutionCommitStorage(db, options);
  const functions = (
    await db.query(`SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,
    has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') allowed,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='ctp_paper' AND p.proname IN('capture_executed_valuation','reconcile_admission_v66','reconcile_admission') ORDER BY p.proname`)
  ).rows;
  assert.deepEqual(
    functions.map((f) => f.proname),
    ['capture_executed_valuation', 'reconcile_admission', 'reconcile_admission_v66'],
  );
  for (const f of functions) {
    assert.equal(f.public, false);
    assert.equal(f.prosecdef, true);
    assert.equal(f.allowed, f.proname === 'reconcile_admission');
    assert(f.proconfig.includes('search_path=pg_catalog'));
    if (f.proname !== 'reconcile_admission_v66') assert(f.proconfig.includes('TimeZone=UTC'));
    if (options.ownership === 'REQUIRE_NON_BYPASS') {
      assert.equal(f.rolsuper, false);
      assert.equal(f.rolbypassrls, false);
    }
  }
}

/** Populated published66 ->67, including redeploy. Actual committed executions
 * are required, not an empty-schema or fabricated financial receipt fixture. */
export async function verifyPaperExecutedValuationUpgrade(db, before) {
  assert.equal(before.retained.functions.length, 257);
  assert(
    before.retained.rows.some((t) => t.name === '"ctp_paper"."execution_commit"' && t.rows.length),
  );
  const after = await capturePaperExecutionStartUpgrade(db);
  assert.equal(after.retained.functions.length, 259);
  assert.deepEqual(
    after.retained.rows,
    before.retained.rows,
    'All populated rows retained byte for byte; no table/backfill',
  );
  for (const f of before.retained.functions) {
    const renamed = f.signature === 'ctp_paper.reconcile_admission(jsonb)';
    const expected = renamed
      ? {
          signature: 'ctp_paper.reconcile_admission_v66(jsonb)',
          definition: f.definition.replace('(p jsonb)', '_v66(p jsonb)'),
        }
      : f;
    assert.deepEqual(
      after.retained.functions.find((x) => x.signature === expected.signature),
      expected,
    );
  }
  for (const f of before.security) {
    const current = after.security.find((x) => x.oid === f.oid);
    assert(current);
    assert.deepEqual(
      current,
      f.proname === 'reconcile_admission'
        ? { ...f, proname: 'reconcile_admission_v66', acl: current.acl }
        : f,
    );
  }
  await verifyPaperExecutedValuationStorage(db, { ownership: 'REQUIRE_NON_BYPASS' });
}

/** Compiled production source reads a genuinely pre67 execution after upgrade.
 * Only actual public metadata/price publications are refreshed, never financial
 * rows, original economic timestamps, user epochs or historical receipts. */
export async function verifyCompiledExecutedValuation(db, env) {
  const { createPostgresPaperExecutedValuationSource, createPostgresPaperExecutedBookSource } =
    await import('../packages/paper-engine/dist/risk.js');
  const { createPostgresMarketSnapshots } = await import('../packages/market-data/dist/index.js');
  const x = (
    await db.query(
      'SELECT request,authorization_epochs,source FROM ctp_paper.execution_commit ORDER BY tenant_id,execution_key LIMIT 1',
    )
  ).rows[0];
  assert(x, 'Actual published66 committed execution required');
  const request = {
    ...x.request,
    authorization: x.authorization_epochs,
    kind: 'PAPER_EXECUTED_VALUATION_CAPTURE',
  };
  const ref = x.source.started.capture.market.snapshot.id;
  const payload = (
    await db.query('SELECT payload FROM ctp_market.snapshot_event WHERE id=$1', [ref])
  ).rows[0];
  assert(payload);
  const p = JSON.parse(payload.payload),
    now = Date.now(),
    oldRule = p.key.dbRuleId;
  p.key.dbRuleId = randomUUID();
  p.record.rules.version = 'upgrade-mark-' + randomUUID();
  p.record.rules.effectiveAt = now - 1;
  p.record.rules.expiresAt = now + 60000;
  await db.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
    oldRule,
  ]);
  await db.query(
    `INSERT INTO public.instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",rules)
    SELECT $1,"instrumentId",version+1,true,$2,now(),"sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",$3::jsonb FROM public.instrument_rule_version WHERE id=$4`,
    [p.key.dbRuleId, new Date(now - 1), JSON.stringify(p.record.rules), oldRule],
  );
  const key = { ...p.key };
  delete key.dbRuleId;
  const head = (
    await db.query(
      'SELECT revision::text revision FROM ctp_market.snapshot_head WHERE key=$1::jsonb',
      [JSON.stringify(key)],
    )
  ).rows[0];
  assert(head);
  p.id = randomUUID();
  p.expectedRevision = head.revision;
  p.timestamp = Date.now();
  for (const v of [p.book, p.ticker]) v.receivedAt = v.exchangeTime = p.timestamp;
  if (p.book.sourceSequence !== null)
    p.book.sourceSequence = (BigInt(p.book.sourceSequence) + BigInt(head.revision) + 1n).toString();
  const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
  const options = (connectionString) => ({ connectionString, environment: 'test' });
  const snapshots = await createPostgresMarketSnapshots(options(env.DATABASE_MARKET_SNAPSHOT_URL));
  const book = await createPostgresPaperExecutedBookSource(
    options(env.DATABASE_PAPER_ADMISSION_URL),
  );
  let valuation;
  try {
    assert.equal((await snapshots.publish(p, io())).status, 'APPLIED');
    const original = await book.read({ ...request, kind: 'PAPER_EXECUTED_BOOK_CAPTURE' }, io());
    assert.equal(original.kind, 'CAPTURED');
    const before = await capturePaperExecutionStartUpgrade(db);
    valuation = await createPostgresPaperExecutedValuationSource(
      options(env.DATABASE_PAPER_ADMISSION_URL),
    );
    const a = await valuation.read(request, io());
    assert.equal(a.kind, 'CAPTURED');
    assert.deepEqual(a.source.book.content, original.source.content);
    assert(a.source.validUntil > Date.now());
    await valuation.close();
    valuation = await createPostgresPaperExecutedValuationSource(
      options(env.DATABASE_PAPER_ADMISSION_URL),
    );
    const b = await valuation.read(request, io());
    assert.equal(b.kind, 'CAPTURED');
    assert.equal(b.source.hash, a.source.hash);
    assert.equal(b.source.validUntil, a.source.validUntil);
    assert.deepEqual(
      (await capturePaperExecutionStartUpgrade(db)).retained.rows,
      before.retained.rows,
      'Readonly compiled captures do not change any row',
    );
    return {
      status: 'PASS',
      pre67Execution: true,
      compiledSource: true,
      restart: true,
      financialRowsUnchanged: true,
    };
  } finally {
    await valuation?.close();
    await book.close();
    await snapshots.close();
  }
}
