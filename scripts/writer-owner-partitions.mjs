// Test/CI evidence only. No runtime authority, result synthesis or budget reset.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { workspace } from './docker-test-utils.mjs';
import { writerOwnerCases } from './writer-owner-manifest.mjs';
import { writerOwnerInputs, writerOwnerInputHash } from './writer-owner-inputs.mjs';
import { requireWriterMigrationOwner } from './writer-owner-identity.mjs';
export { writerOwnerCases };
export const writerOwnerPartitions = Object.freeze([
  Object.freeze({
    id: 'economic',
    pattern: /^paper-(?:execution-commit|executed-book):/u,
    expected: 20,
    report: 'paper-writer-owner-economic-tests',
  }),
  Object.freeze({
    id: 'risk',
    pattern: /^paper-(?:executed-valuation|historical-inventory|current-risk|current-order-risk):/u,
    expected: 29,
    report: 'paper-writer-owner-risk-tests',
  }),
]);
const hash = (b) => createHash('sha256').update(b).digest('hex');
const fail = () => {
  throw Error('WRITER_OWNER_EVIDENCE_INCOMPLETE');
};
export async function verifyWriterOwnerInputs(root = workspace) {
  try {
    if (hash(JSON.stringify(writerOwnerInputs)) !== writerOwnerInputHash) fail();
    for (const [file, expected] of Object.entries(writerOwnerInputs)) {
      const absolute = path.resolve(root, file);
      if (!absolute.startsWith(path.resolve(root) + path.sep)) fail();
      const text = (await readFile(absolute, 'utf8')).replaceAll('\r\n', '\n');
      if (hash(text) !== expected) fail();
    }
    return writerOwnerInputHash;
  } catch {
    throw Error('WRITER_OWNER_INPUT_REVIEW_REQUIRED');
  }
}
function requireExecution(execution, ownership, window) {
  if (
    !execution ||
    execution.timeoutMs !== 90000 ||
    !Number.isSafeInteger(execution.startedAtMs) ||
    !Number.isSafeInteger(execution.completedAtMs) ||
    execution.startedAtMs < window.startedAtMs ||
    execution.completedAtMs > window.deadlineMs ||
    execution.completedAtMs < execution.startedAtMs ||
    execution.completedAtMs - execution.startedAtMs >= 90000 ||
    !Number.isFinite(execution.elapsedMs) ||
    execution.elapsedMs < 0 ||
    execution.elapsedMs >= 90000 ||
    !Array.isArray(execution.processes) ||
    execution.processes.length !== 2
  )
    fail();
  for (const [i, p] of execution.processes.entries())
    if (
      p.id !== writerOwnerPartitions[i].id ||
      !Number.isFinite(p.startMs) ||
      !Number.isFinite(p.settledMs) ||
      p.startMs < 0 ||
      p.settledMs < p.startMs ||
      p.settledMs > execution.elapsedMs
    )
      fail();
  if (
    Math.max(...execution.processes.map((p) => p.startMs)) >=
    Math.min(...execution.processes.map((p) => p.settledMs))
  )
    fail();
  if (!Array.isArray(ownership) || ownership.length !== 2) fail();
  const suffix = /^ctp_p2_owner_([a-f0-9]{12})$/u.exec(ownership[0].database ?? '')?.[1];
  if (
    !suffix ||
    ownership[1].database !== 'ctp_p2_writer_owner_' + suffix ||
    ownership[0].oid === ownership[1].oid
  )
    fail();
  for (const p of ownership) {
    assert.deepEqual(
      p.ownerProfile,
      requireWriterMigrationOwner(p.ownerProfile, ownership[0].database),
    );
    assert.equal(p.ownerProfile.owner_oid, p.ownerOid);
    if (
      !/^[1-9][0-9]*$/u.test(p.oid) ||
      !/^[1-9][0-9]*$/u.test(p.ownerOid) ||
      !/^[a-f0-9]{64}$/u.test(p.dbAclDigest) ||
      p.nonBypassOwner !== true ||
      p.migrations !== 72 ||
      !/^[a-f0-9]{64}$/u.test(p.migrationDigest)
    )
      fail();
  }
  if (ownership[0].migrationDigest !== ownership[1].migrationDigest) fail();
  if (
    ownership[0].ownerOid !== ownership[1].ownerOid ||
    ownership[0].dbAclDigest !== ownership[1].dbAclDigest
  )
    fail();
}
export function mergeWriterOwnerReports(raw, execution, ownership, window) {
  try {
    requireExecution(execution, ownership, window);
    if (
      !Array.isArray(raw) ||
      raw.length !== 2 ||
      raw.some((b) => !Buffer.isBuffer(b) || b.length === 0 || b.length > 2000000)
    )
      fail();
    const reports = raw.map((b) => JSON.parse(b.toString('utf8'))),
      selected = new Map();
    let first = Infinity,
      last = 0,
      fileName;
    for (const [index, r] of reports.entries()) {
      const partition = writerOwnerPartitions[index];
      if (
        r.success !== true ||
        r.numTotalTests !== 49 ||
        r.numPassedTests !== partition.expected ||
        r.numPendingTests !== 49 - partition.expected ||
        r.numFailedTests !== 0 ||
        r.numTodoTests !== 0 ||
        !Number.isSafeInteger(r.startTime) ||
        r.startTime < execution.startedAtMs ||
        !Array.isArray(r.testResults) ||
        r.testResults.length !== 1
      )
        fail();
      const f = r.testResults[0];
      if (
        f.status !== 'passed' ||
        !Array.isArray(f.assertionResults) ||
        f.assertionResults.length !== 49 ||
        typeof f.name !== 'string' ||
        !f.name
          .replaceAll('\\', '/')
          .endsWith('/packages/database/test/paper-execution-commit.integration.test.ts') ||
        !Number.isFinite(f.startTime) ||
        !Number.isFinite(f.endTime) ||
        f.startTime < r.startTime ||
        f.endTime < f.startTime ||
        f.endTime > execution.completedAtMs
      )
        fail();
      if (fileName !== undefined && fileName !== f.name) fail();
      fileName = f.name;
      first = Math.min(first, f.startTime);
      last = Math.max(last, f.endTime);
      const seen = new Set();
      for (const a of f.assertionResults) {
        if (
          !writerOwnerCases.includes(a.fullName) ||
          seen.has(a.fullName) ||
          !Array.isArray(a.failureMessages) ||
          a.failureMessages.length
        )
          fail();
        seen.add(a.fullName);
        const expected = partition.pattern.test(a.fullName);
        if (a.status !== (expected ? 'passed' : 'skipped')) fail();
        if (expected) {
          if (selected.has(a.fullName)) fail();
          selected.set(a.fullName, a);
        }
      }
      if (
        seen.size !== 49 ||
        [...seen].filter((name) => partition.pattern.test(name)).length !== partition.expected
      )
        fail();
    }
    if (selected.size !== 49) fail();
    return {
      success: true,
      numTotalTests: 49,
      numPassedTests: 49,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      startTime: execution.startedAtMs,
      testResults: [
        {
          name: fileName,
          status: 'passed',
          startTime: first,
          endTime: last,
          message: '',
          assertionResults: writerOwnerCases.map((name) => selected.get(name)),
        },
      ],
      provenance: {
        kind: 'ACTUAL_WRITER_OWNER_PARTITIONS',
        inputManifestHash: writerOwnerInputHash,
        rawReports: writerOwnerPartitions.map((p) => p.report + '.json'),
        rawSha256: raw.map(hash),
        execution: globalThis.structuredClone(execution),
        ownership: globalThis.structuredClone(ownership),
        nativeWindow: { runId: window.runId, attempt: window.attempt, sha: window.sha },
      },
    };
  } catch {
    fail();
  }
}
export function requireWriterOwnerProof(merged, raw, window) {
  try {
    if (merged?.provenance?.kind !== 'ACTUAL_WRITER_OWNER_PARTITIONS') fail();
    assert.deepEqual(merged.provenance.nativeWindow, {
      runId: window.runId,
      attempt: window.attempt,
      sha: window.sha,
    });
    const expected = mergeWriterOwnerReports(
      raw,
      merged.provenance.execution,
      merged.provenance.ownership,
      window,
    );
    assert.deepEqual(merged, expected);
  } catch {
    fail();
  }
}
