import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

// Resolve the real Vite -> PostCSS dependency, rather than a test-only package.
const rootRequire = createRequire(import.meta.url);
const viteRequire = createRequire(rootRequire.resolve('vite/package.json'));
const postcssRequire = createRequire(viteRequire.resolve('postcss/package.json'));
const { SourceMapConsumer, SourceMapGenerator } = postcssRequire('source-map-js');
const section = (
  line,
  column = 0,
  map = {
    version: 3,
    sources: ['input.js'],
    sourcesContent: ['const input = 1;'],
    names: [],
    mappings: 'AAAA',
  },
) => ({
  version: 3,
  sections: [{ offset: { line, column }, map }],
});
it.each([1e12, Infinity, NaN, 0.5, '1000000000000'])(
  'actual source-map dependency rejects hostile indexed line offset %s before serialization',
  (offset) => expect(() => new SourceMapConsumer(section(offset))).toThrow(),
);
it('nested indexed section offsets cannot bypass the aggregate work bound', () => {
  expect(() => new SourceMapConsumer(section(6_000_000, 0, section(6_000_000)))).toThrow();
});
it('normal indexed source maps still round-trip through PostCSS dependency', () => {
  const consumer = new SourceMapConsumer(section(10));
  // Indexed consumers expose no sourceRoot; explicitly provide the optional root
  // for the generator's supported fromSourceMap input.
  consumer.sourceRoot = null;
  const map = SourceMapGenerator.fromSourceMap(consumer).toJSON();
  expect(new SourceMapConsumer(map).originalPositionFor({ line: 11, column: 0 })).toMatchObject({
    source: 'input.js',
    line: 1,
    column: 0,
  });
});
