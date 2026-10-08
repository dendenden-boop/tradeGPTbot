import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  canonical,
  eventSchema,
  createState,
  reducePortfolio,
  restorePortfolio,
} from '../src/index.js';
import { binding } from './fixtures.js';
const commitment = {
  id: 'reserve',
  timestamp: 100,
  type: 'COMMITMENT' as const,
  hold: {
    id: 'reservation',
    asset: 'USDT',
    amount: '5.005',
    status: 'UNKNOWN' as const,
    reflected: false,
  },
};
const resolution = {
  id: 'resolve',
  timestamp: 200,
  type: 'RESOLVE_COMMITMENT',
  hold: { ...commitment.hold, amount: '3.003', status: 'RESERVED' },
  proofId: 'durable-proof',
  proofHash: 'a'.repeat(64),
};
const fingerprint = createHash('sha256').update(canonical(resolution)).digest('hex');
const previous = () =>
  reducePortfolio(createState(binding()), commitment, { now: () => 1000, holdWatermark: null });
it('trusted reservation resolution reduces an UNKNOWN hold without a monetary posting and survives exact replay', () => {
  const old = previous();
  const context = {
    now: () => 1000,
    holdWatermark: old.holdWatermark!,
    resolutionEvidence: { eventId: resolution.id, fingerprint },
  };
  const resolved = reducePortfolio(old.state, eventSchema.parse(resolution), context);
  expect(resolved.state.holds).toEqual([resolution.hold]);
  expect(resolved.postings).toEqual([]);
  expect(resolved.holdWatermark?.unknown).toBe(false);
  const replay = reducePortfolio(
    restorePortfolio(JSON.parse(canonical(resolved.state))),
    eventSchema.parse(resolution),
    { ...context, holdWatermark: resolved.holdWatermark! },
  );
  expect(replay.ignored).toBe(true);
  expect(replay.state).toEqual(resolved.state);
});
it('a resolution body cannot authorize itself without matching trusted durable evidence', () => {
  const old = previous();
  expect(() =>
    reducePortfolio(old.state, eventSchema.parse(resolution), {
      now: () => 1000,
      holdWatermark: old.holdWatermark!,
    }),
  ).toThrow('RESOLUTION_PROOF_REQUIRED');
});
it('an older trusted resolution after durable release is ignored after restart without resurrecting collateral', () => {
  const old = previous();
  const resolved = reducePortfolio(old.state, eventSchema.parse(resolution), {
    now: () => 1000,
    holdWatermark: old.holdWatermark!,
    resolutionEvidence: { eventId: resolution.id, fingerprint },
  });
  const released = reducePortfolio(
    resolved.state,
    { id: 'release', timestamp: 300, type: 'RELEASE', holdId: commitment.hold.id, resolved: true },
    { now: () => 1000, holdWatermark: resolved.holdWatermark! },
  );
  const replay = reducePortfolio(
    restorePortfolio(JSON.parse(canonical(released.state))),
    eventSchema.parse(resolution),
    {
      now: () => 1000,
      holdWatermark: released.holdWatermark!,
      resolutionEvidence: { eventId: resolution.id, fingerprint },
    },
  );
  expect(replay.ignored).toBe(true);
  expect(replay.state.holds).toEqual([]);
  expect(replay.postings).toEqual([]);
  expect(replay.holdWatermark).toEqual(released.holdWatermark);
});
it('trusted resolution cannot change asset, reflection, or increase the collateral amount', () => {
  const old = previous();
  for (const hold of [
    { ...resolution.hold, asset: 'BTC' },
    { ...resolution.hold, reflected: true },
    { ...resolution.hold, amount: '6' },
  ]) {
    const forged = { ...resolution, hold };
    const context = {
      now: () => 1000,
      holdWatermark: old.holdWatermark!,
      resolutionEvidence: {
        eventId: resolution.id,
        fingerprint: createHash('sha256').update(canonical(forged)).digest('hex'),
      },
    };
    expect(() => reducePortfolio(old.state, eventSchema.parse(forged), context)).toThrow(
      'RESOLUTION_SCOPE',
    );
  }
});
