// Additional acceptance proof for the reviewed, independently migrated DB scope.
import assert from 'node:assert/strict';
import {
  scopedMainFiles,
  scopedMainManifestHash,
  scopedMainDatabaseName,
} from './native-main-scopes.mjs';
import { roleScopedShape } from './role-scoped-cohorts.mjs';

export function requireRoleScopedEvidence(cohorts, native) {
  assert.equal(cohorts.roleScopedManifest, scopedMainManifestHash);
  assert.deepEqual(
    cohorts.cohorts.map(({ id, parallel, after, afterAny }) => ({
      id,
      parallel,
      ...(after === undefined ? {} : { after }),
      ...(afterAny === undefined ? {} : { afterAny }),
    })),
    roleScopedShape,
  );
  const plans = new Map(cohorts.cohorts.map((c) => [c.id, c]));
  const timings = new Map(cohorts.completed.map((c) => [c.id, c]));
  assert.equal(timings.size, 9);
  assert.deepEqual([...timings.keys()].sort(), roleScopedShape.map((c) => c.id).sort());
  assert.deepEqual(plans.get('main-scoped').files, [...scopedMainFiles]);
  assert.match(plans.get('main').database, /^ctp_p2_fresh_[a-f0-9]+$/);
  assert.equal(
    plans.get('main-scoped').database,
    scopedMainDatabaseName(plans.get('main').database),
  );
  for (const id of [
    'registry',
    'admission',
    'execution-start',
    'execution-preview',
    'execution-commit',
  ])
    assert.notEqual(plans.get('main-scoped').database, plans.get(id).database);
  const expected = cohorts.cohorts.flatMap((c) => c.files).sort();
  assert.equal(new Set(expected).size, expected.length);
  const actual = native.testResults
    .map((f) => {
      const value = f.name.replaceAll('\\', '/');
      const index = value.indexOf('/packages/');
      return index >= 0 ? value.slice(index + 1) : value;
    })
    .sort();
  assert.deepEqual(actual, expected);
  for (const c of timings.values()) {
    assert(Number.isFinite(c.startMs) && Number.isFinite(c.settledMs));
    assert(c.startMs >= 0 && c.settledMs >= c.startMs && c.settledMs <= cohorts.elapsedMs);
  }
  for (const plan of plans.values()) {
    const current = timings.get(plan.id);
    for (const id of plan.after ?? []) assert(current.startMs >= timings.get(id).settledMs);
    if (plan.afterAny)
      assert(plan.afterAny.some((id) => current.startMs >= timings.get(id).settledMs));
  }
  const scoped = timings.get('main-scoped'),
    writer = timings.get('execution-commit'),
    roles = timings.get('roles');
  for (const id of ['main', 'registry']) assert(scoped.startMs >= timings.get(id).settledMs);
  assert(writer.startMs >= scoped.settledMs);
  for (const [id, c] of timings) if (id !== 'roles') assert(roles.startMs >= c.settledMs);
  let active = 0;
  for (const [, delta] of [...timings.values()]
    .flatMap((c) => [
      [c.startMs, 1],
      [c.settledMs, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    active += delta;
    assert(active >= 0 && active <= 2);
  }
  assert.equal(active, 0);
}
