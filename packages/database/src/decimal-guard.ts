import { Prisma } from './generated/client.js';
import { decimalMetadata } from './generated/decimal-metadata.js';
import { decimalText, type DecimalKind } from './decimal.js';

type Field =
  | { readonly kind: 'decimal'; readonly category: DecimalKind }
  | { readonly kind: 'relation'; readonly model: string }
  | { readonly kind: 'other' };
const models: Readonly<Record<string, Readonly<Record<string, Field>>>> = decimalMetadata;

export class DecimalInputError extends Error {
  constructor() {
    super('Invalid database decimal input');
    this.name = 'DecimalInputError';
  }
}

/** Schema-aware validation of Prisma model arguments, including nested operations.
 * JSON/scalar fields, integer counters and selection flags are deliberately opaque.
 * Raw SQL is a separate trusted escape hatch and has no model metadata to validate.
 */
export function validateDecimalArguments(model: string, args: unknown): void {
  let remaining = 20_000;
  function consume(depth: number): void {
    if (--remaining < 0 || depth > 100) throw new DecimalInputError();
  }
  function object(value: unknown, depth: number): Record<string, unknown> | undefined {
    consume(depth);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }
  function each(value: unknown, visit: (item: unknown) => void): void {
    if (Array.isArray(value)) for (const item of value) visit(item);
    else visit(value);
  }
  function money(value: unknown, category: DecimalKind, filter: boolean, depth: number): void {
    // Account for scalar and array nodes too: cyclic arrays and large `in` filters
    // must have the same finite traversal budget as object predicates.
    consume(depth);
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      try {
        decimalText(value, category);
      } catch {
        throw new DecimalInputError();
      }
      return;
    }
    if (value instanceof Prisma.Decimal) {
      // Check exponent/scale before toFixed, so an exponent cannot allocate an unbounded string.
      if (!value.isFinite() || value.e > 29 || value.decimalPlaces() > 18)
        throw new DecimalInputError();
      try {
        decimalText(value.toFixed(), category);
      } catch {
        throw new DecimalInputError();
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) money(entry, category, filter, depth + 1);
      return;
    }
    const input = object(value, depth);
    if (!input) throw new DecimalInputError();
    const allowed = filter
      ? new Set([
          'equals',
          'in',
          'notIn',
          'lt',
          'lte',
          'gt',
          'gte',
          'not',
          '_min',
          '_max',
          '_avg',
          '_sum',
        ])
      : new Set(['set', 'increment', 'decrement', 'multiply', 'divide']);
    for (const [key, entry] of Object.entries(input)) {
      if (filter && key === '_count') continue; // Count is an integer, not a monetary aggregate.
      if (!allowed.has(key)) throw new DecimalInputError();
      money(entry, category, filter, depth + 1);
    }
  }
  function fields(modelName: string): Readonly<Record<string, Field>> {
    if (!Object.hasOwn(models, modelName)) throw new DecimalInputError();
    const result = models[modelName];
    if (!result) throw new DecimalInputError();
    return result;
  }
  function modelInput(modelName: string, value: unknown, filter: boolean, depth: number): void {
    each(value, (item) => {
      const input = object(item, depth);
      if (!input) return;
      const metadata = fields(modelName);
      for (const [key, entry] of Object.entries(input)) {
        const field = Object.hasOwn(metadata, key) ? metadata[key] : undefined;
        if (field?.kind === 'decimal') money(entry, field.category, filter, depth + 1);
        else if (field?.kind === 'relation') {
          if (filter) relationFilter(field.model, entry, depth + 1);
          else relationWrite(field.model, entry, depth + 1);
        } else if (!field) {
          // Boolean predicates and compound unique selectors retain the current model.
          modelInput(modelName, entry, filter, depth + 1);
        }
      }
    });
  }
  function relationFilter(modelName: string, value: unknown, depth: number): void {
    const input = object(value, depth);
    if (!input) return;
    for (const [key, entry] of Object.entries(input)) {
      if (['some', 'every', 'none', 'is', 'isNot'].includes(key))
        modelInput(modelName, entry, true, depth + 1);
      else modelInput(modelName, { [key]: entry }, true, depth + 1);
    }
  }
  function relationWrite(modelName: string, value: unknown, depth: number): void {
    const input = object(value, depth);
    if (!input) return;
    for (const [operation, entry] of Object.entries(input)) {
      if (['connect', 'set', 'disconnect', 'delete', 'deleteMany'].includes(operation)) {
        modelInput(modelName, entry, true, depth + 1);
      } else if (operation === 'create') modelInput(modelName, entry, false, depth + 1);
      else if (operation === 'createMany') argumentsInput(modelName, entry, depth + 1);
      else if (['update', 'updateMany', 'upsert', 'connectOrCreate'].includes(operation)) {
        each(entry, (item) => {
          const update = object(item, depth + 1);
          if (
            update &&
            ['data', 'where', 'create', 'update'].some((key) => Object.hasOwn(update, key))
          ) {
            argumentsInput(modelName, update, depth + 2);
          } else modelInput(modelName, item, false, depth + 2);
        });
      }
    }
  }
  function selection(modelName: string, value: unknown, depth: number): void {
    const input = object(value, depth);
    if (!input) return;
    const metadata = fields(modelName);
    for (const [key, entry] of Object.entries(input)) {
      const field = Object.hasOwn(metadata, key) ? metadata[key] : undefined;
      if (field?.kind === 'relation') argumentsInput(field.model, entry, depth + 1);
      else if (key === '_count') {
        const count = object(entry, depth + 1);
        if (count) selection(modelName, count['select'], depth + 2);
      }
    }
  }
  function argumentsInput(modelName: string, value: unknown, depth: number): void {
    const input = object(value, depth);
    if (!input) return;
    for (const [key, entry] of Object.entries(input)) {
      if (['where', 'cursor', 'having'].includes(key))
        modelInput(modelName, entry, true, depth + 1);
      else if (['data', 'create', 'update'].includes(key))
        modelInput(modelName, entry, false, depth + 1);
      else if (['select', 'include'].includes(key)) selection(modelName, entry, depth + 1);
    }
  }
  fields(model);
  argumentsInput(model, args, 0);
}
