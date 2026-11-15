import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  beforeCurrentRiskEvaluationRoot,
  beforeCurrentRiskEvaluationHash,
  currentRiskEvaluationAddition,
} from './current-risk-evaluation-legacy.mjs';
const source = readFileSync('packages/paper-engine/src/index.ts', 'utf8').replaceAll('\r\n', '\n');
const hash = (text) => createHash('sha256').update(text).digest('hex');
it('reconstructs every accepted9f2f324 root byte after only the reviewed new pure export', () => {
  const old = beforeCurrentRiskEvaluationRoot(source);
  expect(hash(old)).toBe(beforeCurrentRiskEvaluationHash);
  expect(source.replace(currentRiskEvaluationAddition, '')).toBe(old);
  expect(beforeCurrentRiskEvaluationRoot(old)).toBe(old);
});
it.each(['prefix', 'trailing', 'duplicate', 'body', 'export', 'missing-member'])(
  'rejects unreviewed current Risk root %s while preserving the predecessor pin',
  (kind) => {
    const bad =
      kind === 'prefix'
        ? '// prefix\n' + source
        : kind === 'trailing'
          ? source + '// trailing\n'
          : kind === 'duplicate'
            ? source + currentRiskEvaluationAddition
            : kind === 'body'
              ? source.replace("export * from './model.js';", "export * from './unknown-model.js';")
              : kind === 'export'
                ? source.replace(
                    "from './current-risk-evaluation.js'",
                    "from './alternate-evaluator.js'",
                  )
                : source.replace('  type PaperCurrentRiskEvaluationCalculation,\n', '');
    expect(() => beforeCurrentRiskEvaluationRoot(bad)).toThrow(
      'PAPER_CURRENT_EVALUATION_ROOT_REVIEW',
    );
  },
);
