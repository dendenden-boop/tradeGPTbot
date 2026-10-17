import { expect, it } from 'vitest';
import * as risk from '../src/risk.js';

it('exposes a server-only atomic tenant cash and target context reader without financial authority', () => {
  expect(
    (risk as Record<string, unknown>)['createPostgresPaperTenantRiskContextSource'],
  ).toBeTypeOf('function');
  for (const key of ['approve', 'reserve', 'dispatch', 'decodePaperTenantRiskContextSource'])
    expect(key in risk).toBe(false);
});
