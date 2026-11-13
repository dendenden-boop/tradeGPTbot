// REGISTRY_DOMAIN_EARLY_NATIVE: exact registry-profile changes peel before prior reviews.
import { beforeRegistryDomain } from './registry-domain-legacy.mjs';
// Test-only exact accepted514 harness reconstruction; never runtime authority.
import { createHash } from 'node:crypto';
export const historicalInventoryReview = {
  'scripts/test-database.mjs': {
    predecessor: '63d51110bc28dd7836f225cbca30f94c14e60e0e69ee61f1effd9c329b732a40',
    patches: [
      {
        old: '    assert.equal(executionCommitOwner.numPassedTests, 28);\n',
        next: '    // BEGIN PAPER HISTORICAL INVENTORY OWNER_COUNT\n    assert.equal(executionCommitOwner.numPassedTests, 35);\n    // END PAPER HISTORICAL INVENTORY OWNER_COUNT\n',
      },
      {
        old: '  assert.equal(executedValuationSeed.numPendingTests, 27);\n',
        next: '  // BEGIN PAPER HISTORICAL INVENTORY PRE67_PENDING\n  assert.equal(executedValuationSeed.numPendingTests, 34);\n  // END PAPER HISTORICAL INVENTORY PRE67_PENDING\n',
      },
      {
        old: '// BEGIN PAPER EXECUTED VALUATION IMPORT\n',
        next: "// BEGIN PAPER HISTORICAL INVENTORY IMPORT\nimport {\n  verifyPaperHistoricalInventoryStorage,\n  verifyPaperHistoricalInventoryUpgrade,\n  verifyCompiledHistoricalInventory,\n} from './paper-historical-inventory-upgrade.mjs';\n// BEGIN PAPER EXECUTED VALUATION IMPORT\n// END PAPER HISTORICAL INVENTORY IMPORT\n",
      },
      {
        old: "  '202611120001_paper_executed_valuation',\n",
        next: "  // BEGIN PAPER HISTORICAL INVENTORY MIGRATION\n  '202611120001_paper_executed_valuation',\n  '202611130001_paper_historical_inventory',\n  // END PAPER HISTORICAL INVENTORY MIGRATION\n",
      },
      {
        old: '  // END PAPER EXECUTED VALUATION UPGRADE\n',
        next: "  // BEGIN PAPER HISTORICAL INVENTORY UPGRADE\n  // END PAPER EXECUTED VALUATION UPGRADE\n  const beforeHistoricalInventory = await capturePaperExecutionStartUpgrade(paperUpgrade);\n  await cp(\n    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[67]),\n    path.join(paperMigrations, expectedMigrations[67]),\n    { recursive: true },\n  );\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperHistoricalInventoryUpgrade(paperUpgrade, beforeHistoricalInventory);\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperHistoricalInventoryUpgrade(paperUpgrade, beforeHistoricalInventory);\n  const historicalInventoryCompiled = await verifyCompiledHistoricalInventory(\n    paperUpgrade,\n    paperAdmissionEnvironment(databases[4]),\n  );\n  assert.equal(historicalInventoryCompiled.status, 'PASS');\n  // END PAPER HISTORICAL INVENTORY UPGRADE\n",
      },
      {
        old: '    await executionCommitDb.end();\n',
        next: "    // BEGIN PAPER HISTORICAL INVENTORY OWNER_PROOF\n    await verifyPaperHistoricalInventoryStorage(executionCommitDb, {\n      ownership: 'REQUIRE_NON_BYPASS',\n    });\n    await executionCommitDb.end();\n    // END PAPER HISTORICAL INVENTORY OWNER_PROOF\n",
      },
      {
        old: "  await verifyPaperExecutedValuationStorage(admissionReset, { ownership: 'STORAGE_ONLY' });\n",
        next: "  // BEGIN PAPER HISTORICAL INVENTORY RESET_UPGRADE\n  await verifyPaperExecutedValuationStorage(admissionReset, { ownership: 'STORAGE_ONLY' });\n  await verifyPaperHistoricalInventoryStorage(admissionReset, { ownership: 'STORAGE_ONLY' });\n  // END PAPER HISTORICAL INVENTORY RESET_UPGRADE\n",
      },
      {
        old: "  await verifyPaperExecutedValuationStorage(startedAfterReset, { ownership: 'STORAGE_ONLY' });\n",
        next: "  // BEGIN PAPER HISTORICAL INVENTORY RESET_POPULATED\n  await verifyPaperExecutedValuationStorage(startedAfterReset, { ownership: 'STORAGE_ONLY' });\n  await verifyPaperHistoricalInventoryStorage(startedAfterReset, { ownership: 'STORAGE_ONLY' });\n  // END PAPER HISTORICAL INVENTORY RESET_POPULATED\n",
      },
      {
        old: "  await verifyPaperExecutedValuationStorage(reset, { ownership: 'STORAGE_ONLY' });\n",
        next: "  // BEGIN PAPER HISTORICAL INVENTORY RESET_FRESH\n  await verifyPaperExecutedValuationStorage(reset, { ownership: 'STORAGE_ONLY' });\n  await verifyPaperHistoricalInventoryStorage(reset, { ownership: 'STORAGE_ONLY' });\n  // END PAPER HISTORICAL INVENTORY RESET_FRESH\n",
      },
      {
        old: '    paperExecutedValuationCompiled: executedValuationCompiled,\n',
        next: '    // BEGIN PAPER HISTORICAL INVENTORY FLAGS\n    paperExecutedValuationCompiled: executedValuationCompiled,\n    paperHistoricalInventoryUpgradePreserved: true,\n    paperHistoricalInventoryResetValidated: true,\n    paperHistoricalInventoryCompiled: historicalInventoryCompiled,\n    // END PAPER HISTORICAL INVENTORY FLAGS\n',
      },
    ],
  },
  'scripts/native-proof-artifacts.mjs': {
    predecessor: 'ae2ba4da6fe7b9f1d54e733689b5d386ab2a139896f9f4015588d91750fb0743',
    patches: [
      {
        old: "  'paper-execution-commit': 28,\n",
        next: "  // BEGIN PAPER HISTORICAL INVENTORY REPORT_COUNT\n  'paper-execution-commit': 35,\n  // END PAPER HISTORICAL INVENTORY REPORT_COUNT\n",
      },
    ],
  },
  'scripts/test-integration.mjs': {
    predecessor: '75f4a41496c6d8b501760252ce5e2bb554c1d2d7dd079dedf0eb5493b6394f4e',
    patches: [
      {
        old: '      databaseReport.nativeClusterIsolation?.migrations !== 67 ||\n',
        next: '      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      databaseReport.nativeClusterIsolation?.migrations !== 68 ||\n      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/cluster-isolated-evidence.mjs': {
    predecessor: '984420c00d41cc8a643446069e5fa1f1aab60db894d32d033fea47613696fde2',
    patches: [
      {
        old: '  assert.equal(proof.migrations, 67);\n',
        next: '  // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n  assert.equal(proof.migrations, 68);\n  // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/cluster-isolated-evidence.unit.test.mjs': {
    predecessor: 'fddc6a58a2516f97acc910471826632062a1b337032cadb40af466e123e0efe2',
    patches: [
      {
        old: '    migrations: 67,\n',
        next: '    // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n    migrations: 68,\n    // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/native-cluster-bootstrap.mjs': {
    predecessor: '06a4bbfa12a179347c62b81676196e8511b07a366cbc0a7dd69e68ac39ea5da8',
    patches: [
      {
        old: '        67,\n',
        next: '        // BEGIN PAPER HISTORICAL INVENTORY SECONDARY_COUNT\n        68,\n        // END PAPER HISTORICAL INVENTORY SECONDARY_COUNT\n',
      },
      {
        old: '      migrations: 67,\n',
        next: '      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      migrations: 68,\n      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/native-migration-count.unit.test.mjs': {
    predecessor: 'a4556aa6437d94e3bf765e6ebe34638d68de1de8ed13f57b59ad7daf3a248196',
    patches: [
      {
        old: 'const fixture = vi.hoisted(() => ({ count: 67, cloned: 0, inspections: [] }));\n',
        next: '// BEGIN PAPER HISTORICAL INVENTORY FIXTURE\nconst fixture = vi.hoisted(() => ({ count: 68, cloned: 0, inspections: [] }));\n// END PAPER HISTORICAL INVENTORY FIXTURE\n',
      },
      {
        old: 'beforeEach(() => Object.assign(fixture, { count: 67, cloned: 0, inspections: [] }));\n',
        next: '// BEGIN PAPER HISTORICAL INVENTORY RESET\nbeforeEach(() => Object.assign(fixture, { count: 68, cloned: 0, inspections: [] }));\n// END PAPER HISTORICAL INVENTORY RESET\n',
      },
      {
        old: "it('checks migration67 in all four secondary ledgers before starting actor cloning', async () => {\n",
        next: "// BEGIN PAPER HISTORICAL INVENTORY TITLE\nit('checks migration68 in all four secondary ledgers before starting actor cloning', async () => {\n  // END PAPER HISTORICAL INVENTORY TITLE\n",
      },
      {
        old: "it('rejects a secondary ledger still at published66 before cloning any actor', async () => {\n  fixture.count = 66;\n",
        next: "// BEGIN PAPER HISTORICAL INVENTORY STALE\nit('rejects a secondary ledger still at published67 before cloning any actor', async () => {\n  fixture.count = 67;\n  // END PAPER HISTORICAL INVENTORY STALE\n",
      },
    ],
  },
};
export function beforeHistoricalInventory(file, source) {
  source = beforeRegistryDomain(file, source);
  const r = historicalInventoryReview[file];
  if (!r || !source.includes('PAPER HISTORICAL INVENTORY')) return source;
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  if (hash(source) === r.predecessor) return source;
  for (const p of r.patches) {
    if (source.split(p.next).length !== 2)
      throw Error('PAPER_HISTORICAL_INVENTORY_REVIEW_REQUIRED');
    const at = source.indexOf(p.next);
    source = source.slice(0, at) + p.old + source.slice(at + p.next.length);
  }
  if (hash(source) !== r.predecessor) throw Error('PAPER_HISTORICAL_INVENTORY_REVIEW_REQUIRED');
  return source;
}
