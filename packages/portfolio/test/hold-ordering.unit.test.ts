import { expect, it } from 'vitest';
import { createState, reducePortfolio } from '../src/accounting.js';
import { binding } from './fixtures.js';
import type { PortfolioEvent, HoldWatermark } from '../src/domain.js';
const hold = {
  id: 'reservation',
  asset: 'USDT',
  amount: '10',
  status: 'RESERVED' as const,
  reflected: false,
};
const commit = (timestamp: number, amount = '10'): PortfolioEvent => ({
  type: 'COMMITMENT',
  id: `c${timestamp}-${amount}`,
  timestamp,
  hold: { ...hold, amount },
});
const release = (timestamp: number, resolved = true): PortfolioEvent => ({
  type: 'RELEASE',
  id: `r${timestamp}`,
  timestamp,
  holdId: hold.id,
  resolved,
});
function owner() {
  let state = createState(binding());
  let watermark: HoldWatermark | null = null;
  return {
    apply(e: PortfolioEvent) {
      const r = reducePortfolio(state, e, {
        now: () => 1000,
        holdWatermark: watermark,
      });
      state = r.state;
      watermark = r.holdWatermark ?? watermark;
      return r;
    },
    get: () => state,
    restart() {
      state = JSON.parse(JSON.stringify(state)) as typeof state;
      watermark = JSON.parse(JSON.stringify(watermark)) as HoldWatermark | null;
    },
  };
}
it('old commitment and release cannot weaken a newer reservation', () => {
  const o = owner();
  o.apply(commit(900, '100'));
  o.apply(commit(800, '1'));
  expect(o.get().holds[0]?.amount).toBe('100');
  o.apply(release(850));
  expect(o.get().holds).toHaveLength(1);
});
it('released tombstone survives restart and prevents old resurrection', () => {
  const o = owner();
  o.apply(commit(800));
  o.apply(release(900));
  o.restart();
  o.apply(commit(850));
  expect(o.get().holds).toEqual([]);
});
it('identical version replay is idempotent and equal-time conflicts reject', () => {
  const o = owner();
  o.apply(commit(800));
  o.apply(commit(800));
  expect(o.get().holds).toHaveLength(1);
  expect(() => o.apply(commit(800, '1'))).toThrow('HOLD_VERSION_CONFLICT');
});
it('UNKNOWN requires a newer trusted resolution', () => {
  const o = owner();
  o.apply({ ...commit(800), type: 'COMMITMENT', hold: { ...hold, status: 'UNKNOWN' } });
  expect(() => o.apply(release(900, false))).toThrow('UNKNOWN_COMMITMENT');
  o.apply(release(900));
  expect(o.get().holds).toEqual([]);
});
