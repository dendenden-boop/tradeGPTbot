// Test-only exact accepted116 reconstruction. No runtime authority or waiver.
import { createHash } from 'node:crypto';
import { beforeWriterOwnerPartitions } from './writer-owner-partitions-legacy.mjs';
export const currentOrderRiskReview = {
  'scripts/test-database.mjs': {
    predecessor: 'c2b5c3068b20e5ad4dbb30380b320787fafff313921fca851863e165ec2c490f',
    current: '9d7730c7248d15ff540355b909f91e4a945263e7de69abab8c5158cf99e382dd',
    patches: [
      {
        old: '// BEGIN PAPER CURRENT RISK IMPORT\n// BEGIN PAPER CURRENT RISK MARKET IMPORT\nimport {\n',
        next: "// BEGIN PAPER CURRENT ORDER RISK IMPORT\nimport {\n  verifyPaperCurrentOrderRiskStorage,\n  verifyPaperCurrentOrderRiskUpgrade,\n  verifyCompiledCurrentOrderRisk,\n} from './paper-current-order-risk-upgrade.mjs';\n// END PAPER CURRENT ORDER RISK IMPORT\n// BEGIN PAPER CURRENT RISK IMPORT\n// BEGIN PAPER CURRENT RISK MARKET IMPORT\nimport {\n",
      },
      {
        old: "  '202611140001_paper_current_risk',\n  // BEGIN PAPER CURRENT RISK MARKET MIGRATION\n  '202611140002_paper_current_risk_market_coherence',\n  // END PAPER CURRENT RISK MARKET MIGRATION\n  // END PAPER CURRENT RISK MIGRATION\n  // END PAPER HISTORICAL INVENTORY MIGRATION\n",
        next: "  '202611140001_paper_current_risk',\n  // BEGIN PAPER CURRENT RISK MARKET MIGRATION\n  '202611140002_paper_current_risk_market_coherence',\n  // BEGIN PAPER CURRENT ORDER RISK MIGRATION\n  '202611150001_paper_current_order_risk',\n  // END PAPER CURRENT ORDER RISK MIGRATION\n  // END PAPER CURRENT RISK MARKET MIGRATION\n  // END PAPER CURRENT RISK MIGRATION\n  // END PAPER HISTORICAL INVENTORY MIGRATION\n",
      },
      {
        old: "      ownership: 'REQUIRE_NON_BYPASS',\n    });\n    // END PAPER CURRENT RISK MARKET OWNER_PROOF\n    // END PAPER CURRENT RISK OWNER_PROOF\n    await executionCommitDb.end();\n    // END PAPER HISTORICAL INVENTORY OWNER_PROOF\n",
        next: "      ownership: 'REQUIRE_NON_BYPASS',\n    });\n    // END PAPER CURRENT RISK MARKET OWNER_PROOF\n    // BEGIN PAPER CURRENT ORDER RISK OWNER_PROOF\n    await verifyPaperCurrentOrderRiskStorage(executionCommitDb, {\n      ownership: 'REQUIRE_NON_BYPASS',\n    });\n    // END PAPER CURRENT ORDER RISK OWNER_PROOF\n    // END PAPER CURRENT RISK OWNER_PROOF\n    await executionCommitDb.end();\n    // END PAPER HISTORICAL INVENTORY OWNER_PROOF\n",
      },
      {
        old: '    // BEGIN PAPER EXECUTED BOOK OWNER_COUNT\n    // BEGIN PAPER HISTORICAL INVENTORY OWNER_COUNT\n    // BEGIN PAPER CURRENT RISK OWNER_COUNT\n    assert.equal(executionCommitOwner.numPassedTests, 41);\n    // END PAPER CURRENT RISK OWNER_COUNT\n    // END PAPER HISTORICAL INVENTORY OWNER_COUNT\n    // END PAPER EXECUTED BOOK OWNER_COUNT\n',
        next: '    // BEGIN PAPER EXECUTED BOOK OWNER_COUNT\n    // BEGIN PAPER HISTORICAL INVENTORY OWNER_COUNT\n    // BEGIN PAPER CURRENT RISK OWNER_COUNT\n    // BEGIN PAPER CURRENT ORDER RISK OWNER_COUNT\n    assert.equal(executionCommitOwner.numPassedTests, 49);\n    // END PAPER CURRENT ORDER RISK OWNER_COUNT\n    // END PAPER CURRENT RISK OWNER_COUNT\n    // END PAPER HISTORICAL INVENTORY OWNER_COUNT\n    // END PAPER EXECUTED BOOK OWNER_COUNT\n',
      },
      {
        old: '  assert.equal(executedValuationSeed.numFailedTests, 0);\n  // BEGIN PAPER HISTORICAL INVENTORY PRE67_PENDING\n  // BEGIN PAPER CURRENT RISK PRE67_COUNT\n  assert.equal(executedValuationSeed.numPendingTests, 40);\n  // END PAPER CURRENT RISK PRE67_COUNT\n  // END PAPER HISTORICAL INVENTORY PRE67_PENDING\n  const beforeExecutedValuation = await capturePaperExecutionStartUpgrade(paperUpgrade);\n',
        next: '  assert.equal(executedValuationSeed.numFailedTests, 0);\n  // BEGIN PAPER HISTORICAL INVENTORY PRE67_PENDING\n  // BEGIN PAPER CURRENT RISK PRE67_COUNT\n  // BEGIN PAPER CURRENT ORDER RISK PRE67_COUNT\n  assert.equal(executedValuationSeed.numPendingTests, 48);\n  // END PAPER CURRENT ORDER RISK PRE67_COUNT\n  // END PAPER CURRENT RISK PRE67_COUNT\n  // END PAPER HISTORICAL INVENTORY PRE67_PENDING\n  const beforeExecutedValuation = await capturePaperExecutionStartUpgrade(paperUpgrade);\n',
      },
      {
        old: "  );\n  assert.equal(currentRiskMarketCompiled.status, 'PASS');\n  // END PAPER CURRENT RISK MARKET UPGRADE\n\n  // Restore a genuinely populated published-19 format before applying any\n  // lifecycle migration. The acceptance fixture uses actual atomic issuance;\n",
        next: "  );\n  assert.equal(currentRiskMarketCompiled.status, 'PASS');\n  // END PAPER CURRENT RISK MARKET UPGRADE\n  // BEGIN PAPER CURRENT ORDER RISK UPGRADE\n  const beforeCurrentOrderRisk = await capturePaperExecutionStartUpgrade(paperUpgrade);\n  await cp(\n    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[70]),\n    path.join(paperMigrations, expectedMigrations[70]),\n    { recursive: true },\n  );\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperCurrentOrderRiskUpgrade(paperUpgrade, beforeCurrentOrderRisk);\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperCurrentOrderRiskUpgrade(paperUpgrade, beforeCurrentOrderRisk);\n  const currentOrderRiskCompiled = await verifyCompiledCurrentOrderRisk(\n    paperUpgrade,\n    paperAdmissionEnvironment(databases[4]),\n  );\n  assert.equal(currentOrderRiskCompiled.status, 'PASS');\n  // END PAPER CURRENT ORDER RISK UPGRADE\n\n  // Restore a genuinely populated published-19 format before applying any\n  // lifecycle migration. The acceptance fixture uses actual atomic issuance;\n",
      },
      {
        old: '    empty: true,\n  });\n  // END PAPER CURRENT RISK MARKET RESET_UPGRADE\n  // END PAPER CURRENT RISK RESET_UPGRADE\n  // END PAPER HISTORICAL INVENTORY RESET_UPGRADE\n  // END PAPER EXECUTED VALUATION RESET_ADMISSIONRESET\n',
        next: "    empty: true,\n  });\n  // END PAPER CURRENT RISK MARKET RESET_UPGRADE\n  // BEGIN PAPER CURRENT ORDER RISK RESET_ADMISSIONRESET\n  await verifyPaperCurrentOrderRiskStorage(admissionReset, {\n    ownership: 'STORAGE_ONLY',\n    empty: true,\n  });\n  // END PAPER CURRENT ORDER RISK RESET_ADMISSIONRESET\n  // END PAPER CURRENT RISK RESET_UPGRADE\n  // END PAPER HISTORICAL INVENTORY RESET_UPGRADE\n  // END PAPER EXECUTED VALUATION RESET_ADMISSIONRESET\n",
      },
      {
        old: "    empty: true,\n  });\n  // END PAPER CURRENT RISK MARKET RESET_POPULATED\n  // END PAPER HISTORICAL INVENTORY RESET_POPULATED\n  // END PAPER EXECUTED VALUATION RESET_STARTEDAFTERRESET\n  for (const table of ['execution_commit', 'execution_liquidity'])\n",
        next: "    empty: true,\n  });\n  // END PAPER CURRENT RISK MARKET RESET_POPULATED\n  // BEGIN PAPER CURRENT ORDER RISK RESET_STARTEDAFTERRESET\n  await verifyPaperCurrentOrderRiskStorage(startedAfterReset, {\n    ownership: 'STORAGE_ONLY',\n    empty: true,\n  });\n  // END PAPER CURRENT ORDER RISK RESET_STARTEDAFTERRESET\n  // END PAPER HISTORICAL INVENTORY RESET_POPULATED\n  // END PAPER EXECUTED VALUATION RESET_STARTEDAFTERRESET\n  for (const table of ['execution_commit', 'execution_liquidity'])\n",
      },
      {
        old: '    paperCurrentRiskMarketResetValidated: true,\n    paperCurrentRiskMarketCompiled: currentRiskMarketCompiled,\n    // END PAPER CURRENT RISK MARKET FLAGS\n    // END PAPER CURRENT RISK FLAGS\n    // END PAPER HISTORICAL INVENTORY FLAGS\n    // END PAPER EXECUTED VALUATION REPORT\n',
        next: '    paperCurrentRiskMarketResetValidated: true,\n    paperCurrentRiskMarketCompiled: currentRiskMarketCompiled,\n    // END PAPER CURRENT RISK MARKET FLAGS\n    // BEGIN PAPER CURRENT ORDER RISK FLAGS\n    paperCurrentOrderRiskUpgradePreserved: true,\n    paperCurrentOrderRiskResetValidated: true,\n    paperCurrentOrderRiskCompiled: currentOrderRiskCompiled,\n    // END PAPER CURRENT ORDER RISK FLAGS\n    // END PAPER CURRENT RISK FLAGS\n    // END PAPER HISTORICAL INVENTORY FLAGS\n    // END PAPER EXECUTED VALUATION REPORT\n',
      },
      {
        old: "  // BEGIN PAPER CURRENT RISK MARKET RESET_FRESH\n  await verifyPaperCurrentRiskMarketStorage(reset, { ownership: 'STORAGE_ONLY', empty: true });\n  // END PAPER CURRENT RISK MARKET RESET_FRESH\n  // END PAPER CURRENT RISK RESET_FRESH\n  // END PAPER HISTORICAL INVENTORY RESET_FRESH\n  // END PAPER EXECUTED VALUATION RESET_RESET\n",
        next: "  // BEGIN PAPER CURRENT RISK MARKET RESET_FRESH\n  await verifyPaperCurrentRiskMarketStorage(reset, { ownership: 'STORAGE_ONLY', empty: true });\n  // END PAPER CURRENT RISK MARKET RESET_FRESH\n  // BEGIN PAPER CURRENT ORDER RISK RESET_RESET\n  await verifyPaperCurrentOrderRiskStorage(reset, { ownership: 'STORAGE_ONLY', empty: true });\n  // END PAPER CURRENT ORDER RISK RESET_RESET\n  // END PAPER CURRENT RISK RESET_FRESH\n  // END PAPER HISTORICAL INVENTORY RESET_FRESH\n  // END PAPER EXECUTED VALUATION RESET_RESET\n",
      },
    ],
  },
  'scripts/native-proof-artifacts.mjs': {
    predecessor: 'a6cc96bd2bf45aa8f2ef2c609296cb88d32759e326d20bfa86fa15090b693629',
    current: '109553cdc693e4506343cfb794bf224c7fa5d8da0bf0fc7174e2f932bd56235a',
    patches: [
      {
        old: "  // BEGIN PAPER EXECUTED BOOK REPORT_COUNT\n  // BEGIN PAPER HISTORICAL INVENTORY REPORT_COUNT\n  // BEGIN PAPER CURRENT RISK REPORT_COUNT\n  'paper-execution-commit': 41,\n  // END PAPER CURRENT RISK REPORT_COUNT\n  // END PAPER HISTORICAL INVENTORY REPORT_COUNT\n  // END PAPER EXECUTED BOOK REPORT_COUNT\n",
        next: "  // BEGIN PAPER EXECUTED BOOK REPORT_COUNT\n  // BEGIN PAPER HISTORICAL INVENTORY REPORT_COUNT\n  // BEGIN PAPER CURRENT RISK REPORT_COUNT\n  // BEGIN PAPER CURRENT ORDER RISK REPORT_COUNT\n  'paper-execution-commit': 49,\n  // END PAPER CURRENT ORDER RISK REPORT_COUNT\n  // END PAPER CURRENT RISK REPORT_COUNT\n  // END PAPER HISTORICAL INVENTORY REPORT_COUNT\n  // END PAPER EXECUTED BOOK REPORT_COUNT\n",
      },
    ],
  },
  'scripts/native-cluster-bootstrap.mjs': {
    predecessor: '016c1092c654df69e14ed0e2fa809bcda6557134ceab92801a7fa288c9d91399',
    current: 'bfa66a3ef0d5a1af0180dea4a0b419a8b2105e0ce712ad65d3cf11a33d86d216',
    patches: [
      {
        old: '        // BEGIN PAPER EXECUTED VALUATION SECONDARY_APPLIED_COUNT\n        // BEGIN PAPER HISTORICAL INVENTORY SECONDARY_COUNT\n        // BEGIN PAPER CURRENT RISK SECONDARY_COUNT\n        70,\n        // END PAPER CURRENT RISK SECONDARY_COUNT\n        // END PAPER HISTORICAL INVENTORY SECONDARY_COUNT\n        // END PAPER EXECUTED VALUATION SECONDARY_APPLIED_COUNT\n',
        next: '        // BEGIN PAPER EXECUTED VALUATION SECONDARY_APPLIED_COUNT\n        // BEGIN PAPER HISTORICAL INVENTORY SECONDARY_COUNT\n        // BEGIN PAPER CURRENT RISK SECONDARY_COUNT\n        // BEGIN PAPER CURRENT ORDER RISK SECONDARY_COUNT\n        71,\n        // END PAPER CURRENT ORDER RISK SECONDARY_COUNT\n        // END PAPER CURRENT RISK SECONDARY_COUNT\n        // END PAPER HISTORICAL INVENTORY SECONDARY_COUNT\n        // END PAPER EXECUTED VALUATION SECONDARY_APPLIED_COUNT\n',
      },
      {
        old: '      // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n      migrations: 70,\n      // END PAPER CURRENT RISK MIGRATION_COUNT\n      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
        next: '      // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n      // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      migrations: 71,\n      // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      // END PAPER CURRENT RISK MIGRATION_COUNT\n      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/cluster-isolated-evidence.mjs': {
    predecessor: '998073ab0228edf212ecc8b17d9e5b23d087d7240c50037549a66be14fe68f4e',
    current: '74a1a0195be4f885a689f6a2cba1a80d4327e0dfe7d7e1174278dc60a86d9257',
    patches: [
      {
        old: '  // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n  // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n  // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n  assert.equal(proof.migrations, 70);\n  // END PAPER CURRENT RISK MIGRATION_COUNT\n  // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n  // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
        next: '  // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n  // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n  // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n  // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n  assert.equal(proof.migrations, 71);\n  // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n  // END PAPER CURRENT RISK MIGRATION_COUNT\n  // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n  // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/cluster-isolated-evidence.unit.test.mjs': {
    predecessor: '115343f1d25e5f2c6b3dbf714fcb819cdf2f4fca39aa5ec89957f210fe6f4ad8',
    current: '0f607d2f36908551926ad8722a4a8dbd40600140c1a534e5edf4e4563d6edc7a',
    patches: [
      {
        old: '    // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n    // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n    // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n    migrations: 70,\n    // END PAPER CURRENT RISK MIGRATION_COUNT\n    // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n    // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
        next: '    // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n    // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n    // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n    // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    migrations: 71,\n    // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    // END PAPER CURRENT RISK MIGRATION_COUNT\n    // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n    // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/registry-domain-evidence.unit.test.mjs': {
    predecessor: '6836f4b46560cba30733a67f9fc56c7a547f6f09d35c2dce24a0887324e63fa6',
    current: '559eb6930decb5e3c0b76d7d2d47e98d34dd4710b75584e4d8706e43b6844c9b',
    patches: [
      {
        old: "    roleIsolation: { independent: true, probeRolesRemoved: true },\n    actors: 32,\n    // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n    migrations: 70,\n    // END PAPER CURRENT RISK MIGRATION_COUNT\n    fixedRoleGraphHash: 'e'.repeat(64),\n    registryIndependence: globalThis.structuredClone(evidence),\n",
        next: "    roleIsolation: { independent: true, probeRolesRemoved: true },\n    actors: 32,\n    // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n    // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    migrations: 71,\n    // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n    // END PAPER CURRENT RISK MIGRATION_COUNT\n    fixedRoleGraphHash: 'e'.repeat(64),\n    registryIndependence: globalThis.structuredClone(evidence),\n",
      },
    ],
  },
  'scripts/native-migration-count.unit.test.mjs': {
    predecessor: '69bc8325c61fb6148efdb55c783f0beb59dd76dd67c5e0fca9ae2eeef5eb3c67',
    current: '61efc5d57e1dd2c12420546fb735cd77adb36aa6dcb6cbab20c61bd521bbb606',
    patches: [
      {
        old: "import { beforeEach, expect, it, vi } from 'vitest';\n// BEGIN PAPER HISTORICAL INVENTORY FIXTURE\n// BEGIN PAPER CURRENT RISK FIXTURE\nconst fixture = vi.hoisted(() => ({ count: 70, cloned: 0, inspections: [] }));\n// END PAPER CURRENT RISK FIXTURE\n// END PAPER HISTORICAL INVENTORY FIXTURE\nvi.mock('./owned-native-secondary.mjs', () => ({\n",
        next: "import { beforeEach, expect, it, vi } from 'vitest';\n// BEGIN PAPER HISTORICAL INVENTORY FIXTURE\n// BEGIN PAPER CURRENT RISK FIXTURE\nconst fixture = vi.hoisted(() => ({ count: 71, cloned: 0, inspections: [] }));\n// END PAPER CURRENT RISK FIXTURE\n// END PAPER HISTORICAL INVENTORY FIXTURE\nvi.mock('./owned-native-secondary.mjs', () => ({\n",
      },
      {
        old: '\n// BEGIN PAPER HISTORICAL INVENTORY RESET\n// BEGIN PAPER CURRENT RISK RESET\nbeforeEach(() => Object.assign(fixture, { count: 70, cloned: 0, inspections: [] }));\n// END PAPER CURRENT RISK RESET\n// END PAPER HISTORICAL INVENTORY RESET\nfunction run(budget = 10000) {\n',
        next: '\n// BEGIN PAPER HISTORICAL INVENTORY RESET\n// BEGIN PAPER CURRENT RISK RESET\nbeforeEach(() => Object.assign(fixture, { count: 71, cloned: 0, inspections: [] }));\n// END PAPER CURRENT RISK RESET\n// END PAPER HISTORICAL INVENTORY RESET\nfunction run(budget = 10000) {\n',
      },
      {
        old: "}\n// BEGIN PAPER HISTORICAL INVENTORY TITLE\n// BEGIN PAPER CURRENT RISK TITLE\nit('checks migration70 in all four secondary ledgers before starting actor cloning', async () => {\n  // END PAPER CURRENT RISK TITLE\n  // END PAPER HISTORICAL INVENTORY TITLE\n  const f = run();\n",
        next: "}\n// BEGIN PAPER HISTORICAL INVENTORY TITLE\n// BEGIN PAPER CURRENT RISK TITLE\nit('checks migration71 in all four secondary ledgers before starting actor cloning', async () => {\n  // END PAPER CURRENT RISK TITLE\n  // END PAPER HISTORICAL INVENTORY TITLE\n  const f = run();\n",
      },
      {
        old: "  expect(fixture.cloned).toBe(0);\n});\n// END PAPER CURRENT RISK STALE\n// BEGIN PAPER CURRENT RISK MARKET STALE\nit('rejects published69 secondary state before cloning any actor', async () => {\n  fixture.count = 69;\n",
        next: "  expect(fixture.cloned).toBe(0);\n});\n// END PAPER CURRENT RISK STALE\n// BEGIN PAPER CURRENT ORDER RISK STALE\nit('rejects published70 secondary state before cloning any actor', async () => {\n  fixture.count = 70;\n  const f = run();\n  await expect(f.promise).rejects.toThrow();\n  expect(f.migrated).toHaveLength(1);\n  expect(f.observed).toEqual(f.migrated);\n  expect(f.closed).toEqual(f.migrated);\n  expect(fixture.cloned).toBe(0);\n});\n// END PAPER CURRENT ORDER RISK STALE\n// BEGIN PAPER CURRENT RISK MARKET STALE\nit('rejects published69 secondary state before cloning any actor', async () => {\n  fixture.count = 69;\n",
      },
    ],
  },
  'scripts/test-integration.mjs': {
    predecessor: '60fd91fc92ee14b6ee1f0893bb5c660c7960a7a92633f862487beb4085881172',
    current: 'c3ebfd3cb14797b3df6d092638ef03fe3a0fbc7d137fc9bd72a40890bb929fe4',
    patches: [
      {
        old: '      // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n      databaseReport.nativeClusterIsolation?.migrations !== 70 ||\n      // END PAPER CURRENT RISK MIGRATION_COUNT\n      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
        next: '      // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n      // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n      // BEGIN PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      databaseReport.nativeClusterIsolation?.migrations !== 71 ||\n      // END PAPER CURRENT ORDER RISK MIGRATION_COUNT\n      // END PAPER CURRENT RISK MIGRATION_COUNT\n      // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT\n      // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/current-risk-count-legacy.mjs': {
    predecessor: 'aa523c32f1b789154cd2452cbb4ee499eeec47aac049c6f2c0a5d5d1267d5d6d',
    current: 'eb46dcebc2997ad09d2154d80e2aa800aae2b8ed2a70e09f65f2bdcd0b1d0050',
    patches: [
      {
        old: "// Test-only exact accepted455 count and additive69/70 harness review; no runtime authority or waiver.\nimport { createHash } from 'node:crypto';\nexport const currentRiskCountReview = {\n  'scripts/native-proof-artifacts.mjs': {\n    predecessor: '67b79c58f98ccd2d6b457ba499c9fe512ec21d7783461608d859ab3cf8cb7e54',\n",
        next: "// PAPER CURRENT ORDER RISK: restore the latest exact layer before historical pins.\n// Test-only exact accepted455 count and additive69/70 harness review; no runtime authority or waiver.\nimport { createHash } from 'node:crypto';\nimport { beforeCurrentOrderRiskReview } from './current-order-risk-legacy.mjs';\nexport const currentRiskCountReview = {\n  'scripts/native-proof-artifacts.mjs': {\n    predecessor: '67b79c58f98ccd2d6b457ba499c9fe512ec21d7783461608d859ab3cf8cb7e54',\n",
      },
      {
        old: "  },\n};\nexport function beforeCurrentRiskCounts(file, source) {\n  const review = currentRiskCountReview[file];\n  if (!review || !source.includes('PAPER CURRENT RISK')) return source;\n  const hash = (s) => createHash('sha256').update(s).digest('hex');\n",
        next: "  },\n};\nexport function beforeCurrentRiskCounts(file, source) {\n  source = beforeCurrentOrderRiskReview(file, source, 'PAPER_CURRENT_RISK_COUNT_REVIEW_REQUIRED');\n  const review = currentRiskCountReview[file];\n  if (!review || !source.includes('PAPER CURRENT RISK')) return source;\n  const hash = (s) => createHash('sha256').update(s).digest('hex');\n",
      },
    ],
  },
  'scripts/current-risk-count-legacy.unit.test.mjs': {
    predecessor: 'e1722e6ec2d985cd07d991d6527a5d9d6b9753b88731cbf63edae5ca904bf435',
    current: '59ef27e7d393f6838858716c1c846a6e4edc4752a96b04dc8326908e93523011',
    patches: [
      {
        old: "import { readFile } from 'node:fs/promises';\nimport { createHash } from 'node:crypto';\nimport { expect, it } from 'vitest';\n",
        next: "// PAPER CURRENT ORDER RISK: older tamper tests retain their exact predecessor fixture.\nimport { beforeCurrentOrderRiskReview } from './current-order-risk-legacy.mjs';\nimport { readFile } from 'node:fs/promises';\nimport { createHash } from 'node:crypto';\nimport { expect, it } from 'vitest';\n",
      },
      {
        old: "it.each(Object.entries(currentRiskCountReview))(\n  'reconstructs complete accepted455 source below exact new mandatory case counts: %s',\n  async (file, review) => {\n    const source = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(\n      '\\r\\n',\n      '\\n',\n    );\n    expect(hash(source)).toBe(review.current);\n    expect(hash(beforeCurrentRiskCounts(file, source))).toBe(review.predecessor);\n",
        next: "it.each(Object.entries(currentRiskCountReview))(\n  'reconstructs complete accepted455 source below exact new mandatory case counts: %s',\n  async (file, review) => {\n    const source = beforeCurrentOrderRiskReview(\n      file,\n      (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\\r\\n', '\\n'),\n    );\n    expect(hash(source)).toBe(review.current);\n    expect(hash(beforeCurrentRiskCounts(file, source))).toBe(review.predecessor);\n",
      },
    ],
  },
};
export function beforeCurrentOrderRiskReview(
  file,
  source,
  code = 'PAPER_CURRENT_ORDER_RISK_REVIEW_REQUIRED',
) {
  try {
    source = beforeWriterOwnerPartitions(file, source);
  } catch {
    throw Error(code);
  }
  const r = currentOrderRiskReview[file];
  if (!r || !source.includes('PAPER CURRENT ORDER RISK')) return source;
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  if (hash(source) === r.predecessor) return source;
  if (hash(source) !== r.current) throw Error(code);
  for (const p of [...r.patches].reverse()) {
    if (source.split(p.next).length !== 2) throw Error(code);
    source = source.replace(p.next, p.old);
  }
  if (hash(source) !== r.predecessor) throw Error(code);
  return source;
}
