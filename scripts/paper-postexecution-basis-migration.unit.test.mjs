import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

const root = 'packages/database/prisma/migrations';
const predecessor = '202611240001_paper_postexecution_reservation';
const name = '202611250001_paper_postexecution_preparation_basis';
const sql = (migration) =>
  readFileSync(`${root}/${migration}/migration.sql`, 'utf8').replaceAll('\r\n', '\n');
const sha = (source) => createHash('sha256').update(source).digest('hex');

it('publishes only an additive migration after the accepted 72-file chain', () => {
  const migrations = readdirSync(root)
    .filter((entry) => /^\d/u.test(entry))
    .sort();
  expect(migrations.slice(72)).toEqual([name]);
  expect(
    sha(JSON.stringify(migrations.slice(0, 72).map((entry) => [entry, sha(sql(entry))]))),
  ).toBe('96ff887a966223532fa616bcb7dc669bfc7440f5eb08955270e4d7c7309d39fa');
});

it('adds one restricted read branch while retaining every existing reconciliation route', () => {
  const source = sql(name);
  expect(source.startsWith('BEGIN;\n')).toBe(true);
  expect(source.endsWith('\nCOMMIT;\n')).toBe(true);
  const previous = sql(predecessor).match(
    /^CREATE FUNCTION ctp_paper\.reconcile_admission\(p jsonb\)[\s\S]+?^END \$\$;/mu,
  )?.[0];
  expect(previous).toBeDefined();
  const reader = source.match(
    /^CREATE OR REPLACE FUNCTION ctp_paper\.reconcile_admission\(p jsonb\)[\s\S]+?^END \$\$;/mu,
  )?.[0];
  expect(
    reader
      ?.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')
      .replace(
        " IF p->>'kind'='PAPER_POSTEXECUTION_BASIS_READ' THEN RETURN ctp_paper.postexecution_basis(p); END IF;\n",
        '',
      ),
  ).toBe(previous);
  expect(source).toContain(
    'REVOKE ALL ON FUNCTION ctp_paper.postexecution_basis(jsonb) FROM PUBLIC,ctp_paper_risk_admission;',
  );
  expect(source).not.toMatch(
    /^\s*(?:GRANT|ALTER TABLE|CREATE TABLE|INSERT INTO|UPDATE \S+ SET|DELETE FROM)\b/imu,
  );
});
