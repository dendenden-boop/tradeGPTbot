import { z } from 'zod';
import { decimalCompare, decimalMultiply, isStepAligned, parseDecimal } from './decimal.js';
import { immutable, instrumentSchema, newOrderSchema, tradingRulesSchema } from './domain.js';
import type { Instrument, NewOrder, TradingRules } from './domain.js';
import { failure, success } from './errors.js';
import type { ExchangeErrorCode, Result } from './errors.js';
import { idSchema, marketScopeSchema, timestampSchema } from './scope.js';
import type { MarketScope } from './scope.js';

export interface InstrumentRecord {
  readonly instrument: Instrument;
  readonly rules: TradingRules;
}
export interface InstrumentRegistry {
  get(scope: MarketScope, instrumentId: string, now: number): Result<InstrumentRecord>;
  readCurrent?(
    scope: MarketScope,
    instrumentId: string,
    now: number,
    io: RegistryIo,
  ): Promise<Result<InstrumentRecord>>;
}
export interface WritableInstrumentRegistry extends InstrumentRegistry {
  put(
    record: InstrumentRecord,
    now: number,
    io?: RegistryIo,
  ): Result<InstrumentRecord> | Promise<Result<InstrumentRecord>>;
  putBatch?(
    records: readonly InstrumentRecord[],
    now: number,
    io: RegistryIo,
  ): Promise<Result<readonly InstrumentRecord[]>>;
}
export interface RegistryIo {
  readonly signal: AbortSignal;
  readonly deadline: number;
}
/**
 * Trusted production port, owned by the server composition, never by an adapter.
 * Success means the immutable record and anti-reuse history are durably committed
 * atomically. Recovery must retain history and fail closed until complete. Historical
 * IDs cannot be forgotten to reclaim capacity. See the registry lifecycle contract.
 * Structural typing does not attest persistence; implementers must prove this contract.
 */
export interface RuntimeInstrumentRegistry extends WritableInstrumentRegistry {
  /** A successful result includes durable atomic commitment of anti-reuse history. */
  put(
    record: InstrumentRecord,
    now: number,
    io?: RegistryIo,
  ): Result<InstrumentRecord> | Promise<Result<InstrumentRecord>>;
}
/** Finite process-local fixture: no durable recovery or long-running runtime guarantee. */
export interface ReferenceInstrumentRegistry extends WritableInstrumentRegistry {
  put(input: unknown, now: number): Result<InstrumentRecord>;
  size(): number;
}
export function sameMarketScope(a: MarketScope, b: MarketScope): boolean {
  return (
    a.exchange === b.exchange &&
    a.region === b.region &&
    a.market === b.market &&
    a.environment === b.environment
  );
}
function key(scope: MarketScope, instrumentId: string): string {
  return JSON.stringify([
    scope.exchange,
    scope.region,
    scope.market,
    scope.environment,
    instrumentId,
  ]);
}
export const instrumentRecordSchema = z.strictObject({
  instrument: instrumentSchema,
  rules: tradingRulesSchema,
});
const recordSchema = instrumentRecordSchema;
function guarded<T>(code: ExchangeErrorCode, action: () => Result<T>): Result<T> {
  try {
    return action();
  } catch {
    return failure(code);
  }
}

