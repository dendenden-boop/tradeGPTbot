import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforeRoleScopedNative, roleScopedReview } from './role-scoped-legacy.mjs';
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
      const changed = current.replace(patch.next, patch.next.replace('\n', '\n// unreviewed\n'));
      expect(() => beforeRoleScopedNative(file, changed)).toThrow('ROLE_SCOPED_REVIEW_REQUIRED');
    }
  },
);
