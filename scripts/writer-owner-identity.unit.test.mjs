import { expect, it } from 'vitest';
const subject = await import('./writer-owner-suite.mjs');
const role = 'ctp_p2_owner_deadbeef1234';
const identity = () => ({
  owner_name: role,
  owner_oid: '77',
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolreplication: false,
  rolcreaterole: true,
  rolcanlogin: true,
  rolinherit: true,
});
it('accepts the existing migration-only CREATEROLE owner without adding privileges to any runtime login', () => {
  expect(subject.requireWriterMigrationOwner).toBeTypeOf('function');
  expect(() => subject.requireWriterMigrationOwner(identity(), role)).not.toThrow();
});
it.each([
  'rolsuper',
  'rolbypassrls',
  'rolcreatedb',
  'rolreplication',
  'rolcreaterole',
  'rolcanlogin',
  'rolinherit',
  'owner_name',
  'owner_oid',
])('rejects a changed actual migration-owner profile: %s', (field) => {
  expect(subject.requireWriterMigrationOwner).toBeTypeOf('function');
  const value = identity();
  value[field] = typeof value[field] === 'boolean' ? !value[field] : 'unexpected';
  expect(() => subject.requireWriterMigrationOwner(value, role)).toThrow();
});
