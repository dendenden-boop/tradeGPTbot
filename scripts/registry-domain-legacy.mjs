// PAPER CURRENT RISK COUNTS: exact36-case metadata peels before older reviews.
import { beforeCurrentRiskCounts } from './current-risk-count-legacy.mjs';
// Test-only exact307 reconstruction; no runtime authority or waiver.
import { createHash } from 'node:crypto';
export const registryDomainReview = {
  'scripts/test-database.mjs': {
    predecessor: 'f7f29388431c3ac92a2e4320322c8c2cc80e964248e82775abe741485f061781',
    current: '447f831f911cbdbd8924da9916de66b03f1e567ebe421e8fdf260026e4f73949',
    patches: [
      {
        old: '// BEGIN PAPER HISTORICAL INVENTORY IMPORT\nimport {\n  verifyPaperHistoricalInventoryStorage,\n',
        next: '// REGISTRY_DOMAIN_EARLY_NATIVE: new profile requires actual owned registry role proof.\n// BEGIN PAPER HISTORICAL INVENTORY IMPORT\nimport {\n  verifyPaperHistoricalInventoryStorage,\n',
      },
      {
        old: "// BEGIN CERTIFIED CLUSTER DATABASE_IMPORT\nimport { bootstrapNativeCluster } from './native-cluster-bootstrap.mjs';\nimport {\n  planClusterIsolatedCohorts,\n  runClusterIsolatedCohorts,\n} from './cluster-isolated-cohorts.mjs';\nconst retainedRoleScopedRunner = runRoleScopedCohorts;\n// END CERTIFIED CLUSTER DATABASE_IMPORT\n",
        next: "// BEGIN CERTIFIED CLUSTER DATABASE_IMPORT\nimport { bootstrapNativeCluster } from './native-cluster-bootstrap.mjs';\nimport {\n  planRegistryIsolatedCohorts,\n  runRegistryIsolatedCohorts,\n} from './cluster-isolated-cohorts.mjs';\nconst retainedRoleScopedRunner = runRoleScopedCohorts;\n// END CERTIFIED CLUSTER DATABASE_IMPORT\n",
      },
      {
        old: '        ? remainingNativeBudget(nativeWindow)\n        : Math.max(0, proof.timeoutMs - (Date.now() - Date.parse(startedAt))),\n  });\n  const certifiedPlan = await planClusterIsolatedCohorts(\n    originalCohortPlan,\n    nativeSecondary.certificate,\n  );\n  // Upgrade the in-memory plan only after actual separate server/role proof.\n  // No child has started and the original discovery/partition remains intact.\n',
        next: '        ? remainingNativeBudget(nativeWindow)\n        : Math.max(0, proof.timeoutMs - (Date.now() - Date.parse(startedAt))),\n  });\n  const certifiedPlan = await planRegistryIsolatedCohorts(\n    originalCohortPlan,\n    nativeSecondary.certificate,\n    nativeSecondary.registryProof,\n  );\n  // Upgrade the in-memory plan only after actual separate server/role proof.\n  // No child has started and the original discovery/partition remains intact.\n',
      },
      {
        old: '      certifiedRoutes.set(job.id, descriptor);\n      return { ...job, ...descriptor, env: Object.freeze(env) };\n    });\n    return runClusterIsolatedCohorts(certified, {\n      ...options,\n      isolation: nativeSecondary.certificate,\n    });\n  }\n  // END CERTIFIED CLUSTER DATABASE_SETUP\n',
        next: '      certifiedRoutes.set(job.id, descriptor);\n      return { ...job, ...descriptor, env: Object.freeze(env) };\n    });\n    return runRegistryIsolatedCohorts(certified, {\n      ...options,\n      isolation: nativeSecondary.certificate,\n      registryProof: nativeSecondary.registryProof,\n    });\n  }\n  // END CERTIFIED CLUSTER DATABASE_SETUP\n',
      },
    ],
  },
  'scripts/native-cluster-bootstrap.mjs': {
    predecessor: '8f04290fb2d7abe3da0f587f48a0888a07c443ca6c30f97f568124ec1365660c',
    current: 'cfb8bd383d124dd270c774a8d8b4b520d8c0d10711135aecf0356c658a07c4f4',
    patches: [
      {
        old: "// Owned acceptance infrastructure only; never a production runtime authority.\nimport assert from 'node:assert/strict';\nimport { inspectOwnedPostgres } from './owned-native-secondary.mjs';\nimport {\n",
        next: "// REGISTRY_DOMAIN_EARLY_NATIVE: extra issued role-domain proof, no financial authority.\n// Owned acceptance infrastructure only; never a production runtime authority.\nimport { proveRegistryIndependence } from './registry-domain-independence.mjs';\nimport assert from 'node:assert/strict';\nimport { inspectOwnedPostgres } from './owned-native-secondary.mjs';\nimport {\n",
      },
      {
        old: '    primaryEndpoint: primaryIdentity,\n    secondaryEndpoint: secondaryIdentity,\n  });\n  const before = {\n    primary: await nativeRoleCatalogHash(primaryAdmin),\n    secondary: await nativeRoleCatalogHash(secondaryAdmin),\n',
        next: '    primaryEndpoint: primaryIdentity,\n    secondaryEndpoint: secondaryIdentity,\n  });\n  const registryProof = await proveRegistryIndependence({\n    primary: primaryAdmin,\n    secondary: secondaryAdmin,\n    isolation: certificate,\n  });\n  const before = {\n    primary: await nativeRoleCatalogHash(primaryAdmin),\n    secondary: await nativeRoleCatalogHash(secondaryAdmin),\n',
      },
      {
        old: '      primaryIdentity,\n      secondaryIdentity,\n      roleIsolation: certificate.roleIsolation,\n      roleCatalogBefore: before,\n      roleCatalogAfter: after,\n      actors: actors.actors,\n',
        next: '      primaryIdentity,\n      secondaryIdentity,\n      roleIsolation: certificate.roleIsolation,\n      registryIndependence: registryProof.evidence,\n      roleCatalogBefore: before,\n      roleCatalogAfter: after,\n      actors: actors.actors,\n',
      },
      {
        old: '  }\n  return Object.freeze({\n    certificate,\n    port,\n    project: secondaryIdentity.project,\n    migrate,\n',
        next: '  }\n  return Object.freeze({\n    certificate,\n    registryProof,\n    port,\n    project: secondaryIdentity.project,\n    migrate,\n',
      },
    ],
  },
  'scripts/cluster-isolated-cohorts.mjs': {
    predecessor: '8b8ac841f96fa4db2ade85c7805003dab07f1021ab19ac83bdce65ecfe6b1ebd',
    current: '8a6b518d8008e0721baf355c8689e1842a9880bc9424723f91f2745146c2cce5',
    patches: [
      {
        old: "// Certified test-only two-cluster schedule. No production export.\nimport assert from 'node:assert/strict';\nimport { spawn, execFileSync } from 'node:child_process';\n",
        next: "// REGISTRY_DOMAIN_EARLY_NATIVE: explicit additional profile; legacy barriers remain.\n// Certified test-only two-cluster schedule. No production export.\nimport assert from 'node:assert/strict';\nimport { spawn, execFileSync } from 'node:child_process';\n",
      },
      {
        old: "} from './native-main-scopes.mjs';\nimport { planRoleScopedCohorts } from './role-scoped-cohorts.mjs';\nimport { assertNativeClusterIsolation } from './native-cluster-isolation.mjs';\n\nfunction requireClusterRoutes(jobs, isolation) {\n  try {\n",
        next: "} from './native-main-scopes.mjs';\nimport { planRoleScopedCohorts } from './role-scoped-cohorts.mjs';\nimport { assertNativeClusterIsolation } from './native-cluster-isolation.mjs';\nimport {\n  assertRegistryIndependence,\n  verifyRegistryDomainInputs,\n} from './registry-domain-independence.mjs';\nexport {\n  proveRegistryIndependence,\n  assertRegistryIndependence,\n} from './registry-domain-independence.mjs';\n\nfunction requireClusterRoutes(jobs, isolation) {\n  try {\n",
      },
      {
        old: '\nexport async function runClusterIsolatedCohorts(\n  jobs,\n  { timeoutMs, signal, secrets = [], echo = false, cwd = workspace, isolation },\n) {\n  assertNativeClusterIsolation(isolation);\n  await verifyScopedMainFiles(cwd);\n  assert.deepEqual(\n    jobs.map(({ id, parallel, after, afterAny }) => ({\n',
        next: '\nexport async function runClusterIsolatedCohorts(\n  jobs,\n  { timeoutMs, signal, secrets = [], echo = false, cwd = workspace, isolation, registryProof },\n) {\n  assertNativeClusterIsolation(isolation);\n  if (registryProof !== undefined) {\n    assertRegistryIndependence(registryProof, isolation);\n    await verifyRegistryDomainInputs(cwd);\n  }\n  await verifyScopedMainFiles(cwd);\n  assert.deepEqual(\n    jobs.map(({ id, parallel, after, afterAny }) => ({\n',
      },
      {
        old: '      ...(after === undefined ? {} : { after }),\n      ...(afterAny === undefined ? {} : { afterAny }),\n    })),\n    clusterIsolatedShape,\n  );\n  assert.deepEqual(jobs[2].files, [...scopedMainFiles]);\n  requireClusterRoutes(jobs, isolation);\n',
        next: '      ...(after === undefined ? {} : { after }),\n      ...(afterAny === undefined ? {} : { afterAny }),\n    })),\n    registryProof === undefined ? clusterIsolatedShape : registryIsolatedShape,\n  );\n  assert.deepEqual(jobs[2].files, [...scopedMainFiles]);\n  requireClusterRoutes(jobs, isolation);\n',
      },
      {
        old: "    }\n    if (controller.signal.aborted || performance.now() - started >= timeoutMs)\n      throw new Error('Native scoped aggregate deadline/abort');\n    return { timeoutMs, elapsedMs: performance.now() - started, completed };\n  } finally {\n    stop();\n    await Promise.all(active.values());\n",
        next: "    }\n    if (controller.signal.aborted || performance.now() - started >= timeoutMs)\n      throw new Error('Native scoped aggregate deadline/abort');\n    return {\n      timeoutMs,\n      elapsedMs: performance.now() - started,\n      completed,\n      ...(registryProof === undefined ? {} : { registryIndependence: registryProof.evidence }),\n    };\n  } finally {\n    stop();\n    await Promise.all(active.values());\n",
      },
      {
        old: "    signal?.removeEventListener('abort', stop);\n  }\n}\n",
        next: "    signal?.removeEventListener('abort', stop);\n  }\n}\n\n// An explicit extra profile; the original conservative API/shape is unchanged.\nexport const registryIsolatedShape = clusterIsolatedShape.map((job) =>\n  job.id === 'native-admission' ? { ...job, after: [] } : job,\n);\nexport async function planRegistryIsolatedCohorts(original, isolation, registryProof) {\n  assertRegistryIndependence(registryProof, isolation);\n  await verifyRegistryDomainInputs();\n  return (await planClusterIsolatedCohorts(original, isolation)).map((job) =>\n    job.id === 'native-admission' ? { ...job, after: [] } : job,\n  );\n}\nexport async function runRegistryIsolatedCohorts(jobs, options) {\n  assertRegistryIndependence(options.registryProof, options.isolation);\n  return runClusterIsolatedCohorts(jobs, options);\n}\n",
      },
    ],
  },
  'scripts/cluster-isolated-evidence.mjs': {
    predecessor: '40a694b77daa987a4a9b4b30b972ca749585ef01a020e33d2fe2861f562847b0',
    current: '169ddeaa287b531b5e5afbd7a9062a61b86bfb314fa28cbaaa2fd021a5308228',
    patches: [
      {
        old: "// Read-only acceptance evidence; cannot mint a scheduler certificate or grant.\nimport assert from 'node:assert/strict';\nimport { clusterIsolatedShape } from './cluster-isolated-cohorts.mjs';\nimport {\n  scopedMainFiles,\n  scopedMainManifestHash,\n",
        next: "// REGISTRY_DOMAIN_EARLY_NATIVE: verify actual registry separation for early admission.\n// Read-only acceptance evidence; cannot mint a scheduler certificate or grant.\nimport assert from 'node:assert/strict';\nimport { clusterIsolatedShape, registryIsolatedShape } from './cluster-isolated-cohorts.mjs';\nimport { requireRegistryIndependenceEvidence } from './registry-domain-independence.mjs';\nimport {\n  scopedMainFiles,\n  scopedMainManifestHash,\n",
      },
      {
        old: "};\nexport function requireClusterIsolatedEvidence(cohorts, native) {\n  const proof = cohorts.nativeClusterIsolation;\n  assert.equal(proof.status, 'PASS');\n  assert.equal(proof.version, 'native-cluster-isolation-v1');\n  const a = proof.primary,\n",
        next: "};\nexport function requireClusterIsolatedEvidence(cohorts, native) {\n  const proof = cohorts.nativeClusterIsolation;\n  const registryOverlap = Object.hasOwn(cohorts, 'registryIndependence');\n  if (registryOverlap) {\n    requireRegistryIndependenceEvidence(cohorts.registryIndependence);\n    assert.deepEqual(cohorts.registryIndependence, proof.registryIndependence);\n  }\n  assert.equal(proof.status, 'PASS');\n  assert.equal(proof.version, 'native-cluster-isolation-v1');\n  const a = proof.primary,\n",
      },
      {
        old: '      ...(after === undefined ? {} : { after }),\n      ...(afterAny === undefined ? {} : { afterAny }),\n    })),\n    clusterIsolatedShape,\n  );\n  const plans = new Map(cohorts.cohorts.map((c) => [c.id, c])),\n    times = new Map(cohorts.completed.map((c) => [c.id, c]));\n',
        next: '      ...(after === undefined ? {} : { after }),\n      ...(afterAny === undefined ? {} : { afterAny }),\n    })),\n    registryOverlap ? registryIsolatedShape : clusterIsolatedShape,\n  );\n  const plans = new Map(cohorts.cohorts.map((c) => [c.id, c])),\n    times = new Map(cohorts.completed.map((c) => [c.id, c]));\n',
      },
      {
        old: "    assert(active >= 0 && active <= 2);\n  }\n  assert.equal(active, 0);\n  for (const id of ['main', 'main-scoped'])\n    assert(times.get(id).startMs >= times.get('registry').settledMs);\n  for (const [id, t] of times)\n",
        next: "    assert(active >= 0 && active <= 2);\n  }\n  assert.equal(active, 0);\n  if (registryOverlap) {\n    assert(times.get('native-admission').startMs < times.get('registry').settledMs);\n  }\n  for (const id of ['main', 'main-scoped'])\n    assert(times.get(id).startMs >= times.get('registry').settledMs);\n  for (const [id, t] of times)\n",
      },
    ],
  },
  'scripts/historical-inventory-legacy.mjs': {
    predecessor: 'af83b4c4869156f07edc596d571864246c069ab0238d5047ad2857a61b99ba7a',
    current: 'bb02e0e133e84490112cbf2eb5c0f72e8bd9c97a0a8c07f60041f3ef138be17a',
    patches: [
      {
        old: "// Test-only exact accepted514 harness reconstruction; never runtime authority.\nimport { createHash } from 'node:crypto';\nexport const historicalInventoryReview = {\n",
        next: "// REGISTRY_DOMAIN_EARLY_NATIVE: exact registry-profile changes peel before prior reviews.\nimport { beforeRegistryDomain } from './registry-domain-legacy.mjs';\n// Test-only exact accepted514 harness reconstruction; never runtime authority.\nimport { createHash } from 'node:crypto';\nexport const historicalInventoryReview = {\n",
      },
      {
        old: "  },\n};\nexport function beforeHistoricalInventory(file, source) {\n  const r = historicalInventoryReview[file];\n  if (!r || !source.includes('PAPER HISTORICAL INVENTORY')) return source;\n  const hash = (s) => createHash('sha256').update(s).digest('hex');\n",
        next: "  },\n};\nexport function beforeHistoricalInventory(file, source) {\n  source = beforeRegistryDomain(file, source);\n  const r = historicalInventoryReview[file];\n  if (!r || !source.includes('PAPER HISTORICAL INVENTORY')) return source;\n  const hash = (s) => createHash('sha256').update(s).digest('hex');\n",
      },
    ],
  },
  'scripts/historical-inventory-legacy.unit.test.mjs': {
    predecessor: 'b0a6e13d8faa732513478c7a4d90497ea61b147e0eb588ac6bd126030deda66c',
    current: 'f8943e51aebc845fa1ffaa9b0b49baec114e0e4d957461c2c51679da22ca7da2',
    patches: [
      {
        old: "import { readFile } from 'node:fs/promises';\nimport { createHash } from 'node:crypto';\nimport { expect, it } from 'vitest';\n",
        next: "// REGISTRY_DOMAIN_EARLY_NATIVE: isolate the historical fixture before its tamper checks.\nimport { beforeRegistryDomain } from './registry-domain-legacy.mjs';\nimport { readFile } from 'node:fs/promises';\nimport { createHash } from 'node:crypto';\nimport { expect, it } from 'vitest';\n",
      },
      {
        old: "  historicalInventoryReview,\n} from './historical-inventory-legacy.mjs';\nconst sourceOf = async (file) =>\n  (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\\r\\n', '\\n');\nconst hash = (text) => createHash('sha256').update(text).digest('hex');\nit.each(Object.keys(historicalInventoryReview))(\n  'retains the complete accepted main harness below exact inventory additions: %s',\n",
        next: "  historicalInventoryReview,\n} from './historical-inventory-legacy.mjs';\nconst sourceOf = async (file) =>\n  beforeRegistryDomain(\n    file,\n    (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\\r\\n', '\\n'),\n  );\nconst hash = (text) => createHash('sha256').update(text).digest('hex');\nit.each(Object.keys(historicalInventoryReview))(\n  'retains the complete accepted main harness below exact inventory additions: %s',\n",
      },
      {
        old: "      expect(() =>\n        beforeHistoricalInventory(file, source.replace(patch.next, patch.next + patch.next)),\n      ).toThrow('PAPER_HISTORICAL_INVENTORY_REVIEW_REQUIRED');\n      expect(() =>\n        beforeHistoricalInventory(\n          file,\n          source.replace(patch.next, patch.next.replace('\\n', '\\n// unreviewed\\n')),\n        ),\n      ).toThrow('PAPER_HISTORICAL_INVENTORY_REVIEW_REQUIRED');\n    }\n",
        next: "      expect(() =>\n        beforeHistoricalInventory(file, source.replace(patch.next, patch.next + patch.next)),\n      ).toThrow('PAPER_HISTORICAL_INVENTORY_REVIEW_REQUIRED');\n      const boundary = patch.next.indexOf('\\n') + 1;\n      expect(boundary).toBeGreaterThan(0);\n      const changed =\n        patch.next.slice(0, boundary) + '// unreviewed\\n' + patch.next.slice(boundary);\n      expect(() =>\n        beforeHistoricalInventory(\n          file,\n          source.replace(patch.next, () => changed),\n        ),\n      ).toThrow('PAPER_HISTORICAL_INVENTORY_REVIEW_REQUIRED');\n    }\n",
      },
    ],
  },
};
export function beforeRegistryDomain(file, source) {
  source = beforeCurrentRiskCounts(file, source);
  const review = registryDomainReview[file];
  if (!review || !source.includes('REGISTRY_DOMAIN_EARLY_NATIVE')) return source;
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  if (hash(source) !== review.current) throw Error('REGISTRY_DOMAIN_REVIEW_REQUIRED');
  for (const p of review.patches) {
    if (source.split(p.next).length !== 2) throw Error('REGISTRY_DOMAIN_REVIEW_REQUIRED');
    const at = source.indexOf(p.next);
    source = source.slice(0, at) + p.old + source.slice(at + p.next.length);
  }
  if (hash(source) !== review.predecessor) throw Error('REGISTRY_DOMAIN_REVIEW_REQUIRED');
  return source;
}
