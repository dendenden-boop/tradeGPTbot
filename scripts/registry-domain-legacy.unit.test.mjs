import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { registryDomainReview, beforeRegistryDomain } from './registry-domain-legacy.mjs';
const hash = (s) => createHash('sha256').update(s).digest('hex');
it.each(Object.entries(registryDomainReview))(
  'retains complete307 source, assertions, budgets and default behavior beneath reviewed extra profile: %s',
  async (file, r) => {
    const source = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    );
    expect(source).toContain('REGISTRY_DOMAIN_EARLY_NATIVE');
    expect(hash(source)).toBe(r.current);
    expect(hash(beforeRegistryDomain(file, source))).toBe(r.predecessor);
    for (const changed of [source + source, '// outside\n' + source, source + '// outside\n'])
      expect(() => beforeRegistryDomain(file, changed)).toThrow('REGISTRY_DOMAIN_REVIEW_REQUIRED');
    for (const patch of r.patches) {
      expect(source.split(patch.next)).toHaveLength(2);
      const at = source.indexOf(patch.next),
        changed = source.slice(0, at) + '// unreviewed\n' + source.slice(at);
      expect(() => beforeRegistryDomain(file, changed)).toThrow('REGISTRY_DOMAIN_REVIEW_REQUIRED');
    }
  },
);
it('retains exact existing child/drain implementation and the480/1020 second caps', async () => {
  const read = async (file) =>
    (await readFile(new URL(file, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const a = await read('./cluster-isolated-cohorts.mjs'),
    b = await read('./role-scoped-cohorts.mjs');
  const block = (s) =>
    s.slice(
      s.indexOf('  // BEGIN IDENTICAL PHYSICAL LAUNCHER'),
      s.indexOf('  // END IDENTICAL PHYSICAL LAUNCHER'),
    );
  expect(block(a)).toBe(block(b));
  expect(a).toContain('timeoutMs <= 480000');
  expect(await read('./native-proof-window.mjs')).toContain('const budgetMs = 1020000;');
});
