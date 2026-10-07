import { expect, it } from 'vitest';
import { secretFindings } from './scan-secrets.mjs';
import { dependencyBom } from './security-reports.mjs';

it.each([
  ['GITHUB_TOKEN', 'ghp_' + 'A'.repeat(36)],
  ['GITHUB_FINE_GRAINED_TOKEN', 'github_pat_' + 'A'.repeat(82)],
  ['AWS_ACCESS_KEY', 'AKIA' + 'A'.repeat(16)],
  ['SLACK_TOKEN', 'xoxb-' + '1'.repeat(30)],
  ['PRIVATE_KEY', '-----BEGIN ' + 'PRIVATE KEY-----'],
])('detects %s without emitting credential bytes', (kind, sentinel) => {
  const findings = secretFindings('src/credentials.ts', Buffer.from('\n' + sentinel));
  expect(findings).toEqual([{ file: 'src/credentials.ts', line: 2, kind }]);
  expect(JSON.stringify(findings)).not.toContain(sentinel);
});
it('has no blanket test fixture exclusion and rejects unexpected tracked env files', () => {
  expect(
    secretFindings('test/fixtures/keys.ts', Buffer.from('ghp_' + 'A'.repeat(36))),
  ).toHaveLength(1);
  expect(secretFindings('.env.production', Buffer.from('PASSWORD=example'))[0]?.kind).toBe(
    'TRACKED_ENV_FILE',
  );
  expect(secretFindings('.env.example', Buffer.from('PASSWORD=<server-owned>'))).toEqual([]);
});
it('fails rather than silently skipping files above the bounded scan size', () => {
  expect(() => secretFindings('large.ts', Buffer.alloc(4 * 1024 * 1024 + 1))).toThrow(
    'SECRET_SCAN_FILE_CAPACITY',
  );
});
const lock =
  "lockfileVersion: '9.0'\npackages:\n  '@scope/pkg@1.2.3':\n    resolution: {}\n  example@2.0.0:\n    resolution: {}\nsnapshots:\n";
const inventory = () => ({
  MIT: [
    {
      name: '@scope/pkg',
      versions: ['1.2.3'],
      license: 'MIT',
      paths: ['private/local/path'],
      author: 'unused',
    },
  ],
});
it('produces a deterministic installed CycloneDX inventory without machine paths', () => {
  const bom = dependencyBom(inventory(), lock);
  expect(bom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1 });
  expect(bom.components).toEqual([
    {
      type: 'library',
      'bom-ref': '@scope/pkg@1.2.3',
      name: '@scope/pkg',
      version: '1.2.3',
      purl: 'pkg:npm/%40scope/pkg@1.2.3',
      licenses: [{ expression: 'MIT' }],
    },
  ]);
  expect(JSON.stringify(bom)).not.toContain('private/local');
  expect(dependencyBom(inventory(), lock)).toEqual(bom);
});
it.each(['UNKNOWN', 'UNLICENSED', 'GPL-3.0-only'])(
  'fails closed on unreviewed license %s',
  (license) => {
    const i = { [license]: [{ name: 'example', versions: ['2.0.0'], license }] };
    expect(() => dependencyBom(i, lock)).toThrow('LICENSE_POLICY_DENIED');
  },
);
it('rejects invented/extraneous versions and conflicting licenses for the same dependency', () => {
  const extra = inventory();
  extra.MIT[0].versions = ['9.0.0'];
  expect(() => dependencyBom(extra, lock)).toThrow('LICENSE_COMPONENT_NOT_LOCKED');
  const conflicting = {
    ...inventory(),
    ISC: [{ name: '@scope/pkg', versions: ['1.2.3'], license: 'ISC' }],
  };
  expect(() => dependencyBom(conflicting, lock)).toThrow('LICENSE_COMPONENT_CONFLICT');
});
it('does not report an empty or malformed license inventory as acceptance', () => {
  expect(() => dependencyBom({}, lock)).toThrow('LICENSE_INVENTORY_EMPTY');
  expect(() => dependencyBom([], lock)).toThrow('LICENSE_INVENTORY_INVALID');
  expect(() => dependencyBom(inventory(), '')).toThrow('LOCKFILE_PACKAGES_MISSING');
});
it.each(['MPL-2.0', 'EPL-2.0'])(
  'does not extend existing tooling %s exceptions to new packages',
  (license) => {
    expect(() =>
      dependencyBom({ [license]: [{ name: 'example', versions: ['2.0.0'], license }] }, lock),
    ).toThrow('LICENSE_POLICY_DENIED');
  },
);
