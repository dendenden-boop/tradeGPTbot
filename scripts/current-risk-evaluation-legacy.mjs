// Test-only exact accepted9f2f324 root reconstruction. This permits only the
// reviewed additive export and keeps every predecessor byte and hash binding.
import { createHash } from 'node:crypto';
export const currentRiskEvaluationAddition = `export {
  calculatePaperCurrentRiskEvaluation,
  type PaperCurrentRiskEvaluationCalculation,
} from './current-risk-evaluation.js';
`;
export const beforeCurrentRiskEvaluationHash =
  '7ce1c7c6ca4a7f0f18c2e4390c4cd8c9f3a7ad070083fa632ce25bee1ddac644';
export function beforeCurrentRiskEvaluationRoot(text) {
  if (typeof text !== 'string') throw Error('PAPER_CURRENT_EVALUATION_ROOT_REVIEW');
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  if (hash(text) === beforeCurrentRiskEvaluationHash) return text;
  if (text.split(currentRiskEvaluationAddition).length !== 2)
    throw Error('PAPER_CURRENT_EVALUATION_ROOT_REVIEW');
  const retained = text.replace(currentRiskEvaluationAddition, '');
  if (hash(retained) !== beforeCurrentRiskEvaluationHash)
    throw Error('PAPER_CURRENT_EVALUATION_ROOT_REVIEW');
  return retained;
}
