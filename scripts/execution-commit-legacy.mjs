// Test-only exact reconstruction of accepted main b50a9f718c0c3e3a2ad28d23373135d3a75fffa4. No runtime use.
import { createHash } from 'node:crypto';
const patches = {
  'scripts/test-database.mjs': {
    predecessor: '8084950a7d515ee8f4521a756c873db3aef442e935e54ca54f541304c2af1035',
    patches: [
      {
        old: '',
        next: "import {\n  verifyPaperExecutionCommitStorage,\n  verifyPaperExecutionCommitUpgrade,\n} from './paper-execution-commit-upgrade.mjs';\n",
        hash: '92e0b5f9c50dbade26f40ff67a682396410545fee270b573a0d0e2eb642948d4',
      },
      {
        old: '',
        next: "  '202611060001_paper_execution_math',\n  '202611060002_paper_execution_commit',\n",
        hash: '5784bb34fc35027967ece764803f60cfa2857664c6230d7742b584f7d07f1c68',
      },
      {
        old: '',
        next: "    // BEGIN PAPER EXECUTION COMMIT OWNER\n    const executionCommitDb = connect(dbUrl(databases[2]));\n    await verifyPaperExecutionCommitStorage(executionCommitDb, { ownership: 'REQUIRE_NON_BYPASS' });\n    await executionCommitDb.end();\n    pools.delete(executionCommitDb);\n    await run(\n      process.execPath,\n      [\n        fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),\n        'run',\n        '--config',\n        'vitest.database.config.ts',\n        'packages/database/test/paper-execution-commit.integration.test.ts',\n        '--outputFile.json=test-results/paper-execution-commit-owner-tests.json',\n      ],\n      { env: paperAdmissionEnvironment(databases[2]), secrets, echo: true, timeoutMs: 90000 },\n    );\n    const executionCommitOwner = JSON.parse(\n      await readFile(\n        new URL('../test-results/paper-execution-commit-owner-tests.json', import.meta.url),\n        'utf8',\n      ),\n    );\n    assert.equal(executionCommitOwner.success, true);\n    assert.equal(executionCommitOwner.numPassedTests, 13);\n    assert.equal(executionCommitOwner.numFailedTests, 0);\n    assert.equal(executionCommitOwner.numPendingTests, 0);\n    // END PAPER EXECUTION COMMIT OWNER\n",
        hash: '784fa8e5a3a31ad476e82a397693e948e9b1991969082012484522c2cebaa543',
      },
      {
        old: '',
        next: "  // BEGIN PAPER EXECUTION COMMIT UPGRADE\n  const beforeExecutionCommit = await capturePaperExecutionStartUpgrade(paperUpgrade);\n  for (const index of [64, 65])\n    await cp(\n      path.join(workspace, 'packages/database/prisma/migrations', expectedMigrations[index]),\n      path.join(paperMigrations, expectedMigrations[index]),\n      { recursive: true },\n    );\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperExecutionCommitUpgrade(paperUpgrade, beforeExecutionCommit);\n  await migrate(databases[4], paperConfig, true);\n  await verifyPaperExecutionCommitUpgrade(paperUpgrade, beforeExecutionCommit);\n  // END PAPER EXECUTION COMMIT UPGRADE\n",
        hash: 'f301dc5909445b8e532489c837cc5054f6ef68cfb1b1f9658b0041edeb8b4163',
      },
      {
        old: '',
        next: "      ...(cohort.id === 'execution-commit' ? { env: executionStartEnv } : {}),\n",
        hash: '4d2b1c179ed8abfad6331b42e56d4274007ab72046da52a6a117df7eb153311e',
      },
      {
        old: '',
        next: "      ...(cohort.id === 'execution-commit' ? { database: databases[7] } : {}),\n",
        hash: '2c4041ffd5063861d8bdf6aa15ea290c0e599abcda2385a01ab12f505a261965',
      },
      {
        old: '',
        next: "  await verifyPaperExecutionCommitStorage(admissionReset, { ownership: 'STORAGE_ONLY' });\n",
        hash: '29f99e20f0e018fd9e1cb4b2da868116194f5ef7cb10ac9941c5c83064118485',
      },
      {
        old: '',
        next: "  assert.ok(\n    (await startedBeforeReset.query('SELECT count(*)::int n FROM ctp_paper.execution_commit'))\n      .rows[0].n > 0,\n  );\n",
        hash: 'c1b3de8fdb34c77ddf6eae1cf96e3a5a5a97679ea56445a5afc5a59762999e0a',
      },
      {
        old: '',
        next: "  await verifyPaperExecutionCommitStorage(startedAfterReset, { ownership: 'STORAGE_ONLY' });\n  for (const table of ['execution_commit', 'execution_liquidity'])\n    assert.equal(\n      (await startedAfterReset.query('SELECT count(*)::int n FROM ctp_paper.' + table)).rows[0].n,\n      0,\n    );\n",
        hash: 'fcce95bd60f8e3af4e40d6ad7afe44a429111b1592b0b7da0207761b0d60241b',
      },
      {
        old: '',
        next: '    paperExecutionCommitUpgradePreserved: true,\n    paperExecutionCommitResetValidated: true,\n',
        hash: '1c5067706d3521eb2e9fb4f93ae0e0e0a3057dfcc95cc82ecc22ab70666bc23b',
      },
      {
        old: '',
        next: "  await verifyPaperExecutionCommitStorage(reset, { ownership: 'STORAGE_ONLY' });\n",
        hash: 'a8efbff46c086e80dab926da4dbb20ca7c7c689054271b6e725b68d6e0a81a43',
      },
    ],
  },
  'scripts/native-proof-artifacts.mjs': {
    predecessor: 'd534880aec176d7c1d40c16ea67ddc4c99cf34b87ec5e7ea534d566bb8b2152e',
    patches: [
      {
        old: '',
        next: "  'paper-execution-commit': 13,\n",
        hash: '3a066b29bea9c0ea30becedc4ef125a2be65abb463ddfac19d8575547a6003dc',
      },
      {
        old: '',
        next: "  'paper-execution-commit': 90000,\n",
        hash: '931c50a6fe5d8f70d59bb714a4e1f21ed3be08ad1e87bc547ab8b797c14b2212',
      },
      {
        old: '',
        next: "  const commit = cohorts.completed.filter((c) => c.id === 'execution-commit');\n  if (\n    native.numPassedTests < 1492 ||\n    cohorts.files < 49 ||\n    commit.length !== 1 ||\n    !roles ||\n    !preview[0] ||\n    !Number.isFinite(commit[0].startMs) ||\n    !Number.isFinite(commit[0].settledMs) ||\n    commit[0].startMs < preview[0].settledMs ||\n    commit[0].settledMs < commit[0].startMs ||\n    roles.startMs < commit[0].settledMs\n  )\n    fail();\n  for (const id of [\n    'main',\n    'registry',\n    'admission',\n    'native-admission',\n    'execution-start',\n    'execution-preview',\n  ]) {\n    const predecessors = cohorts.completed.filter((c) => c.id === id);\n    if (\n      predecessors.length !== 1 ||\n      !Number.isFinite(predecessors[0].settledMs) ||\n      commit[0].startMs < predecessors[0].settledMs\n    )\n      fail();\n  }\n",
        hash: '0eddc1c605d5438a184e890e262fabcf0200007a7a19367d3ca901a816989f34',
      },
      {
        old: '',
        next: "      .filter((c) => c.id !== 'execution-commit')\n",
        hash: '2dd33c173904bd35267b5d11d2cbf9651754e35001f9708f0fb0fc73217aa05c',
      },
    ],
  },
  'scripts/database-cohorts.mjs': {
    predecessor: '7c8381d35cc50716e6be317a4810ada562a5856ef9d27890061220f4edbedabe',
    patches: [
      {
        old: '',
        next: "const executionCommit = 'packages/database/test/paper-execution-commit.integration.test.ts';\n",
        hash: '8aacd939a10b3f51383f04ac22d6e752cdb263f888cc1f03ebab0288e6c50915',
      },
      {
        old: '',
        next: "  assert.ok(\n    !files.includes(executionCommit) || files.includes(startedPreview),\n    'Financial writer requires reviewed current START Risk',\n  );\n",
        hash: 'de93d954a6ead19c2ced12fd2906ac9cce83ff317b1887e968a895812a6f3d68',
      },
      {
        old: '',
        next: '        file !== executionCommit &&\n',
        hash: '672144874874312800153287e75d12f0a59fc575a91d02f1b6ff883ffd3e3f34',
      },
      {
        old: '',
        next: "    ...(files.includes(executionCommit)\n      ? [\n          {\n            id: 'execution-commit',\n            files: [executionCommit],\n            parallel: false,\n            after: [\n              'main',\n              'registry',\n              'admission',\n              'native-admission',\n              'execution-start',\n              'execution-preview',\n            ],\n          },\n        ]\n      : []),\n",
        hash: '3cb52583944258a5d8d054c46895de35aba09a5646647d40ce6240ceecf3309c',
      },
    ],
  },
  'scripts/started-source-harness.unit.test.mjs': {
    predecessor: 'bd59f53714f79c648e836b24883fab6f9f72cd2f8c0514f030bd84e3a6dc18a6',
    patches: [
      {
        old: '',
        next: "  // BEGIN PAPER EXECUTION COMMIT FIXTURE\n  const writerIndex = files.indexOf(\n    'packages/database/test/paper-execution-commit.integration.test.ts',\n  );\n  if (writerIndex >= 0) files.splice(writerIndex, 1);\n  // END PAPER EXECUTION COMMIT FIXTURE\n",
        hash: 'cfafe8d53b31e75744be5ce186ff68838e7a4e774309db6bf136c1ddcd5516eb',
      },
    ],
  },
  'scripts/started-risk-harness.unit.test.mjs': {
    predecessor: '7e4b5cc72631eaab163aefcfd1ff4caf0f143773707947e337320d176e37f916',
    patches: [
      {
        old: '',
        next: "  // BEGIN PAPER EXECUTION COMMIT FIXTURE\n  const writerIndex = files.indexOf(\n    'packages/database/test/paper-execution-commit.integration.test.ts',\n  );\n  if (writerIndex >= 0) files.splice(writerIndex, 1);\n  // END PAPER EXECUTION COMMIT FIXTURE\n",
        hash: 'cfafe8d53b31e75744be5ce186ff68838e7a4e774309db6bf136c1ddcd5516eb',
      },
    ],
  },
};
const hash = (s) => createHash('sha256').update(s).digest('hex');
export function beforeExecutionCommit(file, source) {
  const entry = patches[file];
  if (!entry) return source;
  const present = entry.patches.filter((p) => source.includes(p.next));
  if (present.length === 0) return source;
  if (present.length !== entry.patches.length)
    throw Error('PAPER_EXECUTION_COMMIT_REVIEW_REQUIRED');
  for (const p of entry.patches) {
    if (hash(p.next) !== p.hash || source.split(p.next).length !== 2)
      throw Error('PAPER_EXECUTION_COMMIT_REVIEW_REQUIRED');
    source = source.replace(p.next, p.old);
  }
  return source;
}
