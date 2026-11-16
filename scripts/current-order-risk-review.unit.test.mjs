import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  beforeCurrentOrderRiskReview,
  currentOrderRiskReview,
} from './current-order-risk-legacy.mjs';
const hash = (s) => createHash('sha256').update(s).digest('hex');
it.each(Object.entries(currentOrderRiskReview))(
  'reconstructs all accepted116 harness bytes below the exact stored-order additions: %s',
  (file, r) => {
    const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    expect(hash(text)).toBe(r.current);
    const before = beforeCurrentOrderRiskReview(file, text);
    expect(hash(before)).toBe(r.predecessor);
    expect(beforeCurrentOrderRiskReview(file, before)).toBe(before);
    for (const bad of ['// outside\n' + text, text + '// outside\n', text + text])
      expect(() => beforeCurrentOrderRiskReview(file, bad)).toThrow(
        'PAPER_CURRENT_ORDER_RISK_REVIEW_REQUIRED',
      );
    for (const p of r.patches) {
      expect(text.split(p.next)).toHaveLength(2);
      expect(() =>
        beforeCurrentOrderRiskReview(file, text.replace(p.next, p.next + '// extra\n')),
      ).toThrow('PAPER_CURRENT_ORDER_RISK_REVIEW_REQUIRED');
    }
  },
);
