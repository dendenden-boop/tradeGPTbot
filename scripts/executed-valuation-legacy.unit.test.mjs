import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforeExecutedValuation, executedValuationReview } from './executed-valuation-legacy.mjs';
const hash = (text) => createHash('sha256').update(text).digest('hex');
it.each(Object.keys(executedValuationReview))(
  'preserves exact accepted Daa bytes below reviewed valuation harness additions: %s',
  async (file) => {
    const text = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    );
    const old = beforeExecutedValuation(file, text),
      review = executedValuationReview[file];
    expect(hash(old)).toBe(review.predecessor);
    expect(beforeExecutedValuation(file, old)).toBe(old);
    expect(() => beforeExecutedValuation(file, text + text)).toThrow(
      'PAPER_EXECUTED_VALUATION_REVIEW_REQUIRED',
    );
    for (const p of review.patches)
      expect(() =>
        beforeExecutedValuation(
          file,
          text.replace(p.next, () => p.next.replace('\n', '\n// unreviewed\n')),
        ),
      ).toThrow('PAPER_EXECUTED_VALUATION_REVIEW_REQUIRED');
    expect(hash(beforeExecutedValuation(file, text + '// outside\n'))).not.toBe(review.predecessor);
  },
);
it('cannot hide changes to original native acceptance budgets', async () => {
  const file = 'scripts/test-database.mjs',
    text = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    );
  const changed = text.replace('90000', '90001');
  expect(changed).not.toBe(text);
  expect(hash(beforeExecutedValuation(file, changed))).not.toBe(
    executedValuationReview[file].predecessor,
  );
});
it('does not normalize unrelated source', () => {
  const text =
    '// BEGIN PAPER EXECUTED VALUATION OTHER\nchanged();\n// END PAPER EXECUTED VALUATION OTHER\n';
  expect(beforeExecutedValuation('other', text)).toBe(text);
});
