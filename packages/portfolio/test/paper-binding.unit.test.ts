import { expect, it } from 'vitest';
import { bindingSchema, createState, restorePortfolio } from '../src/index.js';
import { binding } from './fixtures.js';

it('PAPER has exact null private connection and restores common Portfolio state', () => {
  const b = bindingSchema.parse({ ...binding(), mode: 'PAPER', connectionId: null });
  expect(restorePortfolio(createState(b)).binding.connectionId).toBeNull();
});
it('PAPER never accepts a dummy native connection UUID', () => {
  expect(() => bindingSchema.parse({ ...binding(), mode: 'PAPER' })).toThrow();
});
it.each(['TESTNET', 'DEMO', 'LIVE'] as const)('%s cannot use a null private connection', (mode) => {
  expect(() =>
    bindingSchema.parse({
      ...binding(),
      mode,
      connectionId: null,
      scope: { ...binding().scope, environment: mode },
    }),
  ).toThrow();
});
