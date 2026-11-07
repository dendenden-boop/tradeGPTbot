import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforeRoleScopedNative, roleScopedReview } from './role-scoped-legacy.mjs';

function insertUnreviewedLine(source) {
  const newline = source.indexOf('\n');
  if (newline < 0) throw new Error('MUTATION_LINE_BOUNDARY_REQUIRED');
  const boundary = newline + 1;
  return source.slice(0, boundary) + '// unreviewed\n' + source.slice(boundary);
}

it.each([
  ['first\nsecond\nthird\n', 'first\n// unreviewed\nsecond\nthird\n'],
  ['\nnext\n', '\n// unreviewed\nnext\n'],
])('inserts one deliberate mutation after the first line of %j', (source, changed) => {
  expect(insertUnreviewedLine(source)).toBe(changed);
});

it('rejects a mutation fixture without a line boundary', () => {
  expect(() => insertUnreviewedLine('single line')).toThrow('MUTATION_LINE_BOUNDARY_REQUIRED');
});

it.each(Object.entries(roleScopedReview))(
  'retains every previous harness statement and assertion underneath reviewed scope changes in %s',
  async (file, review) => {
    const current = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    );
    const old = beforeRoleScopedNative(file, current);
    expect(createHash('sha256').update(old).digest('hex')).toBe(review.predecessor);
    expect(beforeRoleScopedNative(file, old)).toBe(old);
    for (const patch of review.patches) {
      const changed = current.replace(patch.next, insertUnreviewedLine(patch.next));
      expect(() => beforeRoleScopedNative(file, changed)).toThrow('ROLE_SCOPED_REVIEW_REQUIRED');
    }
  },
);
