import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { beforeCurrentRiskCounts, currentRiskCountReview } from './current-risk-count-legacy.mjs';
const hash = (s) => createHash('sha256').update(s).digest('hex');
it.each(Object.entries(currentRiskCountReview))(
  'reconstructs complete accepted455 source below exact new mandatory case counts: %s',
  async (file, review) => {
    const source = (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    );
    expect(hash(source)).toBe(review.current);
    expect(hash(beforeCurrentRiskCounts(file, source))).toBe(review.predecessor);
    for (const changed of [source + source, '// outside\n' + source, source + '// outside\n'])
      expect(() => beforeCurrentRiskCounts(file, changed)).toThrow(
        'PAPER_CURRENT_RISK_COUNT_REVIEW_REQUIRED',
      );
    for (const patch of review.patches) {
      expect(source.split(patch.next)).toHaveLength(2);
      const at = source.indexOf(patch.next),
        changed = source.slice(0, at) + '// unreviewed\n' + source.slice(at);
      expect(() => beforeCurrentRiskCounts(file, changed)).toThrow(
        'PAPER_CURRENT_RISK_COUNT_REVIEW_REQUIRED',
      );
    }
  },
);
