import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { controlUpdateSchema, controlScopeSchema } from '../src/controls.js';

const tenantId = randomUUID();
const update = () => ({
  scope: { kind: 'USER', tenantId, targetId: tenantId },
  kind: 'KILL_SWITCH',
  key: 'kill',
  state: 'PAUSED',
  eventId: randomUUID(),
  expectedEpoch: '0',
  reason: 'OPERATOR_PAUSE',
  evidenceHash: 'a'.repeat(64),
});
describe('durable control wire contract', () => {
  it('keeps epochs lossless above Number precision', () => {
    const request = { ...update(), expectedEpoch: '9007199254740993' };
    expect(controlUpdateSchema.parse(request).expectedEpoch).toBe(request.expectedEpoch);
  });
  it.each(['-1', '00', '1.0', '1e3', '9223372036854775807', '99999999999999999999'])(
    'rejects invalid or exhausted epoch %s',
    (expectedEpoch) => {
      expect(controlUpdateSchema.safeParse({ ...update(), expectedEpoch }).success).toBe(false);
    },
  );
  it('does not accept numeric epoch or a client permission flag', () => {
    expect(controlUpdateSchema.safeParse({ ...update(), expectedEpoch: 1 }).success).toBe(false);
    expect(controlUpdateSchema.safeParse({ ...update(), authorized: true }).success).toBe(false);
  });
  it('requires USER target to equal the authoritative tenant', () => {
    expect(
      controlScopeSchema.safeParse({ kind: 'USER', tenantId, targetId: randomUUID() }).success,
    ).toBe(false);
  });
  it('GLOBAL has no client tenant or target', () => {
    expect(controlScopeSchema.safeParse({ kind: 'GLOBAL' }).success).toBe(true);
    expect(controlScopeSchema.safeParse({ kind: 'GLOBAL', tenantId }).success).toBe(false);
  });
  it.each(['CONNECTION', 'STRATEGY'] as const)('requires exact %s identity', (kind) => {
    expect(controlScopeSchema.safeParse({ kind, tenantId, targetId: randomUUID() }).success).toBe(
      true,
    );
    expect(controlScopeSchema.safeParse({ kind, tenantId, targetId: 'client-name' }).success).toBe(
      false,
    );
  });
  it('separates circuit states and kill switch states', () => {
    for (const state of ['OPEN', 'CLOSED', 'HALF_OPEN'])
      expect(controlUpdateSchema.safeParse({ ...update(), state }).success).toBe(false);
    for (const state of ['RUNNING', 'PAUSED'])
      expect(
        controlUpdateSchema.safeParse({ ...update(), kind: 'CIRCUIT', key: 'private_ws', state })
          .success,
      ).toBe(false);
    expect(
      controlUpdateSchema.safeParse({
        ...update(),
        kind: 'CIRCUIT',
        key: 'private_ws',
        state: 'HALF_OPEN',
      }).success,
    ).toBe(true);
  });
  it('kill switches have one canonical key', () => {
    expect(controlUpdateSchema.safeParse({ ...update(), key: 'shadow-kill' }).success).toBe(false);
  });
  it.each(['', 'a'.repeat(65), 'raw credential', '\u0000'])(
    'rejects invalid circuit identity %j',
    (key) => {
      expect(
        controlUpdateSchema.safeParse({ ...update(), kind: 'CIRCUIT', key, state: 'OPEN' }).success,
      ).toBe(false);
    },
  );
  it('requires bounded reason and exact evidence fingerprint', () => {
    expect(controlUpdateSchema.safeParse({ ...update(), reason: '' }).success).toBe(false);
    expect(controlUpdateSchema.safeParse({ ...update(), evidenceHash: 'proof' }).success).toBe(
      false,
    );
  });
});
