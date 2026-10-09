import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, report, workspace } from './docker-test-utils.mjs';
import { prepareAuditUpgrade, verifyAuditUpgrade } from './test-database-audit-upgrade.mjs';
import { exerciseAuthDatabaseHardening } from './test-auth-database-hardening.mjs';
import { preparePortfolioUpgrade, verifyPortfolioUpgrade } from './portfolio-upgrade.mjs';

const expectedMigrations = [
  '202609070001_initial',
  '202609070002_integrity',
  '202609090001_audit_integrity',
  '202609140001_authentication',
  '202609200001_auth_hardening',
  '202610040001_market_data',
  '202610040002_portfolio',
  '202610050001_portfolio_hold_ordering',
  '202610050002_order_engine',
  '202610050003_risk_controls',
  '202610050004_risk_policies',
  '202610060001_risk_loss_journal',
  '202610060002_market_snapshots',
  '202610070001_deferred_transport_permit',
  '202610070002_risk_portfolio_source',
  '202610070003_runtime_instrument_registry',
  '202610070004_portfolio_capture_inventory',
  '202610070005_risk_snapshot_certification',
  '202610080001_atomic_risk_admission',
  '202610080002_risk_reservation_lifecycle',
  '202610080003_risk_residual_collateral',
  '202610080004_current_risk_dispatch',
  '202610080005_issued_hold_authority',
  '202610080006_legacy_native_evidence_recovery',
  '202610080007_bounded_registry_recovery',
  '202610080008_require_certified_dispatch',
  '202610080009_immutable_amend_intent',
  '202610080010_native_identity_authority',
  '202610080011_certified_native_controls',
  '202610080012_native_amend_dispatch',
  '202610080013_native_amend_application',
  '202610080014_native_amend_identity_type',
  '202610090001_native_amend_source_clock',
  '202610090002_certified_native_cancel',
  '202610090003_paper_configuration',
  '202610090004_paper_configuration_seal',
];

const project = process.env.CTP_TEST_PROJECT;
if (
  process.env.NODE_ENV !== 'test' ||
  !project ||
  !/^ctp-integration-\d{1,16}-[a-f0-9]{12}$/.test(project)
) {
  throw new Error('Database tests require the isolated integration runner');
}
let adminUrl;
try {
  adminUrl = new URL(process.env.DATABASE_MIGRATION_URL);
} catch {
  throw new Error('Database runner requires the owned loopback PostgreSQL service');
}
if (
  !['postgres:', 'postgresql:'].includes(adminUrl.protocol) ||
  adminUrl.hostname !== '127.0.0.1' ||
  adminUrl.pathname !== '/ctp_test' ||
  adminUrl.username !== 'ctp_test' ||
  !/^[a-f0-9]{48}$/.test(adminUrl.password) ||
  !/^\d{1,5}$/.test(adminUrl.port) ||
  Number(adminUrl.port) < 1 ||
  Number(adminUrl.port) > 65535 ||
  adminUrl.search !== '' ||
  adminUrl.hash !== ''
) {
  throw new Error('Database runner requires the owned loopback PostgreSQL service');
}
const databaseRequire = createRequire(
  new URL('../packages/database/package.json', import.meta.url),
);
const { Pool } = databaseRequire('pg');
const password = randomBytes(24).toString('hex');
const ownerPassword = randomBytes(24).toString('hex');
const authPassword = randomBytes(24).toString('hex');
const ingestPassword = randomBytes(24).toString('hex');
const portfolioPassword = randomBytes(24).toString('hex');
const executionPassword = randomBytes(24).toString('hex');
const riskControlPassword = randomBytes(24).toString('hex');
const riskOperatorPassword = randomBytes(24).toString('hex');
const policyOperatorPassword = randomBytes(24).toString('hex');
const policyControllerPassword = randomBytes(24).toString('hex');
const evidencePassword = randomBytes(24).toString('hex');
const snapshotPassword = randomBytes(24).toString('hex');
const riskSnapshotPassword = randomBytes(24).toString('hex');
const registryPassword = randomBytes(24).toString('hex');
const certificationPassword = randomBytes(24).toString('hex');
const observationPassword = randomBytes(24).toString('hex');
const admissionPassword = randomBytes(24).toString('hex');
const paperConfigurationPassword = randomBytes(24).toString('hex');
const secrets = [
  decodeURIComponent(adminUrl.password),
  password,
  ownerPassword,
  authPassword,
  ingestPassword,
  portfolioPassword,
  executionPassword,
  riskControlPassword,
  riskOperatorPassword,
  policyOperatorPassword,
  policyControllerPassword,
  evidencePassword,
  snapshotPassword,
  riskSnapshotPassword,
  registryPassword,
  certificationPassword,
  observationPassword,
  admissionPassword,
  paperConfigurationPassword,
];
const suffix = randomBytes(6).toString('hex');
const databases = [
  `ctp_p2_fresh_${suffix}`,
  `ctp_p2_upgrade_${suffix}`,
  `ctp_p2_owner_${suffix}`,
  `ctp_p2_lifecycle_${suffix}`,
  `ctp_p2_paper_upgrade_${suffix}`,
];
const runtimeRole = `ctp_p2_runtime_${suffix}`;
const ownerRole = `ctp_p2_owner_${suffix}`;
const authRole = `ctp_p2_auth_${suffix}`;
const ingestRole = `ctp_p2_ingest_${suffix}`;
const portfolioRole = `ctp_p2_portfolio_${suffix}`;
const executionRole = `ctp_p2_execution_${suffix}`;
const riskControlRole = `ctp_p2_risk_control_${suffix}`;
const riskOperatorRole = `ctp_p2_risk_operator_${suffix}`;
const policyOperatorRole = `ctp_p2_policy_operator_${suffix}`;
const policyControllerRole = `ctp_p2_policy_controller_${suffix}`;
const evidenceRole = `ctp_p2_evidence_${suffix}`;
const snapshotRole = `ctp_p2_snapshot_${suffix}`;
const riskSnapshotRole = `ctp_p2_risk_snapshot_${suffix}`;
const registryRole = `ctp_p2_registry_${suffix}`;
const certificationRole = `ctp_p2_certification_${suffix}`;
const observationRole = `ctp_p2_observation_${suffix}`;
const admissionRole = `ctp_p2_admission_${suffix}`;
const paperConfigurationRole = `ctp_p2_paper_config_${suffix}`;
const identifier = (name) => {
  if (!/^ctp_p2_[a-z0-9_]+$/.test(name)) throw new Error('Refusing unrelated database object');
  return `"${name}"`;
};
const prisma = databaseRequire.resolve('prisma/build/index.js');
const config = 'packages/database/prisma.config.ts';
const startedAt = new Date().toISOString();
let outcome = { status: 'FAIL', startedAt, project };
const pools = new Set();
const connect = (url, maintenance = false) => {
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 1000,
    // CREATE/DROP DATABASE can wait for a physical checkpoint on persistent storage.
    // Bound maintenance on the server as well; runtime/query acceptance budgets stay separate.
    query_timeout: maintenance ? 31_000 : 5000,
    ...(maintenance ? { statement_timeout: 30_000 } : {}),
  });
  pool.on('error', () => {});
  pools.add(pool);
  return pool;
};
const admin = connect(adminUrl.href, true);
const dbUrl = (
  name,
  runtime = false,
  owner = false,
  auth = false,
  ingest = false,
  portfolio = false,
  execution = false,
) => {
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  if (runtime) {
    url.username = runtimeRole;
    url.password = password;
  }
  if (owner) {
    url.username = ownerRole;
    url.password = ownerPassword;
  }
  if (auth) {
    url.username = authRole;
    url.password = authPassword;
  }
  if (ingest) {
    url.username = ingestRole;
    url.password = ingestPassword;
  }
  if (portfolio) {
    url.username = portfolioRole;
    url.password = portfolioPassword;
  }
  if (execution) {
    url.username = executionRole;
    url.password = executionPassword;
  }
  return url.href;
};
const controlUrl = (name, global = false) => {
  const url = new URL(dbUrl(name));
  url.username = global ? riskOperatorRole : riskControlRole;
  url.password = global ? riskOperatorPassword : riskControlPassword;
  return url.href;
};
const policyUrl = (name, platform = false) => {
  const url = new URL(dbUrl(name));
  url.username = platform ? policyOperatorRole : policyControllerRole;
  url.password = platform ? policyOperatorPassword : policyControllerPassword;
  return url.href;
};
const evidenceUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = evidenceRole;
  url.password = evidencePassword;
  return url.href;
};
const snapshotUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = snapshotRole;
  url.password = snapshotPassword;
  return url.href;
};
const riskSnapshotUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = riskSnapshotRole;
  url.password = riskSnapshotPassword;
  return url.href;
};
const registryUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = registryRole;
  url.password = registryPassword;
  return url.href;
};
const certificationUrl = (name, observer = false) => {
  const url = new URL(dbUrl(name));
  url.username = observer ? observationRole : certificationRole;
  url.password = observer ? observationPassword : certificationPassword;
  return url.href;
};
const admissionUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = admissionRole;
  url.password = admissionPassword;
  return url.href;
};
const paperConfigurationUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperConfigurationRole;
  url.password = paperConfigurationPassword;
  return url.href;
};
const migrate = async (name, selectedConfig = config, owner = false) => {
  try {
    return await run(process.execPath, [prisma, 'migrate', 'deploy', '--config', selectedConfig], {
      env: { ...process.env, DATABASE_MIGRATION_URL: dbUrl(name, false, owner) },
      secrets,
      echo: true,
    });
  } catch (error) {
    // Prisma can mask a script error after BEGIN with "transaction is aborted".
    // Diagnose the failed SQL only on this disposable DB, then ALWAYS roll it back.
    const diagnostic = connect(dbUrl(name));
    try {
      const failed = await diagnostic.query(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at DESC LIMIT 1',
      );
      const migration = failed.rows[0]?.migration_name;
      if (!expectedMigrations.includes(migration)) throw error;
      const script = (
        await readFile(
          path.join(workspace, 'packages/database/prisma/migrations', migration, 'migration.sql'),
          'utf8',
        )
      )
        .replace(/^BEGIN;$/m, '')
        .replace(/COMMIT;\s*$/, '');
      await diagnostic.query('BEGIN');
      try {
        await diagnostic.query(script);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'SQL migration error';
        console.error(
          secrets.reduce(
            (s, secret) => s.replaceAll(secret, '[REDACTED]'),
            `Migration diagnostic: ${message}`,
          ),
        );
      } finally {
        await diagnostic.query('ROLLBACK');
      }
    } catch {
      /* Preserve the original migration failure when diagnostics are unavailable. */
    }
    throw error;
  }
};

