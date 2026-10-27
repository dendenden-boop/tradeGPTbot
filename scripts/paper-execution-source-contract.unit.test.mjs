import fs from 'node:fs';
import { expect, it } from 'vitest';
const read = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const current = () =>
  read('packages/database/prisma/migrations/202610270001_paper_execution_source/migration.sql');
const original = () =>
  read('packages/database/prisma/migrations/202610250001_paper_unsent_cancellation/migration.sql');
function header(source) {
  const at = source.indexOf('CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb');
  expect(at).toBeGreaterThan(0);
  return source.slice(at, source.indexOf('AS $$', at)).trim();
}
it('preserves the published reconciliation forwarder settings for every delegated legacy path', () => {
  expect(header(current())).toBe(header(original()));
});
it('adds no table, monetary row, role, sequence or mutation RPC replacement', () => {
  const sql = current();
  expect(sql).not.toMatch(
    /CREATE\s+(?:TABLE|ROLE|SEQUENCE)|INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[a-z_."]+\s+SET/iu,
  );
  expect(sql).not.toMatch(
    /(?:ALTER|CREATE(?:\s+OR\s+REPLACE)?)\s+FUNCTION\s+ctp_paper\.evaluate_and_reserve/iu,
  );
  expect(sql).toContain(
    'ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v57;',
  );
});
it('requires every causal account head before the potentially adopting published inventory helper', () => {
  const sql = current();
  expect(sql.indexOf('LEFT JOIN ctp_paper.admission_book_head')).toBeLessThan(
    sql.indexOf('inv:=ctp_paper.admission_inventory'),
  );
  expect(sql).toContain('(o.book IS NULL OR h.book_id IS NULL)');
  expect(sql).toContain('WHERE x."tenantId"=t AND x.mode=\'PAPER\'');
});
it('captures complete bounded FIFO from the original permanent admission revision without allocating a sequence', () => {
  const sql = current();
  expect(sql).toContain("ORDER BY (x.response->'certificate'->>'revision')::bigint LIMIT 301");
  expect(sql).toContain("IF n>300 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'");
  expect(sql).not.toMatch(/nextval|setval|ORDER BY .*created_ms/iu);
  expect(sql).toContain('IF priority<=previous');
});
it('excludes only actual private NOT_SENT causes while preserving full tenant inventory validation', () => {
  const sql = current();
  expect(sql).toContain('ctp_paper.admission_inventory(r,now_ms)');
  expect(sql).toContain(
    'FROM ctp_paper.withdrawal_barrier w WHERE w.tenant_id=x.tenant_id AND w.reservation_id=x.reservation_id',
  );
  expect(sql).not.toMatch(/status\s*(?:<>|!=)\s*'UNKNOWN'/iu);
});
it('keeps current metadata and epoch validation, original quote liability and freshness deadlines', () => {
  const sql = current();
  for (const part of [
    '"sessionEpoch"=(auth->>\'userSessionEpoch\')',
    '"permissionEpoch"=(auth->>\'permissionEpoch\')',
    'ctp_paper.admission_market(r,cfg,age)',
    "'debits',i.response->'debits'",
    'IF valid_until<=now_ms',
  ])
    expect(sql).toContain(part);
});
it('grants no private helper or old alias access and delegates every old operation unchanged', () => {
  const sql = current();
  expect(sql).toContain(
    'REVOKE ALL ON FUNCTION ctp_paper.capture_execution_candidates(jsonb),ctp_paper.reconcile_admission_v57(jsonb),',
  );
  expect(sql.match(/GRANT EXECUTE ON FUNCTION[^;]+;/gu)).toEqual([
    'GRANT EXECUTE ON FUNCTION ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;',
  ]);
  expect(sql).toContain('RETURN ctp_paper.reconcile_admission_v57(p);');
});
it('requires additive58 fresh-owner, populated57 retention/redeploy/reset and full original native coverage', () => {
  const runner = read('scripts/test-database.mjs');
  expect(runner).toContain("'202610270001_paper_execution_source'");
  expect(runner).toContain('paperAdmissionOwner.numPassedTests, 53');
  expect(runner).toContain('verifyPaperExecutionSourceUpgrade(');
  for (const block of [
    'IMPORT',
    'MIGRATION',
    'OWNER',
    'UPGRADE',
    'RESET_BEFORE',
    'RESET_AFTER',
    'FLAGS',
  ]) {
    expect(runner).toContain('// BEGIN PAPER EXECUTION SOURCE ' + block);
    expect(runner).toContain('// END PAPER EXECUTION SOURCE ' + block);
  }
  expect(read('scripts/native-proof-artifacts.mjs')).toContain("'paper-admission': 53");
  expect(read('scripts/native-proof-artifacts.mjs')).toContain('passed(native, 1384, 480000)');
});
it('pins all six actual native scenarios without a new financial reader cache or lower owner deadline', () => {
  const source = read('packages/database/test/paper-admission.integration.test.ts');
  const additions = source.slice(source.indexOf('// BEGIN PAPER EXECUTION SOURCE TESTS'));
  expect(additions.match(/it\('paper-execution:/gu)).toHaveLength(6);
  expect(read('scripts/native-proof-artifacts.mjs')).toContain("'paper-admission': 90000");
  expect(read('scripts/database-cohorts.mjs')).toContain('480000');
  expect(read('scripts/test-database.mjs')).toContain('beforeUnknownTests.numPendingTests, 36');
  expect(read('scripts/test-database.mjs')).toContain('beforeWithdrawalTests.numPendingTests, 51');
  expect(read('scripts/test-database.mjs')).toContain('beforeReleaseTests.numPendingTests, 52');
});
