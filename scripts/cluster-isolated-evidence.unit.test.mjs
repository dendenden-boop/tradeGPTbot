import { expect, it } from 'vitest';
import { requireClusterIsolatedEvidence } from './cluster-isolated-evidence.mjs';
import { clusterIsolatedShape } from './cluster-isolated-cohorts.mjs';
import { planRoleScopedCohorts } from './role-scoped-cohorts.mjs';
import { planDatabaseCohorts, discoverDatabaseFiles } from './database-cohorts.mjs';
import { scopedMainManifestHash, scopedMainDatabaseName } from './native-main-scopes.mjs';
const original = await planRoleScopedCohorts(
  planDatabaseCohorts(await discoverDatabaseFiles(), { executionStartOverlap: true }),
);
function fixture() {
  const base = 'ctp_p2_fresh_aabbcc112233',
    suffix = base.slice(-12),
    startedAt = new Date(Date.now() - 1000).toISOString();
  const primary = {
      project: 'ctp-integration-901-aabbcc112233',
      containerId: 'a'.repeat(64),
      port: 34001,
      systemIdentifier: '9007199254740992',
    },
    secondary = {
      project: 'ctp-integration-901-aabbcc112232',
      containerId: 'b'.repeat(64),
      port: 34002,
      systemIdentifier: '9007199254740993',
    };
  const identity = (c) => ({
    ...c,
    startedAt,
    image:
      'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
  });
  const proof = {
    status: 'PASS',
    version: 'native-cluster-isolation-v1',
    primary,
    secondary,
    primaryIdentity: identity(primary),
    secondaryIdentity: identity(secondary),
    roleIsolation: { independent: true, probeRolesRemoved: true },
    roleCatalogBefore: { primary: '1'.repeat(64), secondary: '2'.repeat(64) },
    roleCatalogAfter: { primary: '1'.repeat(64), secondary: '2'.repeat(64) },
    actors: 32,
    // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT
    migrations: 67,
    // END PAPER EXECUTED VALUATION MIGRATION_COUNT
    fixedRoleGraphHash: '3'.repeat(64),
    independentlyMigratedDatabases: [
      base,
      'ctp_p2_admission_cohort_' + suffix,
      'ctp_p2_execution_start_cohort_' + suffix,
      scopedMainDatabaseName(base),
    ],
  };
  const plans = clusterIsolatedShape.map((shape) => {
    const p = original.find((p) => p.id === shape.id),
      isPrimary = ['main', 'registry', 'roles'].includes(p.id),
      profile = isPrimary ? primary : secondary;
    const database =
      p.id === 'registry'
        ? 'ctp_p2_registry_cohort_' + suffix
        : p.id === 'main-scoped'
          ? scopedMainDatabaseName(base)
          : p.id === 'admission'
            ? 'ctp_p2_admission_cohort_' + suffix
            : ['execution-start', 'execution-preview', 'execution-commit'].includes(p.id)
              ? 'ctp_p2_execution_start_cohort_' + suffix
              : base;
    return {
      ...p,
      ...shape,
      database,
      cluster: isPrimary ? 'PRIMARY' : 'SECONDARY',
      port: profile.port,
      systemIdentifier: profile.systemIdentifier,
      containerId: profile.containerId,
    };
  });
  const timing = {
    registry: [0, 1],
    main: [1, 12],
    'main-scoped': [1, 3],
    admission: [3, 8],
    'native-admission': [8, 11],
    'execution-start': [11, 14],
    'execution-preview': [14, 16],
    'execution-commit': [16, 18],
    roles: [18, 20],
  };
  return {
    cohorts: {
      nativeClusterIsolation: proof,
      roleScopedManifest: scopedMainManifestHash,
      cohorts: plans,
      elapsedMs: 20,
      timeoutMs: 480000,
      completed: plans.map((p) => ({
        id: p.id,
        startMs: timing[p.id][0],
        settledMs: timing[p.id][1],
      })),
    },
    native: {
      startTime: Date.now(),
      testResults: plans.flatMap((p) => p.files.map((name) => ({ name }))),
    },
  };
}
it('accepts actual certified overlap with the same logical main DB name only on separate physical role domains', () => {
  const f = fixture(),
    before = JSON.stringify(f);
  expect(() => requireClusterIsolatedEvidence(f.cohorts, f.native)).not.toThrow();
  expect(JSON.stringify(f)).toBe(before);
});
it.each([
  'same-system',
  'numeric-system',
  'same-container',
  'same-project',
  'wrong-port',
  'wrong-database',
  'changed-roles',
  'lost-file',
  'early-main',
  'early-scope',
  'third-child',
  'early-writer',
  'early-roles',
  'wrong-image',
  'missing-actor',
  'future-start',
  'missing-proof',
])('rejects incomplete, forged or physically invalid independent-domain evidence: %s', (kind) => {
  const f = fixture(),
    p = f.cohorts.nativeClusterIsolation,
    c = (id) => f.cohorts.cohorts.find((c) => c.id === id),
    t = (id) => f.cohorts.completed.find((c) => c.id === id);
  if (kind === 'same-system') p.secondary.systemIdentifier = p.primary.systemIdentifier;
  if (kind === 'numeric-system')
    p.secondary.systemIdentifier = Number(p.secondary.systemIdentifier);
  if (kind === 'same-container') p.secondary.containerId = p.primary.containerId;
  if (kind === 'same-project') p.secondary.project = p.primary.project;
  if (kind === 'wrong-port') c('admission').port = p.primary.port;
  if (kind === 'wrong-database') c('main-scoped').database = c('main').database;
  if (kind === 'changed-roles') p.roleCatalogAfter.secondary = '4'.repeat(64);
  if (kind === 'lost-file') f.native.testResults.pop();
  if (kind === 'early-main') t('main').startMs = 0;
  if (kind === 'early-scope') t('main-scoped').startMs = 0;
  if (kind === 'third-child') t('native-admission').startMs = 4;
  if (kind === 'early-writer') t('execution-commit').startMs = 15;
  if (kind === 'early-roles') t('roles').startMs = 17;
  if (kind === 'wrong-image') p.secondaryIdentity.image = 'postgres:latest';
  if (kind === 'missing-actor') p.actors = 31;
  if (kind === 'future-start')
    p.secondaryIdentity.startedAt = new Date(f.native.startTime + 1).toISOString();
  if (kind === 'missing-proof') delete f.cohorts.nativeClusterIsolation;
  expect(() => requireClusterIsolatedEvidence(f.cohorts, f.native)).toThrow();
});
