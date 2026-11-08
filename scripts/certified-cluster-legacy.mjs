// Exact predecessor restoration for reviewed test-only cluster isolation.
import { createHash } from 'node:crypto';
export const certifiedClusterReview = {
  'scripts/test-integration.mjs': {
    predecessor: 'fd96d47c79ff7c40f80c8ba0fc480e12583718a4abea51c910a7aba87e4eae60',
    patches: [
      {
        tag: 'PARENT_IMPORT',
        old: '',
        next: "// BEGIN CERTIFIED CLUSTER PARENT_IMPORT\nimport { createOwnedSecondaryPostgres } from './owned-native-secondary.mjs';\n// END CERTIFIED CLUSTER PARENT_IMPORT\n",
        hash: '1091000621bf71135058d46ffd4a21454384ff7dff1c20c6df8663a90f4ca906',
      },
      {
        tag: 'PARENT_STATE',
        old: '',
        next: "// BEGIN CERTIFIED CLUSTER PARENT_STATE\nlet secondaryPostgres, secondaryIdentity;\nconst needsSecondary = ['full', 'database', 'cohorts'].includes(proof.mode);\n// END CERTIFIED CLUSTER PARENT_STATE\n",
        hash: '66b69f60da26ae335ae9a8fc51755172c55ab5716d1a4064f315e104d430c5ef',
      },
      {
        tag: 'PARENT_START',
        old: '',
        next: '  // BEGIN CERTIFIED CLUSTER PARENT_START\n  if (needsSecondary) {\n    secondaryPostgres = createOwnedSecondaryPostgres({\n      project: test.project,\n      env: test.env,\n      secrets: test.secrets,\n    });\n    secondaryIdentity = await secondaryPostgres.start();\n  }\n  // END CERTIFIED CLUSTER PARENT_START\n',
        hash: '9dd5a349271c7556ec7f5b7521412261c8eb42ce646c31ad64732bf5f0b2baab',
      },
      {
        tag: 'PARENT_ENV',
        old: '',
        next: '      // BEGIN CERTIFIED CLUSTER PARENT_ENV\n      ...(secondaryIdentity\n        ? {\n            CTP_TEST_SECONDARY_PROJECT: secondaryIdentity.project,\n            CTP_TEST_SECONDARY_POSTGRES_PORT: String(secondaryIdentity.port),\n            CTP_TEST_SECONDARY_IDENTITY: JSON.stringify(secondaryIdentity),\n          }\n        : {}),\n      // END CERTIFIED CLUSTER PARENT_ENV\n',
        hash: '7860b2c1c02910bab5dcfcff3086a459e7e51f645274308083447a1cbe744d81',
      },
      {
        tag: 'PARENT_REPORT',
        old: '',
        next: "  // BEGIN CERTIFIED CLUSTER PARENT_REPORT\n  if (needsSecondary) {\n    if (\n      databaseReport.nativeClusterIsolation?.status !== 'PASS' ||\n      databaseReport.nativeClusterIsolation?.actors !== 32 ||\n      databaseReport.nativeClusterIsolation?.migrations !== 66 ||\n      ['admission', 'startedExecution', 'nativeAdmission'].some(\n        (key) => databaseReport.nativeClusterIsolation?.secondaryResets?.[key] !== 'PASS',\n      ) ||\n      databaseReport.nativeClusterIsolation?.primary?.project !== test.project ||\n      databaseReport.nativeClusterIsolation?.secondary?.project !== secondaryIdentity.project ||\n      databaseReport.nativeClusterIsolation?.secondary?.containerId !==\n        secondaryIdentity.containerId\n    )\n      throw Error('NATIVE_CLUSTER_ISOLATION_REPORT');\n    outcome.nativeClusterIsolation = databaseReport.nativeClusterIsolation;\n    await secondaryPostgres.identity();\n  }\n  // END CERTIFIED CLUSTER PARENT_REPORT\n",
        hash: 'bf12bca745d58594c072f5bc7a5bd5a3de40aa775dd8fef3c384d0ff767384f9',
      },
      {
        tag: 'PARENT_CLEANUP',
        old: '',
        next: "  // BEGIN CERTIFIED CLUSTER PARENT_CLEANUP\n  if (secondaryPostgres) {\n    try {\n      await secondaryPostgres.close();\n      outcome.secondaryCleanup = 'PASS';\n    } catch {\n      outcome = { ...outcome, status: 'FAIL', secondaryCleanup: 'FAIL' };\n      process.exitCode = 1;\n    }\n  }\n  // END CERTIFIED CLUSTER PARENT_CLEANUP\n",
        hash: 'bacd1b222a860d50ed5bf8024ab2b785a514e4a3c78b7268e49dd48c5c3e2c2f',
      },
    ],
  },
  'scripts/test-database.mjs': {
    predecessor: '116030ecff344d5377e5d80f11035ad3316b637e001fcd67080745e6bb1a5a4d',
    patches: [
      {
        tag: 'DATABASE_IMPORT',
        old: '',
        next: "// BEGIN CERTIFIED CLUSTER DATABASE_IMPORT\nimport { bootstrapNativeCluster } from './native-cluster-bootstrap.mjs';\nimport {\n  planClusterIsolatedCohorts,\n  runClusterIsolatedCohorts,\n} from './cluster-isolated-cohorts.mjs';\nconst retainedRoleScopedRunner = runRoleScopedCohorts;\n// END CERTIFIED CLUSTER DATABASE_IMPORT\n",
        hash: 'c6c488f47c3a8680d0a24d8c3f79ef15963d2f40072bad2432e6855314ceb15e',
      },
      {
        tag: 'DATABASE_STATE',
        old: '',
        next: '// BEGIN CERTIFIED CLUSTER DATABASE_STATE\nlet nativeSecondary;\n// END CERTIFIED CLUSTER DATABASE_STATE\n',
        hash: 'dd0e19bbfd739d4543c6fbd580daef8a1800d3b729f47677d8cee247f7b86009',
      },
      {
        tag: 'DATABASE_URL',
        old: '',
        next: '  // BEGIN CERTIFIED CLUSTER DATABASE_URL\n  if (nativeSecondary && [databases[6], databases[7], databases[8]].includes(name))\n    url.port = String(nativeSecondary.port);\n  // END CERTIFIED CLUSTER DATABASE_URL\n',
        hash: 'fb0b0335fc4e2fb77a52420c71b99dfbdcaded72cb8fb2e88da82e6b512e43f9',
      },
      {
        tag: 'DATABASE_SETUP',
        old: '',
        next: "  // BEGIN CERTIFIED CLUSTER DATABASE_SETUP\n  nativeSecondary = await bootstrapNativeCluster({\n    project,\n    env: process.env,\n    nativeEnv,\n    databases,\n    primaryAdmin: admin,\n    connect,\n    run,\n    prisma,\n    config,\n    secrets,\n    remainingMs: () =>\n      nativeWindow\n        ? remainingNativeBudget(nativeWindow)\n        : Math.max(0, proof.timeoutMs - (Date.now() - Date.parse(startedAt))),\n  });\n  const certifiedPlan = await planClusterIsolatedCohorts(\n    originalCohortPlan,\n    nativeSecondary.certificate,\n  );\n  // Upgrade the in-memory plan only after actual separate server/role proof.\n  // No child has started and the original discovery/partition remains intact.\n  cohortPlan.splice(0, cohortPlan.length, ...certifiedPlan);\n  const certifiedRoutes = new Map();\n  function runRoleScopedCohorts(jobs, options) {\n    if (!nativeSecondary) return retainedRoleScopedRunner(jobs, options);\n    if (nativeWindow)\n      assert(\n        remainingNativeBudget(nativeWindow) >= options.timeoutMs,\n        'NATIVE_WINDOW_INSUFFICIENT',\n      );\n    const certified = jobs.map((job) => {\n      const primary = ['main', 'registry', 'roles'].includes(job.id),\n        env = { ...job.env };\n      if (!primary)\n        for (const [key, value] of Object.entries(env))\n          if (key.startsWith('DATABASE_')) {\n            const url = new URL(value);\n            url.port = String(nativeSecondary.port);\n            env[key] = url.href;\n          }\n      const identity = primary\n        ? nativeSecondary.certificate.primary\n        : nativeSecondary.certificate.secondary;\n      const descriptor = {\n        cluster: primary ? 'PRIMARY' : 'SECONDARY',\n        database: new URL(env.DATABASE_MIGRATION_URL).pathname.slice(1),\n        port: identity.port,\n        systemIdentifier: identity.systemIdentifier,\n        containerId: identity.containerId,\n      };\n      certifiedRoutes.set(job.id, descriptor);\n      return { ...job, ...descriptor, env: Object.freeze(env) };\n    });\n    return runClusterIsolatedCohorts(certified, {\n      ...options,\n      isolation: nativeSecondary.certificate,\n    });\n  }\n  // END CERTIFIED CLUSTER DATABASE_SETUP\n",
        hash: '10477960bb68da7d525e0b263a5d0e3f5bbf97f7dbe12e18453c3e2a01cd0926',
      },
      {
        tag: 'COHORT_VERIFY',
        old: '',
        next: '  // BEGIN CERTIFIED CLUSTER COHORT_VERIFY\n  const clusterEvidence = await nativeSecondary.verify();\n  // END CERTIFIED CLUSTER COHORT_VERIFY\n',
        hash: 'b3d1fd3994267d7c1f2c5e5bb63e3e4008d8558a0d0842cb0ad3e915e5ff7756',
      },
      {
        tag: 'COHORT_REPORT',
        old: '',
        next: '    // BEGIN CERTIFIED CLUSTER COHORT_REPORT\n    nativeClusterIsolation: clusterEvidence,\n    // END CERTIFIED CLUSTER COHORT_REPORT\n',
        hash: '010f2941bf39dbab88e29bc91aaee77b33b38b637a3c54795a8dbef3c55470a3',
      },
      {
        tag: 'COHORT_ROUTE',
        old: '',
        next: '      // BEGIN CERTIFIED CLUSTER COHORT_ROUTE\n      ...certifiedRoutes.get(cohort.id),\n      // END CERTIFIED CLUSTER COHORT_ROUTE\n',
        hash: 'e36dd65594fb6d1d06d0a654acf67c2daf94eaca30bd7ce5743bd107cf0dfc11',
      },
      {
        tag: 'RESET_ADMISSION',
        old: '  await admin.query(`DROP DATABASE ${identifier(databases[6])} WITH (FORCE)`);\n  await admin.query(`CREATE DATABASE ${identifier(databases[6])}`);\n  await migrate(databases[6]);\n  await migrate(databases[6]);\n',
        next: '  // BEGIN CERTIFIED CLUSTER RESET_ADMISSION\n  const admissionMaintenance = nativeSecondary.maintenanceFor(databases[6]);\n  await admissionMaintenance.query(`DROP DATABASE ${identifier(databases[6])} WITH (FORCE)`);\n  await admissionMaintenance.query(`CREATE DATABASE ${identifier(databases[6])}`);\n  await nativeSecondary.migrate(databases[6]);\n  await nativeSecondary.migrate(databases[6]);\n  // END CERTIFIED CLUSTER RESET_ADMISSION\n',
        hash: 'e92d4a527d4aa637a8443e54e502a3953d3551e01d62173b594157a51f4a75a7',
      },
      {
        tag: 'RESET_STARTED',
        old: '  await admin.query(`DROP DATABASE ${identifier(databases[7])} WITH (FORCE)`);\n  await admin.query(`CREATE DATABASE ${identifier(databases[7])}`);\n  await migrate(databases[7]);\n  await migrate(databases[7]);\n',
        next: '  // BEGIN CERTIFIED CLUSTER RESET_STARTED\n  const startedMaintenance = nativeSecondary.maintenanceFor(databases[7]);\n  await startedMaintenance.query(`DROP DATABASE ${identifier(databases[7])} WITH (FORCE)`);\n  await startedMaintenance.query(`CREATE DATABASE ${identifier(databases[7])}`);\n  await nativeSecondary.migrate(databases[7]);\n  await nativeSecondary.migrate(databases[7]);\n  // END CERTIFIED CLUSTER RESET_STARTED\n',
        hash: '7e42ae42ea709a2202902c350a476736c79d82a6534c98a35272b19d986fa50c',
      },
      {
        tag: 'RESET_NATIVE',
        old: '',
        next: '  // BEGIN CERTIFIED CLUSTER RESET_NATIVE\n  await nativeSecondary.resetNativeAdmission();\n  // END CERTIFIED CLUSTER RESET_NATIVE\n',
        hash: '6494704f2685a1a5123ba9cce1d7e8ae676905534723d246c46baafe743e9b18',
      },
      {
        tag: 'DATABASE_FINAL_REPORT',
        old: '',
        next: '    // BEGIN CERTIFIED CLUSTER DATABASE_FINAL_REPORT\n    nativeClusterIsolation: await nativeSecondary.verify(),\n    // END CERTIFIED CLUSTER DATABASE_FINAL_REPORT\n',
        hash: '17deecae946c819cc28f587e496bce7414787ec558a9904e0cdf9293511885fb',
      },
    ],
  },
  'scripts/native-proof-artifacts.mjs': {
    predecessor: 'c4246034e6973b2cfca3c60d2d7f050606264eac7cc4a30c1c4b5794c7ac3f2b',
    patches: [
      {
        tag: 'EVIDENCE_IMPORT',
        old: '',
        next: "// BEGIN CERTIFIED CLUSTER EVIDENCE_IMPORT\nimport { requireClusterIsolatedEvidence } from './cluster-isolated-evidence.mjs';\nconst retainedRoleScopedEvidence = requireRoleScopedEvidence;\n// END CERTIFIED CLUSTER EVIDENCE_IMPORT\n",
        hash: 'e533fa0ca80f2a72441bdcecba33325654dc9b805171adf1007a43fcf8a17fce',
      },
      {
        tag: 'EVIDENCE_SELECT',
        old: '',
        next: '  // BEGIN CERTIFIED CLUSTER EVIDENCE_SELECT\n  const requireRoleScopedEvidence = cohorts?.nativeClusterIsolation\n    ? requireClusterIsolatedEvidence\n    : retainedRoleScopedEvidence;\n  // END CERTIFIED CLUSTER EVIDENCE_SELECT\n',
        hash: '17f09871e614e6fdd958290bc3700d14978b952b4bea00bff2cf2fb1c7a03cfe',
      },
    ],
  },
  'scripts/role-scoped-cohorts.mjs': {
    predecessor: '69e392115aa265a9ba9841958f8fa077f4aeaa167e0c7704fa1b4f7e455a3bea',
    patches: [
      {
        tag: 'EXPORT',
        old: '',
        next: "\n// BEGIN CERTIFIED NATIVE CLUSTER EXPORT\nexport {\n  createNativeClusterIsolation,\n  assertNativeClusterIsolation,\n} from './native-cluster-isolation.mjs';\nexport {\n  planClusterIsolatedCohorts,\n  runClusterIsolatedCohorts,\n} from './cluster-isolated-cohorts.mjs';\n// END CERTIFIED NATIVE CLUSTER EXPORT\n",
        hash: '41f3241905f6b126f42fd6b7124c4d4a5ee73e5219136025202abe9aac59eaff',
      },
    ],
  },
  'scripts/risk-seed-setup-legacy.mjs': {
    predecessor: 'aa258b4dd3cfaeb43b90d2befe5b7d8ceafa6e3613b780e080e9d78979c92c46',
    patches: [
      {
        tag: 'LEGACY_IMPORT',
        old: '',
        next: "// BEGIN CERTIFIED CLUSTER LEGACY_IMPORT\nimport { beforeCertifiedCluster } from './certified-cluster-legacy.mjs';\n// END CERTIFIED CLUSTER LEGACY_IMPORT\n",
        hash: 'ba6803e619236b9fe897c0239a081ea871c709f70b8fd5ecd1ff584d207edc49',
      },
      {
        tag: 'LEGACY_RESTORE',
        old: '',
        next: '  // BEGIN CERTIFIED CLUSTER LEGACY_RESTORE\n  source = beforeCertifiedCluster(file, source);\n  // END CERTIFIED CLUSTER LEGACY_RESTORE\n',
        hash: 'af304c33531cfd9c6c5192d40447c381ee748dc51b6c98d60a8a4578749b000a',
      },
    ],
  },
};
export function beforeCertifiedCluster(file, source) {
  const review = certifiedClusterReview[file];
  if (!review || !/BEGIN CERTIFIED (?:NATIVE )?CLUSTER /u.test(source)) return source;
  const begins = (source.match(/BEGIN CERTIFIED (?:NATIVE )?CLUSTER /gu) ?? []).length;
  const ends = (source.match(/END CERTIFIED (?:NATIVE )?CLUSTER /gu) ?? []).length;
  if (begins !== review.patches.length || ends !== review.patches.length)
    throw Error('ROLE_SCOPED_REVIEW_REQUIRED');
  for (const patch of review.patches) {
    if (
      source.split(patch.next).length !== 2 ||
      createHash('sha256').update(patch.next).digest('hex') !== patch.hash
    )
      throw Error('ROLE_SCOPED_REVIEW_REQUIRED');
    source = source.replace(patch.next, patch.old);
  }
  return source;
}
