// Unit-only genuine report-shape fixture; never imported by the acceptance runner.
import {
  writerOwnerCases,
  writerOwnerPartitions,
  mergeWriterOwnerReports,
} from '../writer-owner-partitions.mjs';
export function writerOwnerEvidence(window) {
  const raw = writerOwnerPartitions.map((p) =>
    Buffer.from(
      JSON.stringify({
        success: true,
        numTotalTests: 49,
        numPassedTests: p.expected,
        numFailedTests: 0,
        numPendingTests: 49 - p.expected,
        numTodoTests: 0,
        startTime: window.startedAtMs + 1100,
        testResults: [
          {
            name: '/workspace/packages/database/test/paper-execution-commit.integration.test.ts',
            status: 'passed',
            startTime: window.startedAtMs + 1200,
            endTime: window.startedAtMs + 2000.25,
            assertionResults: writerOwnerCases.map((name) => ({
              fullName: name,
              status: p.pattern.test(name) ? 'passed' : 'skipped',
              failureMessages: [],
              duration: 1,
            })),
          },
        ],
      }),
    ),
  );
  const execution = {
    timeoutMs: 90000,
    startedAtMs: window.startedAtMs + 1000,
    completedAtMs: window.startedAtMs + 3000,
    elapsedMs: 2000,
    processes: [
      { id: 'economic', startMs: 0, settledMs: 1800 },
      { id: 'risk', startMs: 10, settledMs: 2000 },
    ],
  };
  const ownership = [
    {
      database: 'ctp_p2_owner_deadbeef1234',
      oid: '101',
      migrations: 73,
      migrationDigest: 'b'.repeat(64),
      nonBypassOwner: true,
      ownerOid: '77',
      dbAclDigest: 'd'.repeat(64),
    },
    {
      database: 'ctp_p2_writer_owner_deadbeef1234',
      oid: '102',
      migrations: 73,
      migrationDigest: 'b'.repeat(64),
      nonBypassOwner: true,
      ownerOid: '77',
      dbAclDigest: 'd'.repeat(64),
    },
  ];
  for (const p of ownership)
    p.ownerProfile = {
      owner_name: 'ctp_p2_owner_deadbeef1234',
      owner_oid: '77',
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolreplication: false,
      rolcreaterole: true,
      rolcanlogin: true,
      rolinherit: true,
    };
  return { raw, merged: mergeWriterOwnerReports(raw, execution, ownership, window) };
}
