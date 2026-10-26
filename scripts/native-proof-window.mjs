// CI evidence only: one wall-clock allowance shared by physically isolated VMs.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const budgetMs = 1020000;
const keys = 'attempt,budgetMs,deadlineMs,runId,sha,startedAtMs';
const invalid = () => {
  throw new Error('NATIVE_WINDOW_INVALID');
};

function requireIdentity(identity) {
  if (
    !identity ||
    typeof identity.runId !== 'string' ||
    typeof identity.attempt !== 'string' ||
    typeof identity.sha !== 'string' ||
    !/^[1-9][0-9]*$/u.test(identity.runId) ||
    !/^[1-9][0-9]*$/u.test(identity.attempt) ||
    !/^[a-f0-9]{40}$/u.test(identity.sha)
  )
    invalid();
}

export function nativeWindowIdentity(env = process.env) {
  const identity = {
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    sha: env.GITHUB_SHA,
  };
  requireIdentity(identity);
  return identity;
}

function requireWindow(window) {
  if (
    !window ||
    typeof window !== 'object' ||
    Array.isArray(window) ||
    Object.keys(window).sort().join(',') !== keys
  )
    invalid();
  requireIdentity(window);
  if (
    !Number.isSafeInteger(window.startedAtMs) ||
    !Number.isSafeInteger(window.deadlineMs) ||
    window.startedAtMs <= 0 ||
    window.budgetMs !== budgetMs ||
    window.deadlineMs !== window.startedAtMs + budgetMs
  )
    invalid();
}

export function createNativeWindow(identity, now = Date.now()) {
  requireIdentity(identity);
  const window = {
    runId: identity.runId,
    attempt: identity.attempt,
    sha: identity.sha,
    startedAtMs: now,
    deadlineMs: now + budgetMs,
    budgetMs,
  };
  requireWindow(window);
  return Object.freeze(window);
}

export function remainingNativeBudget(window, now = Date.now()) {
  requireWindow(window);
  if (!Number.isSafeInteger(now) || now < window.startedAtMs) invalid();
  if (now >= window.deadlineMs) throw new Error('NATIVE_WINDOW_EXPIRED');
  return window.deadlineMs - now;
}

export function readNativeWindowEvidence(json, identity) {
  requireIdentity(identity);
  let window;
  try {
    window = JSON.parse(json);
  } catch {
    invalid();
  }
  requireWindow(window);
  for (const key of ['runId', 'attempt', 'sha']) if (window[key] !== identity[key]) invalid();
  return Object.freeze(window);
}

export function readNativeWindow(json, identity, now = Date.now()) {
  const window = readNativeWindowEvidence(json, identity);
  remainingNativeBudget(window, now);
  return window;
}

export function requireNativeWindowReports(owners, cohorts, window) {
  requireWindow(window);
  const fail = () => {
    throw new Error('NATIVE_PROOFS_INCOMPLETE');
  };
  for (const [report, scope] of [
    [owners, 'owners'],
    [cohorts, 'cohorts'],
  ]) {
    if (
      !report ||
      report.status !== 'PARTIAL' ||
      report.proofScope !== scope ||
      !/^ctp-integration-[0-9]+-[a-f0-9]{12}$/u.test(report.project)
    )
      fail();
    try {
      requireWindow(report.nativeWindow);
    } catch {
      fail();
    }
    for (const key of Object.keys(window)) if (report.nativeWindow[key] !== window[key]) fail();
    const started = Date.parse(report.startedAt),
      completed = Date.parse(report.completedAt);
    if (
      !Number.isSafeInteger(started) ||
      !Number.isSafeInteger(completed) ||
      started < window.startedAtMs ||
      completed < started ||
      completed > window.deadlineMs
    )
      fail();
    if (
      report.ownerSuites !== (scope === 'owners' ? 'COMPLETE' : 'DELEGATED') ||
      report.nativeCohorts !== (scope === 'cohorts' ? 'COMPLETE' : 'DELEGATED') ||
      report.isolatedReset !== (scope === 'cohorts' ? 'PASS' : 'DELEGATED')
    )
      fail();
  }
  if (owners.project === cohorts.project) fail();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(',') !== '--create' || !process.env.GITHUB_OUTPUT) invalid();
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `window=${JSON.stringify(createNativeWindow(nativeWindowIdentity()))}\n`,
  );
}
