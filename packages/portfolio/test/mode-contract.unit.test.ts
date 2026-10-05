import { expect, it } from 'vitest';
import { bindingSchema } from '../src/domain.js';
import { binding } from './fixtures.js';
it('admits exact TESTNET storage mode', () =>
  expect(bindingSchema.parse({ ...binding(), mode: 'TESTNET' }).mode).toBe('TESTNET'));
it.each([
  ['DEMO', 'TESTNET'],
  ['TESTNET', 'DEMO'],
  ['TESTNET', 'LIVE'],
  ['LIVE', 'TESTNET'],
  ['DEMO', 'LIVE'],
  ['LIVE', 'DEMO'],
])('rejects contradictory mode %s / environment %s', (mode, environment) =>
  expect(() =>
    bindingSchema.parse({ ...binding(), mode, scope: { ...binding().scope, environment } }),
  ).toThrow(),
);
it('keeps DEMO distinct and accepts a server-selected PAPER public profile', () => {
  expect(
    bindingSchema.parse({
      ...binding(),
      mode: 'DEMO',
      scope: { ...binding().scope, environment: 'DEMO' },
    }).mode,
  ).toBe('DEMO');
  expect(bindingSchema.parse({ ...binding(), mode: 'PAPER' }).mode).toBe('PAPER');
});
