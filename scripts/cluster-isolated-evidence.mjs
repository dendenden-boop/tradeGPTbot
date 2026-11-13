// REGISTRY_DOMAIN_EARLY_NATIVE: verify actual registry separation for early admission.
// Read-only acceptance evidence; cannot mint a scheduler certificate or grant.
import assert from 'node:assert/strict';
import { clusterIsolatedShape, registryIsolatedShape } from './cluster-isolated-cohorts.mjs';
import { requireRegistryIndependenceEvidence } from './registry-domain-independence.mjs';
import {
  scopedMainFiles,
  scopedMainManifestHash,
  scopedMainDatabaseName,
} from './native-main-scopes.mjs';
import { secondaryNativeProject } from './native-cluster-isolation.mjs';
const hex = (value) => assert(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value));
const system = (value) => {
  assert(typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value));
  assert(BigInt(value) <= 18446744073709551615n);
};
export function requireClusterIsolatedEvidence(cohorts, native) {
  const proof = cohorts.nativeClusterIsolation;
  const registryOverlap = Object.hasOwn(cohorts, 'registryIndependence');
  if (registryOverlap) {
    requireRegistryIndependenceEvidence(cohorts.registryIndependence);
    assert.deepEqual(cohorts.registryIndependence, proof.registryIndependence);
  }
  assert.equal(proof.status, 'PASS');
  assert.equal(proof.version, 'native-cluster-isolation-v1');
  const a = proof.primary,
    b = proof.secondary;
  assert.equal(b.project, secondaryNativeProject(a.project));
  hex(a.containerId);
  hex(b.containerId);
  assert.notEqual(a.containerId, b.containerId);
  for (const c of [a, b]) {
    assert(Number.isSafeInteger(c.port) && c.port > 0 && c.port <= 65535);
    system(c.systemIdentifier);
  }
  assert.notEqual(a.port, b.port);
  assert.notEqual(a.systemIdentifier, b.systemIdentifier);
  for (const [side, c] of [
    ['primary', a],
    ['secondary', b],
  ]) {
    const identity = proof[side + 'Identity'];
    assert.equal(identity.project, c.project);
    assert.equal(identity.containerId, c.containerId);
    assert.equal(identity.port, c.port);
    assert(Number.isFinite(Date.parse(identity.startedAt)));
    assert(Date.parse(identity.startedAt) <= native.startTime);
    assert.equal(
      identity.image,
      'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
    );
    hex(proof.roleCatalogBefore[side]);
    assert.equal(proof.roleCatalogBefore[side], proof.roleCatalogAfter[side]);
  }
  assert.deepEqual(proof.roleIsolation, { independent: true, probeRolesRemoved: true });
  assert.equal(proof.actors, 32);
  // BEGIN PAPER EXECUTED VALUATION MIGRATION_COUNT
  // BEGIN PAPER HISTORICAL INVENTORY MIGRATION_COUNT
  assert.equal(proof.migrations, 68);
  // END PAPER HISTORICAL INVENTORY MIGRATION_COUNT
  // END PAPER EXECUTED VALUATION MIGRATION_COUNT
  hex(proof.fixedRoleGraphHash);
  assert.equal(cohorts.roleScopedManifest, scopedMainManifestHash);
  assert.deepEqual(
    cohorts.cohorts.map(({ id, parallel, after, afterAny }) => ({
      id,
      parallel,
      ...(after === undefined ? {} : { after }),
      ...(afterAny === undefined ? {} : { afterAny }),
    })),
    registryOverlap ? registryIsolatedShape : clusterIsolatedShape,
  );
  const plans = new Map(cohorts.cohorts.map((c) => [c.id, c])),
    times = new Map(cohorts.completed.map((c) => [c.id, c]));
  assert.equal(times.size, 9);
  assert.equal(cohorts.completed.length, 9);
  const base = plans.get('main').database;
  assert.match(base, /^ctp_p2_fresh_[a-f0-9]{12}$/u);
  const suffix = base.slice(-12);
  assert.deepEqual(
    [...proof.independentlyMigratedDatabases].sort(),
    [
      base,
      'ctp_p2_admission_cohort_' + suffix,
      'ctp_p2_execution_start_cohort_' + suffix,
      scopedMainDatabaseName(base),
    ].sort(),
  );
  assert.deepEqual(plans.get('main-scoped').files, [...scopedMainFiles]);
  for (const plan of plans.values()) {
    const primary = ['main', 'registry', 'roles'].includes(plan.id),
      expected = primary ? a : b;
    const name =
      plan.id === 'registry'
        ? 'ctp_p2_registry_cohort_' + suffix
        : plan.id === 'main-scoped'
          ? scopedMainDatabaseName(base)
          : plan.id === 'admission'
            ? 'ctp_p2_admission_cohort_' + suffix
            : ['execution-start', 'execution-preview', 'execution-commit'].includes(plan.id)
              ? 'ctp_p2_execution_start_cohort_' + suffix
              : base;
    assert.equal(plan.cluster, primary ? 'PRIMARY' : 'SECONDARY');
    assert.equal(plan.database, name);
    for (const field of ['port', 'containerId', 'systemIdentifier'])
      assert.equal(plan[field], expected[field]);
    const t = times.get(plan.id);
    assert(t && Number.isFinite(t.startMs) && Number.isFinite(t.settledMs));
    assert(t.startMs >= 0 && t.settledMs >= t.startMs && t.settledMs <= cohorts.elapsedMs);
    for (const id of plan.after ?? []) assert(t.startMs >= times.get(id).settledMs);
    if (plan.afterAny) assert(plan.afterAny.some((id) => t.startMs >= times.get(id).settledMs));
  }
  const expected = cohorts.cohorts.flatMap((c) => c.files).sort();
  assert.equal(new Set(expected).size, expected.length);
  const actual = native.testResults
    .map((f) => {
      const name = f.name.replaceAll('\\', '/'),
        at = name.indexOf('/packages/');
      return at >= 0 ? name.slice(at + 1) : name;
    })
    .sort();
  assert.deepEqual(actual, expected);
  let active = 0;
  for (const [, delta] of [...times.values()]
    .flatMap((t) => [
      [t.startMs, 1],
      [t.settledMs, -1],
    ])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    active += delta;
    assert(active >= 0 && active <= 2);
  }
  assert.equal(active, 0);
  if (registryOverlap) {
    assert(times.get('native-admission').startMs < times.get('registry').settledMs);
  }
  for (const id of ['main', 'main-scoped'])
    assert(times.get(id).startMs >= times.get('registry').settledMs);
  for (const [id, t] of times)
    if (!['execution-commit', 'roles'].includes(id))
      assert(times.get('execution-commit').startMs >= t.settledMs);
  for (const [id, t] of times)
    if (id !== 'roles') assert(times.get('roles').startMs >= t.settledMs);
}
