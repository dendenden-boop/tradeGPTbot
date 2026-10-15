import { expect, it } from 'vitest';
import * as risk from '../src/risk.js';
import * as pure from '../src/index.js';

it('exposes an isolated server-owned PAPER authority source without financial approval', () => {
  expect(
    (risk as unknown as Record<string, unknown>)['createPostgresPaperRiskAuthoritySource'],
    'PAPER_RISK_AUTHORITY_FACTORY_MISSING',
  ).toBeTypeOf('function');
  expect('createPostgresPaperRiskAuthoritySource' in pure).toBe(false);
  expect('approve' in risk).toBe(false);
});