try {
  await report('auth-database-hardening', { status: 'RUNNING', startedAt, project });
  // Verify the destination port against the exact owned Compose project before creating any DB.
  const port = await run(
    'docker',
    [
      'compose',
      '--env-file',
      '.env.example',
      '-f',
      'infra/compose.test.yml',
      '--project-name',
      project,
      'port',
      'postgres',
      '5432',
    ],
    { secrets },
  );
  assert.equal(port.trim(), `127.0.0.1:${adminUrl.port}`);
  await admin.query(
    `CREATE ROLE ${identifier(ownerRole)} LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOBYPASSRLS PASSWORD '${ownerPassword}'`,
  );
  for (const name of databases) {
    await admin.query(
      `CREATE DATABASE ${identifier(name)}${name === databases[2] || name === databases[4] ? ` OWNER ${identifier(ownerRole)}` : ''}`,
    );
  }
  await migrate(databases[0]);
  await migrate(databases[0]);
  await admin.query(
    `CREATE ROLE ${identifier(runtimeRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  await admin.query(`GRANT ctp_api TO ${identifier(runtimeRole)}`);
  await admin.query(
    `CREATE ROLE ${identifier(authRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${authPassword}'`,
  );
  await admin.query(`GRANT ctp_auth TO ${identifier(authRole)}`);
  await admin.query(
    `CREATE ROLE ${identifier(ingestRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${ingestPassword}'`,
  );
  await admin.query(`GRANT ctp_ingest TO ${identifier(ingestRole)}`);
  await admin.query(
    `CREATE ROLE ${identifier(portfolioRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${portfolioPassword}'`,
  );
  await admin.query(`GRANT ctp_portfolio TO ${identifier(portfolioRole)}`);
  await admin.query(
    `CREATE ROLE ${identifier(executionRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${executionPassword}'`,
  );
  await admin.query(`GRANT ctp_execution TO ${identifier(executionRole)}`);
  for (const [role, secret, group] of [
    [riskControlRole, riskControlPassword, 'ctp_risk_control'],
    [riskOperatorRole, riskOperatorPassword, 'ctp_risk_operator'],
    [policyOperatorRole, policyOperatorPassword, 'ctp_risk_policy_operator'],
    [policyControllerRole, policyControllerPassword, 'ctp_risk_policy_controller'],
    [evidenceRole, evidencePassword, 'ctp_risk_evidence_collector'],
    [snapshotRole, snapshotPassword, 'ctp_market_snapshot'],
    [riskSnapshotRole, riskSnapshotPassword, 'ctp_risk_snapshot_reader'],
    [registryRole, registryPassword, 'ctp_instrument_registry'],
    [certificationRole, certificationPassword, 'ctp_risk_certifier'],
    [observationRole, observationPassword, 'ctp_risk_observer'],
    [admissionRole, admissionPassword, 'ctp_risk_admission'],
    [paperConfigurationRole, paperConfigurationPassword, 'ctp_paper_configuration'],
  ]) {
    await admin.query(
      `CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${secret}'`,
    );
    await admin.query(`GRANT ${group} TO ${identifier(role)}`);
  }
  // Cluster roles outlive databases. PostgreSQL 17 requires existing role SET
  // membership before a different non-super DDL owner can transfer functions.
  await admin.query(`GRANT ctp_auth_owner TO ${identifier(ownerRole)}`);
  const fresh = connect(dbUrl(databases[0]));
  assert.deepEqual((await fresh.query('SELECT state,epoch::text FROM ctp_risk.global_head')).rows, [
    { state: 'PAUSED', epoch: '1' },
  ]);
  assert.equal(
    (await fresh.query('SELECT count(*)::int n FROM ctp_risk.policy_head')).rows[0].n,
    0,
  );
  assert.equal((await fresh.query('SELECT count(*)::int n FROM ctp_risk.loss_head')).rows[0].n, 0);
  assert.equal(
    (await fresh.query('SELECT count(*)::int n FROM ctp_market.snapshot_head')).rows[0].n,
    0,
  );
  assert.equal(
    (
      await fresh.query(
        'SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      )
    ).rows[0].n,
    expectedMigrations.length,
  );

  await mkdir(path.join(workspace, '.cache'), { recursive: true });
  const prior = await mkdtemp(path.join(workspace, '.cache', 'db-upgrade-'));
  const previousMigrations = path.join(prior, 'migrations');
  await mkdir(previousMigrations);
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations/202609070001_initial'),
    path.join(previousMigrations, '202609070001_initial'),
    { recursive: true },
  );
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations/migration_lock.toml'),
    path.join(previousMigrations, 'migration_lock.toml'),
  );
  const previousConfig = path.join(prior, 'prisma.config.mjs');
  await writeFile(
    previousConfig,
    `import {defineConfig} from ${JSON.stringify(pathToFileURL(databaseRequire.resolve('prisma/config')).href)};\nexport default defineConfig({schema:${JSON.stringify(path.join(workspace, 'packages/database/prisma/schema.prisma'))},migrations:{path:${JSON.stringify(previousMigrations)}},datasource:{url:process.env.DATABASE_MIGRATION_URL}});\n`,
  );
  await migrate(databases[1], previousConfig);
  const upgrade = connect(dbUrl(databases[1]));
  const marker = randomUUID();
  const upgradeAccount = randomUUID();
  const upgradePosting = randomUUID();
  await upgrade.query(
    'INSERT INTO "user" (id,"emailNormalized",status,"updatedAt") VALUES ($1,$2,\'SUSPENDED\',now())',
    [marker, 'upgrade@example.invalid'],
  );
  // These records were committed using migration 001, before deferred ledger
  // validation existed. Migration 002 must preserve and seal the old posting.
  await upgrade.query(
    `INSERT INTO exchange_account
      (id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,
       "clientIdEpoch","updatedAt")
     VALUES ($1::uuid,$2,'BINANCE','PAPER',$1::text,'development','SIMULATED','DISABLED',
       'upgrade-fixture',now())`,
    [upgradeAccount, marker],
  );
  await upgrade.query('BEGIN');
  try {
    await upgrade.query(
      `INSERT INTO ledger_transaction
        (id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode")
       VALUES ($1::uuid,$2,$3,'PAPER','ADJUSTMENT',$1::text,now(),'upgrade-fixture')`,
      [upgradePosting, marker, upgradeAccount],
    );
    await upgrade.query(
      `INSERT INTO ledger_entry
        ("tenantId","transactionId","accountId",mode,"entryIndex",asset,bucket,amount)
       VALUES ($1,$2,$3,'PAPER',0,'USDT','AVAILABLE',1.000000000000000001),
         ($1,$2,$3,'PAPER',1,'USDT','EQUITY',-1.000000000000000001)`,
      [marker, upgradePosting, upgradeAccount],
    );
    await upgrade.query('COMMIT');
  } catch (error) {
    await upgrade.query('ROLLBACK');
    throw error;
  }
  // First upgrade the original data with the exact published migration 002.
  // Then exercise 002 -> 003 using both valid and deliberately invalid old links.
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations/202609070002_integrity'),
    path.join(previousMigrations, '202609070002_integrity'),
    { recursive: true },
  );
  await migrate(databases[1], previousConfig);
  const auditUpgradeIds = await prepareAuditUpgrade(
    upgrade,
    path.join(
      workspace,
      'packages/database/prisma/migrations/202609090001_audit_integrity/migration.sql',
    ),
  );
  // Reproduce the original auth behavior using the exact published 003/004 SQL,
  // before deploying 005 to this independent owned upgrade database.
  const authPrior = await mkdtemp(path.join(workspace, '.cache', 'db-auth-upgrade-'));
  const authPreviousMigrations = path.join(authPrior, 'migrations');
  await cp(previousMigrations, authPreviousMigrations, { recursive: true });
  const authPreviousConfig = path.join(authPrior, 'prisma.config.mjs');
  await writeFile(
    authPreviousConfig,
    `import {defineConfig} from ${JSON.stringify(pathToFileURL(databaseRequire.resolve('prisma/config')).href)};\nexport default defineConfig({schema:${JSON.stringify(path.join(workspace, 'packages/database/prisma/schema.prisma'))},migrations:{path:${JSON.stringify(authPreviousMigrations)}},datasource:{url:process.env.DATABASE_MIGRATION_URL}});\n`,
  );
  for (const migration of ['202609090001_audit_integrity', '202609140001_authentication']) {
    await cp(
      path.join(workspace, 'packages/database/prisma/migrations', migration),
      path.join(authPreviousMigrations, migration),
      { recursive: true },
    );
  }
  await migrate(databases[1], authPreviousConfig);
  const authHardeningBefore = await exerciseAuthDatabaseHardening({
    admin: upgrade,
    adminUrl: dbUrl(databases[1]),
    authUrl: dbUrl(databases[1], false, false, true),
    stage: 'published004',
  });
  for (const migration of [
    '202609200001_auth_hardening',
    '202610040001_market_data',
    '202610040002_portfolio',
  ]) {
    await cp(
      path.join(workspace, 'packages/database/prisma/migrations', migration),
      path.join(authPreviousMigrations, migration),
      { recursive: true },
    );
  }
  await migrate(databases[1], authPreviousConfig);
  const portfolioUpgrade = await preparePortfolioUpgrade(upgrade, marker, upgradeAccount);
  await cp(
    path.join(
      workspace,
      'packages/database/prisma/migrations/202610050001_portfolio_hold_ordering',
    ),
    path.join(authPreviousMigrations, '202610050001_portfolio_hold_ordering'),
    { recursive: true },
  );
  await migrate(databases[1], authPreviousConfig);
  await verifyPortfolioUpgrade(upgrade, portfolioUpgrade);
  const priorCounter = (
    await upgrade.query(
      'SELECT "clientIdHighWatermark"::text AS counter FROM exchange_account WHERE id=$1',
      [upgradeAccount],
    )
  ).rows[0].counter;
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations/202610050002_order_engine'),
    path.join(authPreviousMigrations, '202610050002_order_engine'),
    { recursive: true },
  );
  await migrate(databases[1], authPreviousConfig);
  assert.equal(
    (await upgrade.query("SELECT to_regnamespace('ctp_risk') IS NULL AS missing")).rows[0].missing,
    true,
  );
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations/202610050003_risk_controls'),
    path.join(authPreviousMigrations, '202610050003_risk_controls'),
    { recursive: true },
  );
  await migrate(databases[1], authPreviousConfig);
  await upgrade.query('BEGIN');
  try {
    await upgrade.query("SELECT set_config('app.tenant_id',$1,true)", [marker]);
    await upgrade.query('SELECT ctp_risk.update_tenant($1::jsonb)', [
      JSON.stringify({
        scope: { kind: 'USER', tenantId: marker, targetId: marker },
        kind: 'KILL_SWITCH',
        key: 'kill',
        state: 'PAUSED',
        eventId: randomUUID(),
        expectedEpoch: '0',
        reason: 'POLICY_UPGRADE_PROOF',
        evidenceHash: 'a'.repeat(64),
      }),
    ]);
    await upgrade.query('COMMIT');
  } finally {
    await upgrade.query('ROLLBACK').catch(() => {});
  }
  const priorControlHeads = (
    await upgrade.query(
      'SELECT * FROM ctp_risk.tenant_head ORDER BY "tenantId",scope,target,kind,key',
    )
  ).rows;
  const priorControlEvents = (
    await upgrade.query('SELECT * FROM ctp_risk.tenant_event ORDER BY "tenantId",id')
  ).rows;
  // Exercise exactly the previously published PHASE 12 boundary before quote evidence.
  for (const migration of ['202610050004_risk_policies', '202610060001_risk_loss_journal']) {
    await cp(
      path.join(workspace, 'packages/database/prisma/migrations', migration),
      path.join(authPreviousMigrations, migration),
      { recursive: true },
    );
  }
  await migrate(databases[1], authPreviousConfig);
  assert.equal(
    (
      await upgrade.query(
        "SELECT to_regprocedure('ctp_market.publish_snapshot(text,text)') IS NULL AS missing",
      )
    ).rows[0].missing,
    true,
  );
  const upgradeLossAt = Date.now(),
    upgradeLossDay = Math.floor(upgradeLossAt / 86400000) * 86400000;
  await upgrade.query('BEGIN');
  try {
    await upgrade.query("SELECT set_config('app.tenant_id',$1,true)", [marker]);
    await upgrade.query('SELECT ctp_risk.append_loss_batch($1::jsonb)', [
      JSON.stringify({
        scope: { tenantId: marker, mode: 'TESTNET', valuationAsset: 'USDT' },
        dayStart: upgradeLossDay,
        id: randomUUID(),
        expectedSequence: '0',
        opening: {
          at: upgradeLossDay,
          equity: '1000',
          sourceId: randomUUID(),
          sourceHash: 'a'.repeat(64),
        },
        coveredThrough: upgradeLossAt,
        events: [{ id: randomUUID(), at: upgradeLossAt, kind: 'EQUITY', amount: '990' }],
        coverage: {
          from: upgradeLossDay,
          through: upgradeLossAt,
          sourceId: randomUUID(),
          sourceHash: 'b'.repeat(64),
        },
      }),
    ]);
    await upgrade.query('COMMIT');
  } finally {
    await upgrade.query('ROLLBACK').catch(() => {});
  }
  const priorLossBatches = (
    await upgrade.query('SELECT * FROM ctp_risk.loss_batch ORDER BY "tenantId",id')
  ).rows;
  const priorLossEvents = (
    await upgrade.query('SELECT * FROM ctp_risk.loss_event_identity ORDER BY "tenantId",id')
  ).rows;
  const priorLossHeads = (
    await upgrade.query('SELECT * FROM ctp_risk.loss_head ORDER BY "tenantId",mode,asset,day')
  ).rows;
  // The new permit protocol must preserve every historical timestamp and command at
  // the exact published thirteen-migration boundary, including unresolved attempts.
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations/202610060002_market_snapshots'),
    path.join(authPreviousMigrations, '202610060002_market_snapshots'),
    { recursive: true },
  );
  await migrate(databases[1], authPreviousConfig);
  const priorAttempts = (
    await upgrade.query(
      'SELECT to_jsonb(t) AS evidence FROM public.submission_attempt t ORDER BY id',
    )
  ).rows;
  assert.ok(priorAttempts.length > 0, 'Upgrade requires actual historical attempt evidence');
  await cp(
    path.join(
      workspace,
      'packages/database/prisma/migrations/202610070001_deferred_transport_permit',
    ),
    path.join(authPreviousMigrations, '202610070001_deferred_transport_permit'),
    { recursive: true },
  );
  await migrate(databases[1], authPreviousConfig);
  assert.equal(
    (
      await upgrade.query(
        'SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      )
    ).rows[0].n,
    14,
  );
  const portfolioAuthorityTables = [
    'ctp_portfolio.book',
    'ctp_portfolio.evidence',
    'ctp_portfolio.hold_watermark',
    'public.ledger_transaction',
    'public.ledger_entry',
    'public.risk_reservation',
    'public.submission_attempt',
  ];
  const previousPortfolioAuthority = [];
  for (const table of portfolioAuthorityTables)
    previousPortfolioAuthority.push(
      (
        await upgrade.query(
          `SELECT to_jsonb(t) AS evidence FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  // Exercise the immediate predecessor (15 migrations) before the additive
  // registry upgrade, preserving all existing Portfolio/Order monetary evidence.
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations/202610070002_risk_portfolio_source'),
    path.join(authPreviousMigrations, '202610070002_risk_portfolio_source'),
    { recursive: true },
  );
  await migrate(databases[1], authPreviousConfig);
  assert.equal(
    (
      await upgrade.query(
        'SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      )
    ).rows[0].n,
    15,
  );
  await cp(
    path.join(
      workspace,
      'packages/database/prisma/migrations/202610070003_runtime_instrument_registry',
    ),
    path.join(authPreviousMigrations, '202610070003_runtime_instrument_registry'),
    { recursive: true },
  );
  await migrate(databases[1], authPreviousConfig);
  assert.equal(
    (
      await upgrade.query(
        'SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      )
    ).rows[0].n,
    16,
  );
  const beforeCaptureDefinition = (
    await upgrade.query(
      "SELECT pg_get_functiondef('ctp_risk.capture_portfolio(jsonb)'::regprocedure) AS definition",
    )
  ).rows[0].definition;
  assert.ok(!beforeCaptureDefinition.includes('inventory_ids'));
  await cp(
    path.join(
      workspace,
      'packages/database/prisma/migrations/202610070004_portfolio_capture_inventory',
    ),
    path.join(authPreviousMigrations, '202610070004_portfolio_capture_inventory'),
    { recursive: true },
  );
  await migrate(databases[1], authPreviousConfig);
  assert.equal(
    (
      await upgrade.query(
        'SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      )
    ).rows[0].n,
    17,
  );
  const published17Capture = (
    await upgrade.query(
      "SELECT pg_get_functiondef('ctp_risk.capture_portfolio(jsonb)'::regprocedure) AS definition",
    )
  ).rows[0].definition;
  assert.ok(published17Capture.includes('inventory_ids'));
  await cp(
    path.join(
      workspace,
      'packages/database/prisma/migrations/202610070005_risk_snapshot_certification',
    ),
    path.join(authPreviousMigrations, '202610070005_risk_snapshot_certification'),
    { recursive: true },
  );
  await migrate(databases[1], authPreviousConfig);
  assert.equal(
    (
      await upgrade.query(
        'SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      )
    ).rows[0].n,
    18,
  );
  const beforeAdmissionUpgrade = [];
  for (const table of [
    ...portfolioAuthorityTables,
    'ctp_certification.identity',
    'ctp_certification.certificate',
    'ctp_certification.observation',
  ])
    beforeAdmissionUpgrade.push(
      (
        await upgrade.query(
          `SELECT to_jsonb(t) AS evidence FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  await migrate(databases[1]);
  for (const [index, table] of [
    ...portfolioAuthorityTables,
    'ctp_certification.identity',
    'ctp_certification.certificate',
    'ctp_certification.observation',
  ].entries())
    assert.deepEqual(
      (
        await upgrade.query(
          `SELECT to_jsonb(t) AS evidence FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
      beforeAdmissionUpgrade[index],
    );
  assert.equal(
    (await upgrade.query('SELECT count(*)::int n FROM ctp_admission.issuance')).rows[0].n,
    0,
  );
  const afterCaptureDefinition = (
    await upgrade.query(
      "SELECT pg_get_functiondef('ctp_risk.capture_portfolio(jsonb)'::regprocedure) AS definition",
    )
  ).rows[0].definition;
  assert.ok(afterCaptureDefinition.includes('inventory_ids'));
  // Migration 29 adds exact durable hold-resolution proof. All prior inventory
  // and locking guards must remain byte-identical in the deployed body.
  const oldWatermark = "'released',w.released,'unknown',w.unknown)";
  assert.equal(published17Capture.split(oldWatermark).length, 2);
  assert.equal(
    afterCaptureDefinition,
    published17Capture.replace(
      oldWatermark,
      "'released',w.released,'unknown',w.unknown,'resolution',ctp_admission.hold_resolution_event(t,b.id,w.\"holdId\"))",
    ),
  );
  assert.equal(
    (await upgrade.query('SELECT count(*)::int n FROM ctp_certification.certificate_head')).rows[0]
      .n,
    0,
  );
  assert.equal(
    (await upgrade.query('SELECT count(*)::int n FROM ctp_certification.observation_head')).rows[0]
      .n,
    0,
  );
  assert.equal(
    (await upgrade.query('SELECT count(*)::int n FROM ctp_registry.current_record')).rows[0].n,
    0,
  );
  for (const [index, table] of portfolioAuthorityTables.entries())
    assert.deepEqual(
      (
        await upgrade.query(
          `SELECT to_jsonb(t) AS evidence FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
      previousPortfolioAuthority[index],
    );
  assert.deepEqual(
    (
      await upgrade.query(
        `SELECT to_jsonb(t)-'permitProtocolVersion' AS evidence FROM public.submission_attempt t ORDER BY id`,
      )
    ).rows,
    priorAttempts,
  );
  assert.equal(
    (
      await upgrade.query(
        'SELECT count(*)::int n FROM public.submission_attempt WHERE "permitProtocolVersion"<>1',
      )
    ).rows[0].n,
    0,
  );
  assert.deepEqual(
    (await upgrade.query('SELECT * FROM ctp_risk.loss_batch ORDER BY "tenantId",id')).rows,
    priorLossBatches,
  );
  assert.deepEqual(
    (await upgrade.query('SELECT * FROM ctp_risk.loss_event_identity ORDER BY "tenantId",id')).rows,
    priorLossEvents,
  );
  assert.deepEqual(
    (await upgrade.query('SELECT * FROM ctp_risk.loss_head ORDER BY "tenantId",mode,asset,day'))
      .rows,
    priorLossHeads,
  );
  assert.equal(
    (await upgrade.query('SELECT count(*)::int n FROM ctp_market.snapshot_head')).rows[0].n,
    0,
  );
  assert.deepEqual(
    (
      await upgrade.query(
        'SELECT * FROM ctp_risk.tenant_head ORDER BY "tenantId",scope,target,kind,key',
      )
    ).rows,
    priorControlHeads,
  );
  assert.deepEqual(
    (await upgrade.query('SELECT * FROM ctp_risk.tenant_event ORDER BY "tenantId",id')).rows,
    priorControlEvents,
  );
  assert.equal(
    (await upgrade.query('SELECT count(*)::int n FROM ctp_risk.policy_head')).rows[0].n,
    0,
  );
  assert.deepEqual(
    (await upgrade.query('SELECT state,epoch::text FROM ctp_risk.global_head')).rows,
    [{ state: 'PAUSED', epoch: '1' }],
  );
  await verifyPortfolioUpgrade(upgrade, portfolioUpgrade);
  assert.equal(
    (
      await upgrade.query(
        'SELECT "clientIdHighWatermark"::text AS counter FROM exchange_account WHERE id=$1',
        [upgradeAccount],
      )
    ).rows[0].counter,
    priorCounter,
  );
  assert.equal(
    (await upgrade.query('SELECT count(*)::int AS n FROM ctp_execution.command')).rows[0].n,
    0,
  );
  const authHardeningAfter = await exerciseAuthDatabaseHardening({
    admin: upgrade,
    adminUrl: dbUrl(databases[1]),
    authUrl: dbUrl(databases[1], false, false, true),
    stage: 'hardened005',
  });
  await report('auth-database-hardening', {
    status: 'PASS',
    startedAt,
    completedAt: new Date().toISOString(),
    before: authHardeningBefore,
    after: authHardeningAfter,
    notes:
      'One user/session, actual auth SQL and pool max3. Latencies include pool queue. WAL/dead-tuple deltas are approximate cluster statistics; sampled lock counts may miss short waits.',
  });
  await verifyAuditUpgrade(upgrade, auditUpgradeIds);
  await migrate(databases[1]);
  assert.equal(
    (await upgrade.query('SELECT "emailNormalized" FROM "user" WHERE id=$1', [marker])).rows[0]
      .emailNormalized,
    'upgrade@example.invalid',
  );
  assert.equal(
    (
      await upgrade.query(
        'SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      )
    ).rows[0].n,
    expectedMigrations.length,
  );
  assert.deepEqual(
    (
      await upgrade.query(
        `SELECT "entryIndex",amount::text FROM ledger_entry
         WHERE "transactionId"=$1 ORDER BY "entryIndex"`,
        [upgradePosting],
      )
    ).rows,
    [
      { entryIndex: 0, amount: '1.000000000000000001' },
      { entryIndex: 1, amount: '-1.000000000000000001' },
    ],
  );
  assert.deepEqual(
    (
      await upgrade.query(
        `SELECT "tenantId" FROM ctp_internal.ledger_seal WHERE "transactionId"=$1`,
        [upgradePosting],
      )
    ).rows,
    [{ tenantId: marker }],
  );
  await upgrade.query('BEGIN');
  try {
    await upgrade.query("SELECT set_config('app.tenant_id',$1,true)", [marker]);
    await assert.rejects(
      upgrade.query(
        `INSERT INTO ledger_entry
          ("tenantId","transactionId","accountId",mode,"entryIndex",asset,bucket,amount)
         VALUES ($1,$2,$3,'PAPER',2,'USDT','AVAILABLE',1)`,
        [marker, upgradePosting, upgradeAccount],
      ),
      (error) => error?.code === '23514',
    );
  } finally {
    await upgrade.query('ROLLBACK');
  }

  // Reproduce the documented migration contract with a DDL owner that cannot bypass RLS.
  await migrate(databases[2], previousConfig, true);
  const ownerDatabase = connect(dbUrl(databases[2]));
  const ownerLegacy = await prepareAuditUpgrade(
    ownerDatabase,
    path.join(
      workspace,
      'packages/database/prisma/migrations/202609090001_audit_integrity/migration.sql',
    ),
  );
  await migrate(databases[2], config, true);
  await verifyAuditUpgrade(ownerDatabase, ownerLegacy);
  const { createPostgresControls, createPostgresPolicies, createPostgresLossJournal } =
    await import('../packages/risk-engine/dist/index.js');
  const controlTenant = randomUUID();
  await ownerDatabase.query(
    'INSERT INTO public."user"(id,"emailNormalized","updatedAt") VALUES($1,$2,now())',
    [controlTenant, controlTenant + '@example.invalid'],
  );
  const nonBypassControls = await createPostgresControls({
    connectionString: controlUrl(databases[2]),
    environment: 'test',
    authority: 'TENANT',
  });
  try {
    const result = await nonBypassControls.update(
      {
        scope: { kind: 'USER', tenantId: controlTenant, targetId: controlTenant },
        kind: 'KILL_SWITCH',
        key: 'kill',
        state: 'PAUSED',
        eventId: randomUUID(),
        expectedEpoch: '0',
        reason: 'NON_BYPASS_OWNER_PROOF',
        evidenceHash: 'a'.repeat(64),
      },
      { signal: new AbortController().signal, deadline: Date.now() + 2500 },
    );
    assert.equal(result.epoch, '1');
    assert.equal(result.state, 'PAUSED');
  } finally {
    await nonBypassControls.close();
  }
  const nonBypassPolicyOperator = await createPostgresPolicies({
    connectionString: policyUrl(databases[2], true),
    environment: 'test',
    authority: 'PLATFORM',
  });
  const nonBypassPolicyController = await createPostgresPolicies({
    connectionString: policyUrl(databases[2]),
    environment: 'test',
    authority: 'USER',
  });
  const restrictiveLimits = {
    valuationAsset: 'USDT',
    maxOrderNotional: '0',
    maxInstrumentExposure: '0',
    maxAssetExposure: '0',
    maxAccountExposure: '0',
    maxUserExposure: '0',
    maxConcurrentPositions: 0,
    maxOpenOrders: 0,
    maxLeverage: '1',
    maxDailyRealizedLoss: '0',
    maxDailyTotalLoss: '0',
    maxDrawdownRate: '0',
    maxOrdersPerMinute: 0,
    minAvailableBalance: '0',
    maxPriceDeviationRate: '0',
    maxSpreadRate: '0',
    minLiquidityNotional: '0',
    maxEvidenceAgeMs: 1000,
  };
  const policyRequest = {
    mode: 'TESTNET',
    eventId: randomUUID(),
    expectedVersion: '0',
    reason: 'NON_BYPASS_POLICY_PROOF',
    limits: restrictiveLimits,
  };
  const policyIo = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
  try {
    assert.equal(
      (
        await nonBypassPolicyOperator.update(
          { ...policyRequest, scope: { kind: 'PLATFORM' } },
          policyIo(),
        )
      ).version,
      '1',
    );
    assert.equal(
      (
        await nonBypassPolicyController.update(
          {
            ...policyRequest,
            eventId: randomUUID(),
            scope: { kind: 'USER', tenantId: controlTenant },
          },
          policyIo(),
        )
      ).version,
      '1',
    );
    const heads = await nonBypassPolicyController.read(controlTenant, 'TESTNET', policyIo());
    assert.equal(heads.length, 2);
    assert.deepEqual(
      heads.map((h) => h.limits),
      [restrictiveLimits, restrictiveLimits],
    );
  } finally {
    await nonBypassPolicyOperator.close();
    await nonBypassPolicyController.close();
  }
  const nonBypassLoss = await createPostgresLossJournal({
    connectionString: evidenceUrl(databases[2]),
    environment: 'test',
  });
  const lossAt = Date.now(),
    lossDay = Math.floor(lossAt / 86400000) * 86400000;
  const lossBatch = {
    scope: { tenantId: controlTenant, mode: 'TESTNET', valuationAsset: 'USDT' },
    dayStart: lossDay,
    id: randomUUID(),
    expectedSequence: '0',
    opening: { at: lossDay, equity: '1000', sourceId: randomUUID(), sourceHash: 'a'.repeat(64) },
    coveredThrough: lossAt,
    events: [{ id: randomUUID(), at: lossAt, kind: 'EQUITY', amount: '1000' }],
    coverage: {
      from: lossDay,
      through: lossAt,
      sourceId: randomUUID(),
      sourceHash: 'b'.repeat(64),
    },
  };
  try {
    const head = await nonBypassLoss.append(lossBatch, policyIo());
    assert.equal(head.sequence, '2');
    assert.deepEqual(await nonBypassLoss.read(lossBatch.scope, lossDay, policyIo()), head);
  } finally {
    await nonBypassLoss.close();
  }
  const { createPostgresMarketSnapshots, createPostgresInstrumentRegistry } =
    await import('../packages/market-data/dist/index.js');
  const registryScope = {
    exchange: 'BINANCE',
    region: 'global',
    market: 'SPOT',
    environment: 'TESTNET',
  };
  const registryAt = Date.now();
  const registryRecord = {
    instrument: {
      id: 'BTCUSDT',
      scope: registryScope,
      exchangeSymbol: 'BTCUSDT',
      displaySymbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      settlementAsset: null,
      contract: null,
      expiryAt: null,
      status: 'TRADING',
      metadataVersion: 'owner-registry-v1',
    },
    rules: {
      instrumentId: 'BTCUSDT',
      scope: registryScope,
      version: 'owner-registry-v1',
      effectiveAt: registryAt,
      expiresAt: registryAt + 60000,
      tickSize: '0.05',
      stepSize: '0.001',
      minQuantity: '0.001',
      maxQuantity: '100',
      marketMinQuantity: '0.001',
      marketMaxQuantity: '100',
      minNotional: '5',
      maxNotional: '1000000',
      minPrice: '0.05',
      maxPrice: '1000000',
      quantityUnit: 'BASE',
      pricePrecision: 2,
      quantityPrecision: 3,
      orderTypes: ['LIMIT'],
      timeInForce: ['GTC'],
      leverageTiers: [],
    },
  };
  const ownerRegistry = await createPostgresInstrumentRegistry({
    connectionString: registryUrl(databases[2]),
    environment: 'test',
    scope: registryScope,
    instrumentIds: ['BTCUSDT'],
  });
  try {
    assert.equal((await ownerRegistry.put(registryRecord, Date.now(), policyIo())).ok, true);
    assert.deepEqual(
      (await ownerRegistry.readCurrent(registryScope, 'BTCUSDT', Date.now(), policyIo())).value,
      registryRecord,
    );
  } finally {
    await ownerRegistry.close();
  }
  assert.equal(
    (await ownerDatabase.query('SELECT count(*)::int n FROM ctp_registry.version_history')).rows[0]
      .n,
    2,
  );
  assert.equal(
    (
      await ownerDatabase.query(
        `SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ctp_registry' AND c.relrowsecurity AND c.relforcerowsecurity`,
      )
    ).rows[0].n,
    3,
  );
  const nonBypassSnapshots = await createPostgresMarketSnapshots({
    connectionString: snapshotUrl(databases[2]),
    environment: 'test',
  });
  const missingMarketKey = {
    scope: { exchange: 'BINANCE', region: 'global', market: 'SPOT', environment: 'TESTNET' },
    instrumentId: 'not-collected',
    dbInstrumentId: randomUUID(),
    dbRuleId: randomUUID(),
  };
  try {
    assert.equal(
      (
        await nonBypassSnapshots.publish(
          {
            id: randomUUID(),
            key: missingMarketKey,
            expectedRevision: '0',
            timestamp: Date.now(),
            kind: 'GAP',
            reason: 'NO_NATIVE_EVIDENCE',
          },
          policyIo(),
        )
      ).revision,
      '1',
    );
    await assert.rejects(
      nonBypassSnapshots.read(missingMarketKey, policyIo()),
      /MARKET_EVIDENCE_RESYNC_REQUIRED/,
    );
  } finally {
    await nonBypassSnapshots.close();
  }
  const { createPostgresRiskPortfolioReader } =
    await import('../packages/risk-engine/dist/index.js');
  const { createPostgresPortfolioStore } = await import('../packages/portfolio/dist/index.js');
  const sourceAccount = randomUUID(),
    sourceConnection = randomUUID();
  await ownerDatabase.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,'BINANCE','TESTNET',$3,'global','SPOT','DISABLED','source-owner',now())`,
    [sourceAccount, controlTenant, sourceAccount],
  );
  await ownerDatabase.query(
    `INSERT INTO public.exchange_connection(id,"tenantId","accountId",mode,label,status,permissions,"updatedAt") VALUES($1,$2,$3,'TESTNET','source-owner','DISABLED','{}',now())`,
    [sourceConnection, controlTenant, sourceAccount],
  );
  const sourcePortfolio = await createPostgresPortfolioStore({
    connectionString: dbUrl(databases[2], false, false, false, false, true),
    environment: 'test',
  });
  const nonBypassSource = await createPostgresRiskPortfolioReader({
    connectionString: riskSnapshotUrl(databases[2]),
    environment: 'test',
  });
  try {
    const sourceBinding = {
      tenantId: controlTenant,
      accountId: sourceAccount,
      connectionId: sourceConnection,
      externalAccountId: sourceAccount,
      mode: 'TESTNET',
      walletId: 'primary',
      scope: { exchange: 'BINANCE', region: 'global', market: 'SPOT', environment: 'TESTNET' },
    };
    await sourcePortfolio.apply(
      sourceBinding,
      {
        type: 'SNAPSHOT',
        id: randomUUID(),
        timestamp: Date.now(),
        proof: 'RECONCILED_HISTORY',
        covered: [],
        balances: [],
        positions: [],
      },
      0,
      policyIo(),
    );
    const source = await nonBypassSource.read(
      {
        tenantId: controlTenant,
        targetAccountId: sourceAccount,
        mode: 'TESTNET',
        maxEvidenceAgeMs: 5000,
      },
      policyIo(),
    );
    assert.equal(source.books.length, 1);
    assert.equal(source.books[0].state.status, 'RECONCILED');
    assert.equal(source.accounts[0].id, sourceAccount);
    assert.equal(source.books[0].revision, '1');
  } finally {
    await nonBypassSource.close();
    await sourcePortfolio.close();
  }
  assert.deepEqual(
    (await admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1', [ownerRole]))
      .rows,
    [{ rolsuper: false, rolbypassrls: false }],
  );
  assert.equal(
    (
      await ownerDatabase.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('fee','submission_attempt','order','risk_reservation','fill','ledger_transaction','order_intent')
      AND c.relrowsecurity AND c.relforcerowsecurity`)
    ).rows[0].n,
    7,
  );

  // Run the complete physical certification contract against SECURITY DEFINER
  // functions owned by the non-BYPASSRLS migration owner as well as the fresh DB.
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/risk-certification.integration.test.ts',
      '--outputFile.json=test-results/risk-certification-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_PORTFOLIO_URL: dbUrl(databases[2], false, false, false, false, true),
        DATABASE_EXECUTION_URL: dbUrl(databases[2], false, false, false, false, false, true),
        DATABASE_RISK_POLICY_OPERATOR_URL: policyUrl(databases[2], true),
        DATABASE_RISK_POLICY_CONTROLLER_URL: policyUrl(databases[2]),
        DATABASE_RISK_EVIDENCE_URL: evidenceUrl(databases[2]),
        DATABASE_MARKET_SNAPSHOT_URL: snapshotUrl(databases[2]),
        DATABASE_INSTRUMENT_REGISTRY_URL: registryUrl(databases[2]),
        DATABASE_RISK_CERTIFICATION_URL: certificationUrl(databases[2]),
        DATABASE_RISK_OBSERVATION_URL: certificationUrl(databases[2], true),
      },
      secrets,
      echo: true,
      timeoutMs: 120000,
    },
  );
  const certificationOwner = JSON.parse(
    await readFile(
      new URL('../test-results/risk-certification-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(certificationOwner.success, true);
  assert.equal(certificationOwner.numPendingTests, 0);
  assert.ok(certificationOwner.numPassedTests >= 14);
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/risk-admission.integration.test.ts',
      '--outputFile.json=test-results/risk-admission-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_PORTFOLIO_URL: dbUrl(databases[2], false, false, false, false, true),
        DATABASE_EXECUTION_URL: dbUrl(databases[2], false, false, false, false, false, true),
        DATABASE_RISK_POLICY_OPERATOR_URL: policyUrl(databases[2], true),
        DATABASE_RISK_POLICY_CONTROLLER_URL: policyUrl(databases[2]),
        DATABASE_RISK_EVIDENCE_URL: evidenceUrl(databases[2]),
        DATABASE_MARKET_SNAPSHOT_URL: snapshotUrl(databases[2]),
        DATABASE_INSTRUMENT_REGISTRY_URL: registryUrl(databases[2]),
        DATABASE_RISK_CERTIFICATION_URL: certificationUrl(databases[2]),
        DATABASE_RISK_OBSERVATION_URL: certificationUrl(databases[2], true),
        DATABASE_RISK_OPERATOR_URL: controlUrl(databases[2], true),
        DATABASE_RISK_CONTROL_URL: controlUrl(databases[2]),
        DATABASE_RISK_ADMISSION_URL: admissionUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 120000,
    },
  );
  const admissionOwner = JSON.parse(
    await readFile(
      new URL('../test-results/risk-admission-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(admissionOwner.success, true);
  assert.equal(admissionOwner.numPendingTests, 0);
  assert.ok(admissionOwner.numPassedTests >= 28);

  // The additive PAPER receipt must also work with a non-BYPASSRLS DDL owner.
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-configuration.integration.test.ts',
      '--outputFile.json=test-results/paper-configuration-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperConfigurationOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-configuration-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperConfigurationOwner.success, true);
  assert.equal(paperConfigurationOwner.numPendingTests, 0);
  assert.ok(paperConfigurationOwner.numPassedTests >= 30);

  // Preserve a genuine published-35 receipt while a non-BYPASSRLS owner
  // backfills its immutable seal. FORCE RLS must not silently hide legacy rows.
  const paperPrior = await mkdtemp(path.join(workspace, '.cache', 'db-paper-upgrade-'));
  const paperMigrations = path.join(paperPrior, 'migrations');
  await mkdir(paperMigrations);
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations/migration_lock.toml'),
    path.join(paperMigrations, 'migration_lock.toml'),
  );
  for (const migration of expectedMigrations.slice(0, 35))
    await cp(
      path.join(workspace, 'packages/database/prisma/migrations', migration),
      path.join(paperMigrations, migration),
      { recursive: true },
    );
  const paperConfig = path.join(paperPrior, 'prisma.config.ts');
  await writeFile(
    paperConfig,
    `import {defineConfig} from ${JSON.stringify(databaseRequire.resolve('prisma/config'))};
export default defineConfig({schema:${JSON.stringify(path.join(workspace, 'packages/database/prisma/schema.prisma'))},migrations:{path:${JSON.stringify(paperMigrations)}},datasource:{url:process.env.DATABASE_MIGRATION_URL}});\n`,
  );
  await migrate(databases[4], paperConfig, true);
  const paperUpgrade = connect(dbUrl(databases[4]));
  const paperInput = {
    id: randomUUID(),
    owner: { tenantId: randomUUID(), accountId: randomUUID(), mode: 'PAPER' },
    source: { exchange: 'BINANCE', region: 'global', market: 'SPOT', environment: 'LIVE' },
    valuationAsset: 'USDT',
    model: {
      version: 'spot-l2-taker-v1',
      seed: '9007199254740993',
      takerFeeRate: '0.001',
      maxSlippageRate: '0',
      latencyMs: 100,
      latencyJitterMs: 0,
      participationRate: '0.5',
      maxEvidenceAgeMs: 5000,
    },
  };
  await paperUpgrade.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
    [paperInput.owner.tenantId, `${paperInput.owner.tenantId}@example.invalid`],
  );
  await paperUpgrade.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,'BINANCE','PAPER',$3,'global','SIMULATED','ACTIVE','paper-upgrade',now())`,
    [paperInput.owner.accountId, paperInput.owner.tenantId, `paper:${paperInput.owner.accountId}`],
  );
  const { createPostgresPaperConfiguration } = await import(
    pathToFileURL(path.join(workspace, 'packages/paper-engine/dist/configuration.js'))
  );
  const legacyPaperStore = await createPostgresPaperConfiguration({
    connectionString: paperConfigurationUrl(databases[4]),
    environment: 'test',
  });
  let legacyPaperReceipt;
  try {
    legacyPaperReceipt = await legacyPaperStore.register(paperInput, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
  } finally {
    await legacyPaperStore.close();
  }
  await migrate(databases[4], config, true);
  const sealedPaperStore = await createPostgresPaperConfiguration({
    connectionString: paperConfigurationUrl(databases[4]),
    environment: 'test',
  });
  try {
    assert.deepEqual(
      await sealedPaperStore.read(paperInput.owner, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      }),
      legacyPaperReceipt,
    );
  } finally {
    await sealedPaperStore.close();
  }
  assert.equal(
    (await paperUpgrade.query('SELECT count(*)::int n FROM ctp_paper.configuration_seal')).rows[0]
      .n,
    1,
  );
  assert.equal(
    (
      await paperUpgrade.query(
        "SELECT count(*)::int n FROM pg_policies WHERE policyname IN('paper_seal_upgrade_read','paper_seal_upgrade_write')",
      )
    ).rows[0].n,
    0,
  );

  // Restore a genuinely populated published-19 format before applying any
  // lifecycle migration. The acceptance fixture uses actual atomic issuance;
  // neither its certificates nor its reservations are empty placeholders.
  const lifecyclePrior = await mkdtemp(path.join(workspace, '.cache', 'db-lifecycle-upgrade-'));
  const lifecycleMigrations = path.join(lifecyclePrior, 'migrations');
  await mkdir(lifecycleMigrations);
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations/migration_lock.toml'),
    path.join(lifecycleMigrations, 'migration_lock.toml'),
  );
  for (const migration of expectedMigrations.slice(0, 19))
    await cp(
      path.join(workspace, 'packages/database/prisma/migrations', migration),
      path.join(lifecycleMigrations, migration),
      { recursive: true },
    );
  const lifecycleConfig = path.join(lifecyclePrior, 'prisma.config.ts');
  await writeFile(
    lifecycleConfig,
    `import { defineConfig } from ${JSON.stringify(databaseRequire.resolve('prisma/config'))};
export default defineConfig({schema:${JSON.stringify(path.join(workspace, 'packages/database/prisma/schema.prisma'))},migrations:{path:${JSON.stringify(lifecycleMigrations)}},datasource:{url:process.env.DATABASE_MIGRATION_URL}});\n`,
  );
  await migrate(databases[3], lifecycleConfig);
  await admin.query(`REVOKE ALL ON DATABASE ${identifier(databases[3])} FROM PUBLIC`);
  await admin.query(
    `GRANT CONNECT ON DATABASE ${identifier(databases[3])} TO ${identifier(executionRole)}`,
  );
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.upgrade.config.ts',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[0]),
        DATABASE_PHASE12_UPGRADE_URL: dbUrl(databases[3]),
        DATABASE_PHASE12_UPGRADE_EXECUTION_URL: dbUrl(
          databases[3],
          false,
          false,
          false,
          false,
          false,
          true,
        ),
        DATABASE_PORTFOLIO_URL: dbUrl(databases[0], false, false, false, false, true),
        DATABASE_EXECUTION_URL: dbUrl(databases[0], false, false, false, false, false, true),
        DATABASE_RISK_POLICY_OPERATOR_URL: policyUrl(databases[0], true),
        DATABASE_RISK_POLICY_CONTROLLER_URL: policyUrl(databases[0]),
        DATABASE_RISK_EVIDENCE_URL: evidenceUrl(databases[0]),
        DATABASE_MARKET_SNAPSHOT_URL: snapshotUrl(databases[0]),
        DATABASE_INSTRUMENT_REGISTRY_URL: registryUrl(databases[0]),
        DATABASE_RISK_OBSERVATION_URL: certificationUrl(databases[0], true),
        DATABASE_RISK_ADMISSION_URL: admissionUrl(databases[0]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const lifecycleUpgrade = JSON.parse(
    await readFile(
      new URL('../test-results/risk-lifecycle-upgrade-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(lifecycleUpgrade.success, true);
  assert.equal(lifecycleUpgrade.numPassedTests, 1);
  assert.equal(lifecycleUpgrade.numPendingTests, 0);

  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[0]),
        DATABASE_RUNTIME_URL: dbUrl(databases[0], true),
        DATABASE_INGEST_URL: dbUrl(databases[0], false, false, false, true),
        DATABASE_PORTFOLIO_URL: dbUrl(databases[0], false, false, false, false, true),
        DATABASE_EXECUTION_URL: dbUrl(databases[0], false, false, false, false, false, true),
        DATABASE_RISK_CONTROL_URL: controlUrl(databases[0]),
        DATABASE_RISK_OPERATOR_URL: controlUrl(databases[0], true),
        DATABASE_RISK_POLICY_OPERATOR_URL: policyUrl(databases[0], true),
        DATABASE_RISK_POLICY_CONTROLLER_URL: policyUrl(databases[0]),
        DATABASE_RISK_EVIDENCE_URL: evidenceUrl(databases[0]),
        DATABASE_MARKET_SNAPSHOT_URL: snapshotUrl(databases[0]),
        DATABASE_RISK_SNAPSHOT_URL: riskSnapshotUrl(databases[0]),
        DATABASE_INSTRUMENT_REGISTRY_URL: registryUrl(databases[0]),
        DATABASE_RISK_CERTIFICATION_URL: certificationUrl(databases[0]),
        DATABASE_RISK_OBSERVATION_URL: certificationUrl(databases[0], true),
        DATABASE_RISK_ADMISSION_URL: admissionUrl(databases[0]),
        DATABASE_AUTH_URL: dbUrl(databases[0], false, false, true),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[0]),
      },
      secrets,
      echo: true,
      // Whole serial suite budget; individual transaction/abort deadlines stay unchanged.
      timeoutMs: 300000,
    },
  );
  const tests = JSON.parse(
    await readFile(new URL('../test-results/database-tests.json', import.meta.url), 'utf8'),
  );
  assert.equal(tests.success, true);
  assert.ok(tests.numPassedTests > 0);

  // Exercise the actual compiled entrypoint with separate login roles before this
  // owned database is reset. The child owns its loopback SMTP sink and API listener.
  await run(process.execPath, ['scripts/test-auth-runtime.mjs'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_MIGRATION_URL: dbUrl(databases[0]),
      DATABASE_URL: dbUrl(databases[0], true),
      DATABASE_AUTH_URL: dbUrl(databases[0], false, false, true),
    },
    secrets,
    echo: true,
    timeoutMs: 120000,
  });
  const authRuntime = JSON.parse(
    await readFile(new URL('../test-results/auth-runtime.json', import.meta.url), 'utf8'),
  );
  assert.equal(authRuntime.status, 'PASS');

  await run(process.execPath, ['scripts/test-auth-hardening.mjs'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_MIGRATION_URL: dbUrl(databases[0]),
      DATABASE_URL: dbUrl(databases[0], true),
      DATABASE_AUTH_URL: dbUrl(databases[0], false, false, true),
    },
    secrets,
    echo: true,
    // Includes fixed-window mail capacity recovery and paced enumeration.
    timeoutMs: 180000,
  });

  // Reset ONLY the DB name created above, then reapply the same versioned migrations.
  await fresh.end();
  pools.delete(fresh);
  const resetStorageStarted = Date.now();
  await admin.query(`DROP DATABASE ${identifier(databases[0])} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${identifier(databases[0])}`);
  const resetStorageMs = Date.now() - resetStorageStarted;
  await migrate(databases[0]);
  const reset = connect(dbUrl(databases[0]));
  assert.equal((await reset.query('SELECT count(*)::int n FROM "user"')).rows[0].n, 0);
  assert.deepEqual((await reset.query('SELECT state,epoch::text FROM ctp_risk.global_head')).rows, [
    { state: 'PAUSED', epoch: '1' },
  ]);
  assert.equal(
    (await reset.query('SELECT count(*)::int n FROM ctp_risk.policy_head')).rows[0].n,
    0,
  );
  assert.equal((await reset.query('SELECT count(*)::int n FROM ctp_risk.loss_head')).rows[0].n, 0);
  assert.equal(
    (await reset.query('SELECT count(*)::int n FROM ctp_market.snapshot_head')).rows[0].n,
    0,
  );
  assert.equal(
    (await reset.query('SELECT count(*)::int n FROM ctp_registry.current_record')).rows[0].n,
    0,
  );
  assert.equal(
    (await reset.query('SELECT count(*)::int n FROM ctp_registry.version_history')).rows[0].n,
    0,
  );
  assert.equal(
    (await reset.query('SELECT count(*)::int n FROM ctp_paper.configuration')).rows[0].n,
    0,
  );
  assert.equal(
    (await reset.query('SELECT count(*)::int n FROM ctp_paper.configuration_seal')).rows[0].n,
    0,
  );
  outcome = {
    ...outcome,
    status: 'PASS',
    fresh: 'PASS',
    upgradePreservesData: 'PASS',
    upgradeSealsExistingLedger: 'PASS',
    upgradeBackfillsEvidenceScope: 'PASS',
    upgradeRejectsInvalidLegacyLinks: 'PASS',
    nonBypassMigrationOwner: 'PASS',
    repeatedDeploy: 'PASS',
    isolatedReset: 'PASS',
    authenticatedRuntime: 'PASS',
    authenticationHardening: 'PASS',
    orderEngineUpgradeFromPhase10: 'PASS',
    riskControlsFreshAndResetPaused: 'PASS',
    riskControlsUpgradePaused: 'PASS',
    riskControlsUpgradeFromPhase11: 'PASS',
    riskControlsNonBypassOwner: 'PASS',
    riskPoliciesFreshAndResetMissing: 'PASS',
    riskPoliciesUpgradeFromPhase12: 'PASS',
    riskPoliciesNonBypassOwner: 'PASS',
    riskLossFreshAndResetMissing: 'PASS',
    riskLossUpgradeFromPhase12: 'PASS',
    riskLossNonBypassOwner: 'PASS',
    marketSnapshotsFreshAndResetMissing: 'PASS',
    marketSnapshotsNonBypassOwner: 'PASS',
    marketSnapshotsUpgradeFromPhase12: 'PASS',
    deferredPermitUpgradeFromPhase12: 'PASS',
    riskPortfolioSourceNonBypassOwner: 'PASS',
    riskPortfolioSourceUpgradeFromPhase12: 'PASS',
    instrumentRegistryFreshAndReset: 'PASS',
    instrumentRegistryUpgradeFromPhase12: 'PASS',
    instrumentRegistryNonBypassOwner: 'PASS',
    portfolioCaptureInventoryUpgradeFromPublished16: 'PASS',
    riskCertificationUpgradeFromPublished17: 'PASS',
    riskAdmissionUpgradeFromPublished18: 'PASS',
    riskAdmissionNonBypassOwner: 'PASS',
    riskLifecyclePopulatedUpgradeFromPublished19: 'PASS',
    paperConfigurationNonBypassOwner: 'PASS',
    paperConfigurationPopulatedUpgradeFromPublished35: 'PASS',
    resetStorageMs,
    maintenanceStatementTimeoutMs: 30_000,
    tests: tests.numPassedTests,
  };
} catch (error) {
  const reason =
    error instanceof Error
      ? secrets.reduce((s, value) => s.replaceAll(value, '[REDACTED]'), error.message)
      : 'Database tests failed';
  console.error(reason);
  outcome = { ...outcome, reason };
  process.exitCode = 1;
} finally {
  for (const pool of pools) await pool.end().catch(() => {});
  // The parent runner removes the entire owned Compose project, even after partial setup.
  await report('database', { ...outcome, completedAt: new Date().toISOString() });
}
