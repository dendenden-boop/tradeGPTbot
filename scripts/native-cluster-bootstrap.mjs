// Owned acceptance infrastructure only; never a production runtime authority.
import assert from 'node:assert/strict';
import { inspectOwnedPostgres } from './owned-native-secondary.mjs';
import {
  secondaryNativeProject,
  createNativeClusterIsolation,
} from './native-cluster-isolation.mjs';
import {
  nativeActorRegistrations,
  cloneNativeClusterActors,
  nativeRoleCatalogHash,
} from './native-cluster-actors.mjs';

export async function bootstrapNativeCluster({
  project,
  env,
  nativeEnv,
  databases,
  primaryAdmin,
  connect,
  run,
  prisma,
  config,
  secrets,
  remainingMs,
}) {
  const root = new URL(nativeEnv.DATABASE_MIGRATION_URL),
    port = Number(env.CTP_TEST_SECONDARY_POSTGRES_PORT);
  assert.equal(env.CTP_TEST_SECONDARY_PROJECT, secondaryNativeProject(project));
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535 && port !== Number(root.port));
  nativeActorRegistrations(nativeEnv, { primaryPort: Number(root.port), database: databases[0] });
  const options = { env, secrets, echo: false };
  const primaryIdentity = await inspectOwnedPostgres(project, Number(root.port), options, run);
  const secondaryIdentity = await inspectOwnedPostgres(
    env.CTP_TEST_SECONDARY_PROJECT,
    port,
    options,
    run,
  );
  assert.deepEqual(secondaryIdentity, JSON.parse(env.CTP_TEST_SECONDARY_IDENTITY));
  assert.notEqual(primaryIdentity.containerId, secondaryIdentity.containerId);
  const allowed = new Set([databases[0], databases[6], databases[7], databases[8]]);
  for (const name of allowed) assert.match(name, /^ctp_p2_[a-z0-9_]+_[a-f0-9]{12}$/u);
  assert.equal(allowed.size, 4);
  const urlFor = (name) => {
    assert(allowed.has(name));
    const u = new URL(root);
    u.port = String(port);
    u.pathname = '/' + name;
    return u.href;
  };
  const maintenance = new URL(root);
  maintenance.port = String(port);
  maintenance.pathname = '/ctp_test';
  const secondaryAdmin = connect(maintenance.href, true);
  const reset = new Map();
  async function migrate(name) {
    assert(allowed.has(name));
    const budget = remainingMs();
    assert(budget > 0);
    await run(process.execPath, [prisma, 'migrate', 'deploy', '--config', config], {
      env: { ...env, DATABASE_MIGRATION_URL: urlFor(name) },
      secrets,
      echo: true,
      timeoutMs: Math.min(120000, budget),
    });
    const db = connect(urlFor(name));
    try {
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
          )
        ).rows[0].n,
        // BEGIN PAPER EXECUTED VALUATION SECONDARY_APPLIED_COUNT
        // BEGIN PAPER HISTORICAL INVENTORY SECONDARY_COUNT
        68,
        // END PAPER HISTORICAL INVENTORY SECONDARY_COUNT
        // END PAPER EXECUTED VALUATION SECONDARY_APPLIED_COUNT
      );
    } finally {
      await db.end();
    }
    if (reset.has(name)) reset.set(name, reset.get(name) + 1);
  }
  for (const name of allowed) {
    await secondaryAdmin.query(`CREATE DATABASE "${name}"`);
    await migrate(name);
  }
  const actors = await cloneNativeClusterActors(primaryAdmin, secondaryAdmin, nativeEnv, {
    primaryPort: Number(root.port),
    database: databases[0],
  });
  assert.equal(actors.actors, 32);
  const certificate = await createNativeClusterIsolation({
    primary: primaryAdmin,
    secondary: secondaryAdmin,
    primaryEndpoint: primaryIdentity,
    secondaryEndpoint: secondaryIdentity,
  });
  const before = {
    primary: await nativeRoleCatalogHash(primaryAdmin),
    secondary: await nativeRoleCatalogHash(secondaryAdmin),
  };
  let nativeReset = false;
  function maintenanceFor(name) {
    assert(allowed.has(name));
    return Object.freeze({
      async query(sql) {
        assert(
          sql === `DROP DATABASE "${name}" WITH (FORCE)` || sql === `CREATE DATABASE "${name}"`,
        );
        const result = await secondaryAdmin.query(sql);
        if (sql.startsWith('DROP ')) reset.set(name, 0);
        return result;
      },
    });
  }
  async function resetNativeAdmission() {
    const name = databases[0],
      beforeReset = connect(urlFor(name));
    try {
      assert(
        (await beforeReset.query('SELECT count(*)::int n FROM public.risk_reservation')).rows[0].n >
          0,
      );
    } finally {
      await beforeReset.end();
    }
    await maintenanceFor(name).query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await maintenanceFor(name).query(`CREATE DATABASE "${name}"`);
    await migrate(name);
    await migrate(name);
    const after = connect(urlFor(name));
    try {
      for (const table of [
        'public."order"',
        'public.order_intent',
        'public.risk_decision',
        'public.risk_reservation',
        'public.submission_attempt',
        'public.fill',
        'public.fee',
        'public.ledger_transaction',
        'public.ledger_entry',
        'ctp_portfolio.book',
        'ctp_portfolio.outbox',
        'ctp_portfolio.hold_watermark',
        'ctp_risk.policy_head',
        'ctp_risk.loss_head',
        'ctp_market.snapshot_head',
        'ctp_registry.current_record',
        'ctp_registry.version_history',
      ])
        assert.equal((await after.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
      assert.deepEqual(
        (await after.query('SELECT state,epoch::text FROM ctp_risk.global_head')).rows,
        [{ state: 'PAUSED', epoch: '1' }],
      );
    } finally {
      await after.end();
    }
    nativeReset = true;
  }
  async function verify() {
    assert.deepEqual(
      await inspectOwnedPostgres(project, Number(root.port), options, run),
      primaryIdentity,
    );
    assert.deepEqual(
      await inspectOwnedPostgres(secondaryIdentity.project, port, options, run),
      secondaryIdentity,
    );
    const after = {
      primary: await nativeRoleCatalogHash(primaryAdmin),
      secondary: await nativeRoleCatalogHash(secondaryAdmin),
    };
    assert.deepEqual(after, before);
    for (const [client, identity] of [
      [primaryAdmin, certificate.primary],
      [secondaryAdmin, certificate.secondary],
    ])
      assert.equal(
        (await client.query('SELECT system_identifier::text AS id FROM pg_control_system()'))
          .rows[0].id,
        identity.systemIdentifier,
      );
    return Object.freeze({
      status: 'PASS',
      version: certificate.version,
      primary: certificate.primary,
      secondary: certificate.secondary,
      primaryIdentity,
      secondaryIdentity,
      roleIsolation: certificate.roleIsolation,
      roleCatalogBefore: before,
      roleCatalogAfter: after,
      actors: actors.actors,
      fixedRoleGraphHash: actors.fixedRoleGraphHash,
      independentlyMigratedDatabases: [...allowed],
      // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT
      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT
      migrations: 68,
      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT
      // END PAPER EXECUTED VALUATION MIGRATION_COUNT
      secondaryResets: {
        nativeAdmission: nativeReset ? 'PASS' : 'PENDING',
        admission: (reset.get(databases[6]) ?? 0) >= 2 ? 'PASS' : 'PENDING',
        startedExecution: (reset.get(databases[7]) ?? 0) >= 2 ? 'PASS' : 'PENDING',
      },
    });
  }
  return Object.freeze({
    certificate,
    port,
    project: secondaryIdentity.project,
    migrate,
    maintenanceFor,
    resetNativeAdmission,
    verify,
  });
}