/** Test/reference registry. Persistence and feed refresh are injected in later phases. */
export function createInstrumentRegistry(options: {
  readonly capacity: number;
  readonly versionCapacity?: number;
}): ReferenceInstrumentRegistry {
  let capacity: number;
  let versionCapacity: number;
  try {
    const parsed = z
      .strictObject({
        capacity: z.number().int().min(1).max(10_000),
        versionCapacity: z.number().int().min(2).max(100_000).optional(),
      })
      .parse(options);
    capacity = parsed.capacity;
    versionCapacity = parsed.versionCapacity ?? Math.min(100_000, Math.max(128, capacity * 64));
  } catch {
    throw new Error('INVALID_REGISTRY_CAPACITY');
  }
  const records = new Map<string, InstrumentRecord>();
  const versions = new Set<string>();
  return Object.freeze({
    put(input: unknown, now: number): Result<InstrumentRecord> {
      return guarded('INVALID_RESPONSE', () => {
        const parsed = recordSchema.safeParse(input);
        if (!parsed.success || !timestampSchema.safeParse(now).success)
          return failure('INVALID_RESPONSE');
        const { instrument, rules } = parsed.data;
        if (!sameMarketScope(instrument.scope, rules.scope) || instrument.id !== rules.instrumentId)
          return failure('SCOPE_MISMATCH');
        if (
          (instrument.scope.market === 'SPOT' && rules.quantityUnit !== 'BASE') ||
          (instrument.scope.market === 'SPOT' && rules.leverageTiers.length > 0)
        )
          return failure('INVALID_RESPONSE');
        if (rules.effectiveAt > now || rules.expiresAt <= now) return failure('STALE_METADATA');
        const recordKey = key(instrument.scope, instrument.id);
        const previous = records.get(recordKey);
        if (!previous && records.size >= capacity) return failure('BUSY');
        const rulesKey = JSON.stringify([recordKey, 'rules', rules.version]);
        const metadataKey = JSON.stringify([recordKey, 'instrument', instrument.metadataVersion]);
        if (
          (versions.has(rulesKey) && previous?.rules.version !== rules.version) ||
          (versions.has(metadataKey) &&
            previous?.instrument.metadataVersion !== instrument.metadataVersion)
        )
          return failure('INVALID_RESPONSE');
        if (
          previous &&
          (rules.effectiveAt < previous.rules.effectiveAt ||
            (rules.version === previous.rules.version &&
              JSON.stringify(rules) !== JSON.stringify(previous.rules)) ||
            (instrument.metadataVersion === previous.instrument.metadataVersion &&
              JSON.stringify(instrument) !== JSON.stringify(previous.instrument)))
        )
          return failure('INVALID_RESPONSE');
        // A symbol has one stable identity inside an exact market/environment scope.
        for (const record of records.values()) {
          if (
            sameMarketScope(record.instrument.scope, instrument.scope) &&
            record.instrument.id !== instrument.id &&
            record.instrument.exchangeSymbol === instrument.exchangeSymbol
          )
            return failure('INVALID_RESPONSE');
        }
        const newVersions = Number(!versions.has(rulesKey)) + Number(!versions.has(metadataKey));
        if (versions.size + newVersions > versionCapacity) return failure('BUSY');
        const result = immutable({ instrument, rules });
        versions.add(rulesKey);
        versions.add(metadataKey);
        records.set(recordKey, result);
        return success(result);
      });
    },
    get(scope: MarketScope, instrumentId: string, now: number): Result<InstrumentRecord> {
      return guarded('INVALID_REQUEST', () => {
        const parsed = marketScopeSchema.safeParse(scope);
        if (
          !parsed.success ||
          !idSchema.safeParse(instrumentId).success ||
          !timestampSchema.safeParse(now).success
        )
          return failure('INVALID_REQUEST');
        const record = records.get(key(parsed.data, instrumentId));
        if (!record) return failure('NOT_FOUND');
        if (
          record.rules.effectiveAt > now ||
          record.rules.expiresAt <= now ||
          (record.instrument.expiryAt !== null && record.instrument.expiryAt <= now) ||
          record.instrument.status !== 'TRADING'
        )
          return failure('STALE_METADATA');
        return success(record);
      });
    },
    size(): number {
      return records.size;
    },
  });
}

