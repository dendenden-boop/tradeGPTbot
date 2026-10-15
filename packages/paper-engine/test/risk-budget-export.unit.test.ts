import { expect, it } from 'vitest';
import * as paper from '../src/index.js';

it('exports PAPER vector budget arithmetic without financial authority', () => {
  expect(
    (paper as unknown as Record<string, unknown>)['calculatePaperRiskBudget'],
    'PAPER_RISK_BUDGET_MISSING',
  ).toBeTypeOf('function');
});
