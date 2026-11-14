import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { capturePaperExecutionStartUpgrade } from './paper-execution-start-upgrade.mjs';
import { verifyPaperHistoricalInventoryStorage } from './paper-historical-inventory-upgrade.mjs';

const tables = [
  'current_loss_baseline',
  'current_loss_checkpoint',
  'current_loss_head',
  'current_loss_seen',
  'current_loss_native_clock',
  'current_risk_certificate',
  'current_risk_head',
];
const functions = [
  'current_evidence_head_monotone',
  'current_loss_project',
  'current_risk_facts',
  'current_loss_economics',
  'current_mark_equity',
  'current_loss_mark',
  'current_loss_opening',
  'current_source_heads',
  'current_loss_advance',
  'current_risk_operation',
  'reconcile_admission_v68',
  'reconcile_admission',
];
export async function verifyPaperCurrentRiskStorage(db, options) {
  await verifyPaperHistoricalInventoryStorage(db, options);
  const storage = (
    await db.query(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolsuper,r.rolbypassrls,
   has_table_privilege('ctp_paper_risk_admission',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) public
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
   WHERE n.nspname='ctp_paper' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
      [tables],
    )
  ).rows;
  assert.deepEqual(
    storage.map((r) => r.relname),
    [...tables].sort(),
  );
  for (const r of storage) {
    assert.equal(r.relrowsecurity, true);
    assert.equal(r.relforcerowsecurity, true);
    assert.equal(r.allowed, false);
    assert.equal(r.public, false);
    if (options.ownership === 'REQUIRE_NON_BYPASS') {
      assert.equal(r.rolsuper, false, r.relname + ': non-superuser owner');
      assert.equal(r.rolbypassrls, false, r.relname + ': non-BYPASSRLS owner');
    }
  }
  const callable = (
    await db.query(
      `SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,
   has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') allowed,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
   WHERE n.nspname='ctp_paper' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,
      [functions],
    )
  ).rows;
  assert.deepEqual(
    callable.map((r) => r.proname),
    [...functions].sort(),
  );
  for (const r of callable) {
    assert.equal(r.public, false, r.proname + ': PUBLIC execute revoked');
    assert.equal(
      r.allowed,
      r.proname === 'reconcile_admission',
      r.proname + ': exact runtime RPC surface',
    );
    assert.equal(
      r.prosecdef,
      ['reconcile_admission', 'reconcile_admission_v68'].includes(r.proname),
      r.proname + ': expected invoker/definer',
    );
    assert(r.proconfig.includes('search_path=pg_catalog'));
    if (options.ownership === 'REQUIRE_NON_BYPASS') {
      assert.equal(r.rolsuper, false, r.proname + ': non-superuser owner');
      assert.equal(r.rolbypassrls, false, r.proname + ': non-BYPASSRLS owner');
    }
  }
  const fks = (
    await db.query(`SELECT c.conrelid::regclass::text name,pg_get_constraintdef(c.oid) definition
   FROM pg_constraint c WHERE c.conrelid IN('ctp_paper.current_loss_head'::regclass,
   'ctp_paper.current_loss_checkpoint'::regclass,'ctp_paper.current_risk_certificate'::regclass) AND c.contype='f'`)
  ).rows;
  assert(
    fks.some(
      (r) =>
        r.name === 'ctp_paper.current_loss_head' &&
        r.definition.includes('revision, id, document_hash'),
    ),
  );
  assert(
    fks.some(
      (r) =>
        r.name === 'ctp_paper.current_loss_checkpoint' &&
        r.definition.includes('previous_day_start_ms, previous_revision, previous_hash'),
    ),
  );
  assert(
    fks.some(
      (r) =>
        r.name === 'ctp_paper.current_risk_certificate' &&
        r.definition.includes('loss_day_start_ms, loss_revision, loss_id, loss_hash'),
    ),
  );
  const clocks = (
    await db.query(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
   WHERE conrelid='ctp_paper.current_loss_native_clock'::regclass AND contype='p'`)
  ).rows;
  assert.deepEqual(clocks, [{ definition: 'PRIMARY KEY (tenant_id, execution_id, native_ms)' }]);
  const sequences = (
    await db.query(`SELECT c.relname,s.seqcycle,
   has_sequence_privilege('ctp_paper_risk_admission',c.oid,'USAGE,SELECT,UPDATE') allowed
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid
   WHERE n.nspname='ctp_paper' AND c.relname IN('current_loss_revision','current_risk_revision') ORDER BY c.relname`)
  ).rows;
  assert.deepEqual(sequences, [
    { relname: 'current_loss_revision', seqcycle: false, allowed: false },
    { relname: 'current_risk_revision', seqcycle: false, allowed: false },
  ]);
  if (options.empty === true)
    for (const name of tables)
      assert.equal((await db.query('SELECT count(*)::int n FROM ctp_paper.' + name)).rows[0].n, 0);
}
export async function verifyPaperCurrentRiskUpgrade(db, before) {
  assert.equal(before.retained.functions.length, 261);
  assert(
    before.retained.rows.some((t) => t.name === '"ctp_paper"."execution_commit"' && t.rows.length),
  );
  const after = await capturePaperExecutionStartUpgrade(db);
  assert.equal(after.retained.functions.length, 272);
  for (const t of before.retained.rows)
    assert.deepEqual(
      after.retained.rows.find((r) => r.name === t.name),
      t,
    );
  assert.deepEqual(
    after.retained.rows.filter((r) => !before.retained.rows.some((t) => t.name === r.name)),
    [...tables].sort().map((name) => ({ name: '"ctp_paper"."' + name + '"', rows: [] })),
  );
  for (const f of before.retained.functions) {
    const expected =
      f.signature === 'ctp_paper.reconcile_admission(jsonb)'
        ? {
            signature: 'ctp_paper.reconcile_admission_v68(jsonb)',
            definition: f.definition.replace('(p jsonb)', '_v68(p jsonb)'),
          }
        : f;
    assert.deepEqual(
      after.retained.functions.find((r) => r.signature === expected.signature),
      expected,
    );
  }
  for (const f of before.security) {
    const current = after.security.find((r) => r.oid === f.oid);
    assert(current);
    assert.deepEqual(current, {
      ...f,
      proname: f.proname === 'reconcile_admission' ? 'reconcile_admission_v68' : f.proname,
      acl: f.proname === 'reconcile_admission' ? current.acl : f.acl,
    });
  }
  await verifyPaperCurrentRiskStorage(db, { ownership: 'REQUIRE_NON_BYPASS' });
}
export async function verifyCompiledCurrentRisk(db, env) {
  const { createPostgresPaperCurrentRiskCoordinator } =
      await import('../packages/paper-engine/dist/risk.js'),
    { createPostgresPaperRuntimeObservations, paperRuntimeDependencies } =
      await import('../packages/paper-engine/dist/runtime.js'),
    { createPostgresMarketSnapshots, createPostgresMarketTrades } =
      await import('../packages/market-data/dist/index.js');
  const x = (
    await db.query(
      'SELECT request,authorization_epochs,source FROM ctp_paper.execution_commit ORDER BY tenant_id,execution_key LIMIT 1',
    )
  ).rows[0];
  assert(x);
  const request = {
      ...x.request,
      authorization: x.authorization_epochs,
      kind: 'PAPER_CURRENT_RISK_CERTIFY',
    },
    owner = {
      tenantId: request.admission.binding.tenantId,
      accountId: request.admission.binding.accountId,
      mode: 'PAPER',
    },
    options = { connectionString: env.DATABASE_PAPER_ADMISSION_URL, environment: 'test' },
    io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
  const snapshots = await createPostgresMarketSnapshots({
      connectionString: env.DATABASE_MARKET_SNAPSHOT_URL,
      environment: 'test',
    }),
    trades = await createPostgresMarketTrades({
      connectionString: env.DATABASE_MARKET_TRADE_URL,
      environment: 'test',
    }),
    runtime = await createPostgresPaperRuntimeObservations({
      connectionString: env.DATABASE_PAPER_RUNTIME_OBSERVER_URL,
      environment: 'test',
    });
  let coordinator;
  try {
    const nativeId = x.source.started.capture.market.snapshot.id,
      native = (
        await db.query(
          `SELECT s.payload,h.revision::text revision FROM ctp_market.snapshot_head h
       JOIN ctp_market.snapshot_event s ON s.id=h.native WHERE h.key=(SELECT key FROM ctp_market.snapshot_event WHERE id=$1)`,
          [nativeId],
        )
      ).rows[0];
    assert(native);
    const snapshot = JSON.parse(native.payload),
      retainedTrade = (
        await db.query(
          `SELECT e.payload,h.revision::text revision FROM ctp_market.trade_head h
       JOIN ctp_market.trade_event e ON e.id=h.native WHERE h.key=($1::jsonb-'dbRuleId')`,
          [JSON.stringify(snapshot.key)],
        )
      ).rows[0];
    assert(retainedTrade);
    // Test-only retained template, not current evidence. The fixed public
    // publisher must accept a new sequenced fixture observation below; no old
    // trade reader or historical source has its lease renewed by this helper.
    const tradeHead = { revision: retainedTrade.revision },
      trade = JSON.parse(retainedTrade.payload);
    assert(trade);
    const now = Date.now();
    snapshot.id = randomUUID();
    snapshot.expectedRevision = native.revision;
    snapshot.timestamp = now;
    for (const v of [snapshot.book, snapshot.ticker]) v.receivedAt = v.exchangeTime = now;
    if (snapshot.book.sourceSequence !== null)
      snapshot.book.sourceSequence = (
        BigInt(snapshot.book.sourceSequence) +
        BigInt(native.revision) +
        1n
      ).toString();
    assert.equal((await snapshots.publish(snapshot, io())).status, 'APPLIED');
    // This is a new synthetic fixture observation under the proven current
    // metadata, not reinterpretation of the retained immutable trade receipt.
    trade.key = globalThis.structuredClone(snapshot.key);
    trade.record = globalThis.structuredClone(snapshot.record);
    trade.id = randomUUID();
    trade.expectedRevision = tradeHead.revision;
    trade.timestamp = Date.now();
    trade.trade.tradeId = 'compiled-current-' + randomUUID();
    trade.trade.receivedAt = trade.trade.exchangeTime = trade.timestamp;
    if (trade.trade.sourceSequence !== null)
      trade.trade.sourceSequence = (
        BigInt(trade.trade.sourceSequence) +
        BigInt(tradeHead.revision) +
        1n
      ).toString();
    assert.equal((await trades.publish(trade, io())).status, 'APPLIED');
    const context = await runtime.context(owner, io()),
      head = await runtime.head(owner, io());
    await runtime.publish(
      {
        id: randomUUID(),
        expectedRevision: head?.revision ?? '0',
        observation: {
          owner,
          configurationId: context.configuration.configuration.id,
          configurationHash: context.configurationHash,
          permissionEpoch: context.current.permissionEpoch,
          userSessionEpoch: context.current.userSessionEpoch,
          accountVersion: context.current.accountVersion,
          health: Object.fromEntries(
            paperRuntimeDependencies.map((k) => [
              k,
              { sourceId: 'compiled-current:' + k, asOf: Date.now(), status: 'HEALTHY' },
            ]),
          ),
        },
      },
      io(),
    );
    const before = await capturePaperExecutionStartUpgrade(db);
    coordinator = await createPostgresPaperCurrentRiskCoordinator(options);
    const first = await coordinator.certify(request, io());
    assert.equal(first.loss.complete, true);
    assert.equal(first.scope.dbRuleId, snapshot.key.dbRuleId);
    assert.equal(first.loss.actualEquity, first.inventory.valuation.equity);
    assert(!('grant' in first));
    assert(!('permit' in first));
    await coordinator.close();
    coordinator = await createPostgresPaperCurrentRiskCoordinator(options);
    assert.deepEqual(await coordinator.readCurrent(request, io()), first);
    assert.deepEqual(await coordinator.certify(request, io()), first);
    const after = await capturePaperExecutionStartUpgrade(db);
    for (const table of before.retained.rows.filter(
      (r) => !tables.some((t) => r.name === '"ctp_paper"."' + t + '"'),
    ))
      assert.deepEqual(
        after.retained.rows.find((r) => r.name === table.name),
        table,
      );
    return {
      status: 'PASS',
      pre69Execution: true,
      compiledSource: true,
      restart: true,
      finiteLease: true,
      currentRulesValidated: true,
      financialRowsUnchanged: true,
    };
  } finally {
    await coordinator?.close();
    await runtime.close();
    await trades.close();
    await snapshots.close();
  }
}
