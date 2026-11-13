// Owned acceptance infrastructure only. This is never a financial capability.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertNativeClusterIsolation } from './native-cluster-isolation.mjs';
import { verifyAdmissionParallelFiles } from './database-cohorts.mjs';
import { workspace } from './docker-test-utils.mjs';

const issued = new WeakSet();
const evidence = () => ({
  version: 'native-registry-independence-v1',
  before: { primary: false, secondary: false },
  during: { primary: true, secondary: false },
  after: { primary: false, secondary: false },
});
export function requireRegistryIndependenceEvidence(value) {
  assert.deepEqual(value, evidence());
}
export function assertRegistryIndependence(proof, isolation) {
  if (!proof || !issued.has(proof) || proof.isolation !== isolation)
    throw Error('NATIVE_REGISTRY_INDEPENDENCE');
  assertNativeClusterIsolation(isolation);
  return proof;
}
export async function proveRegistryIndependence({ primary, secondary, isolation }) {
  assertNativeClusterIsolation(isolation);
  async function pair(sql, values = []) {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => primary.query(sql, values)),
      Promise.resolve().then(() => secondary.query(sql, values)),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return results.map((result) => result.value);
  }
  async function identities() {
    const [a, b] = await pair('SELECT system_identifier::text AS id FROM pg_control_system()');
    assert.deepEqual(a.rows, [{ id: isolation.primary.systemIdentifier }]);
    assert.deepEqual(b.rows, [{ id: isolation.secondary.systemIdentifier }]);
  }
  async function flags() {
    const [a, b] = await pair('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [
      'ctp_instrument_registry',
    ]);
    assert.equal(a.rows.length, 1);
    assert.equal(b.rows.length, 1);
    assert.equal(typeof a.rows[0].rolcanlogin, 'boolean');
    assert.equal(typeof b.rows[0].rolcanlogin, 'boolean');
    return { primary: a.rows[0].rolcanlogin, secondary: b.rows[0].rolcanlogin };
  }
  let changed = false,
    failure,
    result;
  try {
    await identities();
    const before = await flags();
    assert.deepEqual(before, { primary: false, secondary: false });
    // Set before dispatch: even an ambiguous test-DDL response must attempt to
    // restore the known original NOLOGIN state, never issue an overlap token.
    changed = true;
    await primary.query('ALTER ROLE ctp_instrument_registry LOGIN');
    const during = await flags();
    assert.deepEqual(during, { primary: true, secondary: false });
    result = { before, during };
  } catch (error) {
    failure = error;
  } finally {
    if (changed) {
      try {
        await primary.query('ALTER ROLE ctp_instrument_registry NOLOGIN');
      } catch (error) {
        failure ??= error;
      }
    }
  }
  try {
    if (failure) throw failure;
    const after = await flags();
    await identities();
    const value = { version: 'native-registry-independence-v1', ...result, after };
    requireRegistryIndependenceEvidence(value);
    for (const field of ['before', 'during', 'after']) Object.freeze(value[field]);
    const proof = Object.freeze({ isolation, evidence: Object.freeze(value) });
    issued.add(proof);
    return proof;
  } catch {
    throw Error('NATIVE_REGISTRY_INDEPENDENCE');
  }
}

// Filled with exact reviewed registry inputs; admission inputs retain their
// existing complete review. A changed file cannot silently retain early launch.
export const registryDomainInputPins = Object.freeze({
  'packages/database/test/instrument-registry.integration.test.ts':
    '4213c2dc2c48a75df62d8c282ce8c76b3fe2e69faf9d3fb5d74b286f2b78bece',
  'packages/exchange-core/test/fixtures/adapter.ts':
    '4183fa89da2f2b240aaf0d634fa5bc50c50b99bd774e9ff8f213fa37f66b7ec4',
  'packages/database/test/fixtures/registry-commit-proxy.ts':
    'a64aefc8526cea37cc6f218c407ee730d82e58f504d8a111888d03ca0a915af4',
});
export async function verifyRegistryDomainInputs(root = workspace) {
  await verifyAdmissionParallelFiles(root);
  assert.equal(Object.keys(registryDomainInputPins).length, 3);
  for (const [file, expected] of Object.entries(registryDomainInputPins)) {
    const source = (await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      expected,
      'REGISTRY_DOMAIN_REVIEW_REQUIRED:' + file,
    );
  }
}
