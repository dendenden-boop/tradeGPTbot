import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reviewed installed license expressions. MPL/EPL are limited to the existing
// tooling inventory; this list does not waive redistribution obligations.
const licenses = new Set([
  'MIT',
  'Apache-2.0',
  'ISC',
  'MIT and ISC',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'EPL-2.0',
  'MPL-2.0',
  'BlueOak-1.0.0',
  'MIT-0',
  'Unlicense',
]);

export function dependencyBom(inventory, lockfile) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory))
    throw new Error('LICENSE_INVENTORY_INVALID');
  const packages = lockfile.split(/^packages:\r?$/m)[1]?.split(/^snapshots:\r?$/m)[0];
  if (!packages) throw new Error('LOCKFILE_PACKAGES_MISSING');
  const locked = new Set(
    [...packages.matchAll(/^ {2}'?([^\n']+@[^\n']+)'?:\r?$/gm)].map((match) => match[1]),
  );
  const components = new Map();
  for (const [license, entries] of Object.entries(inventory)) {
    if (!licenses.has(license) || !Array.isArray(entries)) throw new Error('LICENSE_POLICY_DENIED');
    for (const item of entries) {
      if (
        !item ||
        item.license !== license ||
        typeof item.name !== 'string' ||
        !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(item.name) ||
        !Array.isArray(item.versions) ||
        !item.versions.length
      )
        throw new Error('LICENSE_COMPONENT_INVALID');
      if (
        (license === 'EPL-2.0' && item.name !== 'elkjs') ||
        (license === 'MPL-2.0' && !/^lightningcss(?:-[a-z0-9-]+)?$/.test(item.name))
      )
        throw new Error('LICENSE_POLICY_DENIED');
      for (const version of item.versions) {
        if (typeof version !== 'string' || !/^[0-9][a-zA-Z0-9.+-]*$/.test(version))
          throw new Error('LICENSE_VERSION_INVALID');
        const id = `${item.name}@${version}`;
        if (!locked.has(id)) throw new Error('LICENSE_COMPONENT_NOT_LOCKED');
        const component = {
          type: 'library',
          'bom-ref': id,
          name: item.name,
          version,
          purl: `pkg:npm/${item.name.replace('@', '%40')}@${version}`,
          licenses: [{ expression: license === 'MIT and ISC' ? 'MIT AND ISC' : license }],
        };
        if (components.has(id) && JSON.stringify(components.get(id)) !== JSON.stringify(component))
          throw new Error('LICENSE_COMPONENT_CONFLICT');
        components.set(id, component);
      }
    }
  }
  if (!components.size) throw new Error('LICENSE_INVENTORY_EMPTY');
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      properties: [
        { name: 'ctp:lockfile:sha256', value: createHash('sha256').update(lockfile).digest('hex') },
        {
          name: 'ctp:scope',
          value:
            'Installed frozen workspace on this OS; optional packages on other OSes are not claimed.',
        },
      ],
    },
    components: [...components.values()].sort((a, b) => (a['bom-ref'] < b['bom-ref'] ? -1 : 1)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = process.env['npm_execpath'];
  if (!cli || !/pnpm\.[cm]?js$/.test(cli)) throw new Error('PINNED_PNPM_REQUIRED');
  if (
    execFileSync(process.execPath, [cli, '--version'], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim() !== '11.25.0'
  )
    throw new Error('PINNED_PNPM_REQUIRED');
  const inventory = JSON.parse(
    execFileSync(process.execPath, [cli, 'licenses', 'list', '--json'], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  const bom = dependencyBom(inventory, readFileSync('pnpm-lock.yaml', 'utf8'));
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/sbom.cdx.json', JSON.stringify(bom, null, 2) + '\n');
  writeFileSync(
    'test-results/licenses.json',
    JSON.stringify(
      {
        status: 'PASS',
        components: bom.components.map((c) => ({
          name: c.name,
          version: c.version,
          licenses: c.licenses,
        })),
        expressions: [...new Set(bom.components.map((c) => c.licenses[0].expression))].sort(),
      },
      null,
      2,
    ) + '\n',
  );
  let report;
  try {
    report = execFileSync(process.execPath, [cli, 'audit', '--json'], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Preserve a real JSON vulnerability report on failure; no credentials,
    // command environment or raw stderr are copied to the artifact.
    // eslint-disable-next-line preserve-caught-error -- Child stderr/environment must not leak into CI artifacts or public diagnostics.
    if (!error.stdout) throw new Error('DEPENDENCY_AUDIT_UNAVAILABLE');
    report = error.stdout.toString();
  }
  const audit = JSON.parse(report);
  writeFileSync('test-results/dependency-audit.json', JSON.stringify(audit, null, 2) + '\n');
  const vulnerabilities = audit.metadata?.vulnerabilities;
  if (
    !vulnerabilities ||
    !['low', 'moderate', 'high', 'critical'].every(
      (k) => Number.isSafeInteger(vulnerabilities[k]) && vulnerabilities[k] >= 0,
    )
  )
    throw new Error('DEPENDENCY_AUDIT_INVALID');
  console.log(
    JSON.stringify({
      status: vulnerabilities.high || vulnerabilities.critical ? 'FAIL' : 'PASS',
      installedComponents: bom.components.length,
      vulnerabilities,
      lock: bom.metadata.properties[0].value,
    }),
  );
  if (vulnerabilities.high || vulnerabilities.critical) process.exitCode = 1;
}
