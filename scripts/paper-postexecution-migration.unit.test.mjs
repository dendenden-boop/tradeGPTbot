import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { currentOrderRiskCaptureQuery } from '../packages/paper-engine/src/current-order-risk-query.ts';
import {
  beforePostexecutionMigration,
  postexecutionMigrationReview,
} from './paper-postexecution-migration-legacy.mjs';

const root = 'packages/database/prisma/migrations';
const name = '202611240001_paper_postexecution_reservation';
const sql = (migration) =>
  readFileSync(`${root}/${migration}/migration.sql`, 'utf8').replaceAll('\r\n', '\n');
const sha = (source) => createHash('sha256').update(source).digest('hex');

it.each(Object.entries(postexecutionMigrationReview))(
  'reconstructs the exact prior harness and rejects unreviewed changes to %s',
  (file, review) => {
    const source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    expect(sha(source)).toBe(review.current);
    expect(sha(beforePostexecutionMigration(file, source))).toBe(review.predecessor);
    expect(() => beforePostexecutionMigration(file, source + '// unexpected\n')).toThrow(
      'PAPER_POSTEXECUTION_REVIEW_REQUIRED',
    );
  },
);

it('appends the successor as migration 72 without changing the accepted migration chain', () => {
  const migrations = readdirSync(root)
    .filter((entry) => /^\d/u.test(entry))
    .sort();
  expect(migrations).toHaveLength(72);
  expect(migrations[71]).toBe(name);
  expect(sha(JSON.stringify(migrations.slice(0, 71).map((m) => [m, sha(sql(m))])))).toBe(
    'ad28b7cf464ffafa8cd97bb790cc168dda81508df9bbc48f574d363a114c276a',
  );
});

it('installs the cause, deferred guard, mirrored current Risk proof and writer in a single transaction', () => {
  const source = sql(name);
  expect(source.match(/^BEGIN;$/gmu)).toHaveLength(1);
  expect(source.match(/^COMMIT;$/gmu)).toHaveLength(1);
  expect(source.startsWith('BEGIN;\n')).toBe(true);
  expect(source.endsWith('\nCOMMIT;\n')).toBe(true);
  const body = /AS \$postexecution_proof\$\n([\s\S]+?)\n\$postexecution_proof\$;/u.exec(
    source,
  )?.[1];
  expect(body).toBe(
    currentOrderRiskCaptureQuery
      .replace('ctp_paper.reconcile_admission($1::jsonb)', '$1::jsonb')
      .trim(),
  );
  expect(source).toContain('CREATE CONSTRAINT TRIGGER postexecution_causality');
  expect(source).toContain('CREATE FUNCTION ctp_paper.postexecution_reserve');
  expect(source).toContain(
    'ALTER TABLE ctp_paper.postexecution_commitment FORCE ROW LEVEL SECURITY',
  );
});
