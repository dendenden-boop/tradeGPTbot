import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import {
  writerOwnerJobs,
  prepareWriterOwnerClone,
  runWriterOwnerSuite,
} from './writer-owner-suite.mjs';
import { writerOwnerCases } from './writer-owner-manifest.mjs';
const names = ['ctp_p2_owner_deadbeef1234', 'ctp_p2_writer_owner_deadbeef1234'];
const env = (database) => ({
  NODE_ENV: 'test',
  CTP_TEST_PROJECT: 'ctp-integration-1-aaaaaaaaaaaa',
  DATABASE_MIGRATION_URL:
    'postgresql://ctp_test:' + 'a'.repeat(48) + '@127.0.0.1:12345/' + database,
  DATABASE_PAPER_ADMISSION_URL:
    'postgresql://ctp_p2_risk_deadbeef1234:' + 'b'.repeat(48) + '@127.0.0.1:12345/' + database,
});
const args = [
  path.resolve('node_modules/vitest/vitest.mjs'),
  'run',
  '--config',
  'vitest.database.config.ts',
  'packages/database/test/paper-execution-commit.integration.test.ts',
  '--outputFile.json=test-results/paper-execution-commit-owner-tests.json',
];
const options = () => ({
  env: env(names[0]),
  secondaryEnv: env(names[1]),
  ownership: names.map((database) => ({ database })),
  timeoutMs: 90000,
});
it('does not grant a fresh90s allowance if the pre-provisioning budget anchor is missing', async () => {
  await expect(runWriterOwnerSuite(process.execPath, args, options())).rejects.toThrow(
    'WRITER_OWNER_BUDGET_REQUIRED',
  );
});
it('does not expose a malformed private credential in route validation diagnostics', () => {
  const o = options(),
    secret = 'must-not-leak-private-credential';
  o.secondaryEnv.DATABASE_MIGRATION_URL = o.secondaryEnv.DATABASE_MIGRATION_URL.replace(
    'a'.repeat(48),
    secret,
  );
  let error;
  try {
    writerOwnerJobs(process.execPath, args, o);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain(secret);
});
it('keeps every original native case identity and selects exactly20/29 in two controlled environments', () => {
  const text = readFileSync(args[4], 'utf8'),
    ast = ts.createSourceFile('native.ts', text, ts.ScriptTarget.Latest, true),
    actual = [];
  function visit(node, parents = []) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['it', 'describe'].includes(node.expression.text) &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      if (node.expression.text === 'it') {
        actual.push([...parents, node.arguments[0].text].join(' '));
        return;
      }
      ts.forEachChild(node.arguments[1], (n) => visit(n, [...parents, node.arguments[0].text]));
      return;
    }
    ts.forEachChild(node, (n) => visit(n, parents));
  }
  visit(ast);
  expect(actual).toEqual(writerOwnerCases);
  const jobs = writerOwnerJobs(process.execPath, args, options());
  expect(jobs).toHaveLength(2);
  expect(
    jobs.map(
      (j) =>
        writerOwnerCases.filter((name) =>
          new RegExp(j.args[j.args.indexOf('-t') + 1], 'u').test(name),
        ).length,
    ),
  ).toEqual([20, 29]);
  expect(jobs[0].env.DATABASE_MIGRATION_URL).not.toBe(jobs[1].env.DATABASE_MIGRATION_URL);
});
it.each([
  'same database',
  'foreign environment',
  'foreign endpoint',
  'different project',
  'different port',
  'excessive budget',
  'extra selector',
  'wrong output',
])('rejects uncontrolled writer route or selection: %s', (defect) => {
  const o = options(),
    a = [...args];
  if (defect === 'same database') o.ownership[1].database = o.ownership[0].database;
  if (defect === 'foreign environment') o.secondaryEnv.NODE_ENV = 'production';
  if (defect === 'foreign endpoint')
    o.secondaryEnv.DATABASE_MIGRATION_URL = o.secondaryEnv.DATABASE_MIGRATION_URL.replace(
      '127.0.0.1',
      'example.invalid',
    );
  if (defect === 'different project')
    o.secondaryEnv.CTP_TEST_PROJECT = 'ctp-integration-2-deadbeef1234';
  if (defect === 'different port')
    o.secondaryEnv.DATABASE_MIGRATION_URL = o.secondaryEnv.DATABASE_MIGRATION_URL.replace(
      ':12345/',
      ':12346/',
    );
  if (defect === 'excessive budget') o.timeoutMs = 180000;
  if (defect === 'extra selector') a.push('-t', 'only one');
  if (defect === 'wrong output') a[a.length - 1] = '--outputFile.json=../outside.json';
  expect(() => writerOwnerJobs(process.execPath, a, o)).toThrow();
});
it('clones only the owned owner database and verifies both actual71-migration/non-bypass databases', async () => {
  const admin = { query: vi.fn(async () => ({ rows: [] })) },
    closed = [],
    verified = [],
    connect = (database) => ({
      query: async (sql) => ({
        rows: sql.includes('pg_database')
          ? [
              {
                oid: database === names[0] ? '101' : '102',
                owner_oid: '77',
                owner_name: names[0],
                restricted: true,
                acl: [{ grantor: '77', grantee: '0', privilege: 'CONNECT', grantable: false }],
              },
            ]
          : Array.from({ length: 71 }, (_, i) => ({
              migration_name: String(i),
              checksum: 'a'.repeat(64),
            })),
      }),
      end: async () => {
        closed.push(database);
      },
    });
  const result = await prepareWriterOwnerClone({
    admin,
    source: names[0],
    clone: names[1],
    ownerRole: names[0],
    connect,
    verify: async (client) => {
      verified.push(client);
    },
  });
  expect(admin.query.mock.calls.map((a) => a[0])).toEqual([
    'CREATE DATABASE "' + names[1] + '" TEMPLATE "' + names[0] + '" OWNER "' + names[0] + '"',
    'REVOKE CREATE,TEMP ON DATABASE "' + names[1] + '" FROM PUBLIC',
  ]);
  expect(verified).toHaveLength(2);
  expect(closed).toEqual(names);
  expect(result[0].migrationDigest).toBe(result[1].migrationDigest);
  expect(result[0].oid).not.toBe(result[1].oid);
});
