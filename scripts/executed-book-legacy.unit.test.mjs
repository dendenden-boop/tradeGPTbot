import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforeExecutedBookCapture, executedBookReview } from './executed-book-legacy.mjs';

const pins = {
  'scripts/test-database.mjs': '4868e3962a665a23efa3f63a9e01839373b8f98e26d427c8643ae09af10e3ccc',
  'scripts/native-proof-artifacts.mjs':
    '21ea374223ade2cf2467c1928e3835f6e69db5b7a65fe1a4bb65833acaf32b8d',
  'scripts/certified-cluster-legacy.mjs':
    'ce821ea884ccc3ff433aa6e91dd5477549d45e8de0ea5fba41a00843a67ddd79',
};
const hash = (text) => createHash('sha256').update(text).digest('hex');
const sourceOf = async (file) =>
  (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
it.each(Object.entries(pins))(
  'retains every B15 predecessor byte beneath reviewed capture owner coverage: %s',
  async (file, pin) => {
    const source = await sourceOf(file),
      previous = beforeExecutedBookCapture(file, source);
    expect(executedBookReview[file].predecessor).toBe(pin);
    expect(hash(previous)).toBe(pin);
    expect(beforeExecutedBookCapture(file, previous)).toBe(previous);
    expect(() => beforeExecutedBookCapture(file, source + source)).toThrow(
      'PAPER_EXECUTED_BOOK_REVIEW_REQUIRED',
    );
    for (const patch of executedBookReview[file].patches) {
      const boundary = patch.next.indexOf('\n') + 1;
      expect(boundary).toBeGreaterThan(0);
      const changed =
        patch.next.slice(0, boundary) + '// unreviewed change\n' + patch.next.slice(boundary);
      expect(() => beforeExecutedBookCapture(file, source.replace(patch.next, changed))).toThrow(
        'PAPER_EXECUTED_BOOK_REVIEW_REQUIRED',
      );
    }
    const outside = '// changed outside the reviewed capture patches\n';
    expect(beforeExecutedBookCapture(file, source + outside)).toBe(previous + outside);
    expect(hash(beforeExecutedBookCapture(file, source + outside))).not.toBe(pin);
  },
);
it('never hides an owner deadline change under capture count reconstruction', async () => {
  const file = 'scripts/test-database.mjs',
    source = await sourceOf(file);
  const changed = source.replace('90000', '90001');
  expect(changed).not.toBe(source);
  const restored = beforeExecutedBookCapture(file, changed);
  expect(restored).toContain('90001');
  expect(hash(restored)).not.toBe(pins[file]);
});
it('does not normalize unreviewed files', () => {
  const source =
    '// BEGIN PAPER EXECUTED BOOK OTHER\ncaller();\n// END PAPER EXECUTED BOOK OTHER\n';
  expect(beforeExecutedBookCapture('scripts/unreviewed.mjs', source)).toBe(source);
});
