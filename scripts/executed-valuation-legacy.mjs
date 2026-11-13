// Test-only exact accepted Daa reconstruction. Runtime never imports this file.
import { createHash } from 'node:crypto';
import { beforeHistoricalInventory } from './historical-inventory-legacy.mjs';
export const executedValuationReview = {
  'scripts/test-database.mjs': {
    predecessor: 'ff99263de715f18e0bf2589a5e2dc69a3789cb17fc73936a309eb7c9d6093e46',
    patches: [
      {
        tag: 'IMPORT',
        old: '',
        next: "// BEGIN PAPER EXECUTED VALUATION IMPORT\nimport {\n  verifyPaperExecutedValuationStorage,\n  verifyPaperExecutedValuationUpgrade,\n  verifyCompiledExecutedValuation,\n} from './paper-executed-valuation-upgrade.mjs';\n// END PAPER EXECUTED VALUATION IMPORT\n",
        hash: 'a67eef99be54c05d2639729bc22c323c45fb62d94ad3a8828d3ff98436ee981d',
      },
      {
        tag: 'MIGRATION',
        old: "  '202611060002_paper_execution_commit',\n",
        next: "  // BEGIN PAPER EXECUTED VALUATION MIGRATION\n  '202611060002_paper_execution_commit',\n  '202611120001_paper_executed_valuation',\n  // END PAPER EXECUTED VALUATION MIGRATION\n",
        hash: '9baa50af7b337fe57253966c55c574c46f6443cbcab228f6f3b0512487d4fb32',
      },
      {
        tag: 'OWNER_PROOF',
        old: "    await verifyPaperExecutionCommitStorage(executionCommitDb, { ownership: 'REQUIRE_NON_BYPASS' });\n",
        next: "    // BEGIN PAPER EXECUTED VALUATION OWNER_PROOF\n    await verifyPaperExecutionCommitStorage(executionCommitDb, { ownership: 'REQUIRE_NON_BYPASS' });\n    await verifyPaperExecutedValuationStorage(executionCommitDb, {\n      ownership: 'REQUIRE_NON_BYPASS',\n    });\n    // END PAPER EXECUTED VALUATION OWNER_PROOF\n",
        hash: 'd9d68ab518eae4952491e08576ea09b92dee47362f577d4fa2eaf1d8f56c57d4',
      },
      {
        tag: 'OWNER_COUNT',
        old: '    // BEGIN PAPER EXECUTED BOOK OWNER_COUNT\n    assert.equal(executionCommitOwner.numPassedTests, 20);\n    // END PAPER EXECUTED BOOK OWNER_COUNT\n',
        next: '    // BEGIN PAPER EXECUTED VALUATION OWNER_COUNT\n    // BEGIN PAPER EXECUTED BOOK OWNER_COUNT\n    assert.equal(executionCommitOwner.numPassedTests, 28);\n    // END PAPER EXECUTED BOOK OWNER_COUNT\n    // END PAPER EXECUTED VALUATION OWNER_COUNT\n',
        hash: 'c87c44827c09fdddfe421ab829074b41e75d75937cc6399099de6719fbeeb95b',
      },
      {
        tag: 'UPGRADE',
        old: '  // END PAPER EXECUTION COMMIT UPGRADE\n',
        next: "  // BEGIN PAPER EXECUTED VALUATION UPGRADE\n  // END PAPER EXECUTION COMMIT UPGRADE\n  // Seed a real published66 financial execution through the accepted writer.\n  await run(\n    process.execPath,\n    [\n      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),\n      'run',\n      '--config',\n      'vitest.database.config.ts',\n      'packages/database/test/paper-execution-commit.integration.test.ts',\n      '-t',\n      '^paper-executed-book: captures the real committed book and conserved ledger without another monetary effect$',\n      '--outputFile.json=test-results/paper-executed-valuation-pre67-tests.json',\n    ],\n    { env: paperAdmissionEnvironment(databases[4]), secrets, echo: true, timeoutMs: 90000 },\n  );\n  const executedValuationSeed = JSON.parse(\n    await readFile(\n      new URL('../test-results/paper-executed-valuation-pre67-tests.json', import.meta.url),\n      'utf8',\n    ),\n  );\n  assert.equal(executedValuationSeed.success, true);\n  assert.equal(executedValuationSeed.numPassedTests, 1);\n  assert.equal(executedValuationSeed.numFailedTests, 0);\n  assert.equal(executedValuationSeed.numPendingTests, 27);\n  const beforeExecutedValuation = await capturePaperExecutionStartUpgrade(paperUpgrade);\n  await cp(\n    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[66]),\n    path.join(paperMigrations, expectedMigrations[66]),\n    { recursive: true },\n  );\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperExecutedValuationUpgrade(paperUpgrade, beforeExecutedValuation);\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperExecutedValuationUpgrade(paperUpgrade, beforeExecutedValuation);\n  const executedValuationCompiled = await verifyCompiledExecutedValuation(\n    paperUpgrade,\n    paperAdmissionEnvironment(databases[4]),\n  );\n  assert.equal(executedValuationCompiled.status, 'PASS');\n  // END PAPER EXECUTED VALUATION UPGRADE\n",
        hash: '9c261aa856bbc5fc7bc5ad758f6c1899daff0c512538154690c54dfa584e9e4f',
      },
      {
        tag: 'RESET_ADMISSIONRESET',
        old: "  await verifyPaperExecutionCommitStorage(admissionReset, { ownership: 'STORAGE_ONLY' });\n",
        next: "  // BEGIN PAPER EXECUTED VALUATION RESET_ADMISSIONRESET\n  await verifyPaperExecutionCommitStorage(admissionReset, { ownership: 'STORAGE_ONLY' });\n  await verifyPaperExecutedValuationStorage(admissionReset, { ownership: 'STORAGE_ONLY' });\n  // END PAPER EXECUTED VALUATION RESET_ADMISSIONRESET\n",
        hash: 'a2777df7ccc1ce24e32ed1d483f3f951033902ef0a82239a06b1f75b2b929f5d',
      },
      {
        tag: 'RESET_STARTEDAFTERRESET',
        old: "  await verifyPaperExecutionCommitStorage(startedAfterReset, { ownership: 'STORAGE_ONLY' });\n",
        next: "  // BEGIN PAPER EXECUTED VALUATION RESET_STARTEDAFTERRESET\n  await verifyPaperExecutionCommitStorage(startedAfterReset, { ownership: 'STORAGE_ONLY' });\n  await verifyPaperExecutedValuationStorage(startedAfterReset, { ownership: 'STORAGE_ONLY' });\n  // END PAPER EXECUTED VALUATION RESET_STARTEDAFTERRESET\n",
        hash: '9ee0f66d4d0270458697e285b00baf533331852344dfe8d5b12213cd9e4c6439',
      },
      {
        tag: 'RESET_RESET',
        old: "  await verifyPaperExecutionCommitStorage(reset, { ownership: 'STORAGE_ONLY' });\n",
        next: "  // BEGIN PAPER EXECUTED VALUATION RESET_RESET\n  await verifyPaperExecutionCommitStorage(reset, { ownership: 'STORAGE_ONLY' });\n  await verifyPaperExecutedValuationStorage(reset, { ownership: 'STORAGE_ONLY' });\n  // END PAPER EXECUTED VALUATION RESET_RESET\n",
        hash: '8d9485d9b4c000bf218f587c738f2d41f4eb476ea4bcdae1ce12656804fc21c4',
      },
      {
        tag: 'REPORT',
        old: '    paperExecutionCommitResetValidated: true,\n',
        next: '    // BEGIN PAPER EXECUTED VALUATION REPORT\n    paperExecutionCommitResetValidated: true,\n    paperExecutedValuationUpgradePreserved: true,\n    paperExecutedValuationResetValidated: true,\n    paperExecutedValuationCompiled: executedValuationCompiled,\n    // END PAPER EXECUTED VALUATION REPORT\n',
        hash: '6e951d3c6297c50576257d4a8c70c743df5821c985b6a622510c2390cb57fd83',
      },
    ],
  },
  'scripts/native-proof-artifacts.mjs': {
    predecessor: '6f1182a9c7ccff5d335f30cf46848d70078ff69719d31774a3061dfbbb894d86',
    patches: [
      {
        tag: 'REPORT_COUNT',
        old: "  // BEGIN PAPER EXECUTED BOOK REPORT_COUNT\n  'paper-execution-commit': 20,\n  // END PAPER EXECUTED BOOK REPORT_COUNT\n",
        next: "  // BEGIN PAPER EXECUTED VALUATION REPORT_COUNT\n  // BEGIN PAPER EXECUTED BOOK REPORT_COUNT\n  'paper-execution-commit': 28,\n  // END PAPER EXECUTED BOOK REPORT_COUNT\n  // END PAPER EXECUTED VALUATION REPORT_COUNT\n",
        hash: '1cc2ab4103484dc285d21fc5feac4b1f612ed697d400ac5ea2ce4f8ec3f93fb9',
      },
    ],
  },
  'scripts/test-integration.mjs': {
    predecessor: '93a45a17876e6ef031add75b51499bb918ed49bf37eba60118105e01f7179a09',
    patches: [
      {
        tag: 'MIGRATION_COUNT',
        old: '      databaseReport.nativeClusterIsolation?.migrations !== 66 ||\n',
        next: '      // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n      databaseReport.nativeClusterIsolation?.migrations !== 67 ||\n      // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
        hash: 'eff94d0f834cb5a15d129b491492511a05021c2e7e2e7084022426e4011b8fc8',
      },
    ],
  },
  'scripts/native-cluster-bootstrap.mjs': {
    predecessor: '107cfa51c24b836f97bf351672f40f9ffce13761ec4e0b929f2bba61a5c68afa',
    patches: [
      {
        tag: 'MIGRATION_COUNT',
        old: '      migrations: 66,\n',
        next: '      // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n      migrations: 67,\n      // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
        hash: '4c66a165c4146c77bd5aa8f63a62a9a1d728d19de5b0bc0c934840995cdbcd15',
      },
      {
        tag: 'SECONDARY_APPLIED_COUNT',
        old: '        66,\n',
        next: '        // BEGIN PAPER EXECUTED VALUATION SECONDARY_APPLIED_COUNT\n        67,\n        // END PAPER EXECUTED VALUATION SECONDARY_APPLIED_COUNT\n',
        hash: '752f31ada785a83deb7ef08063a4e90a57c95346823da4537841de6cd37f73d0',
      },
    ],
  },
  'scripts/cluster-isolated-evidence.mjs': {
    predecessor: '76dc32595868a63417314d730d6ed401fd29a5d0468a31f800fd0047a5c27c16',
    patches: [
      {
        tag: 'MIGRATION_COUNT',
        old: '  assert.equal(proof.migrations, 66);\n',
        next: '  // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n  assert.equal(proof.migrations, 67);\n  // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
        hash: '9185dc2e726a8a760d491e8cc8ff78815e3aecbb2c276fd955fa06b19add9661',
      },
    ],
  },
  'scripts/cluster-isolated-evidence.unit.test.mjs': {
    predecessor: '08002684120cf2bcaef124c713ffb085a15d410aa1150821bd9a58ece3fb79e1',
    patches: [
      {
        tag: 'MIGRATION_COUNT',
        old: '    migrations: 66,\n',
        next: '    // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT\n    migrations: 67,\n    // END PAPER EXECUTED VALUATION MIGRATION_COUNT\n',
        hash: '509fdbce0a03bfe8b3b2f3733ac92a2f198eaed138e5136f087a73f6ba242f2e',
      },
    ],
  },
  'scripts/executed-book-legacy.mjs': {
    predecessor: '29214f5b91cac776690cf702354e8b74347ee0494aad0ef9578f28ec6cc37482',
    patches: [
      {
        tag: 'LEGACY_IMPORT',
        old: '',
        next: "// BEGIN PAPER EXECUTED VALUATION LEGACY_IMPORT\nimport { beforeExecutedValuation } from './executed-valuation-legacy.mjs';\n// END PAPER EXECUTED VALUATION LEGACY_IMPORT\n",
        hash: 'db66082751a4774813530625d00cc80dd6f80e8d02285773b29cf80c22e01019',
      },
      {
        tag: 'LEGACY_RESTORE',
        old: 'export function beforeExecutedBookCapture(file, source) {\n',
        next: "// BEGIN PAPER EXECUTED VALUATION LEGACY_RESTORE\nexport function beforeExecutedBookCapture(file, source) {\n  try {\n    source = beforeExecutedValuation(file, source);\n  } catch {\n    throw Error('PAPER_EXECUTED_BOOK_REVIEW_REQUIRED');\n  }\n  // END PAPER EXECUTED VALUATION LEGACY_RESTORE\n",
        hash: '19efb6ed38ea83f6a9f1ef4b2e8a835f4d7ead791b11bc66e5d47c59cb54f97c',
      },
    ],
  },
  'scripts/execution-commit-harness.unit.test.mjs': {
    predecessor: '51aa56826620917989aa562b6c9aefb140959fec6967125f72c3df89899070d0',
    patches: [
      {
        tag: 'RETAINED_RUNNER',
        old: "  const runner = await readFile(new URL('./test-database.mjs', import.meta.url), 'utf8');\n",
        next: "  // BEGIN PAPER EXECUTED VALUATION RETAINED_RUNNER\n  const { beforeExecutedValuation } = await import('./executed-valuation-legacy.mjs');\n  const runner = beforeExecutedValuation(\n    'scripts/test-database.mjs',\n    (await readFile(new URL('./test-database.mjs', import.meta.url), 'utf8')).replaceAll(\n      '\\r\\n',\n      '\\n',\n    ),\n  );\n  // END PAPER EXECUTED VALUATION RETAINED_RUNNER\n",
        hash: '3c3817cbce3460014a9cd52a95994b71a1f44408617d5bbc1a96ef3825751e1e',
      },
    ],
  },
  'scripts/executed-book-legacy.unit.test.mjs': {
    predecessor: 'e195c8f8c447147d0b8532d6c76285308081e2fc217456fb9690bc8e0c00367f',
    patches: [
      {
        tag: 'RETAINED_BOOK_FIXTURE',
        old: "const sourceOf = async (file) =>\n  (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\\r\\n', '\\n');\n",
        next: "// BEGIN PAPER EXECUTED VALUATION RETAINED_BOOK_FIXTURE\nimport { beforeExecutedValuation } from './executed-valuation-legacy.mjs';\nconst sourceOf = async (file) =>\n  beforeExecutedValuation(\n    file,\n    (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\\r\\n', '\\n'),\n  );\n// END PAPER EXECUTED VALUATION RETAINED_BOOK_FIXTURE\n",
        hash: 'a71a9657290f17362b3a10b22aaa3080af88ff998bccff6ebc0458a53341f193',
      },
    ],
  },
  'scripts/certified-cluster-legacy.unit.test.mjs': {
    predecessor: '056ff919cd1fd26ef6062edba8714bd2b29a2b7238cb2d302c9971b0b6e4a6b9',
    patches: [
      {
        tag: 'RETAINED_CLUSTER_FIXTURE',
        old: "    const source = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(\n      '\\r\\n',\n      '\\n',\n    );\n",
        next: "    // BEGIN PAPER EXECUTED VALUATION RETAINED_CLUSTER_FIXTURE\n    const { beforeExecutedValuation } = await import('./executed-valuation-legacy.mjs');\n    const source = beforeExecutedValuation(\n      file,\n      (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\\r\\n', '\\n'),\n    );\n    // END PAPER EXECUTED VALUATION RETAINED_CLUSTER_FIXTURE\n",
        hash: '5e38af6d19224d84d4d7f4df1e9ab955e47718365da4d6465b2304f3cbcc7c85',
      },
    ],
  },
};
export function beforeExecutedValuation(file, source) {
  source = beforeHistoricalInventory(file, source);
  const review = executedValuationReview[file];
  if (!review || !source.includes('PAPER EXECUTED VALUATION')) return source;
  if (
    (source.match(/BEGIN PAPER EXECUTED VALUATION /gu) ?? []).length !== review.patches.length ||
    (source.match(/END PAPER EXECUTED VALUATION /gu) ?? []).length !== review.patches.length
  )
    throw Error('PAPER_EXECUTED_VALUATION_REVIEW_REQUIRED');
  for (const patch of review.patches) {
    if (
      source.split(patch.next).length !== 2 ||
      createHash('sha256').update(patch.next).digest('hex') !== patch.hash
    )
      throw Error('PAPER_EXECUTED_VALUATION_REVIEW_REQUIRED');
    source = source.replace(patch.next, patch.old);
  }
  return source;
}