/** Validate units and exact filters without silently rounding or converting a command. */
export function validateOrderAgainstRules(
  input: unknown,
  record: InstrumentRecord,
  now: number,
): Result<NewOrder> {
  return guarded('INVALID_REQUEST', () => {
    const order = newOrderSchema.safeParse(input);
    const parsedRecord = recordSchema.safeParse(record);
    if (!order.success || !parsedRecord.success || !timestampSchema.safeParse(now).success)
      return failure('INVALID_REQUEST');
    const { instrument, rules } = parsedRecord.data;
    const v = order.data;
    if (
      !sameMarketScope(instrument.scope, rules.scope) ||
      instrument.id !== rules.instrumentId ||
      v.instrumentId !== instrument.id
    )
      return failure('SCOPE_MISMATCH');
    if (
      v.ruleVersion !== rules.version ||
      rules.effectiveAt > now ||
      rules.expiresAt <= now ||
      instrument.status !== 'TRADING' ||
      (instrument.expiryAt !== null && instrument.expiryAt <= now)
    )
      return failure('STALE_METADATA');
    if (
      !rules.orderTypes.includes(v.type) ||
      (v.timeInForce !== null && !rules.timeInForce.includes(v.timeInForce))
    )
      return failure('UNSUPPORTED');
    if (instrument.scope.market === 'SPOT') {
      if (
        rules.quantityUnit !== 'BASE' ||
        v.size.kind === 'CONTRACTS' ||
        v.reduceOnly ||
        (v.size.kind === 'BASE_QUANTITY' && v.size.asset !== instrument.baseAsset) ||
        (v.size.kind === 'QUOTE_BUDGET' && v.size.asset !== instrument.quoteAsset)
      )
        return failure('INVALID_REQUEST');
    } else if (rules.quantityUnit === 'CONTRACTS') {
      if (
        v.size.kind !== 'CONTRACTS' ||
        v.size.contractSpecVersion !== instrument.contract?.version
      )
        return failure('INVALID_REQUEST');
    } else if (v.size.kind !== 'BASE_QUANTITY' || v.size.asset !== instrument.baseAsset)
      return failure('INVALID_REQUEST');
    try {
      if (v.size.kind !== 'QUOTE_BUDGET') {
        const min =
          v.type === 'MARKET' || v.type === 'STOP_MARKET'
            ? rules.marketMinQuantity
            : rules.minQuantity;
        const max =
          v.type === 'MARKET' || v.type === 'STOP_MARKET'
            ? rules.marketMaxQuantity
            : rules.maxQuantity;
        if (
          !isStepAligned(v.size.value, rules.stepSize) ||
          decimalCompare(v.size.value, min) < 0 ||
          decimalCompare(v.size.value, max) > 0
        )
          return failure('INVALID_REQUEST');
      }
      for (const price of [v.limitPrice, v.trigger?.price ?? null]) {
        if (
          price !== null &&
          (!isStepAligned(price, rules.tickSize) ||
            (rules.minPrice !== null && decimalCompare(price, rules.minPrice) < 0) ||
            (rules.maxPrice !== null && decimalCompare(price, rules.maxPrice) > 0))
        )
          return failure('INVALID_REQUEST');
      }
      // Quote budgets are already quote notional. Contract units require their explicit contract size.
      const notional =
        v.size.kind === 'QUOTE_BUDGET'
          ? v.size.value
          : v.size.kind === 'CONTRACTS' && instrument.contract?.unit === 'QUOTE'
            ? decimalMultiply(v.size.value, instrument.contract.size)
            : v.limitPrice !== null
              ? decimalMultiply(
                  decimalMultiply(
                    v.size.value,
                    v.size.kind === 'CONTRACTS'
                      ? (instrument.contract?.size ?? parseDecimal('1'))
                      : parseDecimal('1'),
                  ),
                  v.limitPrice,
                )
              : null;
      if (
        notional !== null &&
        (decimalCompare(notional, rules.minNotional) < 0 ||
          (rules.maxNotional !== null && decimalCompare(notional, rules.maxNotional) > 0))
      )
        return failure('INVALID_REQUEST');
      // Market-order notional needs a fresh execution/risk valuation; this function makes no estimate.
      return success(immutable(v));
    } catch {
      return failure('INVALID_REQUEST');
    }
  });
}
