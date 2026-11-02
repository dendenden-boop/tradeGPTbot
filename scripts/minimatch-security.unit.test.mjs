import { expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const eslint = createRequire(require.resolve('eslint'));
const configArray = createRequire(eslint.resolve('@eslint/config-array'));
const typescript = createRequire(require.resolve('typescript-eslint'));
const parser = createRequire(typescript.resolve('@typescript-eslint/parser'));
const estree = createRequire(parser.resolve('@typescript-eslint/typescript-estree'));
const consumers = [eslint, configArray, estree];

it('resolves patched minimatch for every actual ESLint and TypeScript parser consumer', () => {
  for (const consumer of consumers) {
    expect(consumer('minimatch/package.json').version).toBe('11.0.1');
  }
});

it('bounds globpart preprocessing amplification at the requested expansion limit', () => {
  // GHSA-g3hv-75wg-m249: the maintainer caps the **/.. split at
  // braceExpandMax. Six segments bound the vulnerable reproduction to 64
  // alternatives; this test never runs the unbounded adversarial example.
  const pattern = Array(6).fill('**/../a/b').join('/');
  for (const consumer of consumers) {
    const { Minimatch } = consumer('minimatch');
    const result = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 4 });
    expect(result.set.length).toBeGreaterThan(0);
    expect(result.set.length).toBeLessThanOrEqual(4);
  }
});

it('retains ordinary positive, negative, brace and dotfile glob semantics for the actual consumers', () => {
  for (const consumer of consumers) {
    const { minimatch, Minimatch } = consumer('minimatch');
    expect(minimatch('packages/paper-engine/src/risk.ts', '**/*.{ts,mjs}')).toBe(true);
    expect(minimatch('scripts/check-docs.mjs', '**/*.{ts,mjs}')).toBe(true);
    expect(minimatch('docs/phase-13/verification.md', '**/*.{ts,mjs}')).toBe(false);
    expect(minimatch('.github/workflows/ci.yml', '**/*.yml')).toBe(false);
    expect(minimatch('.github/workflows/ci.yml', '**/*.yml', { dot: true })).toBe(true);
    const optimized = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 });
    expect(optimized.match('../a/b/../c/d')).toBe(true);
    expect(optimized.match('x/a/b/y/c/d')).toBe(true);
  }
});
