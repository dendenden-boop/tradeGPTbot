import { expect, it } from 'vitest';
import { discoverDatabaseFiles, planDatabaseCohorts } from './database-cohorts.mjs';
import { planRoleScopedCohorts } from './role-scoped-cohorts.mjs';
import { registryIsolatedShape } from './cluster-isolated-cohorts.mjs';
import { requireClusterIsolatedEvidence } from './cluster-isolated-evidence.mjs';
import { scopedMainDatabaseName, scopedMainManifestHash } from './native-main-scopes.mjs';
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
  };
  const secondary = {
    project: 'ctp-integration-901-aabbcc112232',
    containerId: 'b'.repeat(64),
    port: 34002,
    systemIdentifier: '9007199254740993',
  };
  const identity = (p) => ({
    project: p.project,
    containerId: p.containerId,
    port: p.port,
    startedAt,
    image:
      'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
  });
  const evidence = {
    version: 'native-registry-independence-v1',
    before: { primary: false, secondary: false },
    during: { primary: true, secondary: false },
    after: { primary: false, secondary: false },
  };
  const proof = {
    status: 'PASS',
    version: 'native-cluster-isolation-v1',
    primary,
    secondary,
    primaryIdentity: identity(primary),
    secondaryIdentity: identity(secondary),
    roleCatalogBefore: { primary: 'c'.repeat(64), secondary: 'd'.repeat(64) },
    roleCatalogAfter: { primary: 'c'.repeat(64), secondary: 'd'.repeat(64) },
    roleIsolation: { independent: true, probeRolesRemoved: true },
    actors: 32,
    migrations: 68,
    fixedRoleGraphHash: 'e'.repeat(64),
    registryIndependence: globalThis.structuredClone(evidence),
    independentlyMigratedDatabases: [
      base,
      'ctp_p2_admission_cohort_' + suffix,
      'ctp_p2_execution_start_cohort_' + suffix,
      scopedMainDatabaseName(base),
    ],
  };
  const plans = original.map((p) => {
    const primaryRoute = ['main', 'registry', 'roles'].includes(p.id),
      side = primaryRoute ? primary : secondary;
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
      ...registryIsolatedShape.find((j) => j.id === p.id),
      database,
      cluster: primaryRoute ? 'PRIMARY' : 'SECONDARY',
      port: side.port,
      containerId: side.containerId,
      systemIdentifier: side.systemIdentifier,
    };
  });
  const timing = {
    registry: [0, 4],
    'native-admission': [0, 6],
    main: [4, 10],
    'main-scoped': [6, 8],
    admission: [8, 12],
    'execution-start': [10, 13],
    'execution-preview': [13, 14],
    'execution-commit': [14, 16],
    roles: [16, 18],
  };
  return {
    cohorts: {
      nativeClusterIsolation: proof,
      registryIndependence: evidence,
      roleScopedManifest: scopedMainManifestHash,
      timeoutMs: 480000,
      elapsedMs: 18,
      cohorts: plans,
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
it('accepts and does not mutate complete observed independent-domain registry overlap evidence', () => {
  const f = fixture(),
    before = JSON.stringify(f);
  expect(() => requireClusterIsolatedEvidence(f.cohorts, f.native)).not.toThrow();
  expect(JSON.stringify(f)).toBe(before);
});
it.each([
  'missing-marker',
  'missing-probe',
  'wrong-version',
  'primary-not-observed',
  'unsafe-secondary',
  'unrestored',
  'proof-mismatch',
  'unknown-field',
  'same-system',
  'wrong-route',
  'late-native',
  'early-primary',
  'third-child',
  'early-writer',
  'early-roles',
  'lost-file',
])('rejects incomplete or unsafe registry-overlap evidence: %s', (kind) => {
  const f = fixture(),
    c = f.cohorts,
    p = c.nativeClusterIsolation,
    e = c.registryIndependence;
  const plan = (id) => c.cohorts.find((j) => j.id === id),
    time = (id) => c.completed.find((j) => j.id === id);
  if (kind === 'missing-marker') delete c.registryIndependence;
  if (kind === 'missing-probe') delete p.registryIndependence;
  if (kind === 'wrong-version') e.version = 'unreviewed';
  if (kind === 'primary-not-observed') e.during.primary = false;
  if (kind === 'unsafe-secondary') e.during.secondary = true;
  if (kind === 'unrestored') e.after.primary = true;
  if (kind === 'proof-mismatch') p.registryIndependence.during.primary = false;
  if (kind === 'unknown-field') e.approved = true;
  if (kind === 'same-system') p.secondary.systemIdentifier = p.primary.systemIdentifier;
  if (kind === 'wrong-route') plan('native-admission').port = p.primary.port;
  if (kind === 'late-native') time('native-admission').startMs = 5;
  if (kind === 'early-primary') time('main').startMs = 1;
  if (kind === 'third-child') time('main-scoped').startMs = 4;
  if (kind === 'early-writer') time('execution-commit').startMs = 12;
  if (kind === 'early-roles') time('roles').startMs = 15;
  if (kind === 'lost-file') f.native.testResults.pop();
  expect(() => requireClusterIsolatedEvidence(c, f.native)).toThrow();
});
