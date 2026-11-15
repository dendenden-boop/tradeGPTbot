// Test-only exact accepted455 count and additive69/70 harness review; no runtime authority or waiver.
import { createHash } from 'node:crypto';
import { beforeCurrentOrderRiskReview } from './current-order-risk-legacy.mjs';
export const currentRiskCountReview = {
  'scripts/native-proof-artifacts.mjs': {
    predecessor: '67b79c58f98ccd2d6b457ba499c9fe512ec21d7783461608d859ab3cf8cb7e54',
    current: 'a6cc96bd2bf45aa8f2ef2c609296cb88d32759e326d20bfa86fa15090b693629',
    patches: [
      {
        old: "  'paper-execution-commit': 35,\n",
        next: "  // BEGIN PAPER CURRENT RISK REPORT_COUNT\n  'paper-execution-commit': 41,\n  // END PAPER CURRENT RISK REPORT_COUNT\n",
      },
    ],
  },
  'scripts/test-database.mjs': {
    predecessor: '447f831f911cbdbd8924da9916de66b03f1e567ebe421e8fdf260026e4f73949',
    current: 'c2b5c3068b20e5ad4dbb30380b320787fafff313921fca851863e165ec2c490f',
    patches: [
      {
        old: '',
        next: "  // BEGIN PAPER CURRENT RISK MARKET UPGRADE\n  const beforeCurrentRiskMarket = await capturePaperExecutionStartUpgrade(paperUpgrade);\n  await cp(\n    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[69]),\n    path.join(paperMigrations, expectedMigrations[69]),\n    { recursive: true },\n  );\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperCurrentRiskMarketUpgrade(paperUpgrade, beforeCurrentRiskMarket);\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperCurrentRiskMarketUpgrade(paperUpgrade, beforeCurrentRiskMarket);\n  const currentRiskMarketCompiled = await verifyCompiledCurrentRisk(\n    paperUpgrade,\n    paperAdmissionEnvironment(databases[4]),\n  );\n  assert.equal(currentRiskMarketCompiled.status, 'PASS');\n  // END PAPER CURRENT RISK MARKET UPGRADE\n",
      },
      {
        old: '',
        next: "  // BEGIN PAPER CURRENT RISK MARKET RESET_POPULATED\n  await verifyPaperCurrentRiskMarketStorage(startedAfterReset, {\n    ownership: 'STORAGE_ONLY',\n    empty: true,\n  });\n  // END PAPER CURRENT RISK MARKET RESET_POPULATED\n",
      },
      {
        old: '    assert.equal(executionCommitOwner.numPassedTests, 35);\n',
        next: '    // BEGIN PAPER CURRENT RISK OWNER_COUNT\n    assert.equal(executionCommitOwner.numPassedTests, 41);\n    // END PAPER CURRENT RISK OWNER_COUNT\n',
      },
      {
        old: '  assert.equal(executedValuationSeed.numPendingTests, 34);\n',
        next: '  // BEGIN PAPER CURRENT RISK PRE67_COUNT\n  assert.equal(executedValuationSeed.numPendingTests, 40);\n  // END PAPER CURRENT RISK PRE67_COUNT\n',
      },
      {
        old: '',
        next: "// BEGIN PAPER CURRENT RISK IMPORT\n// BEGIN PAPER CURRENT RISK MARKET IMPORT\nimport {\n  verifyPaperCurrentRiskMarketStorage,\n  verifyPaperCurrentRiskMarketUpgrade,\n} from './paper-current-risk-market-upgrade.mjs';\n// END PAPER CURRENT RISK MARKET IMPORT\nimport {\n  verifyPaperCurrentRiskStorage,\n  verifyPaperCurrentRiskUpgrade,\n  verifyCompiledCurrentRisk,\n} from './paper-current-risk-upgrade.mjs';\n// END PAPER CURRENT RISK IMPORT\n",
      },
      {
        old: '',
        next: "  // BEGIN PAPER CURRENT RISK MIGRATION\n  '202611140001_paper_current_risk',\n  // BEGIN PAPER CURRENT RISK MARKET MIGRATION\n  '202611140002_paper_current_risk_market_coherence',\n  // END PAPER CURRENT RISK MARKET MIGRATION\n  // END PAPER CURRENT RISK MIGRATION\n",
      },
      {
        old: '',
        next: "    // BEGIN PAPER CURRENT RISK OWNER_PROOF\n    await verifyPaperCurrentRiskStorage(executionCommitDb, { ownership: 'REQUIRE_NON_BYPASS' });\n    // BEGIN PAPER CURRENT RISK MARKET OWNER_PROOF\n    await verifyPaperCurrentRiskMarketStorage(executionCommitDb, {\n      ownership: 'REQUIRE_NON_BYPASS',\n    });\n    // END PAPER CURRENT RISK MARKET OWNER_PROOF\n    // END PAPER CURRENT RISK OWNER_PROOF\n",
      },
      {
        old: '',
        next: "  // BEGIN PAPER CURRENT RISK UPGRADE\n  const beforeCurrentRisk = await capturePaperExecutionStartUpgrade(paperUpgrade);\n  await cp(\n    path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[68]),\n    path.join(paperMigrations, expectedMigrations[68]),\n    { recursive: true },\n  );\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperCurrentRiskUpgrade(paperUpgrade, beforeCurrentRisk);\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperCurrentRiskUpgrade(paperUpgrade, beforeCurrentRisk);\n  const currentRiskCompiled = await verifyCompiledCurrentRisk(\n    paperUpgrade,\n    paperAdmissionEnvironment(databases[4]),\n  );\n  assert.equal(currentRiskCompiled.status, 'PASS');\n  // END PAPER CURRENT RISK UPGRADE\n",
      },
      {
        old: '',
        next: "  // BEGIN PAPER CURRENT RISK RESET_UPGRADE\n  await verifyPaperCurrentRiskStorage(admissionReset, { ownership: 'STORAGE_ONLY', empty: true });\n  // BEGIN PAPER CURRENT RISK MARKET RESET_UPGRADE\n  await verifyPaperCurrentRiskMarketStorage(admissionReset, {\n    ownership: 'STORAGE_ONLY',\n    empty: true,\n  });\n  // END PAPER CURRENT RISK MARKET RESET_UPGRADE\n  // END PAPER CURRENT RISK RESET_UPGRADE\n",
      },
      {
        old: '',
        next: "  // BEGIN PAPER CURRENT RISK RESET_POPULATED\n  await verifyPaperCurrentRiskStorage(startedAfterReset, {\n    ownership: 'STORAGE_ONLY',\n    empty: true,\n  });\n  // END PAPER CURRENT RISK RESET_POPULATED\n",
      },
      {
        old: '',
        next: "  // BEGIN PAPER CURRENT RISK RESET_FRESH\n  await verifyPaperCurrentRiskStorage(reset, { ownership: 'STORAGE_ONLY', empty: true });\n  // BEGIN PAPER CURRENT RISK MARKET RESET_FRESH\n  await verifyPaperCurrentRiskMarketStorage(reset, { ownership: 'STORAGE_ONLY', empty: true });\n  // END PAPER CURRENT RISK MARKET RESET_FRESH\n  // END PAPER CURRENT RISK RESET_FRESH\n",
      },
      {
        old: '',
        next: '    // BEGIN PAPER CURRENT RISK FLAGS\n    paperCurrentRiskUpgradePreserved: true,\n    paperCurrentRiskResetValidated: true,\n    paperCurrentRiskCompiled: currentRiskCompiled,\n    // BEGIN PAPER CURRENT RISK MARKET FLAGS\n    paperCurrentRiskMarketUpgradePreserved: true,\n    paperCurrentRiskMarketResetValidated: true,\n    paperCurrentRiskMarketCompiled: currentRiskMarketCompiled,\n    // END PAPER CURRENT RISK MARKET FLAGS\n    // END PAPER CURRENT RISK FLAGS\n',
      },
    ],
  },
  'scripts/registry-domain-legacy.mjs': {
    predecessor: '0f657f56076f85661f4af375f43aa711b5a0b9c32e98cd0615b259603f967e2c',
    current: 'aa34daf655481f710e223b4b66a196646cda2261cfb06969a1d8aca2ecb89ee4',
    patches: [
      {
        old: '// Test-only exact307 reconstruction; no runtime authority or waiver.\n',
        next: "// PAPER CURRENT RISK COUNTS: exact36-case metadata peels before older reviews.\nimport { beforeCurrentRiskCounts } from './current-risk-count-legacy.mjs';\n// Test-only exact307 reconstruction; no runtime authority or waiver.\n",
      },
      {
        old: 'export function beforeRegistryDomain(file, source) {\n',
        next: 'export function beforeRegistryDomain(file, source) {\n  source = beforeCurrentRiskCounts(file, source);\n',
      },
    ],
  },
  'scripts/registry-domain-legacy.unit.test.mjs': {
    predecessor: '73c1bca48ac467103cb8501cbc7d45742de9ef868036824ab455431fe5301cfa',
    current: '3d10f0285c40de0378bd7ea75ad094c0d22f391348111f1306cb10aa51ade357',
    patches: [
      {
        old: "import { readFile } from 'node:fs/promises';\n",
        next: "// PAPER CURRENT RISK COUNTS: isolate older fixtures before their tamper checks.\nimport { beforeCurrentRiskCounts } from './current-risk-count-legacy.mjs';\nimport { readFile } from 'node:fs/promises';\n",
      },
      {
        old: "    const source = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(\n      '\\r\\n',\n      '\\n',\n    );\n",
        next: "    const source = beforeCurrentRiskCounts(\n      file,\n      (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\\r\\n', '\\n'),\n    );\n",
      },
    ],
  },
  'scripts/native-cluster-bootstrap.mjs': {
    predecessor: 'cfb8bd383d124dd270c774a8d8b4b520d8c0d10711135aecf0356c658a07c4f4',
    current: '016c1092c654df69e14ed0e2fa809bcda6557134ceab92801a7fa288c9d91399',
    patches: [
      {
        old: '        68,\n',
        next: '        // BEGIN PAPER CURRENT RISK SECONDARY_COUNT\n        70,\n        // END PAPER CURRENT RISK SECONDARY_COUNT\n',
      },
      {
        old: '      migrations: 68,\n',
        next: '      // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n      migrations: 70,\n      // END PAPER CURRENT RISK MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/cluster-isolated-evidence.mjs': {
    predecessor: '169ddeaa287b531b5e5afbd7a9062a61b86bfb314fa28cbaaa2fd021a5308228',
    current: '998073ab0228edf212ecc8b17d9e5b23d087d7240c50037549a66be14fe68f4e',
    patches: [
      {
        old: '  assert.equal(proof.migrations, 68);\n',
        next: '  // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n  assert.equal(proof.migrations, 70);\n  // END PAPER CURRENT RISK MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/cluster-isolated-evidence.unit.test.mjs': {
    predecessor: '930e377caa75ee495016d7cbb590944260a78160181fa2b72235d024145def94',
    current: '115343f1d25e5f2c6b3dbf714fcb819cdf2f4fca39aa5ec89957f210fe6f4ad8',
    patches: [
      {
        old: '    migrations: 68,\n',
        next: '    // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n    migrations: 70,\n    // END PAPER CURRENT RISK MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/registry-domain-evidence.unit.test.mjs': {
    predecessor: 'b9feaaa7857cef4b0287b05990ef121b938d345e7d5f6a5a02be06f7830ebae4',
    current: '6836f4b46560cba30733a67f9fc56c7a547f6f09d35c2dce24a0887324e63fa6',
    patches: [
      {
        old: '    migrations: 68,\n',
        next: '    // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n    migrations: 70,\n    // END PAPER CURRENT RISK MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/native-migration-count.unit.test.mjs': {
    predecessor: '0ba313596d62ef4e050bb009f41ac1185e016becf1466df69596999377e490ba',
    current: '69bc8325c61fb6148efdb55c783f0beb59dd76dd67c5e0fca9ae2eeef5eb3c67',
    patches: [
      {
        old: '',
        next: "// BEGIN PAPER CURRENT RISK MARKET STALE\nit('rejects published69 secondary state before cloning any actor', async () => {\n  fixture.count = 69;\n  const f = run();\n  await expect(f.promise).rejects.toThrow();\n  expect(f.migrated).toHaveLength(1);\n  expect(f.observed).toEqual(f.migrated);\n  expect(f.closed).toEqual(f.migrated);\n  expect(fixture.cloned).toBe(0);\n});\n// END PAPER CURRENT RISK MARKET STALE\n",
      },
      {
        old: 'const fixture = vi.hoisted(() => ({ count: 68, cloned: 0, inspections: [] }));\n',
        next: '// BEGIN PAPER CURRENT RISK FIXTURE\nconst fixture = vi.hoisted(() => ({ count: 70, cloned: 0, inspections: [] }));\n// END PAPER CURRENT RISK FIXTURE\n',
      },
      {
        old: 'beforeEach(() => Object.assign(fixture, { count: 68, cloned: 0, inspections: [] }));\n',
        next: '// BEGIN PAPER CURRENT RISK RESET\nbeforeEach(() => Object.assign(fixture, { count: 70, cloned: 0, inspections: [] }));\n// END PAPER CURRENT RISK RESET\n',
      },
      {
        old: "it('checks migration68 in all four secondary ledgers before starting actor cloning', async () => {\n",
        next: "// BEGIN PAPER CURRENT RISK TITLE\nit('checks migration70 in all four secondary ledgers before starting actor cloning', async () => {\n  // END PAPER CURRENT RISK TITLE\n",
      },
      {
        old: '',
        next: "// BEGIN PAPER CURRENT RISK STALE\nit('rejects the previously latest published68 secondary ledger before any actor cloning', async () => {\n  fixture.count = 68;\n  const f = run();\n  await expect(f.promise).rejects.toThrow();\n  expect(f.migrated).toHaveLength(1);\n  expect(f.observed).toEqual(f.migrated);\n  expect(f.closed).toEqual(f.migrated);\n  expect(fixture.cloned).toBe(0);\n});\n// END PAPER CURRENT RISK STALE\n",
      },
    ],
  },
  'scripts/test-integration.mjs': {
    predecessor: '760b50363b20670d3eafe527f298fce5be5fdad857a8868f75089bb766f519e7',
    current: '60fd91fc92ee14b6ee1f0893bb5c660c7960a7a92633f862487beb4085881172',
    patches: [
      {
        old: '      databaseReport.nativeClusterIsolation?.migrations !== 68 ||\n',
        next: '      // BEGIN PAPER CURRENT RISK MIGRATION_COUNT\n      databaseReport.nativeClusterIsolation?.migrations !== 70 ||\n      // END PAPER CURRENT RISK MIGRATION_COUNT\n',
      },
    ],
  },
  'scripts/historical-inventory-harness.unit.test.mjs': {
    predecessor: '5db896a1bfee0695e5fe1cd0f503eb199d20b4e89dfcac5d1c60ed19c065aef8',
    current: '263556403e3f46a6c2672119f2d891b57d0071d15bf2028f2cfa57a0c68f4701',
    patches: [
      {
        old: '    /^it\\(/gm,\n',
        next: '    // BEGIN PAPER CURRENT RISK NESTED_CASE_DISCOVERY\n    /^[ \\t]*it\\(/gmu,\n    // END PAPER CURRENT RISK NESTED_CASE_DISCOVERY\n',
      },
    ],
  },
};
export function beforeCurrentRiskCounts(file, source) {
  source = beforeCurrentOrderRiskReview(file, source, 'PAPER_CURRENT_RISK_COUNT_REVIEW_REQUIRED');
  const review = currentRiskCountReview[file];
  if (!review || !source.includes('PAPER CURRENT RISK')) return source;
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  if (hash(source) !== review.current) throw Error('PAPER_CURRENT_RISK_COUNT_REVIEW_REQUIRED');
  for (const p of review.patches) {
    if (source.split(p.next).length !== 2) throw Error('PAPER_CURRENT_RISK_COUNT_REVIEW_REQUIRED');
    const at = source.indexOf(p.next);
    source = source.slice(0, at) + p.old + source.slice(at + p.next.length);
  }
  if (hash(source) !== review.predecessor) throw Error('PAPER_CURRENT_RISK_COUNT_REVIEW_REQUIRED');
  return source;
}
