import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyAdmissionParallelFiles } from './database-cohorts.mjs';
import { beforePublicMarketWriters } from './public-market-fixture-legacy.mjs';
import { beforePreparedExecutionSource } from './prepared-execution-source-legacy.mjs';
const read = (p) =>
  beforePublicMarketWriters(
    p,
    beforePreparedExecutionSource(
      p,
      fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
    ),
  );
const sql = () =>
  read('packages/database/prisma/migrations/202610270002_paper_attempt_journal/migration.sql');
it('preserves published BEFORE TRUNCATE errors through cause checks without adding foreign-key dependencies on old tables', () => {
  const s = sql();
  expect(s).not.toMatch(/REFERENCES ctp_paper\.(?:withdrawal_barrier|admission_issuance)\(/u);
  expect(s).toContain('CREATE TRIGGER attempt_preparation_cause BEFORE INSERT');
  expect(s).toContain('CREATE TRIGGER attempt_not_sent_cause BEFORE INSERT');
  expect(s).toContain('w.reservation_id<>j.reservation_id');
});
it('adds two private immutable forced-RLS journals and grants only the original two RPCs', () => {
  const s = sql();
  expect(s.match(/CREATE TABLE /gu)).toHaveLength(2);
  for (const table of ['attempt_preparation', 'attempt_not_sent']) {
    expect(s).toContain(`ALTER TABLE ctp_paper.${table} FORCE ROW LEVEL SECURITY;`);
    expect(s).toContain(`BEFORE UPDATE OR DELETE ON ctp_paper.${table}`);
    expect(s).toContain(`BEFORE TRUNCATE ON ctp_paper.${table}`);
  }
  expect(s.match(/GRANT [^;]+;/gu)).toEqual([
    'GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;',
  ]);
  expect(s).not.toMatch(
    /CREATE ROLE|INSERT INTO public\.|UPDATE public\.|DELETE FROM public\.|CREATE SEQUENCE/iu,
  );
});
it('retains current epochs before permanent replay and full current inventory only for a new preparation', () => {
  const s = sql(),
    at = s.indexOf('CREATE FUNCTION ctp_paper.attempt_journal('),
    body = s.slice(at);
  expect(body.indexOf('"permissionEpoch"=')).toBeLessThan(
    body.indexOf('SELECT * INTO j FROM ctp_paper.attempt_preparation'),
  );
  expect(body.indexOf('IF read_only THEN RETURN')).toBeLessThan(
    body.indexOf('PERFORM ctp_paper.capture_execution_candidates'),
  );
  expect(body).toContain("sem:=p-'kind'-'authorization'");
  expect(body).toContain('ctp_paper.withdraw_before_dispatch(w.request,true)');
});
it('runs additive59 populated58 deploy/redeploy/reset and all61 owner contracts without changing deadlines', () => {
  const r = read('scripts/test-database.mjs'),
    proof = read('scripts/native-proof-artifacts.mjs');
  for (const block of [
    'IMPORT',
    'MIGRATION',
    'OWNER',
    'UPGRADE',
    'RESET_BEFORE',
    'RESET_AFTER',
    'FLAGS',
  ]) {
    expect(r).toContain('// BEGIN PAPER ATTEMPT JOURNAL ' + block);
    expect(r).toContain('// END PAPER ATTEMPT JOURNAL ' + block);
  }
  expect(r).toContain('paperAdmissionOwner.numPassedTests, 61');
  expect(r).toContain('beforeUnknownTests.numPendingTests, 44');
  expect(r).toContain('beforeWithdrawalTests.numPendingTests, 59');
  expect(r).toContain('beforeReleaseTests.numPendingTests, 60');
  expect(proof).toContain("'paper-admission': 61");
  expect(proof).toContain('passed(native, 1392, 480000)');
  expect(proof).toContain("'paper-admission': 90000");
  expect(read('scripts/integration-proof.mjs')).toContain('full: 1020000');
  expect(
    read('packages/database/test/paper-admission.integration.test.ts').match(
      /it\('paper-attempt-journal:/gu,
    ),
  ).toHaveLength(8);
});
it('explicitly retains all published58 native statements and passes renewed cluster-role isolation fingerprints', async () => {
  const text = read('packages/database/test/paper-admission.integration.test.ts');
  const before = text.replace(
    /^[ \t]*\/\/ BEGIN PAPER ATTEMPT JOURNAL ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER ATTEMPT JOURNAL \1\n/gm,
    '',
  );
  expect(createHash('sha256').update(before).digest('hex')).toBe(
    '4089a9db8cd00c54487c528dbfdfe28a502db7e1973e064960a1e6d7e134125c',
  );
  await verifyAdmissionParallelFiles();
});
