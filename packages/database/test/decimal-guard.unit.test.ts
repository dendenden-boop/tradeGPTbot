import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/client.js';
import { DecimalInputError, validateDecimalArguments } from '../src/decimal-guard.js';

function balance(args: unknown): void {
  validateDecimalArguments('BalanceSnapshot', args);
}

describe('schema-aware Prisma decimal arguments', () => {
  it.each([0, 0.1 + 0.2, NaN, Infinity, 1n, '1e2', '01', '1\n', { toString: () => '0.3' }])(
    'rejects noncanonical monetary scalar %#',
    (total) => {
      expect(() => balance({ data: { total } })).toThrow(DecimalInputError);
    },
  );
  it('accepts bounded strings and Prisma Decimal without changing the caller input', () => {
    const args = {
      data: { total: '123.000000000000000001', available: new Prisma.Decimal('0.3') },
    };
    balance(args);
    expect(args.data.total).toBe('123.000000000000000001');
    expect(args.data.available.toFixed()).toBe('0.3');
    balance({ data: { total: '-0.000000000000000001', borrowed: undefined } });
    validateDecimalArguments('Order', { data: { limitPrice: null } });
  });
  it.each(['NaN', 'Infinity', '1e1000000000', '1e-1000000000', '0.0000000000000000001'])(
    'rejects nonfinite, overflow and overscale Decimal %s before string expansion',
    (value) =>
      expect(() => balance({ data: { total: new Prisma.Decimal(value) } })).toThrow(
        DecimalInputError,
      ),
  );
  it('uses each schema field category rather than one permissive monetary bound', () => {
    balance({ data: { total: '999999999999999999999999999999' } });
    expect(() =>
      validateDecimalArguments('Order', { data: { quantity: '100000000000000000000' } }),
    ).toThrow(DecimalInputError);
    expect(() =>
      validateDecimalArguments('RiskProfile', { data: { maxDrawdownRate: '100' } }),
    ).toThrow(DecimalInputError);
  });
  it.each(['set', 'increment', 'decrement', 'multiply', 'divide'])(
    'guards atomic %s operands',
    (operation) => {
      balance({ data: { total: { [operation]: '0.3' } } });
      expect(() => balance({ data: { total: { [operation]: 0.3 } } })).toThrow(DecimalInputError);
    },
  );
  it.each(['equals', 'lt', 'lte', 'gt', 'gte', 'not', '_min', '_max', '_avg', '_sum'])(
    'guards monetary predicate %s',
    (operation) => {
      balance({ having: { total: { [operation]: { equals: '0.3' }, _count: { gt: 1 } } } });
      expect(() => balance({ having: { total: { [operation]: { equals: 0.3 } } } })).toThrow(
        DecimalInputError,
      );
    },
  );
  it('guards arrays, boolean conditions and compound selectors in reads and bulk writes', () => {
    expect(() => balance({ data: [{ total: '1' }, { total: 0.3 }] })).toThrow(DecimalInputError);
    expect(() => balance({ where: { OR: [{ total: { in: ['1', 0.3] } }] } })).toThrow(
      DecimalInputError,
    );
    expect(() => balance({ cursor: { custom_unique: { total: 0.3 } } })).toThrow(DecimalInputError);
    balance({
      where: {
        AND: [
          { total: { notIn: ['1', new Prisma.Decimal('2')] } },
          { NOT: { total: { lt: '0' } } },
        ],
      },
    });
  });
  it.each([
    { create: { total: 0.3 } },
    { create: [{ total: '1' }, { total: 0.3 }] },
    { createMany: { data: [{ total: '1' }, { total: 0.3 }], skipDuplicates: true } },
    { update: { where: { id: 'fixture' }, data: { total: { increment: 0.3 } } } },
    { update: { total: 0.3 } },
    { updateMany: [{ where: {}, data: { total: 0.3 } }] },
    { upsert: { where: {}, create: { total: '1' }, update: { total: 0.3 } } },
    { connectOrCreate: { where: {}, create: { total: 0.3 } } },
    { connect: { total: 0.3 } },
    { set: { total: 0.3 } },
    { disconnect: { total: 0.3 } },
    { delete: { total: 0.3 } },
    { deleteMany: { total: { equals: 0.3 } } },
  ])('guards nested relation write operation %#', (operation) => {
    expect(() =>
      validateDecimalArguments('ExchangeAccount', {
        data: { balanceSnapshotRecords: operation },
      }),
    ).toThrow(DecimalInputError);
  });
  it.each(['some', 'every', 'none', 'is', 'isNot'])(
    'guards relation filters under %s',
    (operation) => {
      expect(() =>
        validateDecimalArguments('ExchangeAccount', {
          where: { balanceSnapshotRecords: { [operation]: { total: { equals: 0.3 } } } },
        }),
      ).toThrow(DecimalInputError);
    },
  );
  it('guards deeply nested relation selections and filtered relation counts', () => {
    for (const key of ['select', 'include']) {
      expect(() =>
        validateDecimalArguments('ExchangeAccount', {
          [key]: {
            accountStateVersionRecords: {
              include: { balanceSnapshots: { where: { total: 0.3 } } },
            },
          },
        }),
      ).toThrow(DecimalInputError);
    }
    expect(() =>
      validateDecimalArguments('ExchangeAccount', {
        select: { _count: { select: { balanceSnapshotRecords: { where: { total: 0.3 } } } } },
      }),
    ).toThrow(DecimalInputError);
  });
  it('does not misclassify JSON keys, integer counters or aggregate selection flags', () => {
    validateDecimalArguments('RiskProfile', {
      data: { policy: { total: 0.3, quantity: 1, price: 1.1, maxDrawdownRate: 1000 }, version: 2 },
    });
    validateDecimalArguments('ExchangeAccount', {
      data: { version: { increment: 1 }, reconciliationEpoch: 1n },
    });
    balance({
      take: 10,
      skip: 2,
      select: { total: true },
      orderBy: { total: 'asc' },
      by: ['asset'],
      _sum: { total: true },
      _count: { total: true },
      having: { total: { _count: { gt: 1 } } },
    });
  });
  it('bounds cyclic object predicates, cyclic monetary arrays and excessive nesting', () => {
    const predicate: Record<string, unknown> = {};
    predicate['AND'] = predicate;
    expect(() => balance({ where: predicate })).toThrow(DecimalInputError);
    const values: unknown[] = [];
    values.push(values);
    expect(() => balance({ where: { total: { in: values } } })).toThrow(DecimalInputError);
    let nested: unknown = '1';
    for (let index = 0; index < 110; index++) nested = { not: nested };
    expect(() => balance({ where: { total: nested } })).toThrow(DecimalInputError);
  });
  it('bounds monetary scalar arrays and bulk payloads by total traversal work', () => {
    expect(() =>
      balance({ where: { total: { in: Array.from({ length: 20_001 }, () => '1') } } }),
    ).toThrow(DecimalInputError);
    expect(() => balance({ data: Array.from({ length: 20_001 }, () => ({ total: '1' })) })).toThrow(
      DecimalInputError,
    );
  });
  it.each(['MissingModel', '__proto__', 'constructor'])(
    'fails closed for unknown model %s',
    (model) => {
      expect(() => validateDecimalArguments(model, { data: { total: 0.3 } })).toThrow(
        DecimalInputError,
      );
    },
  );
});
