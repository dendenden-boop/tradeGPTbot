import assert from 'node:assert/strict';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createPasswordHasher } from '../packages/auth/dist/index.js';
import { report } from './docker-test-utils.mjs';

const startedAt = new Date().toISOString();
const started = performance.now();
const hasher = await createPasswordHasher();
const initializationMs = performance.now() - started;
const password = 'Local benchmark input, never a user credential';
const hashMs = [];
const verifyMs = [];
const rounds = 7;
try {
  for (let index = 0; index < rounds; index++) {
    const hashStarted = performance.now();
    const encoded = await hasher.hash(password);
    hashMs.push(performance.now() - hashStarted);
    const verifyStarted = performance.now();
    assert.equal(await hasher.verify(encoded, password), true);
    verifyMs.push(performance.now() - verifyStarted);
  }
  const parallelStarted = performance.now();
  await Promise.all([hasher.hash(password), hasher.hash(password)]);
  const parallelTwoMs = performance.now() - parallelStarted;
  const distribution = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      p50: Math.round(sorted[Math.floor(sorted.length / 2)]),
      p95: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    };
  };
  const result = {
    status: 'PASS',
    startedAt,
    completedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    availableParallelism: availableParallelism(),
    memoryMiB: Math.round(totalmem() / 1024 ** 2),
    rounds,
    argon2id: { memoryKiB: 65_536, iterations: 3, parallelism: 1, hashBytes: 32 },
    initializationMs: Math.round(initializationMs),
    hashMs: distribution(hashMs),
    verifyMs: distribution(verifyMs),
    parallelTwoMs: Math.round(parallelTwoMs),
    maxRssKiB: process.resourceUsage().maxRSS,
    scope: 'Local native hashing sample; not a capacity, load, or production SLO certification',
  };
  await report('auth-benchmark', result);
  console.log(JSON.stringify(result));
} finally {
  await hasher.close();
}
