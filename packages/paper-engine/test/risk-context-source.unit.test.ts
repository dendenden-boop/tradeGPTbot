import { expect, it } from 'vitest';
import * as risk from '../src/risk.js';
import * as pure from '../src/index.js';

it('provides a fixed atomic PAPER authority/runtime context source without financial authority', () => {
  expect(
    (risk as unknown as Record<string, unknown>)['createPostgresPaperRiskContextSource'],
    'PAPER_RISK_CONTEXT_FACTORY_MISSING',
  ).toBeTypeOf('function');
  expect('createPostgresPaperRiskContextSource' in pure).toBe(false);
  for (const name of ['approve', 'reserve', 'dispatch', 'decodePaperRiskContextSource'])
    expect(name in risk).toBe(false);
});
