import { expect, it } from 'vitest';
const module = await import('./writer-owner-partitions.mjs').catch(() => ({}));
const required = (name) => {
  expect(module[name]).toBeTypeOf('function');
  return module[name];
};
const window = {
  runId: '123',
  attempt: '1',
  sha: 'a'.repeat(40),
  startedAtMs: 1800000000000,
  deadlineMs: 1800001020000,
  budgetMs: 1020000,
};
function fixture() {
  const cases = module.writerOwnerCases;
  expect(cases).toHaveLength(49);
  const reports = [0, 1].map((part) => ({
    success: true,
    numTotalTests: 49,
    numPassedTests: part === 0 ? 20 : 29,
    numFailedTests: 0,
    numPendingTests: part === 0 ? 29 : 20,
    numTodoTests: 0,
    startTime: window.startedAtMs + 1100,
    testResults: [
      {
        name: '/workspace/packages/database/test/paper-execution-commit.integration.test.ts',
        status: 'passed',
        startTime: window.startedAtMs + 1200,
        endTime: window.startedAtMs + 4000,
        assertionResults: cases.map((name) => ({
          fullName: name,
          status: module.writerOwnerPartitions[part].pattern.test(name) ? 'passed' : 'skipped',
          failureMessages: [],
          duration: 1,
        })),
      },
    ],
  }));
  const execution = {
    timeoutMs: 90000,
    startedAtMs: window.startedAtMs + 1000,
    completedAtMs: window.startedAtMs + 4500,
    elapsedMs: 3500,
    processes: [
      { id: 'economic', startMs: 0, settledMs: 3000 },
      { id: 'risk', startMs: 10, settledMs: 3500 },
    ],
  };
  const ownership = [
    {
      database: 'ctp_p2_owner_deadbeef1234',
      oid: '101',
      migrations: 71,
      migrationDigest: 'b'.repeat(64),
      nonBypassOwner: true,
      ownerOid: '77',
      dbAclDigest: 'd'.repeat(64),
    },
    {
      database: 'ctp_p2_writer_owner_deadbeef1234',
      oid: '102',
      migrations: 71,
      migrationDigest: 'b'.repeat(64),
      nonBypassOwner: true,
      ownerOid: '77',
      dbAclDigest: 'd'.repeat(64),
    },
  ];
  return {
    reports,
    execution,
    ownership,
    raw: () => reports.map((r) => Buffer.from(JSON.stringify(r))),
  };
}
it('derives49 passed cases only from complementary20/29 real raw results under one physical90s budget', () => {
  const merge = required('mergeWriterOwnerReports'),
    verify = required('requireWriterOwnerProof'),
    f = fixture(),
    raw = f.raw();
  const result = merge(raw, f.execution, f.ownership, window);
  verify(result, raw, window);
  expect(result.numPassedTests).toBe(49);
  expect(result.numPendingTests).toBe(0);
  expect(result.testResults[0].assertionResults.map((a) => a.fullName).sort()).toEqual(
    [...module.writerOwnerCases].sort(),
  );
  expect(result.provenance.kind).toBe('ACTUAL_WRITER_OWNER_PARTITIONS');
  expect(result.provenance.execution.timeoutMs).toBe(90000);
});
it.each([
  'overlap',
  'missing',
  'skipped',
  'failed',
  'extra',
  'reset budget',
  'late close',
  'same database',
  'same oid',
  'wrong migrations',
  'wrong migration digest',
  'different ACL',
  'different owner',
  'outside window',
])('rejects incomplete or conflicting owner evidence: %s', (kind) => {
  const merge = required('mergeWriterOwnerReports'),
    f = fixture(),
    rows = f.reports[0].testResults[0].assertionResults;
  if (kind === 'overlap') {
    const a = rows.find((a) => a.status === 'skipped');
    a.status = 'passed';
    f.reports[0].numPassedTests++;
    f.reports[0].numPendingTests--;
  }
  if (kind === 'missing') rows.pop();
  if (kind === 'skipped') rows.find((a) => a.status === 'passed').status = 'skipped';
  if (kind === 'failed') {
    f.reports[1].success = false;
    f.reports[1].numFailedTests = 1;
  }
  if (kind === 'extra') rows.push({ ...rows[0], fullName: 'unreviewed extra case' });
  if (kind === 'reset budget') f.execution.timeoutMs = 180000;
  if (kind === 'late close') f.execution.elapsedMs = 90001;
  if (kind === 'same database') f.ownership[1].database = f.ownership[0].database;
  if (kind === 'same oid') f.ownership[1].oid = f.ownership[0].oid;
  if (kind === 'wrong migrations') f.ownership[1].migrations = 70;
  if (kind === 'wrong migration digest') f.ownership[1].migrationDigest = 'c'.repeat(64);
  if (kind === 'different ACL') f.ownership[1].dbAclDigest = 'e'.repeat(64);
  if (kind === 'different owner') f.ownership[1].ownerOid = '78';
  if (kind === 'outside window') f.execution.startedAtMs = window.startedAtMs - 1;
  expect(() => merge(f.raw(), f.execution, f.ownership, window)).toThrow(
    'WRITER_OWNER_EVIDENCE_INCOMPLETE',
  );
});
it('rejects altered raw bytes, merged case results or physical execution proof after derivation', () => {
  const merge = required('mergeWriterOwnerReports'),
    verify = required('requireWriterOwnerProof'),
    f = fixture(),
    raw = f.raw(),
    result = merge(raw, f.execution, f.ownership, window);
  const altered = [Buffer.from(raw[0].toString() + ' '), raw[1]];
  expect(() => verify(result, altered, window)).toThrow('WRITER_OWNER_EVIDENCE_INCOMPLETE');
  const missing = globalThis.structuredClone(result);
  missing.testResults[0].assertionResults.pop();
  expect(() => verify(missing, raw, window)).toThrow('WRITER_OWNER_EVIDENCE_INCOMPLETE');
  const stale = globalThis.structuredClone(result);
  stale.provenance.execution.elapsedMs = 90001;
  expect(() => verify(stale, raw, window)).toThrow('WRITER_OWNER_EVIDENCE_INCOMPLETE');
});
