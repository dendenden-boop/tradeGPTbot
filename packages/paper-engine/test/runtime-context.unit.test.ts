import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { decodePaperRuntimeContext } from '../src/runtime-domain.js';
import { runtimeFixture } from './runtime-fixtures.js';

function fixture() {
  const f = runtimeFixture();
  const { owner, asOf, configuration, current } = f.w;
  return {
    ...f,
    context: { owner, asOf, configuration, current, kind: 'PAPER_RUNTIME_CONTEXT' as const },
  };
}
it('binds server collector context to sealed configuration and exact current epochs without health defaults', () => {
  const f = fixture(),
    result = decodePaperRuntimeContext(f.context, f.owner, f.now);
  expect(result.configuration).toEqual(f.configuration);
  expect(result.configurationHash).toBe(f.context.configuration.hash);
  expect(result.current).toEqual(f.context.current);
  expect(Object.isFrozen(result)).toBe(true);
  for (const key of ['health', 'approve', 'grant', 'ready', 'capabilities'])
    expect(key in result).toBe(false);
});
it.each(['owner', 'identity', 'hash', 'future', 'epoch', 'extra'] as const)(
  'rejects %s context mismatch',
  (kind) => {
    const f = fixture();
    if (kind === 'owner') f.context.owner.accountId = randomUUID();
    if (kind === 'identity') f.context.current.clientIdEpoch = 'foreign';
    if (kind === 'hash') f.context.configuration.hash = '0'.repeat(64);
    if (kind === 'future') f.context.asOf = f.now + 1;
    if (kind === 'epoch') f.context.current.userSessionEpoch = '2147483648';
    const raw = kind === 'extra' ? { ...f.context, health: {} } : f.context;
    expect(() => decodePaperRuntimeContext(raw, f.owner, f.now)).toThrow('PAPER_RUNTIME_CORRUPT');
  },
);
it('does not renew collector context when decoded after expiry', () => {
  const f = fixture();
  expect(() => decodePaperRuntimeContext(f.context, f.owner, f.now + 5001)).toThrow(
    'PAPER_RUNTIME_STALE',
  );
});
