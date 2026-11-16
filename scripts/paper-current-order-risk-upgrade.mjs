import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { capturePaperExecutionStartUpgrade } from './paper-execution-start-upgrade.mjs';
import { verifyPaperCurrentRiskMarketStorage } from './paper-current-risk-market-upgrade.mjs';
import { verifyCompiledCurrentRisk } from './paper-current-risk-upgrade.mjs';

const names = [
  'current_order_target',
  'current_order_inventory',
  'current_order_facts_base',
  'current_order_facts',
  'current_order_certificate',
  'current_order_risk_operation',
  'reconcile_admission_v70',
  'reconcile_admission',
];
export async function verifyPaperCurrentOrderRiskStorage(db, options) {
  await verifyPaperCurrentRiskMarketStorage(db, options);
  const rows = (
    await db.query(
      `SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,
   has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') allowed,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
   WHERE n.nspname='ctp_paper' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,
      [names],
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.proname),
    [...names].sort(),
  );
  for (const r of rows) {
    assert.equal(r.allowed, r.proname === 'reconcile_admission');
    assert.equal(r.public, false);
    assert.equal(
      r.prosecdef,
      ['current_order_inventory', 'reconcile_admission_v70', 'reconcile_admission'].includes(
        r.proname,
      ),
    );
    assert(r.proconfig.includes('search_path=pg_catalog'));
    if (options.ownership === 'REQUIRE_NON_BYPASS') {
      assert.equal(r.rolsuper, false);
      assert.equal(r.rolbypassrls, false);
    }
  }
}
export async function verifyPaperCurrentOrderRiskUpgrade(db, before) {
  assert.equal(before.retained.functions.length, 273);
  assert(
    before.retained.rows.some(
      (t) => t.name === '"ctp_paper"."current_risk_certificate"' && t.rows.length,
    ),
  );
  const after = await capturePaperExecutionStartUpgrade(db);
  assert.equal(after.retained.functions.length, 280);
  assert.deepEqual(
    after.retained.rows,
    before.retained.rows,
    'No financial row, old certificate or loss checkpoint is rewritten',
  );
  for (const f of before.retained.functions) {
    const expected =
      f.signature === 'ctp_paper.reconcile_admission(jsonb)'
        ? {
            signature: 'ctp_paper.reconcile_admission_v70(jsonb)',
            definition: f.definition.replace(
              'FUNCTION ctp_paper.reconcile_admission(',
              'FUNCTION ctp_paper.reconcile_admission_v70(',
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
      proname: f.proname === 'reconcile_admission' ? 'reconcile_admission_v70' : f.proname,
      acl: f.proname === 'reconcile_admission' ? current.acl : f.acl,
    });
  }
  await verifyPaperCurrentOrderRiskStorage(db, { ownership: 'REQUIRE_NON_BYPASS' });
}
async function publishCurrentFixtureEvidence(db, env, source) {
  const { createPostgresMarketSnapshots, createPostgresMarketTrades } =
      await import('../packages/market-data/dist/index.js'),
    { createPostgresPaperRuntimeObservations, paperRuntimeDependencies } =
      await import('../packages/paper-engine/dist/runtime.js');
  const options = (connectionString) => ({ connectionString, environment: 'test' }),
    io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
  const snapshots = await createPostgresMarketSnapshots(options(env.DATABASE_MARKET_SNAPSHOT_URL)),
    trades = await createPostgresMarketTrades(options(env.DATABASE_MARKET_TRADE_URL)),
    runtime = await createPostgresPaperRuntimeObservations(
      options(env.DATABASE_PAPER_RUNTIME_OBSERVER_URL),
    );
  try {
    const row = (
      await db.query(
        `SELECT e.payload,h.revision::text revision FROM ctp_paper.execution_commit x
      JOIN ctp_market.snapshot_event original ON original.id=(x.source->'started'->'capture'->'market'->'snapshot'->>'id')::uuid
      JOIN ctp_market.snapshot_head h ON h.key=original.key JOIN ctp_market.snapshot_event e ON e.id=h.native
      WHERE x.tenant_id=$1 AND x.execution_key=$2`,
        [source.admission.binding.tenantId, source.executionKey],
      )
    ).rows[0];
    assert(row);
    const p = JSON.parse(row.payload);
    const retained = (
      await db.query(
        `SELECT e.payload,h.revision::text revision FROM ctp_market.trade_head h
      JOIN ctp_market.trade_event e ON e.id=h.native WHERE h.key=($1::jsonb-'dbRuleId')`,
        [JSON.stringify(p.key)],
      )
    ).rows[0];
    assert(retained);
    p.id = randomUUID();
    p.expectedRevision = row.revision;
    p.timestamp = Date.now();
    for (const v of [p.book, p.ticker]) v.receivedAt = v.exchangeTime = p.timestamp;
    if (p.book.sourceSequence !== null)
      p.book.sourceSequence = (
        BigInt(p.book.sourceSequence) +
        BigInt(row.revision) +
        1n
      ).toString();
    assert.equal((await snapshots.publish(p, io())).status, 'APPLIED');
    const trade = JSON.parse(retained.payload);
    trade.id = randomUUID();
    trade.key = globalThis.structuredClone(p.key);
    trade.record = globalThis.structuredClone(p.record);
    trade.expectedRevision = retained.revision;
    trade.timestamp = Date.now();
    trade.trade.tradeId = 'compiled-current-order-' + randomUUID();
    trade.trade.receivedAt = trade.trade.exchangeTime = trade.timestamp;
    if (trade.trade.sourceSequence !== null)
      trade.trade.sourceSequence = (
        BigInt(trade.trade.sourceSequence) +
        BigInt(retained.revision) +
        1n
      ).toString();
    assert.equal((await trades.publish(trade, io())).status, 'APPLIED');
    const owner = {
        tenantId: source.admission.binding.tenantId,
        accountId: source.admission.binding.accountId,
        mode: 'PAPER',
      },
      context = await runtime.context(owner, io()),
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
              { sourceId: 'compiled-current-order:' + k, asOf: Date.now(), status: 'HEALTHY' },
            ]),
          ),
        },
      },
      io(),
    );
  } finally {
    await runtime.close();
    await trades.close();
    await snapshots.close();
  }
}
export async function verifyCompiledCurrentOrderRisk(db, env) {
  // Publish genuine fresh fixture observations through the existing fixed
  // sources after upgrade/redeploy, before creating the new durable target.
  assert.equal((await verifyCompiledCurrentRisk(db, env)).status, 'PASS');
  const { createPostgresPaperCurrentOrderRiskSource, createPostgresPaperCurrentRiskCoordinator } =
      await import('../packages/paper-engine/dist/risk.js'),
    { createPostgresOrderStore } = await import('../packages/order-engine/dist/index.js');
  const x = (
    await db.query(`SELECT x.request,x.authorization_epochs,c.binding,c.draft,native.payload current_market
   FROM ctp_paper.execution_commit x JOIN ctp_execution.command c ON c."tenantId"=x.tenant_id AND c."intentId"=x.intent_id
   JOIN ctp_market.snapshot_event original ON original.id=(x.source->'started'->'capture'->'market'->'snapshot'->>'id')::uuid
   JOIN ctp_market.snapshot_head h ON h.key=original.key JOIN ctp_market.snapshot_event native ON native.id=h.native
   ORDER BY x.tenant_id,x.execution_key LIMIT 1`)
  ).rows[0];
  assert(x);
  const source = {
      ...x.request,
      authorization: x.authorization_epochs,
      kind: 'PAPER_CURRENT_RISK_CERTIFY',
    },
    binding = JSON.parse(x.binding),
    draft = JSON.parse(x.draft),
    currentMarket = JSON.parse(x.current_market),
    options = { connectionString: env.DATABASE_PAPER_ADMISSION_URL, environment: 'test' },
    io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
  const store = await createPostgresOrderStore({
    connectionString: env.DATABASE_EXECUTION_URL,
    environment: 'test',
  });
  let reader, old;
  try {
    // The retained v1 draft proves original history, not current admission.
    // Earlier populated-upgrade probes intentionally publish genuine v2 rules.
    // Create the new target against those actual current metadata IDs/versions.
    assert.equal(currentMarket.key.dbInstrumentId, draft.dbInstrumentId);
    const target = await store.create(
      binding,
      {
        ...draft,
        key: randomUUID(),
        dbRuleId: currentMarket.key.dbRuleId,
        order: { ...draft.order, ruleVersion: currentMarket.record.rules.version },
      },
      io(),
    );
    const wire = (
      await db.query(
        'SELECT encode("commandHash",\'hex\') hash FROM ctp_execution.command WHERE "tenantId"=$1 AND "intentId"=$2',
        [binding.tenantId, target.intentId],
      )
    ).rows[0];
    assert(wire);
    const request = {
      kind: 'PAPER_CURRENT_ORDER_RISK_CAPTURE',
      source,
      target: { orderId: target.id, intentId: target.intentId, commandHash: wire.hash },
    };
    old = await createPostgresPaperCurrentRiskCoordinator(options);
    await assert.rejects(old.certify(source, io()));
    // Preparation and complete preservation snapshots are not trading time.
    // Publish actual new sequenced observations after the target exists; never
    // renew retained source timestamps or extend any runtime evidence deadline.
    await publishCurrentFixtureEvidence(db, env, source);
    const before = await capturePaperExecutionStartUpgrade(db);
    reader = await createPostgresPaperCurrentOrderRiskSource(options);
    const value = await reader.capture(request, io());
    assert.equal(value.evaluation.result.kind, 'EVALUATED');
    assert.equal(value.target.orderId, target.id);
    assert.equal(value.certificate.snapshot.ordersInLastMinute, 2);
    for (const k of ['grant', 'permit', 'reservationId']) assert(!(k in value));
    await reader.close();
    reader = await createPostgresPaperCurrentOrderRiskSource(options);
    const replay = await reader.readCurrent(request, io());
    assert.deepEqual(replay.certificate, value.certificate);
    assert.deepEqual(replay.target, value.target);
    const after = await capturePaperExecutionStartUpgrade(db);
    for (const row of before.retained.rows.filter(
      (r) => !r.name.startsWith('"ctp_paper"."current_'),
    ))
      assert.deepEqual(
        after.retained.rows.find((r) => r.name === row.name),
        row,
      );
    return {
      status: 'PASS',
      compiledSource: true,
      durableTarget: true,
      restart: true,
      finiteLease: true,
      financialRowsUnchanged: true,
      oldReaderStillRejects: true,
    };
  } finally {
    await reader?.close();
    await old?.close();
    await store.close();
  }
}
