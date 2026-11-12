import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforeCertifiedCluster, certifiedClusterReview } from './certified-cluster-legacy.mjs';
const pins = {
  'scripts/test-integration.mjs':
    'fd96d47c79ff7c40f80c8ba0fc480e12583718a4abea51c910a7aba87e4eae60',
  'scripts/test-database.mjs': '116030ecff344d5377e5d80f11035ad3316b637e001fcd67080745e6bb1a5a4d',
  'scripts/native-proof-artifacts.mjs':
    'c4246034e6973b2cfca3c60d2d7f050606264eac7cc4a30c1c4b5794c7ac3f2b',
  'scripts/role-scoped-cohorts.mjs':
    '69e392115aa265a9ba9841958f8fa077f4aeaa167e0c7704fa1b4f7e455a3bea',
  'scripts/risk-seed-setup-legacy.mjs':
    'aa258b4dd3cfaeb43b90d2befe5b7d8ceafa6e3613b780e080e9d78979c92c46',
};
const hash = (s) => createHash('sha256').update(s).digest('hex');
it.each(Object.entries(pins))(
  'retains every exact 28839b6 statement beneath independently reviewed cluster changes: %s',
  async (file, pin) => {
    const source = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    );
    expect(certifiedClusterReview[file].predecessor).toBe(pin);
    const previous = beforeCertifiedCluster(file, source);
    expect(hash(previous)).toBe(pin);
    expect(beforeCertifiedCluster(file, previous)).toBe(previous);
    expect(() => beforeCertifiedCluster(file, source + source)).toThrow(
      'ROLE_SCOPED_REVIEW_REQUIRED',
    );
    for (const patch of certifiedClusterReview[file].patches) {
      const marker = patch.next.indexOf('// BEGIN CERTIFIED ');
      expect(marker).toBeGreaterThanOrEqual(0);
      const boundary = patch.next.indexOf('\n', marker) + 1;
      expect(boundary).toBeGreaterThan(0);
      const changed =
        patch.next.slice(0, boundary) + '// unreviewed\n' + patch.next.slice(boundary);
      expect(() => beforeCertifiedCluster(file, source.replace(patch.next, changed))).toThrow(
        'ROLE_SCOPED_REVIEW_REQUIRED',
      );
    }
    const outside = '// preserved unreviewed statement\n';
    expect(beforeCertifiedCluster(file, source + outside)).toBe(previous + outside);
    expect(hash(beforeCertifiedCluster(file, source + outside))).not.toBe(pin);
  },
);
