import { describe, expect, it } from 'vitest';
import { decimalText } from '../../database/src/decimal.js';
import { balanceSchema, positionSchema, tradingRulesSchema } from '../src/domain.js';
import { normalizedFixtures } from './fixtures/domain.js';

const fixture = normalizedFixtures();
const boundaryValues = [20, 21, 30].map((digits) => ({
  digits,
  value: `${'9'.repeat(digits)}.999999999999999999`,
}));
const aggregateOverflow = '1000000000000000000000000000000';

describe('PHASE 2 aggregate storage and PHASE 4 DTO alignment', () => {
  it.each(boundaryValues)(
    'preserves all aggregate balance fields at $digits integer digits',
    ({ value }) => {
      // BalanceSnapshot.total/available/reserved are aggregate NUMERIC, not amount NUMERIC.
      const stored = decimalText(value, 'aggregate');
      const input = {
        ...fixture.balance,
        free: stored,
        locked: stored,
        total: stored,
        availableToTrade: { state: 'AVAILABLE', value: stored },
      };
      expect(balanceSchema.parse(input)).toEqual(input);
    },
  );

  it.each(boundaryValues)(
    'preserves signed aggregate PnL at $digits integer digits',
    ({ value }) => {
      // Position.realizedPnl/unrealizedPnl use the same aggregate category in PHASE 2.
      const positive = decimalText(value, 'aggregate');
      const negative = decimalText(`-${value}`, 'aggregate');
      for (const [realized, unrealized] of [
        [positive, negative],
        [negative, positive],
      ]) {
        const input = {
          ...fixture.position,
          realizedPnl: { state: 'AVAILABLE', value: realized },
          unrealizedPnl: { state: 'AVAILABLE', value: unrealized },
        };
        expect(positionSchema.parse(input)).toEqual(input);
      }
    },
  );

  it('preserves signed balance aggregates while keeping reserved/locked nonnegative', () => {
    const value = decimalText(`-${'9'.repeat(30)}.999999999999999999`, 'aggregate');
    const input = {
      ...fixture.balance,
      free: value,
      total: value,
      locked: '0',
      availableToTrade: { state: 'AVAILABLE', value },
    };
    expect(balanceSchema.parse(input)).toEqual(input);
    expect(balanceSchema.safeParse({ ...input, locked: '-0.000000000000000001' }).success).toBe(
      false,
    );
  });

  it.each(['free', 'locked', 'total', 'availableToTrade'] as const)(
    'rejects 31 integer digits for balance %s just as aggregate storage does',
    (field) => {
      expect(() => decimalText(aggregateOverflow, 'aggregate')).toThrow(RangeError);
      const input = {
        ...fixture.balance,
        [field]:
          field === 'availableToTrade'
            ? { state: 'AVAILABLE', value: aggregateOverflow }
            : aggregateOverflow,
      };
      expect(balanceSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each(['realizedPnl', 'unrealizedPnl'] as const)(
    'rejects both signs of overflowing %s',
    (field) => {
      for (const value of [aggregateOverflow, `-${aggregateOverflow}`]) {
        expect(() => decimalText(value, 'aggregate')).toThrow(RangeError);
        expect(
          positionSchema.safeParse({
            ...fixture.position,
            [field]: { state: 'AVAILABLE', value },
          }).success,
        ).toBe(false);
      }
    },
  );

  it.each([0.1, '1.0', '1e21', '0.0000000000000000001'])(
    'keeps the strict monetary boundary after widening %#',
    (value) => {
      expect(balanceSchema.safeParse({ ...fixture.balance, total: value }).success).toBe(false);
      expect(
        positionSchema.safeParse({
          ...fixture.position,
          realizedPnl: { state: 'AVAILABLE', value },
        }).success,
      ).toBe(false);
    },
  );

  it('retains unavailable observations and zero without inventing aggregate evidence', () => {
    const input = {
      ...fixture.position,
      realizedPnl: { state: 'AVAILABLE', value: '0' },
      unrealizedPnl: { state: 'UNAVAILABLE', reason: 'STALE' },
    };
    expect(positionSchema.parse(input)).toEqual(input);
    expect(
      balanceSchema.parse({
        ...fixture.balance,
        availableToTrade: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
      }).availableToTrade,
    ).toEqual({ state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' });
  });

  it('keeps position quantities and entry prices bounded by their 20-digit storage categories', () => {
    const value = '100000000000000000000';
    expect(() => decimalText(value, 'quantity')).toThrow(RangeError);
    expect(() => decimalText(value, 'price')).toThrow(RangeError);
    expect(positionSchema.safeParse({ ...fixture.position, quantity: value }).success).toBe(false);
    expect(
      positionSchema.safeParse({
        ...fixture.position,
        entryPrice: { state: 'AVAILABLE', value },
      }).success,
    ).toBe(false);
  });
});

describe('stored rule notionals retain their actual numeric categories', () => {
  it('accepts minNotional up to the full amount 20+18 bound without rounding', () => {
    const value = '99999999999999999999.999999999999999999';
    const stored = decimalText(value, 'amount');
    expect(
      tradingRulesSchema.parse({ ...fixture.rules, minNotional: stored, maxNotional: null })
        .minNotional,
    ).toBe(value);
    expect(tradingRulesSchema.parse({ ...fixture.rules, minNotional: '0' }).minNotional).toBe('0');
  });

  it.each([21, 30, 31])('rejects %s integer digits for the stored amount minNotional', (digits) => {
    const value = '9'.repeat(digits);
    expect(() => decimalText(value, 'amount')).toThrow(RangeError);
    expect(
      tradingRulesSchema.safeParse({ ...fixture.rules, minNotional: value, maxNotional: null })
        .success,
    ).toBe(false);
  });

  it.each(boundaryValues)(
    'retains $digits-digit max/tier notionals in bounded rule JSON',
    ({ value }) => {
      // These are JSON rule metadata, without an InstrumentRuleVersion amount column.
      // RiskProfile.maxNotional, the existing SQL notional cap, uses aggregate 30+18.
      const stored = decimalText(value, 'aggregate');
      const input = {
        ...fixture.rules,
        minNotional: '0',
        maxNotional: stored,
        leverageTiers: [{ notionalCap: stored, maxLeverage: '10' }],
      };
      expect(tradingRulesSchema.parse(input)).toEqual(input);
    },
  );

  it('rejects oversized or nonpositive caps and negative minimum notional', () => {
    for (const value of [aggregateOverflow, '0', '-1']) {
      expect(
        tradingRulesSchema.safeParse({ ...fixture.rules, minNotional: '0', maxNotional: value })
          .success,
      ).toBe(false);
      expect(
        tradingRulesSchema.safeParse({
          ...fixture.rules,
          leverageTiers: [{ notionalCap: value, maxLeverage: '10' }],
        }).success,
      ).toBe(false);
    }
    expect(tradingRulesSchema.safeParse({ ...fixture.rules, minNotional: '-1' }).success).toBe(
      false,
    );
  });
});
