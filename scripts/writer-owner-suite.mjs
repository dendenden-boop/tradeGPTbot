// Private acceptance orchestration. The original sequential native49 proof stays.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { workspace } from './docker-test-utils.mjs';
import { remainingNativeBudget } from './native-proof-window.mjs';
import { runOwnedWriterProcesses } from './writer-owner-processes.mjs';
import { requireWriterMigrationOwner } from './writer-owner-identity.mjs';
export { requireWriterMigrationOwner };
import {
  writerOwnerPartitions,
  mergeWriterOwnerReports,
  requireWriterOwnerProof,
  verifyWriterOwnerInputs,
} from './writer-owner-partitions.mjs';
const file = 'packages/database/test/paper-execution-commit.integration.test.ts';
const output = '--outputFile.json=test-results/paper-execution-commit-owner-tests.json';
export function writerOwnerJobs(binary, args, { env, secondaryEnv, ownership, timeoutMs }) {
  try {
    assert.equal(timeoutMs, 90000);
    assert.equal(binary, process.execPath);
    assert.equal(args.length, 6);
    assert.equal(path.basename(args[0]), 'vitest.mjs');
    assert(path.resolve(args[0]).startsWith(path.resolve(workspace, 'node_modules') + path.sep));
    assert.deepEqual(args.slice(1), ['run', '--config', 'vitest.database.config.ts', file, output]);
    assert.equal(ownership.length, 2);
    assert.notEqual(ownership[0].database, ownership[1].database);
    // Database and Compose project nonces are independently server-generated.
    const suffix = /^ctp_p2_owner_([a-f0-9]{12})$/u.exec(ownership[0].database ?? '')?.[1];
    assert(suffix);
    assert.equal(ownership[0].database, 'ctp_p2_owner_' + suffix);
    assert.equal(ownership[1].database, 'ctp_p2_writer_owner_' + suffix);
    let host;
    for (const [index, values] of [env, secondaryEnv].entries()) {
      assert.equal(values.NODE_ENV, 'test');
      assert.match(values.CTP_TEST_PROJECT, /^ctp-integration-\d{1,16}-[a-f0-9]{12}$/u);
      assert.equal(values.CTP_TEST_PROJECT, env.CTP_TEST_PROJECT);
      for (const [key, value] of Object.entries(values))
        if (key.startsWith('DATABASE_')) {
          const u = new URL(value);
          assert.equal(u.protocol, 'postgresql:');
          assert.equal(u.hostname, '127.0.0.1');
          assert.equal(u.pathname, '/' + ownership[index].database);
          assert.equal(u.search, '');
          assert.equal(u.hash, '');
          assert.match(u.password, /^[a-f0-9]{48}$/u);
          host ??= u.host;
          assert.equal(u.host, host);
        }
      assert(values.DATABASE_MIGRATION_URL);
      assert(values.DATABASE_PAPER_ADMISSION_URL);
    }
    return writerOwnerPartitions.map((p, index) => ({
      id: p.id,
      binary,
      args: [
        ...args.slice(0, -1),
        '-t',
        p.pattern.source,
        '--outputFile.json=test-results/' + p.report + '.json',
      ],
      env: { ...(index === 0 ? env : secondaryEnv) },
    }));
  } catch {
    // Validation errors must never print private server credentials or URLs.
    throw Error('WRITER_OWNER_ROUTE_INVALID');
  }
}
export async function runWriterOwnerSuite(binary, args, options) {
  if (
    !options.budgetStarted ||
    !Number.isFinite(options.budgetStarted.monotonic) ||
    !Number.isSafeInteger(options.budgetStarted.wall)
  )
    throw Error('WRITER_OWNER_BUDGET_REQUIRED');
  const jobs = writerOwnerJobs(binary, args, options);
  await verifyWriterOwnerInputs();
  assert(remainingNativeBudget(options.window) >= 90000);
  const execution = await runOwnedWriterProcesses(jobs, {
    timeoutMs: 90000,
    secrets: options.secrets,
    echo: options.echo,
    budgetStarted: options.budgetStarted,
  });
  const raw = await Promise.all(
    writerOwnerPartitions.map((p) =>
      readFile(path.resolve(workspace, 'test-results', p.report + '.json')),
    ),
  );
  const merged = mergeWriterOwnerReports(raw, execution, options.ownership, options.window);
  requireWriterOwnerProof(merged, raw, options.window);
  await writeFile(
    path.resolve(workspace, 'test-results/paper-execution-commit-owner-tests.json'),
    JSON.stringify(merged, null, 2) + '\n',
  );
  return merged;
}
export async function prepareWriterOwnerClone({
  admin,
  source,
  clone,
  ownerRole,
  connect,
  verify,
}) {
  const suffix = /^ctp_p2_owner_([a-f0-9]{12})$/u.exec(source)?.[1];
  assert(suffix);
  assert.equal(clone, 'ctp_p2_writer_owner_' + suffix);
  assert.equal(ownerRole, 'ctp_p2_owner_' + suffix);
  const identifier = (name) => '"' + name + '"';
  await admin.query(
    `CREATE DATABASE ${identifier(clone)} TEMPLATE ${identifier(source)} OWNER ${identifier(ownerRole)}`,
  );
  await admin.query(`REVOKE CREATE,TEMP ON DATABASE ${identifier(clone)} FROM PUBLIC`);
  const result = [];
  for (const database of [source, clone]) {
    const client = connect(database);
    try {
      await verify(client);
      const identity = (
        await client.query(`SELECT d.oid::text oid,d.datdba::text owner_oid,r.rolname owner_name,
        r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolreplication,r.rolcreaterole,r.rolcanlogin,r.rolinherit,
        (SELECT jsonb_agg(jsonb_build_object('grantor',a.grantor::text,'grantee',a.grantee::text,'privilege',a.privilege_type,'grantable',a.is_grantable)
         ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable)
         FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a) acl
        FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database()`)
      ).rows;
      assert.equal(identity.length, 1);
      // The existing migration-only owner has CREATEROLE for published DDL.
      // Runtime logins retain their original NOCREATEROLE/non-bypass profile.
      const ownerProfile = requireWriterMigrationOwner(identity[0], ownerRole);
      const migrations = (
        await client.query(
          'SELECT migration_name,checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name',
        )
      ).rows;
      assert.equal(migrations.length, 73);
      const migrationDigest = createHash('sha256').update(JSON.stringify(migrations)).digest('hex');
      result.push({
        database,
        oid: identity[0].oid,
        migrations: 73,
        migrationDigest,
        nonBypassOwner: true,
        ownerOid: identity[0].owner_oid,
        ownerProfile,
        dbAclDigest: createHash('sha256').update(JSON.stringify(identity[0].acl)).digest('hex'),
      });
    } finally {
      await client.end();
    }
  }
  assert.notEqual(result[0].oid, result[1].oid);
  assert.equal(result[0].migrationDigest, result[1].migrationDigest);
  assert.equal(result[0].ownerOid, result[1].ownerOid);
  assert.equal(result[0].dbAclDigest, result[1].dbAclDigest);
  return result;
}
