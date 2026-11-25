// Exact test-only restoration for historical harness reviews.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const basisReview = JSON.parse(
  readFileSync(
    new URL('./fixtures/postexecution-basis-harness-review.json', import.meta.url),
    'utf8',
  ),
);

export function beforePostexecutionBasisMigration(
  file,
  text,
  code = 'PAPER_POSTEXECUTION_BASIS_REVIEW_REQUIRED',
) {
  const review = basisReview[file];
  if (!review) return text;
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  const original = hash(text);
  if (original === review.predecessor) return text;
  if (original !== review.current) throw Error(code);
  for (const patch of [...review.patches].reverse()) {
    if (text.split(patch.next).length !== 2) throw Error(code);
    text = text.replace(patch.next, () => patch.old);
  }
  if (hash(text) !== review.predecessor) throw Error(code);
  return text;
}

export const postexecutionMigrationReview = {
  'scripts/native-main-scopes.mjs': {
    predecessor: '70e1766879ac58d198a5eb650b84946286f2492f995b1d86fcb4bdd5f330cdd5',
    current: 'c0551639f3b60fd637d8f5919658e0f088907e4825f24e294c6a05470e47e9b7',
    patches: [
      {
        old: '',
        next: '// PAPER POSTEXECUTION migration72 acceptance.\n',
      },
      {
        old: '2488efa619605da702a98c276c94c79a16bc46e8cc601957add0c58e2cc03a71',
        next: 'd2964d0921f1d9c47c21d2efdb64f33401b46a63833c93912868e0da4d469939',
      },
    ],
  },
  'scripts/test-database.mjs': {
    predecessor: 'a4e6196fd5b70c8278ff1441db3bbe4e4366e2bca7d43c43793b57b8f140c85e',
    current: '1436058f003b30f9656f5c69ceeaee79d6ef98a944b373dec823aa38bba0ee89',
    patches: [
      {
        old: "// BEGIN WRITER OWNER PARTITIONS IMPORT\nimport { performance } from 'node:perf_hooks';\nimport { prepareWriterOwnerClone, runWriterOwnerSuite } from './writer-owner-suite.mjs';",
        next: "// PAPER POSTEXECUTION migration72 acceptance.\nimport {\n  verifyCompiledPaperPostexecution,\n  verifyPaperPostexecutionStorage,\n  verifyPaperPostexecutionUpgrade,\n} from './paper-postexecution-upgrade.mjs';\n// BEGIN WRITER OWNER PARTITIONS IMPORT\nimport { performance } from 'node:perf_hooks';\nimport { prepareWriterOwnerClone, runWriterOwnerSuite } from './writer-owner-suite.mjs';",
      },
      {
        old: "  '202611140002_paper_current_risk_market_coherence',\n  // BEGIN PAPER CURRENT ORDER RISK MIGRATION\n  '202611150001_paper_current_order_risk',\n  // END PAPER CURRENT ORDER RISK MIGRATION\n  // END PAPER CURRENT RISK MARKET MIGRATION\n  // END PAPER CURRENT RISK MIGRATION",
        next: "  '202611140002_paper_current_risk_market_coherence',\n  // BEGIN PAPER CURRENT ORDER RISK MIGRATION\n  '202611150001_paper_current_order_risk',\n  '202611240001_paper_postexecution_reservation',\n  // END PAPER CURRENT ORDER RISK MIGRATION\n  // END PAPER CURRENT RISK MARKET MIGRATION\n  // END PAPER CURRENT RISK MIGRATION",
      },
      {
        old: "  );\n  assert.equal(currentOrderRiskCompiled.status, 'PASS');\n  // END PAPER CURRENT ORDER RISK UPGRADE\n\n  // Restore a genuinely populated published-19 format before applying any\n  // lifecycle migration. The acceptance fixture uses actual atomic issuance;",
        next: "  );\n  assert.equal(currentOrderRiskCompiled.status, 'PASS');\n  // END PAPER CURRENT ORDER RISK UPGRADE\n  const beforePostexecution = await capturePaperExecutionStartUpgrade(paperUpgrade);\n  await cp(\n    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[71]),\n    path.join(paperMigrations, expectedMigrations[71]),\n    { recursive: true },\n  );\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperPostexecutionUpgrade(paperUpgrade, beforePostexecution);\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperPostexecutionUpgrade(paperUpgrade, beforePostexecution);\n  const postexecutionCompiled = await verifyCompiledPaperPostexecution(\n    paperUpgrade,\n    paperAdmissionEnvironment(databases[4]),\n  );\n  assert.equal(postexecutionCompiled.status, 'PASS');\n\n  // Restore a genuinely populated published-19 format before applying any\n  // lifecycle migration. The acceptance fixture uses actual atomic issuance;",
      },
      {
        old: "      nativeCohorts: 'DELEGATED',\n      isolatedReset: 'DELEGATED',\n      requiredNativeJob: 'Native PostgreSQL and real services',\n      authenticatedRuntime: 'DELEGATED',\n      authenticationHardening: 'DELEGATED',\n      requiredAuthJob: 'Auth runtime and faults',",
        next: "      nativeCohorts: 'DELEGATED',\n      isolatedReset: 'DELEGATED',\n      requiredNativeJob: 'Native PostgreSQL and real services',\n      paperPostexecutionUpgradePreserved: true,\n      paperPostexecutionCompiled: postexecutionCompiled,\n      authenticatedRuntime: 'DELEGATED',\n      authenticationHardening: 'DELEGATED',\n      requiredAuthJob: 'Auth runtime and faults',",
      },
      {
        old: '    empty: true,\n  });\n  // END PAPER CURRENT ORDER RISK RESET_ADMISSIONRESET\n  // END PAPER CURRENT RISK RESET_UPGRADE\n  // END PAPER HISTORICAL INVENTORY RESET_UPGRADE\n  // END PAPER EXECUTED VALUATION RESET_ADMISSIONRESET',
        next: '    empty: true,\n  });\n  // END PAPER CURRENT ORDER RISK RESET_ADMISSIONRESET\n  await verifyPaperPostexecutionStorage(admissionReset, { nonBypass: false, empty: true });\n  // END PAPER CURRENT RISK RESET_UPGRADE\n  // END PAPER HISTORICAL INVENTORY RESET_UPGRADE\n  // END PAPER EXECUTED VALUATION RESET_ADMISSIONRESET',
      },
      {
        old: '    paperCurrentOrderRiskUpgradePreserved: true,\n    paperCurrentOrderRiskResetValidated: true,\n    paperCurrentOrderRiskCompiled: currentOrderRiskCompiled,\n    // END PAPER CURRENT ORDER RISK FLAGS\n    // END PAPER CURRENT RISK FLAGS\n    // END PAPER HISTORICAL INVENTORY FLAGS',
        next: '    paperCurrentOrderRiskUpgradePreserved: true,\n    paperCurrentOrderRiskResetValidated: true,\n    paperCurrentOrderRiskCompiled: currentOrderRiskCompiled,\n    paperPostexecutionUpgradePreserved: true,\n    paperPostexecutionResetValidated: true,\n    paperPostexecutionCompiled: postexecutionCompiled,\n    // END PAPER CURRENT ORDER RISK FLAGS\n    // END PAPER CURRENT RISK FLAGS\n    // END PAPER HISTORICAL INVENTORY FLAGS',
      },
      {
        old: "  // BEGIN PAPER CURRENT ORDER RISK RESET_RESET\n  await verifyPaperCurrentOrderRiskStorage(reset, { ownership: 'STORAGE_ONLY', empty: true });\n  // END PAPER CURRENT ORDER RISK RESET_RESET\n  // END PAPER CURRENT RISK RESET_FRESH\n  // END PAPER HISTORICAL INVENTORY RESET_FRESH\n  // END PAPER EXECUTED VALUATION RESET_RESET",
        next: "  // BEGIN PAPER CURRENT ORDER RISK RESET_RESET\n  await verifyPaperCurrentOrderRiskStorage(reset, { ownership: 'STORAGE_ONLY', empty: true });\n  // END PAPER CURRENT ORDER RISK RESET_RESET\n  await verifyPaperPostexecutionStorage(reset, { nonBypass: false, empty: true });\n  // END PAPER CURRENT RISK RESET_FRESH\n  // END PAPER HISTORICAL INVENTORY RESET_FRESH\n  // END PAPER EXECUTED VALUATION RESET_RESET",
      },
    ],
  },
  'scripts/native-cluster-bootstrap.mjs': {
    predecessor: 'bfa66a3ef0d5a1af0180dea4a0b419a8b2105e0ce712ad65d3cf11a33d86d216',
    current: '62ca97a0929f403ddf37823e52eedc48166da3c9c234a1f22ec7033d375b5932',
    patches: [
      {
        old: "// REGISTRY_DOMAIN_EARLY_NATIVE: extra issued role-domain proof, no financial authority.\n// Owned acceptance infrastructure only; never a production runtime authority.\nimport { proveRegistryIndependence } from './registry-domain-independence.mjs';",
        next: "// PAPER POSTEXECUTION migration72 acceptance.\n// REGISTRY_DOMAIN_EARLY_NATIVE: extra issued role-domain proof, no financial authority.\n// Owned acceptance infrastructure only; never a production runtime authority.\nimport { proveRegistryIndependence } from './registry-domain-independence.mjs';",
      },
      {
        old: '        // BEGIN PAPER HISTORICAL INVENTORY SECONDARY_COUNT\n        // BEGIN PAPER CURRENT RISK SECONDARY_COUNT\n        // BEGIN PAPER CURRENT ORDER RISK SECONDARY_COUNT\n        71,\n        // END PAPER CURRENT ORDER RISK SECONDARY_COUNT\n        // END PAPER CURRENT RISK SECONDARY_COUNT\n        // END PAPER HISTORICAL INVENTORY SECONDARY_COUNT',
        next: '        // BEGIN PAPER HISTORICAL INVENTORY SECONDARY_COUNT\n        // BEGIN PAPER CURRENT RISK SECONDARY_COUNT\n        // BEGIN PAPER CURRENT ORDER RISK SECONDARY_COUNT\n        72,\n        // END PAPER CURRENT ORDER RISK SECONDARY_COUNT\n        // END PAPER CURRENT RISK SECONDARY_COUNT\n        // END PAPER HISTORICAL INVENTORY SECONDARY_COUNT',
      },
      {
        old: '      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n      // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      migrations: 71,\n      // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      // END PAPER CURRENT RISK MIGRATION_COUNT\n      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT',
        next: '      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n      // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      migrations: 72,\n      // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      // END PAPER CURRENT RISK MIGRATION_COUNT\n      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT',
      },
    ],
  },
  'scripts/cluster-isolated-evidence.mjs': {
    predecessor: '74a1a0195be4f885a689f6a2cba1a80d4327e0dfe7d7e1174278dc60a86d9257',
    current: 'c02422ea187870dd7778526cd0e82c39cebe430bbe1afc68cf1d72ae505ef4b7',
    patches: [
      {
        old: "// REGISTRY_DOMAIN_EARLY_NATIVE: verify actual registry separation for early admission.\n// Read-only acceptance evidence; cannot mint a scheduler certificate or grant.\nimport assert from 'node:assert/strict';",
        next: "// PAPER POSTEXECUTION migration72 acceptance.\n// REGISTRY_DOMAIN_EARLY_NATIVE: verify actual registry separation for early admission.\n// Read-only acceptance evidence; cannot mint a scheduler certificate or grant.\nimport assert from 'node:assert/strict';",
      },
      {
        old: '  // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n  // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n  // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n  assert.equal(proof.migrations, 71);\n  // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n  // END PAPER CURRENT RISK MIGRATION_COUNT\n  // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT',
        next: '  // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n  // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n  // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n  assert.equal(proof.migrations, 72);\n  // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n  // END PAPER CURRENT RISK MIGRATION_COUNT\n  // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT',
      },
    ],
  },
  'scripts/cluster-isolated-evidence.unit.test.mjs': {
    predecessor: '0f607d2f36908551926ad8722a4a8dbd40600140c1a534e5edf4e4563d6edc7a',
    current: 'b5fff48fca738e1cc9394b2f5e4927bc6e9ca2612f80140d18f9c8c6291a71f9',
    patches: [
      {
        old: "import { expect, it } from 'vitest';\nimport { requireClusterIsolatedEvidence } from './cluster-isolated-evidence.mjs';\nimport { clusterIsolatedShape } from './cluster-isolated-cohorts.mjs';",
        next: "// PAPER POSTEXECUTION migration72 acceptance.\nimport { expect, it } from 'vitest';\nimport { requireClusterIsolatedEvidence } from './cluster-isolated-evidence.mjs';\nimport { clusterIsolatedShape } from './cluster-isolated-cohorts.mjs';",
      },
      {
        old: '    // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n    // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n    // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    migrations: 71,\n    // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    // END PAPER CURRENT RISK MIGRATION_COUNT\n    // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT',
        next: '    // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n    // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n    // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    migrations: 72,\n    // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    // END PAPER CURRENT RISK MIGRATION_COUNT\n    // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT',
      },
    ],
  },
  'scripts/registry-domain-evidence.unit.test.mjs': {
    predecessor: '559eb6930decb5e3c0b76d7d2d47e98d34dd4710b75584e4d8706e43b6844c9b',
    current: 'e4c29e0094568581e1103244f4082a18a1fc475aaec25688a19a7aa55f25df77',
    patches: [
      {
        old: "import { expect, it } from 'vitest';\nimport { discoverDatabaseFiles, planDatabaseCohorts } from './database-cohorts.mjs';\nimport { planRoleScopedCohorts } from './role-scoped-cohorts.mjs';",
        next: "// PAPER POSTEXECUTION migration72 acceptance.\nimport { expect, it } from 'vitest';\nimport { discoverDatabaseFiles, planDatabaseCohorts } from './database-cohorts.mjs';\nimport { planRoleScopedCohorts } from './role-scoped-cohorts.mjs';",
      },
      {
        old: "    actors: 32,\n    // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n    // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    migrations: 71,\n    // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    // END PAPER CURRENT RISK MIGRATION_COUNT\n    fixedRoleGraphHash: 'e'.repeat(64),",
        next: "    actors: 32,\n    // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n    // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    migrations: 72,\n    // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    // END PAPER CURRENT RISK MIGRATION_COUNT\n    fixedRoleGraphHash: 'e'.repeat(64),",
      },
    ],
  },
  'scripts/test-integration.mjs': {
    predecessor: 'c3ebfd3cb14797b3df6d092638ef03fe3a0fbc7d137fc9bd72a40890bb929fe4',
    current: 'f9f3cab235867abcc2fc12e8ebe81c84df1ad124e66e11f0e1903052d5a97c36',
    patches: [
      {
        old: "import { fileURLToPath } from 'node:url';\nimport { createServer } from 'node:net';\nimport { readFile } from 'node:fs/promises';",
        next: "// PAPER POSTEXECUTION migration72 acceptance.\nimport { fileURLToPath } from 'node:url';\nimport { createServer } from 'node:net';\nimport { readFile } from 'node:fs/promises';",
      },
      {
        old: '      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n      // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      databaseReport.nativeClusterIsolation?.migrations !== 71 ||\n      // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      // END PAPER CURRENT RISK MIGRATION_COUNT\n      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT',
        next: '      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n      // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      databaseReport.nativeClusterIsolation?.migrations !== 72 ||\n      // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      // END PAPER CURRENT RISK MIGRATION_COUNT\n      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT',
      },
    ],
  },
  'scripts/native-migration-count.unit.test.mjs': {
    predecessor: '61efc5d57e1dd2c12420546fb735cd77adb36aa6dcb6cbab20c61bd521bbb606',
    current: 'cdb8e761e4a4a04f11eeb555473089f08af33e999796dc600d301be3381b5314',
    patches: [
      {
        old: "import { beforeEach, expect, it, vi } from 'vitest';\n// BEGIN PAPER HISTORICAL INVENTORY FIXTURE\n// BEGIN PAPER CURRENT RISK FIXTURE\nconst fixture = vi.hoisted(() => ({ count: 71, cloned: 0, inspections: [] }));\n// END PAPER CURRENT RISK FIXTURE\n// END PAPER HISTORICAL INVENTORY FIXTURE\nvi.mock('./owned-native-secondary.mjs', () => ({",
        next: "// PAPER POSTEXECUTION migration72 acceptance.\nimport { beforeEach, expect, it, vi } from 'vitest';\n// BEGIN PAPER HISTORICAL INVENTORY FIXTURE\n// BEGIN PAPER CURRENT RISK FIXTURE\nconst fixture = vi.hoisted(() => ({ count: 72, cloned: 0, inspections: [] }));\n// END PAPER CURRENT RISK FIXTURE\n// END PAPER HISTORICAL INVENTORY FIXTURE\nvi.mock('./owned-native-secondary.mjs', () => ({",
      },
      {
        old: '\n// BEGIN PAPER HISTORICAL INVENTORY RESET\n// BEGIN PAPER CURRENT RISK RESET\nbeforeEach(() => Object.assign(fixture, { count: 71, cloned: 0, inspections: [] }));\n// END PAPER CURRENT RISK RESET\n// END PAPER HISTORICAL INVENTORY RESET\nfunction run(budget = 10000) {',
        next: '\n// BEGIN PAPER HISTORICAL INVENTORY RESET\n// BEGIN PAPER CURRENT RISK RESET\nbeforeEach(() => Object.assign(fixture, { count: 72, cloned: 0, inspections: [] }));\n// END PAPER CURRENT RISK RESET\n// END PAPER HISTORICAL INVENTORY RESET\nfunction run(budget = 10000) {',
      },
      {
        old: "}\n// BEGIN PAPER HISTORICAL INVENTORY TITLE\n// BEGIN PAPER CURRENT RISK TITLE\nit('checks migration71 in all four secondary ledgers before starting actor cloning', async () => {\n  // END PAPER CURRENT RISK TITLE\n  // END PAPER HISTORICAL INVENTORY TITLE\n  const f = run();",
        next: "}\n// BEGIN PAPER HISTORICAL INVENTORY TITLE\n// BEGIN PAPER CURRENT RISK TITLE\nit('checks migration72 in all four secondary ledgers before starting actor cloning', async () => {\n  // END PAPER CURRENT RISK TITLE\n  // END PAPER HISTORICAL INVENTORY TITLE\n  const f = run();",
      },
      {
        old: "  expect(fixture.cloned).toBe(0);\n});\n// END PAPER CURRENT RISK STALE\n// BEGIN PAPER CURRENT ORDER RISK STALE\nit('rejects published70 secondary state before cloning any actor', async () => {\n  fixture.count = 70;",
        next: "  expect(fixture.cloned).toBe(0);\n});\n// END PAPER CURRENT RISK STALE\nit('rejects published71 secondary state before cloning any actor', async () => {\n  fixture.count = 71;\n  const f = run();\n  await expect(f.promise).rejects.toThrow();\n  expect(f.migrated).toHaveLength(1);\n  expect(f.observed).toEqual(f.migrated);\n  expect(f.closed).toEqual(f.migrated);\n  expect(fixture.cloned).toBe(0);\n});\n// BEGIN PAPER CURRENT ORDER RISK STALE\nit('rejects published70 secondary state before cloning any actor', async () => {\n  fixture.count = 70;",
      },
    ],
  },
};

export function beforePostexecutionMigration(
  file,
  text,
  code = 'PAPER_POSTEXECUTION_REVIEW_REQUIRED',
) {
  const review = postexecutionMigrationReview[file];
  if (!review || !text.includes('PAPER POSTEXECUTION migration72 acceptance')) return text;
  text = beforePostexecutionBasisMigration(file, text, code);
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  if (hash(text) !== review.current) throw Error(code);
  for (const patch of [...review.patches].reverse()) {
    if (text.split(patch.next).length !== 2) throw Error(code);
    text = text.replace(patch.next, () => patch.old);
  }
  if (hash(text) !== review.predecessor) throw Error(code);
  return text;
}
