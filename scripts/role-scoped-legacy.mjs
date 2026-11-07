// Exact test-only reconstruction of the preceding 09d13d6 candidate harness beneath the new scope.
import { createHash } from 'node:crypto';
import { beforeAdmissionFundingLane } from './admission-funding-lane-legacy.mjs';
export const roleScopedReview = {
  'scripts/test-database.mjs': {
    predecessor: 'c4727a5d69fa7bd4d81a2387fd9e488cd19b738f661dabe72dd0c0c34d350867',
    patches: [
      {
        tag: 'IMPORT',
        old: '',
        next: "// BEGIN ROLE SCOPED NATIVE IMPORT\nimport { planRoleScopedCohorts, runRoleScopedCohorts } from './role-scoped-cohorts.mjs';\nimport { scopedMainDatabaseName, verifyScopedMainFiles } from './native-main-scopes.mjs';\n// END ROLE SCOPED NATIVE IMPORT\n",
        hash: 'e17ece18ef04c0cbce3c16b35d1dfffd161734d32d755484a1a3b6332285c790',
      },
      {
        tag: 'RUNNER_IMPORT',
        old: '  runDatabaseCohorts,\n',
        next: '  // BEGIN ROLE SCOPED NATIVE RUNNER_IMPORT\n  // END ROLE SCOPED NATIVE RUNNER_IMPORT\n',
        hash: 'c8af89acdd5c4445475ac972e865c66acc3ac9874e720a8b2b93a136a686d568',
      },
      {
        tag: 'DB_NAME',
        old: '',
        next: '  // BEGIN ROLE SCOPED NATIVE DB_NAME\n  scopedMainDatabaseName(`ctp_p2_fresh_${suffix}`),\n  // END ROLE SCOPED NATIVE DB_NAME\n',
        hash: 'a1a928f4c47f31f2943302c1979cb942bc8562fd5f2b06489c7e6663ea70cea4',
      },
      {
        tag: 'MIGRATE',
        old: '',
        next: '  // BEGIN ROLE SCOPED NATIVE MIGRATE\n  await migrate(databases[8]);\n  // END ROLE SCOPED NATIVE MIGRATE\n',
        hash: '13958cdffb9a148746262c22143483b5a91d4413e0fa1962f091ce22d0a8ca15',
      },
      {
        tag: 'PLAN',
        old: '  const cohortPlan = planDatabaseCohorts(await discoverDatabaseFiles(), {\n    executionStartOverlap: true,\n  });\n',
        next: '  // BEGIN ROLE SCOPED NATIVE PLAN\n  const originalCohortPlan = planDatabaseCohorts(await discoverDatabaseFiles(), {\n    executionStartOverlap: true,\n  });\n  const cohortPlan = await planRoleScopedCohorts(originalCohortPlan);\n  // END ROLE SCOPED NATIVE PLAN\n',
        hash: '29f6eccf49f405dbee6be3ab618aee32b5025f081af3562b99c4ca324c3ec1a1',
      },
      {
        tag: 'RAW_REPORTS',
        old: "    ({ id }) => new URL('../test-results/database-' + id + '-tests.json', import.meta.url),\n",
        next: "    // BEGIN ROLE SCOPED NATIVE RAW_REPORTS\n    ({ id }) =>\n      new URL(\n        '../test-results/database-' + (id === 'main' ? 'main-mutators' : id) + '-tests.json',\n        import.meta.url,\n      ),\n    // END ROLE SCOPED NATIVE RAW_REPORTS\n",
        hash: '6156d4139d92b778c214d01a593f218fe065ab5a5c743c5314221d428cdcf259',
      },
      {
        tag: 'ENV',
        old: '',
        next: "  // BEGIN ROLE SCOPED NATIVE ENV\n  const scopedEnv = { ...nativeEnv };\n  for (const [key, value] of Object.entries(scopedEnv))\n    if (key.startsWith('DATABASE_')) {\n      const url = new URL(value);\n      assert.equal(url.pathname, '/' + databases[0]);\n      url.pathname = '/' + databases[8];\n      scopedEnv[key] = url.href;\n    }\n  // END ROLE SCOPED NATIVE ENV\n",
        hash: '47726a283b121920c1dbc3d8a06f58a4b3cfa384727f0226d9f13da983446845',
      },
      {
        tag: 'RUN',
        old: '  const cohortRun = await runDatabaseCohorts(\n',
        next: '  // BEGIN ROLE SCOPED NATIVE RUN\n  const cohortRun = await runRoleScopedCohorts(\n    // END ROLE SCOPED NATIVE RUN\n',
        hash: '5257bd999a729b4dd93dd29ed809a24f5c21cb9edabd6ae89eff9dd2894bc030',
      },
      {
        tag: 'COHORT_ENV',
        old: '',
        next: "      // BEGIN ROLE SCOPED NATIVE COHORT_ENV\n      ...(cohort.id === 'main-scoped' ? { env: scopedEnv } : {}),\n      // END ROLE SCOPED NATIVE COHORT_ENV\n",
        hash: '733857e9aa4b8809663ec6a3ab61429b32bf6e8de7ef5fb23b3fa13250746b25',
      },
      {
        tag: 'ORIGINAL_MAIN_REPORT',
        old: '',
        next: "  // BEGIN ROLE SCOPED NATIVE ORIGINAL_MAIN_REPORT\n  // Retain both actual Vitest split reports and an explicitly derived original-main view.\n  const originalMainPlan = cohortPlan.filter((c) => ['main', 'main-scoped'].includes(c.id));\n  const originalMainReports = await Promise.all(\n    originalMainPlan.map(async (c) =>\n      JSON.parse(await readFile(cohortReports[cohortPlan.indexOf(c)], 'utf8')),\n    ),\n  );\n  await report('database-main-tests', {\n    ...mergeDatabaseReports(originalMainPlan, originalMainReports),\n    provenance: {\n      kind: 'MERGED_ORIGINAL_MAIN_COVERAGE',\n      rawReports: ['database-main-mutators-tests.json', 'database-main-scoped-tests.json'],\n    },\n  });\n  // END ROLE SCOPED NATIVE ORIGINAL_MAIN_REPORT\n",
        hash: '31470784bd3fac73cf40c4845a51dff0c800dfcce022a58818ff61d070c83f1f',
      },
      {
        tag: 'MANIFEST',
        old: '',
        next: '    // BEGIN ROLE SCOPED NATIVE MANIFEST\n    roleScopedManifest: (await verifyScopedMainFiles()).manifest,\n    // END ROLE SCOPED NATIVE MANIFEST\n',
        hash: 'ad6c9a033f140d090e71ac8f6ee5b120a52ab83b35d20e146ece9ade73710824',
      },
      {
        tag: 'COHORT_DATABASE',
        old: '',
        next: "      // BEGIN ROLE SCOPED NATIVE COHORT_DATABASE\n      ...(cohort.id === 'main-scoped' ? { database: databases[8] } : {}),\n      // END ROLE SCOPED NATIVE COHORT_DATABASE\n",
        hash: 'a70b0fad32cd608c7e7244f80642753c03c97829d188cef949ee742c1e6bf0cf',
      },
      {
        tag: 'REMOVE_COMPAT',
        old: '',
        next: "    // BEGIN ROLE SCOPED NATIVE REMOVE_COMPAT\n    new URL('../test-results/database-main-tests.json', import.meta.url),\n    // END ROLE SCOPED NATIVE REMOVE_COMPAT\n",
        hash: '6b9b3944385bcbacbfe78e1871106b2d1b0e6362af77a2c2cd3465fe1ffa5cf2',
      },
    ],
  },
  'scripts/native-proof-artifacts.mjs': {
    predecessor: '39da0392a9d558dc4c152e48e4844374d2c1504336c8fe4ed34fe4eff1b0d51e',
    patches: [
      {
        tag: 'IMPORT',
        old: '',
        next: "// BEGIN ROLE SCOPED NATIVE IMPORT\nimport { requireRoleScopedEvidence } from './role-scoped-evidence.mjs';\n// END ROLE SCOPED NATIVE IMPORT\n",
        hash: '2db9ad95e8db3bebe54462a1c03675a8960a9cf5b3bc46596e553533b9eecad3',
      },
      {
        tag: 'EVIDENCE',
        old: '',
        next: '  // BEGIN ROLE SCOPED NATIVE EVIDENCE\n  try {\n    requireRoleScopedEvidence(cohorts, native);\n  } catch {\n    fail();\n  }\n  // END ROLE SCOPED NATIVE EVIDENCE\n',
        hash: '57b0be562293f15ff172d5ffb9e7812da5ecd93d63e1a4220cd65ca3dadd8019',
      },
      {
        tag: 'LEGACY_PLAN',
        old: '',
        next: "      // BEGIN ROLE SCOPED NATIVE LEGACY_PLAN\n      .filter((c) => c.id !== 'main-scoped')\n      // END ROLE SCOPED NATIVE LEGACY_PLAN\n",
        hash: 'ad8669a45e933a007760dee877531559971051460597e37be2b2c911096d998e',
      },
    ],
  },
  'scripts/execution-commit-legacy.mjs': {
    predecessor: '8323b0395ba94f0eba6bc99fae536bcb200ff1f40e17cb018a66da24819a7403',
    patches: [
      {
        tag: 'IMPORT',
        old: '',
        next: "// BEGIN ROLE SCOPED NATIVE IMPORT\nimport { beforeRoleScopedNative } from './role-scoped-legacy.mjs';\n// END ROLE SCOPED NATIVE IMPORT\n",
        hash: 'f228d8b40559f616177dbd20c0f4d89e02c50fa94220112d4364bcfac53b6208',
      },
      {
        tag: 'RESTORE',
        old: '',
        next: "  // BEGIN ROLE SCOPED NATIVE RESTORE\n  try {\n    source = beforeRoleScopedNative(file, source);\n  } catch {\n    // Preserve this existing review boundary's fail-closed error contract.\n    throw Error('PAPER_EXECUTION_COMMIT_REVIEW_REQUIRED');\n  }\n  // END ROLE SCOPED NATIVE RESTORE\n",
        hash: '889c54b82d4ba667991d3ba294e9332f6ffd81880be4a74bbd0f7a2980aa5dcd',
      },
    ],
  },
};
export function beforeRoleScopedNative(file, source) {
  source = beforeAdmissionFundingLane(file, source);
  const entry = roleScopedReview[file];
  if (!entry || !source.includes('ROLE SCOPED NATIVE')) return source;
  if ((source.match(/ROLE SCOPED NATIVE/g) ?? []).length !== entry.patches.length * 2)
    throw Error('ROLE_SCOPED_REVIEW_REQUIRED');
  for (const p of entry.patches) {
    if (
      source.split(p.next).length !== 2 ||
      createHash('sha256').update(p.next).digest('hex') !== p.hash
    )
      throw Error('ROLE_SCOPED_REVIEW_REQUIRED');
    source = source.replace(p.next, p.old);
  }
  return source;
}
