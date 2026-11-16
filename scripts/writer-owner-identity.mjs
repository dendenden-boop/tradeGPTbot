// CI migration owner only. This never changes any PostgreSQL role or grant.
import assert from 'node:assert/strict';
export function requireWriterMigrationOwner(row, ownerRole) {
  assert.match(ownerRole, /^ctp_p2_owner_[a-f0-9]{12}$/u);
  assert.equal(row.owner_name, ownerRole);
  assert.match(row.owner_oid, /^[1-9][0-9]*$/u);
  const flags = {
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolreplication: false,
    rolcreaterole: true,
    rolcanlogin: true,
    rolinherit: true,
  };
  for (const [flag, expected] of Object.entries(flags)) assert.equal(row[flag], expected);
  return { owner_name: row.owner_name, owner_oid: row.owner_oid, ...flags };
}
