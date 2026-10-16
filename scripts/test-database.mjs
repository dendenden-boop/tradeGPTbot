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
  '202610090005_paper_initial_funding',
  '202610100001_paper_initial_portfolio',
  '202610110001_public_trade_journal',
  '202610120001_paper_order_binding',
  '202610120002_paper_portfolio_bootstrap',
  '202610130001_paper_book_source',
  '202610130002_paper_risk_portfolio',
  '202610140001_paper_risk_valuation',
  '202610140002_paper_risk_cash_loss',
  '202610140003_paper_order_risk_source',
  '202610150001_paper_risk_authority',
  '202610150002_paper_runtime_observations',
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
const paperFundingPassword = randomBytes(24).toString('hex');
const paperPortfolioPassword = randomBytes(24).toString('hex');
const paperBookPassword = randomBytes(24).toString('hex');
const paperBookSourcePassword = randomBytes(24).toString('hex');
const paperRiskPortfolioPassword = randomBytes(24).toString('hex');
const paperRiskValuationPassword = randomBytes(24).toString('hex');
const paperRiskLossPassword = randomBytes(24).toString('hex');
const paperOrderRiskPassword = randomBytes(24).toString('hex');
const paperRiskAuthorityPassword = randomBytes(24).toString('hex');
const paperRuntimeObserverPassword = randomBytes(24).toString('hex');
const paperRuntimeReaderPassword = randomBytes(24).toString('hex');
const marketTradePassword = randomBytes(24).toString('hex');
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
  paperFundingPassword,
  paperPortfolioPassword,
  paperBookPassword,
  paperBookSourcePassword,
  paperRiskPortfolioPassword,
  paperRiskValuationPassword,
  paperRiskLossPassword,
  paperOrderRiskPassword,
  paperRiskAuthorityPassword,
  paperRuntimeObserverPassword,
  paperRuntimeReaderPassword,
  marketTradePassword,
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
const paperFundingRole = `ctp_p2_paper_funding_${suffix}`;
const paperPortfolioRole = `ctp_p2_paper_portfolio_${suffix}`;
const paperBookRole = `ctp_p2_paper_book_${suffix}`;
const paperBookSourceRole = `ctp_p2_paper_book_source_${suffix}`;
const paperRiskPortfolioRole = `ctp_p2_paper_risk_portfolio_${suffix}`;
const paperRiskValuationRole = `ctp_p2_paper_risk_valuation_${suffix}`;
const paperRiskLossRole = `ctp_p2_paper_risk_loss_${suffix}`;
const paperOrderRiskRole = `ctp_p2_paper_order_risk_${suffix}`;
const paperRiskAuthorityRole = `ctp_p2_paper_risk_authority_${suffix}`;
const paperRuntimeObserverRole = `ctp_p2_paper_runtime_observer_${suffix}`;
const paperRuntimeReaderRole = `ctp_p2_paper_runtime_reader_${suffix}`;
const marketTradeRole = `ctp_p2_market_trade_${suffix}`;
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
const marketTradeUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = marketTradeRole;
  url.password = marketTradePassword;
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
const paperFundingUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperFundingRole;
  url.password = paperFundingPassword;
  return url.href;
};
const paperRiskPortfolioUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperRiskPortfolioRole;
  url.password = paperRiskPortfolioPassword;
  return url.href;
};
const paperRiskValuationUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperRiskValuationRole;
  url.password = paperRiskValuationPassword;
  return url.href;
};
const paperRiskLossUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperRiskLossRole;
  url.password = paperRiskLossPassword;
  return url.href;
};
const paperOrderRiskUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperOrderRiskRole;
  url.password = paperOrderRiskPassword;
  return url.href;
};
const paperRiskAuthorityUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperRiskAuthorityRole;
  url.password = paperRiskAuthorityPassword;
  return url.href;
};
const paperRuntimeObserverUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperRuntimeObserverRole;
  url.password = paperRuntimeObserverPassword;
  return url.href;
};
const paperRuntimeReaderUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperRuntimeReaderRole;
  url.password = paperRuntimeReaderPassword;
  return url.href;
};
const paperBookSourceUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperBookSourceRole;
  url.password = paperBookSourcePassword;
  return url.href;
};
const paperBookUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperBookRole;
  url.password = paperBookPassword;
  return url.href;
};
const paperPortfolioUrl = (name) => {
  const url = new URL(dbUrl(name));
  url.username = paperPortfolioRole;
  url.password = paperPortfolioPassword;
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
    [paperFundingRole, paperFundingPassword, 'ctp_paper_funding'],
    [paperPortfolioRole, paperPortfolioPassword, 'ctp_paper_portfolio_reader'],
    [paperBookRole, paperBookPassword, 'ctp_paper_book_initializer'],
    [paperBookSourceRole, paperBookSourcePassword, 'ctp_paper_book_source'],
    [paperRiskPortfolioRole, paperRiskPortfolioPassword, 'ctp_paper_risk_portfolio'],
    [paperRiskValuationRole, paperRiskValuationPassword, 'ctp_paper_risk_valuation'],
    [paperRiskLossRole, paperRiskLossPassword, 'ctp_paper_risk_loss'],
    [paperOrderRiskRole, paperOrderRiskPassword, 'ctp_paper_order_risk'],
    [paperRuntimeObserverRole, paperRuntimeObserverPassword, 'ctp_paper_runtime_observer'],
    [paperRuntimeReaderRole, paperRuntimeReaderPassword, 'ctp_paper_runtime_reader'],
    [paperRiskAuthorityRole, paperRiskAuthorityPassword, 'ctp_paper_risk_authority'],
    [marketTradeRole, marketTradePassword, 'ctp_market_trade'],
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
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[2]),
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

  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-funding.integration.test.ts',
      '--outputFile.json=test-results/paper-funding-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[2]),
        DATABASE_RISK_OPERATOR_URL: controlUrl(databases[2], true),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperFundingOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-funding-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperFundingOwner.success, true);
  assert.equal(paperFundingOwner.numPendingTests, 0);
  assert.ok(paperFundingOwner.numPassedTests >= 40);
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-initial-portfolio.integration.test.ts',
      '--outputFile.json=test-results/paper-portfolio-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[2]),
        DATABASE_PAPER_PORTFOLIO_URL: paperPortfolioUrl(databases[2]),
        DATABASE_PORTFOLIO_URL: dbUrl(databases[2], false, false, false, false, true),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperPortfolioOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-portfolio-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperPortfolioOwner.success, true);
  assert.equal(paperPortfolioOwner.numPendingTests, 0);
  assert.ok(paperPortfolioOwner.numPassedTests >= 35);
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/market-trades.integration.test.ts',
      '--outputFile.json=test-results/market-trades-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_MARKET_TRADE_URL: marketTradeUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 120000,
    },
  );
  const marketTradesOwner = JSON.parse(
    await readFile(
      new URL('../test-results/market-trades-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(marketTradesOwner.success, true);
  assert.equal(marketTradesOwner.numFailedTests, 0);
  assert.equal(marketTradesOwner.numPendingTests, 0);
  assert.equal(marketTradesOwner.numPassedTests, 40);
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-market-frames.integration.test.ts',
      '--outputFile.json=test-results/paper-market-frames-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
        DATABASE_MARKET_SNAPSHOT_URL: snapshotUrl(databases[2]),
        DATABASE_MARKET_TRADE_URL: marketTradeUrl(databases[2]),
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperFramesOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-market-frames-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperFramesOwner.success, true);
  assert.equal(paperFramesOwner.numFailedTests, 0);
  assert.equal(paperFramesOwner.numPendingTests, 0);
  assert.equal(paperFramesOwner.numPassedTests, 14);
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-order-drafts.integration.test.ts',
      '--outputFile.json=test-results/paper-order-drafts-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_EXECUTION_URL: dbUrl(databases[2], false, false, false, false, false, true),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperDraftsOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-order-drafts-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperDraftsOwner.success, true);
  assert.equal(paperDraftsOwner.numFailedTests, 0);
  assert.equal(paperDraftsOwner.numPendingTests, 0);
  assert.equal(paperDraftsOwner.numPassedTests, 29);
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-portfolio-bootstrap.integration.test.ts',
      '--outputFile.json=test-results/paper-book-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_EXECUTION_URL: dbUrl(databases[2], false, false, false, false, false, true),
        DATABASE_PORTFOLIO_URL: dbUrl(databases[2], false, false, false, false, true),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[2]),
        DATABASE_PAPER_PORTFOLIO_URL: paperPortfolioUrl(databases[2]),
        DATABASE_PAPER_BOOK_URL: paperBookUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperBookOwner = JSON.parse(
    await readFile(new URL('../test-results/paper-book-owner-tests.json', import.meta.url), 'utf8'),
  );
  assert.equal(paperBookOwner.success, true);
  assert.equal(paperBookOwner.numFailedTests, 0);
  assert.equal(paperBookOwner.numPendingTests, 0);
  assert.equal(paperBookOwner.numPassedTests, 32);
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-book-source.integration.test.ts',
      '--outputFile.json=test-results/paper-book-source-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_EXECUTION_URL: dbUrl(databases[2], false, false, false, false, false, true),
        DATABASE_PORTFOLIO_URL: dbUrl(databases[2], false, false, false, false, true),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[2]),
        DATABASE_PAPER_PORTFOLIO_URL: paperPortfolioUrl(databases[2]),
        DATABASE_PAPER_BOOK_URL: paperBookUrl(databases[2]),
        DATABASE_PAPER_BOOK_SOURCE_URL: paperBookSourceUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperBookSourceOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-book-source-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperBookSourceOwner.success, true);
  assert.equal(paperBookSourceOwner.numFailedTests, 0);
  assert.equal(paperBookSourceOwner.numPendingTests, 0);
  assert.equal(paperBookSourceOwner.numPassedTests, 37);
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-risk-portfolio.integration.test.ts',
      '--outputFile.json=test-results/paper-risk-portfolio-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_EXECUTION_URL: dbUrl(databases[2], false, false, false, false, false, true),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[2]),
        DATABASE_PAPER_BOOK_URL: paperBookUrl(databases[2]),
        DATABASE_PAPER_BOOK_SOURCE_URL: paperBookSourceUrl(databases[2]),
        DATABASE_PAPER_RISK_PORTFOLIO_URL: paperRiskPortfolioUrl(databases[2]),
        DATABASE_PAPER_RISK_VALUATION_URL: paperRiskValuationUrl(databases[2]),
        DATABASE_MARKET_SNAPSHOT_URL: snapshotUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperRiskPortfolioOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-risk-portfolio-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperRiskPortfolioOwner.success, true);
  assert.equal(paperRiskPortfolioOwner.numPassedTests, 44);
  assert.equal(paperRiskPortfolioOwner.numFailedTests, 0);
  assert.equal(paperRiskPortfolioOwner.numPendingTests, 0);
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-risk-loss.integration.test.ts',
      '--outputFile.json=test-results/paper-risk-loss-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_EXECUTION_URL: dbUrl(databases[2], false, false, false, false, false, true),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[2]),
        DATABASE_PAPER_BOOK_URL: paperBookUrl(databases[2]),
        DATABASE_PAPER_BOOK_SOURCE_URL: paperBookSourceUrl(databases[2]),
        DATABASE_PAPER_RISK_PORTFOLIO_URL: paperRiskPortfolioUrl(databases[2]),
        DATABASE_PAPER_RISK_LOSS_URL: paperRiskLossUrl(databases[2]),
        DATABASE_PAPER_RISK_VALUATION_URL: paperRiskValuationUrl(databases[2]),
        DATABASE_MARKET_SNAPSHOT_URL: snapshotUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperRiskLossOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-risk-loss-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperRiskLossOwner.success, true);
  assert.equal(paperRiskLossOwner.numPassedTests, 26);
  assert.equal(paperRiskLossOwner.numFailedTests, 0);
  assert.equal(paperRiskLossOwner.numPendingTests, 0);

  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-order-risk.integration.test.ts',
      '--outputFile.json=test-results/paper-order-risk-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_EXECUTION_URL: dbUrl(databases[2], false, false, false, false, false, true),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[2]),
        DATABASE_PAPER_BOOK_URL: paperBookUrl(databases[2]),
        DATABASE_PAPER_ORDER_RISK_URL: paperOrderRiskUrl(databases[2]),
        DATABASE_MARKET_SNAPSHOT_URL: snapshotUrl(databases[2]),
        DATABASE_MARKET_TRADE_URL: marketTradeUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperOrderRiskOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-order-risk-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperOrderRiskOwner.success, true);
  assert.equal(paperOrderRiskOwner.numPassedTests, 19);
  assert.equal(paperOrderRiskOwner.numFailedTests, 0);
  assert.equal(paperOrderRiskOwner.numPendingTests, 0);

  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-risk-authority.integration.test.ts',
      '--outputFile.json=test-results/paper-risk-authority-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_EXECUTION_URL: dbUrl(databases[2], false, false, false, false, false, true),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[2]),
        DATABASE_PAPER_BOOK_URL: paperBookUrl(databases[2]),
        DATABASE_PAPER_RISK_AUTHORITY_URL: paperRiskAuthorityUrl(databases[2]),
        DATABASE_MARKET_SNAPSHOT_URL: snapshotUrl(databases[2]),
        DATABASE_MARKET_TRADE_URL: marketTradeUrl(databases[2]),
        DATABASE_RISK_POLICY_OPERATOR_URL: policyUrl(databases[2], true),
        DATABASE_RISK_POLICY_CONTROLLER_URL: policyUrl(databases[2]),
        DATABASE_RISK_OPERATOR_URL: controlUrl(databases[2], true),
        DATABASE_RISK_CONTROL_URL: controlUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperRiskAuthorityOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-risk-authority-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperRiskAuthorityOwner.success, true);
  assert.equal(paperRiskAuthorityOwner.numPassedTests, 36);
  assert.equal(paperRiskAuthorityOwner.numFailedTests, 0);
  assert.equal(paperRiskAuthorityOwner.numPendingTests, 0);

  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/database/test/paper-runtime.integration.test.ts',
      '--outputFile.json=test-results/paper-runtime-owner-tests.json',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: dbUrl(databases[2]),
        DATABASE_PAPER_CONFIGURATION_URL: paperConfigurationUrl(databases[2]),
        DATABASE_PAPER_RUNTIME_OBSERVER_URL: paperRuntimeObserverUrl(databases[2]),
        DATABASE_PAPER_RUNTIME_READER_URL: paperRuntimeReaderUrl(databases[2]),
      },
      secrets,
      echo: true,
      timeoutMs: 90000,
    },
  );
  const paperRuntimeOwner = JSON.parse(
    await readFile(
      new URL('../test-results/paper-runtime-owner-tests.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(paperRuntimeOwner.success, true);
  assert.equal(paperRuntimeOwner.numPassedTests, 40);
  assert.equal(paperRuntimeOwner.numFailedTests, 0);
  assert.equal(paperRuntimeOwner.numPendingTests, 0);

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
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[35]),
    path.join(paperMigrations, expectedMigrations[35]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
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

  // Published-36 populated configuration survives the additive funding upgrade.
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[36]),
    path.join(paperMigrations, expectedMigrations[36]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  const { createPostgresPaperFunding } = await import(
    pathToFileURL(path.join(workspace, 'packages/paper-engine/dist/funding.js'))
  );
  const upgradedFunding = await createPostgresPaperFunding({
    connectionString: paperFundingUrl(databases[4]),
    environment: 'test',
  });
  const initialFunding = {
    id: randomUUID(),
    owner: paperInput.owner,
    configurationId: paperInput.id,
    balances: [{ asset: 'USDT', amount: '1000' }],
  };
  let fundingReceipt;
  try {
    fundingReceipt = await upgradedFunding.initialize(initialFunding, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
  } finally {
    await upgradedFunding.close();
  }
  await migrate(databases[4], paperConfig, true);
  const restartedFunding = await createPostgresPaperFunding({
    connectionString: paperFundingUrl(databases[4]),
    environment: 'test',
  });
  try {
    assert.deepEqual(
      await restartedFunding.read(paperInput.owner, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      }),
      fundingReceipt,
    );
  } finally {
    await restartedFunding.close();
  }
  assert.equal(
    (
      await paperUpgrade.query(
        'SELECT count(*)::int n FROM public.ledger_entry WHERE "transactionId"=$1',
        [initialFunding.id],
      )
    ).rows[0].n,
    2,
  );
  assert.deepEqual(
    JSON.parse(
      (
        await paperUpgrade.query('SELECT receipt_text FROM ctp_paper.configuration WHERE id=$1', [
          paperInput.id,
        ])
      ).rows[0].receipt_text,
    ),
    legacyPaperReceipt,
  );
  // Initial-funding provenance from published 37 survives read-only capture.
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[37]),
    path.join(paperMigrations, expectedMigrations[37]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  const { createPostgresPaperInitialPortfolio } = await import(
    pathToFileURL(path.join(workspace, 'packages/paper-engine/dist/portfolio.js'))
  );
  const initialPortfolio = await createPostgresPaperInitialPortfolio({
    connectionString: paperPortfolioUrl(databases[4]),
    environment: 'test',
  });
  let initialSource;
  try {
    initialSource = await initialPortfolio.read(paperInput.owner, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
    assert.deepEqual(initialSource.funding, fundingReceipt);
    assert.deepEqual(initialSource.configuration, legacyPaperReceipt);
    assert.equal(initialSource.state.binding.connectionId, null);
    assert.equal(initialSource.state.balances[0].total, '1000');
  } finally {
    await initialPortfolio.close();
  }
  await migrate(databases[4], paperConfig, true);
  const restartedPortfolio = await createPostgresPaperInitialPortfolio({
    connectionString: paperPortfolioUrl(databases[4]),
    environment: 'test',
  });
  try {
    const source = await restartedPortfolio.read(paperInput.owner, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
    assert.deepEqual(source.funding, fundingReceipt);
    assert.deepEqual(source.state.balances, initialSource.state.balances);
  } finally {
    await restartedPortfolio.close();
  }
  // Published-38 populated funding/configuration survive the isolated public
  // journal migration. No Portfolio book or monetary journal is introduced.
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[38]),
    path.join(paperMigrations, expectedMigrations[38]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  await migrate(databases[4], paperConfig, true);
  const postTradePortfolio = await createPostgresPaperInitialPortfolio({
    connectionString: paperPortfolioUrl(databases[4]),
    environment: 'test',
  });
  try {
    const source = await postTradePortfolio.read(paperInput.owner, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
    assert.deepEqual(source.configuration, legacyPaperReceipt);
    assert.deepEqual(source.funding, fundingReceipt);
    assert.deepEqual(source.state.balances, initialSource.state.balances);
  } finally {
    await postTradePortfolio.close();
  }
  const { createPostgresMarketTrades } = await import(
    pathToFileURL(path.join(workspace, 'packages/market-data/dist/index.js'))
  );
  const upgradedTrades = await createPostgresMarketTrades({
    connectionString: marketTradeUrl(databases[4]),
    environment: 'test',
  });
  try {
    const emptyKey = {
      scope: paperInput.source,
      instrumentId: 'BINANCE:SPOT:BTCUSDT',
      dbInstrumentId: randomUUID(),
      dbRuleId: randomUUID(),
    };
    assert.deepEqual(
      await upgradedTrades.head(emptyKey, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      }),
      { revision: '0', gap: false },
    );
    await assert.rejects(
      upgradedTrades.read(emptyKey, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      }),
      /MARKET_TRADE_MISSING/u,
    );
  } finally {
    await upgradedTrades.close();
  }
  // Published-39 population: retain the original configuration/funding/initial
  // Portfolio receipt while adding the read-only common order binding proof.
  const beforePaperDraftUpgrade = (
    await paperUpgrade.query('SELECT receipt_text FROM ctp_paper.configuration WHERE id=$1', [
      paperInput.id,
    ])
  ).rows[0].receipt_text;
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[39]),
    path.join(paperMigrations, expectedMigrations[39]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  await migrate(databases[4], paperConfig, true);
  const { createPostgresOrderStore } = await import('../packages/order-engine/dist/index.js');
  const upgradedPaperOrders = await createPostgresOrderStore({
    connectionString: dbUrl(databases[4], false, false, false, false, false, true),
    environment: 'test',
  });
  try {
    const binding = {
      ...paperInput.owner,
      connectionId: null,
      externalAccountId: `paper:${paperInput.owner.accountId}`,
      profile: {
        ...paperInput.source,
        accountMode: 'SIMULATED',
        endpointProfileId: 'paper-spot-v1',
        profileVersion: paperInput.model.version,
      },
    };
    assert.equal(
      await upgradedPaperOrders.findCreate(
        binding,
        {
          key: 'upgrade-missing',
          dbInstrumentId: randomUUID(),
          dbRuleId: randomUUID(),
          positionSide: 'NET',
          bucket: 'CROSS',
          order: {
            instrumentId: 'BTCUSDT',
            ruleVersion: 'v1',
            side: 'BUY',
            type: 'MARKET',
            size: { kind: 'BASE_QUANTITY', value: '1', asset: 'BTC' },
            limitPrice: null,
            trigger: null,
            timeInForce: null,
            reduceOnly: false,
          },
        },
        { signal: new AbortController().signal, deadline: Date.now() + 2500 },
      ),
      null,
    );
  } finally {
    await upgradedPaperOrders.close();
  }
  assert.equal(
    (
      await paperUpgrade.query('SELECT receipt_text FROM ctp_paper.configuration WHERE id=$1', [
        paperInput.id,
      ])
    ).rows[0].receipt_text,
    beforePaperDraftUpgrade,
  );
  const retainedPaper = await createPostgresPaperInitialPortfolio({
    connectionString: paperPortfolioUrl(databases[4]),
    environment: 'test',
  });
  try {
    const retained = await retainedPaper.read(paperInput.owner, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
    assert.deepEqual(retained.configuration, legacyPaperReceipt);
    assert.deepEqual(retained.funding, fundingReceipt);
    assert.deepEqual(retained.state.balances, initialSource.state.balances);
  } finally {
    await retainedPaper.close();
  }
  assert.equal(
    (
      await paperUpgrade.query(
        'SELECT count(*)::int n FROM public.ledger_entry WHERE "transactionId"=$1',
        [initialFunding.id],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await paperUpgrade.query(
        'SELECT count(*)::int n FROM ctp_portfolio.book WHERE "accountId"=$1',
        [paperInput.owner.accountId],
      )
    ).rows[0].n,
    0,
  );
  // Published-40 populated upgrade retains the original conserved seed and
  // initial-only guard. New checkpoint authority is isolated and adds no money.
  const beforePaperBookUpgrade = (
    await paperUpgrade.query('SELECT receipt_text FROM ctp_paper.initial_funding WHERE id=$1', [
      initialFunding.id,
    ])
  ).rows[0].receipt_text;
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[40]),
    path.join(paperMigrations, expectedMigrations[40]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  await migrate(databases[4], paperConfig, true);
  const { createPostgresPaperPortfolioBootstrap } =
    await import('../packages/paper-engine/dist/portfolio.js');
  const upgradedBook = await createPostgresPaperPortfolioBootstrap({
    connectionString: paperBookUrl(databases[4]),
    environment: 'test',
  });
  try {
    await assert.rejects(
      upgradedBook.read(paperInput.owner, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      }),
      /PAPER_BOOK_MISSING/,
    );
    const initialBook = await upgradedBook.initialize(paperInput.owner, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
    assert.equal(initialBook.bookId, initialFunding.id);
    assert.equal(initialBook.revision, '1');
    assert.deepEqual(initialBook.state.balances, initialSource.state.balances);
    assert.deepEqual(
      await upgradedBook.initialize(paperInput.owner, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      }),
      initialBook,
    );
    assert.deepEqual(
      await upgradedBook.read(paperInput.owner, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      }),
      initialBook,
    );
  } finally {
    await upgradedBook.close();
  }
  assert.equal(
    (
      await paperUpgrade.query('SELECT receipt_text FROM ctp_paper.initial_funding WHERE id=$1', [
        initialFunding.id,
      ])
    ).rows[0].receipt_text,
    beforePaperBookUpgrade,
  );
  assert.equal(
    (
      await paperUpgrade.query(
        'SELECT count(*)::int n FROM public.ledger_transaction WHERE "accountId"=$1',
        [paperInput.owner.accountId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await paperUpgrade.query(
        'SELECT count(*)::int n FROM public.ledger_entry WHERE "transactionId"=$1',
        [initialFunding.id],
      )
    ).rows[0].n,
    2,
  );
  for (const table of ['ctp_portfolio.book', 'ctp_portfolio.evidence', 'ctp_portfolio.outbox'])
    assert.equal(
      (
        await paperUpgrade.query('SELECT count(*)::int n FROM ' + table + ' WHERE "accountId"=$1', [
          paperInput.owner.accountId,
        ])
      ).rows[0].n,
      1,
    );
  // Genuine populated published-41 book survives additive capture-only 42.
  const { createPostgresPaperBookSource } =
    await import('../packages/paper-engine/dist/portfolio.js');
  await assert.rejects(
    createPostgresPaperBookSource({
      connectionString: paperBookSourceUrl(databases[4]),
      environment: 'test',
    }),
    /PAPER_BOOK_SOURCE_ROLE_UNSAFE/,
  );
  const retainedBookBefore42 = (
    await paperUpgrade.query(
      'SELECT id,revision::text,state,state_hash FROM ctp_portfolio.book WHERE "accountId"=$1',
      [paperInput.owner.accountId],
    )
  ).rows;
  const retainedOriginBefore42 = (
    await paperUpgrade.query('SELECT receipt_text FROM ctp_paper.book_origin WHERE account_id=$1', [
      paperInput.owner.accountId,
    ])
  ).rows;
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[41]),
    path.join(paperMigrations, expectedMigrations[41]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  await migrate(databases[4], paperConfig, true);
  const upgradedBookSource = await createPostgresPaperBookSource({
    connectionString: paperBookSourceUrl(databases[4]),
    environment: 'test',
  });
  try {
    const source = await upgradedBookSource.read(paperInput.owner, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
    assert.equal(source.kind, 'PAPER_BOOK_SOURCE');
    assert.equal(source.bookId, initialFunding.id);
    assert.equal(source.revision, '1');
    assert.deepEqual(source.state.balances, initialSource.state.balances);
    assert.deepEqual(source.drafts, []);
    assert.equal(source.state.snapshotAt, source.origin.createdAt);
    assert.ok(source.asOf >= source.origin.createdAt);
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT id,revision::text,state,state_hash FROM ctp_portfolio.book WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      retainedBookBefore42,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT receipt_text FROM ctp_paper.book_origin WHERE account_id=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      retainedOriginBefore42,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_transaction WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_entry WHERE "transactionId"=$1',
          [initialFunding.id],
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await upgradedBookSource.close();
  }

  // Genuine populated published-42 source remains unchanged by capture-only 43.
  const { createPostgresPaperRiskPortfolioSource } =
    await import('../packages/paper-engine/dist/portfolio.js');
  await assert.rejects(
    createPostgresPaperRiskPortfolioSource({
      connectionString: paperRiskPortfolioUrl(databases[4]),
      environment: 'test',
    }),
    /PAPER_RISK_PORTFOLIO_ROLE_UNSAFE/,
  );
  const bookBefore43 = (
    await paperUpgrade.query(
      'SELECT id,revision::text,state,state_hash FROM ctp_portfolio.book WHERE "accountId"=$1',
      [paperInput.owner.accountId],
    )
  ).rows;
  const originBefore43 = (
    await paperUpgrade.query('SELECT receipt_text FROM ctp_paper.book_origin WHERE account_id=$1', [
      paperInput.owner.accountId,
    ])
  ).rows;
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[42]),
    path.join(paperMigrations, expectedMigrations[42]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  await migrate(databases[4], paperConfig, true);
  const inventory = await createPostgresPaperRiskPortfolioSource({
    connectionString: paperRiskPortfolioUrl(databases[4]),
    environment: 'test',
  });
  try {
    const r = await inventory.read(paperInput.owner, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
    assert.equal(r.kind, 'PAPER_RISK_PORTFOLIO_SOURCE');
    assert.deepEqual(r.accountIds, [paperInput.owner.accountId]);
    assert.equal(r.accounts.length, 1);
    assert.deepEqual(r.accounts[0].state.balances, initialSource.state.balances);
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT id,revision::text,state,state_hash FROM ctp_portfolio.book WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      bookBefore43,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT receipt_text FROM ctp_paper.book_origin WHERE account_id=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      originBefore43,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_transaction WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_entry WHERE "transactionId"=$1',
          [initialFunding.id],
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await inventory.close();
  }

  // Populated published-43 -> additive 44: original quote seed/book/draft.
  const { createPostgresPaperRiskValuationSource } =
    await import('../packages/paper-engine/dist/portfolio.js');
  await assert.rejects(
    createPostgresPaperRiskValuationSource({
      connectionString: paperRiskValuationUrl(databases[4]),
      environment: 'test',
    }),
    /PAPER_RISK_VALUATION_ROLE_UNSAFE/,
  );
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[43]),
    path.join(paperMigrations, expectedMigrations[43]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  await migrate(databases[4], paperConfig, true);
  const valuationSource = await createPostgresPaperRiskValuationSource({
    connectionString: paperRiskValuationUrl(databases[4]),
    environment: 'test',
  });
  try {
    const r = await valuationSource.read(paperInput.owner, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
    assert.equal(r.kind, 'PAPER_RISK_VALUATION_SOURCE');
    assert.equal(r.valuation.equity, '1000');
    assert.deepEqual(r.markets, []);
    assert.equal(
      r.inventory.accounts[0].state.snapshotAt,
      JSON.parse(bookBefore43[0].state).snapshotAt,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT id,revision::text,state,state_hash FROM ctp_portfolio.book WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      bookBefore43,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT receipt_text FROM ctp_paper.book_origin WHERE account_id=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      originBefore43,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_transaction WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_entry WHERE "transactionId"=$1',
          [initialFunding.id],
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await valuationSource.close();
  }
  // Populated published-44 -> additive 45: original quote seed/book/draft.
  const { createPostgresPaperRiskLossSource } =
    await import('../packages/paper-engine/dist/portfolio.js');
  await assert.rejects(
    createPostgresPaperRiskLossSource({
      connectionString: paperRiskLossUrl(databases[4]),
      environment: 'test',
    }),
    /PAPER_RISK_LOSS_ROLE_UNSAFE/,
  );
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[44]),
    path.join(paperMigrations, expectedMigrations[44]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  await migrate(databases[4], paperConfig, true);
  const lossSource = await createPostgresPaperRiskLossSource({
    connectionString: paperRiskLossUrl(databases[4]),
    environment: 'test',
  });
  try {
    const r = await lossSource.read(paperInput.owner, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
    assert.equal(r.kind, 'PAPER_RISK_LOSS_SOURCE');
    assert.equal(r.actualEquity, '1000');
    assert.equal(
      r.inventory.accounts[0].state.snapshotAt,
      JSON.parse(bookBefore43[0].state).snapshotAt,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT id,revision::text,state,state_hash FROM ctp_portfolio.book WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      bookBefore43,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT receipt_text FROM ctp_paper.book_origin WHERE account_id=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      originBefore43,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_transaction WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_entry WHERE "transactionId"=$1',
          [initialFunding.id],
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await lossSource.close();
  }
  // Populated published-45 -> additive 46 retains the original seed/book/draft.
  // Earlier upgrades only checked a missing idempotency key. Provision an
  // actual common draft under published 45; never infer it from an empty lookup.
  const retainedDraftBinding = {
    ...paperInput.owner,
    connectionId: null,
    externalAccountId: `paper:${paperInput.owner.accountId}`,
    profile: {
      ...paperInput.source,
      accountMode: 'SIMULATED',
      endpointProfileId: 'paper-spot-v1',
      profileVersion: paperInput.model.version,
    },
  };
  const retainedInstrument = randomUUID(),
    retainedRule = randomUUID(),
    retainedAt = Date.now();
  const retainedRules = {
    ...registryRecord.rules,
    scope: paperInput.source,
    version: 'paper-upgrade-source-v1',
    effectiveAt: retainedAt - 1000,
    expiresAt: retainedAt + 60000,
  };
  await paperUpgrade.query(
    "INSERT INTO public.instrument(id,exchange,market,mode,\"exchangeSymbol\",\"baseAsset\",\"quoteAsset\",active,\"updatedAt\") VALUES($1,'BINANCE','SPOT','LIVE',$2,'BTC','USDT',true,now())",
    [retainedInstrument, 'PAPER-UPGRADE-' + retainedInstrument],
  );
  await paperUpgrade.query(
    'INSERT INTO public.instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",rules) VALUES($1,$2,1,true,$3,now(),$4,$5,$6,$7,$8,$9,$10::jsonb)',
    [
      retainedRule,
      retainedInstrument,
      new Date(retainedRules.effectiveAt),
      Buffer.alloc(32, 1),
      retainedRules.tickSize,
      retainedRules.stepSize,
      retainedRules.minQuantity,
      retainedRules.maxQuantity,
      retainedRules.minNotional,
      JSON.stringify(retainedRules),
    ],
  );
  const retainedDraft = {
    key: 'published-45-real-draft',
    dbInstrumentId: retainedInstrument,
    dbRuleId: retainedRule,
    positionSide: 'NET',
    bucket: 'CROSS',
    order: {
      instrumentId: 'BTCUSDT',
      ruleVersion: retainedRules.version,
      side: 'BUY',
      type: 'LIMIT',
      size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '1' },
      limitPrice: '10',
      timeInForce: 'GTC',
      trigger: null,
      reduceOnly: false,
    },
  };
  const retainedOrders = await createPostgresOrderStore({
    connectionString: dbUrl(databases[4], false, false, false, false, false, true),
    environment: 'test',
  });
  let retainedOrder;
  try {
    retainedOrder = await retainedOrders.create(retainedDraftBinding, retainedDraft, policyIo());
    assert.equal(retainedOrder.command.clientOrderId, '1');
  } finally {
    await retainedOrders.close();
  }
  const { createPostgresPaperOrderRiskSource } =
    await import('../packages/paper-engine/dist/portfolio.js');
  await assert.rejects(
    createPostgresPaperOrderRiskSource({
      connectionString: paperOrderRiskUrl(databases[4]),
      environment: 'test',
    }),
    /PAPER_ORDER_RISK_ROLE_UNSAFE/,
  );
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[45]),
    path.join(paperMigrations, expectedMigrations[45]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  await migrate(databases[4], paperConfig, true);
  const orderRiskUpgrade = await createPostgresPaperOrderRiskSource({
    connectionString: paperOrderRiskUrl(databases[4]),
    environment: 'test',
  });
  try {
    const replayOrders = await createPostgresOrderStore({
      connectionString: dbUrl(databases[4], false, false, false, false, false, true),
      environment: 'test',
    });
    try {
      assert.deepEqual(
        await replayOrders.findCreate(retainedDraftBinding, retainedDraft, policyIo()),
        retainedOrder,
      );
    } finally {
      await replayOrders.close();
    }
    // This populated historical fixture deliberately has no market heads. A
    // new source must reject missing evidence without renewing the original seed.
    await assert.rejects(
      orderRiskUpgrade.read(
        { owner: paperInput.owner, intentId: retainedOrder.intentId },
        { signal: new AbortController().signal, deadline: Date.now() + 2500 },
      ),
      /PAPER_ORDER_RISK_MARKET/,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT id,revision::text,state,state_hash FROM ctp_portfolio.book WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      bookBefore43,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT receipt_text FROM ctp_paper.book_origin WHERE account_id=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      originBefore43,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_transaction WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_entry WHERE "transactionId"=$1',
          [initialFunding.id],
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await orderRiskUpgrade.close();
  }
  // Populated published-46 -> additive 47: retain the real immutable draft,
  // original funding/book, and the old RPC definition/authority unchanged.
  const originalOrderRiskDefinition = (
    await paperUpgrade.query(
      "SELECT pg_get_functiondef('ctp_paper.capture_order_risk(jsonb)'::regprocedure) definition",
    )
  ).rows[0].definition;
  const { createPostgresPaperRiskAuthoritySource } =
    await import('../packages/paper-engine/dist/risk.js');
  await assert.rejects(
    createPostgresPaperRiskAuthoritySource({
      connectionString: paperRiskAuthorityUrl(databases[4]),
      environment: 'test',
    }),
    /PAPER_RISK_AUTHORITY_ROLE_UNSAFE/,
  );
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[46]),
    path.join(paperMigrations, expectedMigrations[46]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  await migrate(databases[4], paperConfig, true);
  assert.equal(
    (
      await paperUpgrade.query(
        "SELECT pg_get_functiondef('ctp_paper.capture_order_risk(jsonb)'::regprocedure) definition",
      )
    ).rows[0].definition,
    originalOrderRiskDefinition,
  );
  const authorityUpgrade = await createPostgresPaperRiskAuthoritySource({
    connectionString: paperRiskAuthorityUrl(databases[4]),
    environment: 'test',
  });
  try {
    // This populated fixture has deliberately no public market heads: source
    // composition cannot manufacture them or renew the original snapshot.
    await assert.rejects(
      authorityUpgrade.read(
        { owner: paperInput.owner, intentId: retainedOrder.intentId },
        {
          signal: new AbortController().signal,
          deadline: Date.now() + 2500,
        },
      ),
      /PAPER_RISK_AUTHORITY_MARKET/,
    );
    const retained = await createPostgresOrderStore({
      connectionString: dbUrl(databases[4], false, false, false, false, false, true),
      environment: 'test',
    });
    try {
      assert.deepEqual(
        await retained.findCreate(retainedDraftBinding, retainedDraft, policyIo()),
        retainedOrder,
      );
    } finally {
      await retained.close();
    }
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT id,revision::text,state,state_hash FROM ctp_portfolio.book WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      bookBefore43,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT receipt_text FROM ctp_paper.book_origin WHERE account_id=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      originBefore43,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_transaction WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await paperUpgrade.query(
          'SELECT count(*)::int n FROM public.ledger_entry WHERE "transactionId"=$1',
          [initialFunding.id],
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await authorityUpgrade.close();
  }
  // Published-47 -> additive 48 must preserve retained native/draft/book state.
  const beforeRuntimeAuthority = (
    await paperUpgrade.query(
      "SELECT pg_get_functiondef('ctp_paper.capture_risk_authority(jsonb)'::regprocedure) definition",
    )
  ).rows[0].definition;
  const { createPostgresPaperRuntimeObservations, createPostgresPaperRuntimeSource } =
    await import('../packages/paper-engine/dist/runtime.js');
  await assert.rejects(
    createPostgresPaperRuntimeObservations({
      connectionString: paperRuntimeObserverUrl(databases[4]),
      environment: 'test',
    }),
    /PAPER_RUNTIME_ROLE_UNSAFE/,
  );
  await cp(
    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[47]),
    path.join(paperMigrations, expectedMigrations[47]),
    { recursive: true },
  );
  await migrate(databases[4], paperConfig, true);
  await migrate(databases[4], paperConfig, true);
  assert.equal(
    (
      await paperUpgrade.query(
        "SELECT pg_get_functiondef('ctp_paper.capture_risk_authority(jsonb)'::regprocedure) definition",
      )
    ).rows[0].definition,
    beforeRuntimeAuthority,
  );
  const runtimeObserverUpgrade = await createPostgresPaperRuntimeObservations({
    connectionString: paperRuntimeObserverUrl(databases[4]),
    environment: 'test',
  });
  const runtimeReaderUpgrade = await createPostgresPaperRuntimeSource({
    connectionString: paperRuntimeReaderUrl(databases[4]),
    environment: 'test',
  });
  try {
    assert.equal(await runtimeObserverUpgrade.head(paperInput.owner, policyIo()), null);
    assert.equal(
      (await runtimeObserverUpgrade.context(paperInput.owner, policyIo())).configuration
        .configuration.id,
      paperInput.id,
    );
    await assert.rejects(
      runtimeReaderUpgrade.read(paperInput.owner, policyIo()),
      /PAPER_RUNTIME_MISSING/,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT id,revision::text,state,state_hash FROM ctp_portfolio.book WHERE "accountId"=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      bookBefore43,
    );
    assert.deepEqual(
      (
        await paperUpgrade.query(
          'SELECT receipt_text FROM ctp_paper.book_origin WHERE account_id=$1',
          [paperInput.owner.accountId],
        )
      ).rows,
      originBefore43,
    );
    const retained = await createPostgresOrderStore({
      connectionString: dbUrl(databases[4], false, false, false, false, false, true),
      environment: 'test',
    });
    try {
      assert.deepEqual(
        await retained.findCreate(retainedDraftBinding, retainedDraft, policyIo()),
        retainedOrder,
      );
    } finally {
      await retained.close();
    }
  } finally {
    await runtimeObserverUpgrade.close();
    await runtimeReaderUpgrade.close();
  }
  const retainedInitialGuard = await createPostgresPaperInitialPortfolio({
    connectionString: paperPortfolioUrl(databases[4]),
    environment: 'test',
  });
  try {
    await assert.rejects(
      retainedInitialGuard.read(paperInput.owner, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      }),
      /PAPER_PORTFOLIO_INCOMPLETE/,
    );
  } finally {
    await retainedInitialGuard.close();
  }
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
        DATABASE_PAPER_FUNDING_URL: paperFundingUrl(databases[0]),
        DATABASE_PAPER_PORTFOLIO_URL: paperPortfolioUrl(databases[0]),
        DATABASE_PAPER_BOOK_URL: paperBookUrl(databases[0]),
        DATABASE_PAPER_BOOK_SOURCE_URL: paperBookSourceUrl(databases[0]),
        DATABASE_PAPER_RISK_PORTFOLIO_URL: paperRiskPortfolioUrl(databases[0]),
        DATABASE_PAPER_RISK_VALUATION_URL: paperRiskValuationUrl(databases[0]),
        DATABASE_PAPER_RISK_LOSS_URL: paperRiskLossUrl(databases[0]),
        DATABASE_PAPER_ORDER_RISK_URL: paperOrderRiskUrl(databases[0]),
        DATABASE_PAPER_RUNTIME_OBSERVER_URL: paperRuntimeObserverUrl(databases[0]),
        DATABASE_PAPER_RUNTIME_READER_URL: paperRuntimeReaderUrl(databases[0]),
        DATABASE_PAPER_RISK_AUTHORITY_URL: paperRiskAuthorityUrl(databases[0]),
        DATABASE_MARKET_TRADE_URL: marketTradeUrl(databases[0]),
      },
      secrets,
      echo: true,
      // Whole serial suite budget; 1036 cases outgrew the 360s aggregate on CI.
      // This finite orchestration budget does not change any test/SQL/abort deadline.
      timeoutMs: 480000,
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
  assert.equal(
    (await reset.query('SELECT count(*)::int n FROM ctp_paper.initial_funding')).rows[0].n,
    0,
  );
  assert.equal(
    (await reset.query('SELECT count(*)::int n FROM ctp_paper.funding_seal')).rows[0].n,
    0,
  );
  for (const table of ['trade_event', 'trade_seal', 'native_trade_seen', 'trade_head'])
    assert.equal(
      (await reset.query(`SELECT count(*)::int n FROM ctp_market.${table}`)).rows[0].n,
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
    paperFundingNonBypassOwner: 'PASS',
    paperFundingPopulatedUpgradeFromPublished36: 'PASS',
    paperPortfolioNonBypassOwner: 'PASS',
    paperPortfolioPopulatedUpgradeFromPublished37: 'PASS',
    marketTradesNonBypassOwner: 'PASS',
    paperMarketFramesNonBypassOwner: 'PASS',
    marketTradesPopulatedUpgradeFromPublished38: 'PASS',
    paperOrderDraftsNonBypassOwner: 'PASS',
    paperOrderDraftsPopulatedUpgradeFromPublished39: 'PASS',
    paperBookNonBypassOwner: 'PASS',
    paperBookSourceNonBypassOwner: 'PASS',
    paperRiskPortfolioNonBypassOwner: 'PASS',
    paperRiskPortfolioPopulatedUpgradeFromPublished42: 'PASS',
    paperRiskLossNonBypassOwner: 'PASS',
    paperRiskLossPopulatedUpgradeFromPublished44: 'PASS',
    paperOrderRiskNonBypassOwner: 'PASS',
    paperOrderRiskPopulatedUpgradeFromPublished45: 'PASS',
    paperRuntimeNonBypassOwner: 'PASS',
    paperRuntimePopulatedUpgradeFromPublished47: 'PASS',
    paperRiskAuthorityNonBypassOwner: 'PASS',
    paperRiskAuthorityPopulatedUpgradeFromPublished46: 'PASS',
    paperRiskValuationNonBypassOwner: 'PASS',
    paperRiskValuationPopulatedUpgradeFromPublished43: 'PASS',
    paperBookSourcePopulatedUpgradeFromPublished41: 'PASS',
    paperBookPopulatedUpgradeFromPublished40: 'PASS',
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
