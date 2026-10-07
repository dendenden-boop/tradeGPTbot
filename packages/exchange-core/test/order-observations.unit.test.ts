import { describe, expect, it } from 'vitest';
import { createOrderObservationWindow, orderSchema, parseDecimal } from '../src/index.js';
import { normalizedFixtures, NOW } from './fixtures/domain.js';

const sample = orderSchema.parse(normalizedFixtures().order);
const observation = (id: string, time: number, terminal = true) => ({
  ...sample,
  exchangeOrderId: id,
  updatedAt: time,
  status: terminal ? ('CANCELED' as const) : ('OPEN' as const),
});
describe('bounded order continuity proof', () => {
  it('retains active orders through 10000 terminal identities with bounded state', () => {
    const window = createOrderObservationWindow();
    const live = observation('active', NOW, false);
    expect(window.observe(live)).toBe(true);
    for (let i = 1; i <= 10000; i++) {
      expect(window.observe(observation(String(i), NOW + i))).toBe(true);
      expect(window.retained().active).toBe(1);
      expect(window.retained().terminal).toBeLessThanOrEqual(64);
    }
    // A different order's history cannot evict the proof of this active order.
    expect(window.observe({ ...live, updatedAt: NOW + 1 })).toBe(true);
    expect(() => window.observe(live)).toThrow('REGRESSED_ORDER_OBSERVATION');
    expect(window.retained()).toEqual({ active: 1, terminal: 64, retiredThrough: NOW + 9936 });
  });
  it.each(['original', 'conflicting', 'regressed'] as const)(
    'an evicted terminal identity cannot silently adopt %s old evidence',
    (kind) => {
      const window = createOrderObservationWindow(2);
      const old = observation('one', NOW);
      window.observe(old);
      window.observe(observation('two', NOW + 1));
      window.observe(observation('three', NOW + 2));
      const replay =
        kind === 'original'
          ? old
          : kind === 'regressed'
            ? { ...old, updatedAt: NOW - 1 }
            : { ...old, status: 'OPEN' as const };
      expect(() => window.observe(replay)).toThrow('UNPROVABLE_ORDER_REPLAY');
      expect(window.retained()).toEqual({ active: 0, terminal: 2, retiredThrough: NOW });
    },
  );
  it('known exact replay is idempotent and equal changed evidence conflicts', () => {
    const window = createOrderObservationWindow(),
      order = observation('one', NOW);
    expect(window.observe(order)).toBe(true);
    expect(window.observe(structuredClone(order))).toBe(false);
    expect(() => window.observe({ ...order, quantity: parseDecimal('2') })).toThrow(
      'CONFLICTING_ORDER_OBSERVATION',
    );
  });
  it('active pressure rejects without evicting an active/UNKNOWN identity', () => {
    const window = createOrderObservationWindow(2),
      first = observation('one', NOW, false),
      second = { ...observation('two', NOW, false), status: 'UNKNOWN' as const };
    window.observe(first);
    window.observe(second);
    expect(() => window.observe(observation('three', NOW + 1, false))).toThrow(
      'ACTIVE_ORDER_CAPACITY',
    );
    expect(window.observe(first)).toBe(false);
    expect(window.observe(second)).toBe(false);
    expect(window.retained()).toEqual({ active: 2, terminal: 0, retiredThrough: -1 });
  });
  it('terminal proof cannot regress even at a later time', () => {
    const window = createOrderObservationWindow(),
      order = observation('one', NOW);
    window.observe(order);
    expect(() => window.observe({ ...order, updatedAt: NOW + 1, status: 'OPEN' })).toThrow(
      'REGRESSED_ORDER_STATE',
    );
  });
});
