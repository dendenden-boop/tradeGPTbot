import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, report, workspace } from './docker-test-utils.mjs';

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
const secrets = [decodeURIComponent(adminUrl.password), password];
const suffix = randomBytes(6).toString('hex');
const databases = [`ctp_p2_fresh_${suffix}`, `ctp_p2_upgrade_${suffix}`];
const runtimeRole = `ctp_p2_runtime_${suffix}`;
const identifier = (name) => {
  if (!/^ctp_p2_[a-z0-9_]+$/.test(name)) throw new Error('Refusing unrelated database object');
  return `"${name}"`;
};
const prisma = databaseRequire.resolve('prisma/build/index.js');
const config = 'packages/database/prisma.config.ts';
const startedAt = new Date().toISOString();
let outcome = { status: 'FAIL', startedAt, project };
const pools = new Set();
const connect = (url) => {
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 1000,
    query_timeout: 5000,
  });
  pool.on('error', () => {});
  pools.add(pool);
  return pool;
};
const admin = connect(adminUrl.href);
const dbUrl = (name, runtime = false) => {
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  if (runtime) {
    url.username = runtimeRole;
    url.password = password;
  }
  return url.href;
};
const migrate = async (name, selectedConfig = config) => {
  try {
    return await run(process.execPath, [prisma, 'migrate', 'deploy', '--config', selectedConfig], {
      env: { ...process.env, DATABASE_MIGRATION_URL: dbUrl(name) },
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
      if (!['202609070001_initial', '202609070002_integrity'].includes(migration)) throw error;
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
  for (const name of databases) await admin.query(`CREATE DATABASE ${identifier(name)}`);
  await migrate(databases[0]);
  await migrate(databases[0]);
  const fresh = connect(dbUrl(databases[0]));
  assert.equal(
    (
      await fresh.query(
        'SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      )
    ).rows[0].n,
    2,
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
    2,
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

  await admin.query(
    `CREATE ROLE ${identifier(runtimeRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  await admin.query(`GRANT ctp_api TO ${identifier(runtimeRole)}`);
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
      },
      secrets,
      echo: true,
      timeoutMs: 180000,
    },
  );
  const tests = JSON.parse(
    await readFile(new URL('../test-results/database-tests.json', import.meta.url), 'utf8'),
  );
  assert.equal(tests.success, true);
  assert.ok(tests.numPassedTests > 0);

  // Reset ONLY the DB name created above, then reapply the same versioned migrations.
  await fresh.end();
  pools.delete(fresh);
  await admin.query(`DROP DATABASE ${identifier(databases[0])} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${identifier(databases[0])}`);
  await migrate(databases[0]);
  const reset = connect(dbUrl(databases[0]));
  assert.equal((await reset.query('SELECT count(*)::int n FROM "user"')).rows[0].n, 0);
  outcome = {
    ...outcome,
    status: 'PASS',
    fresh: 'PASS',
    upgradePreservesData: 'PASS',
    upgradeSealsExistingLedger: 'PASS',
    repeatedDeploy: 'PASS',
    isolatedReset: 'PASS',
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
