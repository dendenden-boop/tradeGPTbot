// Explicit local provisioning. Runtime images do not contain this DDL tool or migration credentials.
import { createRequire } from 'node:module';
import { run } from './docker-test-utils.mjs';
import { createDatabase, createAuthDatabase } from '../packages/database/dist/index.js';

const databaseRequire = createRequire(
  new URL('../packages/database/package.json', import.meta.url),
);
const { Pool } = databaseRequire('pg');
const secretFields = ['POSTGRES_PASSWORD', 'POSTGRES_API_PASSWORD', 'POSTGRES_AUTH_PASSWORD'];
if (
  !['development', 'test'].includes(process.env.NODE_ENV) ||
  secretFields.some((field) => !/^[a-f0-9]{48}$/u.test(process.env[field] ?? ''))
) {
  throw new Error('Local provisioning requires generated development/test credentials');
}
const host = process.env.CTP_LOCAL_POSTGRES_HOST ?? '127.0.0.1';
if (!['postgres', '127.0.0.1'].includes(host))
  throw new Error('Local provisioning requires owned PostgreSQL');
const url = `postgresql://ctp:${process.env.POSTGRES_PASSWORD}@${host}:5432/ctp`;
const pool = new Pool({
  connectionString: url,
  max: 1,
  connectionTimeoutMillis: 1000,
  statement_timeout: 30_000,
  query_timeout: 31_000,
});
pool.on('error', () => {});
try {
  await pool.query('SELECT pg_advisory_lock(731493, 3)');
  await run(
    process.execPath,
    [
      databaseRequire.resolve('prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      'packages/database/prisma.config.ts',
    ],
    {
      env: { ...process.env, DATABASE_MIGRATION_URL: url },
      secrets: secretFields.map((field) => process.env[field]),
      echo: false,
    },
  );
  for (const [name, group, field] of [
    ['ctp_api_login', 'ctp_api', 'POSTGRES_API_PASSWORD'],
    ['ctp_auth_login', 'ctp_auth', 'POSTGRES_AUTH_PASSWORD'],
  ]) {
    const existing = await pool.query(
      'SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,rolcanlogin FROM pg_roles WHERE rolname=$1',
      [name],
    );
    if (!existing.rows[0]) {
      // Names are fixed and generated passwords validated as exact 48-character hex above.
      await pool.query(
        `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${process.env[field]}'`,
      );
    } else if (
      !existing.rows[0].rolcanlogin ||
      Object.entries(existing.rows[0]).some(([key, value]) => key !== 'rolcanlogin' && value)
    ) {
      throw new Error('Existing local runtime role is unsafe');
    }
    await pool.query(`GRANT ${group} TO ${name}`);
    const probe = await (group === 'ctp_api' ? createDatabase : createAuthDatabase)({
      connectionString: `postgresql://${name}:${process.env[field]}@${host}:5432/ctp`,
      environment: process.env.NODE_ENV,
    });
    try {
      await probe.ready();
    } finally {
      await probe.close();
    }
  }
  console.log('Local migrations and separate API/auth database roles are ready.');
} catch {
  console.error(
    'Local provisioning failed. Existing passwords were not changed; inspect role ownership and migration state locally.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
