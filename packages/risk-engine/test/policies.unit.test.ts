import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { policyUpdateSchema, policyHeadSchema, policyFingerprint } from '../src/policies.js';
import { fixture } from './fixtures.js';

const update = () => ({
  scope: { kind: 'USER', tenantId: randomUUID() },
  mode: 'TESTNET',
  eventId: randomUUID(),
  expectedVersion: '0',
  reason: 'SERVER_POLICY_CHANGE',
  limits: fixture().user,
});
it('policy replacement has canonical lossless CAS versions', () => {
  const request = { ...update(), expectedVersion: '9007199254740993' };
  expect(policyUpdateSchema.parse(request).expectedVersion).toBe(request.expectedVersion);
});
it.each(['00', '-1', '1.0', '1e3', '9223372036854775807', 1])(
  'rejects invalid or exhausted policy version %s',
  (expectedVersion) => {
    expect(policyUpdateSchema.safeParse({ ...update(), expectedVersion }).success).toBe(false);
  },
);
it('platform policy has no caller tenant authority', () => {
  expect(policyUpdateSchema.safeParse({ ...update(), scope: { kind: 'PLATFORM' } }).success).toBe(
    true,
  );
  expect(
    policyUpdateSchema.safeParse({
      ...update(),
      scope: { kind: 'PLATFORM', tenantId: randomUUID() },
    }).success,
  ).toBe(false);
});
it('exact TESTNET and DEMO policies remain separate', () => {
  expect(policyUpdateSchema.parse(update()).mode).toBe('TESTNET');
  expect(policyUpdateSchema.parse({ ...update(), mode: 'DEMO' }).mode).toBe('DEMO');
});
it('new and missing policy constraints fail closed', () => {
  const request = update();
  expect(
    policyUpdateSchema.safeParse({
      ...request,
      limits: { ...request.limits, futureConstraint: '1' },
    }).success,
  ).toBe(false);
  const { maxUserExposure: omitted, ...limits } = request.limits;
  void omitted;
  expect(policyUpdateSchema.safeParse({ ...request, limits }).success).toBe(false);
});
it('limits fingerprint preserves decimal digits and ignores property insertion order', () => {
  const a = { ...fixture().user, maxUserExposure: '9007199254740993.000000000000000001' };
  const b = Object.fromEntries(Object.entries(a).reverse());
  expect(policyFingerprint(a)).toBe(policyFingerprint(b));
  expect(policyFingerprint(a)).not.toBe(
    policyFingerprint({ ...a, maxUserExposure: '9007199254740993' }),
  );
});
it('persisted policy heads require matching content hashes and positive versions', () => {
  const request = update();
  const head = {
    scope: request.scope,
    mode: request.mode,
    version: '1',
    eventId: request.eventId,
    limits: request.limits,
    limitsHash: policyFingerprint(request.limits),
  };
  expect(policyHeadSchema.safeParse(head).success).toBe(true);
  expect(policyHeadSchema.safeParse({ ...head, limitsHash: 'a'.repeat(64) }).success).toBe(false);
  expect(policyHeadSchema.safeParse({ ...head, version: '0' }).success).toBe(false);
  expect(
    policyHeadSchema.safeParse({ ...head, limits: { ...head.limits, maxLeverage: '0' } }).success,
  ).toBe(false);
});
