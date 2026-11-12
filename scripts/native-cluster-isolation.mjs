// Test-runner authority only; no production database or exchange entrypoint.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const issued = new WeakSet();
const fail = () => {
  throw Error('NATIVE_CLUSTER_ISOLATION');
};
export function secondaryNativeProject(project) {
  if (typeof project !== 'string' || !/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(project)) fail();
  return (
    project.slice(0, -12) + (BigInt('0x' + project.slice(-12)) ^ 1n).toString(16).padStart(12, '0')
  );
}
function profile(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.project !== 'string' ||
    !/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(value.project) ||
    typeof value.containerId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.containerId) ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  )
    fail();
  return { project: value.project, containerId: value.containerId, port: value.port };
}
async function systemIdentifier(client) {
  const r = await client.query('SELECT system_identifier::text AS id FROM pg_control_system()');
  const id = r.rows?.[0]?.id;
  if (
    r.rows.length !== 1 ||
    typeof id !== 'string' ||
    !/^[1-9][0-9]{0,19}$/u.test(id) ||
    BigInt(id) > 18446744073709551615n
  )
    fail();
  return id;
}
export function assertNativeClusterIsolation(certificate) {
  if (!certificate || !issued.has(certificate)) fail();
  return certificate;
}
// This lower-level diagnostic proves PostgreSQL role separation only. Its
// result is deliberately not an issued scheduler/Compose certificate.
export async function proveNativeRoleIndependence(primary, secondary) {
  const [first, second] = await Promise.all([
    systemIdentifier(primary),
    systemIdentifier(secondary),
  ]);
  if (first === second) fail();
  const role = 'ctp_cluster_probe_' + randomBytes(6).toString('hex');
  let createdPrimary = false,
    createdSecondary = false,
    failure;
  try {
    await primary.query(
      `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdPrimary = true;
    await secondary.query(
      `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdSecondary = true;
    await primary.query(`ALTER ROLE "${role}" LOGIN`);
    const [one, two] = await Promise.all([
      primary.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [role]),
      secondary.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [role]),
    ]);
    assert.deepEqual(one.rows, [{ rolcanlogin: true }]);
    assert.deepEqual(two.rows, [{ rolcanlogin: false }]);
  } catch (error) {
    failure = error;
  } finally {
    const closed = await Promise.allSettled([
      ...(createdPrimary ? [primary.query(`DROP ROLE "${role}"`)] : []),
      ...(createdSecondary ? [secondary.query(`DROP ROLE "${role}"`)] : []),
    ]);
    if (closed.some((r) => r.status !== 'fulfilled'))
      failure ??= Error('NATIVE_CLUSTER_ISOLATION_CLEANUP');
  }
  if (failure) fail();
  return Object.freeze({ first, second });
}
export async function createNativeClusterIsolation({
  primary,
  secondary,
  primaryEndpoint,
  secondaryEndpoint,
}) {
  const a = profile(primaryEndpoint),
    b = profile(secondaryEndpoint);
  if (
    b.project !== secondaryNativeProject(a.project) ||
    a.containerId === b.containerId ||
    a.port === b.port
  )
    fail();
  const { first, second } = await proveNativeRoleIndependence(primary, secondary);
  const certificate = Object.freeze({
    version: 'native-cluster-isolation-v1',
    primary: Object.freeze({ ...a, systemIdentifier: first }),
    secondary: Object.freeze({ ...b, systemIdentifier: second }),
    roleIsolation: Object.freeze({ independent: true, probeRolesRemoved: true }),
  });
  issued.add(certificate);
  return certificate;
}
