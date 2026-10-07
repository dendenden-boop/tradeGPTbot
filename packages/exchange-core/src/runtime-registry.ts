import { performance } from 'node:perf_hooks';
import { immutable } from './domain.js';
import { failure, success, type Result } from './errors.js';
import { idSchema, marketScopeSchema, timestampSchema, type MarketScope } from './scope.js';
import {
  instrumentRecordSchema,
  sameMarketScope,
  type InstrumentRecord,
  type RegistryIo,
  type RuntimeInstrumentRegistry,
} from './registry.js';

export interface RegistryReceipt {
  readonly revision: string;
  readonly record: InstrumentRecord;
}
/** Each store call is bounded physical I/O. publish returns only after known COMMIT.
 * read returns one transaction's current rows; it never recovers historic rows into memory.
 * PostgreSQL owns immutable permanent history and serializes competing publications. */
export interface DurableInstrumentStore {
  read(ids: readonly string[], io: RegistryIo): Promise<readonly RegistryReceipt[]>;
  publish(
    records: readonly InstrumentRecord[],
    io: RegistryIo,
  ): Promise<readonly RegistryReceipt[]>;
  close(): Promise<void>;
}
const runtimeOwners = new WeakSet<object>();
export function isRuntimeInstrumentRegistry(value: unknown): value is RuntimeInstrumentRegistry {
  return typeof value === 'object' && value !== null && runtimeOwners.has(value);
}

/** Explicit server composition. get is a bounded-age observational projection;
 * readCurrent is the authoritative durable read. Financial authorization must use
 * current rows in its own transaction, never treat this projection as a certificate. */
export async function createRuntimeInstrumentRegistry(options: {
  scope: MarketScope;
  instrumentIds: readonly string[];
  store: DurableInstrumentStore;
}) {
  const scope = marketScopeSchema.parse(options.scope);
  const ids = [...options.instrumentIds].map((id) => idSchema.parse(id)).sort();
  if (!ids.length || ids.length > 300 || new Set(ids).size !== ids.length)
    throw new Error('REGISTRY_SCOPE');
  const allowed = new Set(ids),
    cache = new Map<string, RegistryReceipt>();
  let closed = false,
    ready = false,
    recovering = false,
    freshUntil = 0;
  const controller = new AbortController();
  const context = (): RegistryIo => ({ signal: controller.signal, deadline: Date.now() + 1000 });
  function decode(receipts: readonly RegistryReceipt[]): Map<string, RegistryReceipt> {
    if (receipts.length > ids.length) throw new Error('REGISTRY_CAPACITY');
    const decoded = new Map<string, RegistryReceipt>();
    for (const value of receipts) {
      const record = immutable(instrumentRecordSchema.parse(value.record)),
        id = record.instrument.id;
      if (
        !/^[1-9][0-9]{0,18}$/.test(value.revision) ||
        BigInt(value.revision) > 9223372036854775807n ||
        !allowed.has(id) ||
        decoded.has(id) ||
        !sameMarketScope(scope, record.instrument.scope) ||
        !sameMarketScope(scope, record.rules.scope) ||
        record.rules.instrumentId !== id ||
        (scope.market === 'SPOT' &&
          (record.rules.quantityUnit !== 'BASE' || record.rules.leverageTiers.length !== 0))
      )
        throw new Error('REGISTRY_CORRUPT');
      decoded.set(id, immutable({ revision: value.revision, record }));
    }
    return decoded;
  }
  function apply(receipts: readonly RegistryReceipt[]) {
    const next = decode(receipts);
    if (closed) throw new Error('REGISTRY_CLOSED');
    for (const [id, value] of next) {
      const previous = cache.get(id);
      if (previous && BigInt(previous.revision) > BigInt(value.revision)) continue;
      if (
        previous &&
        previous.revision === value.revision &&
        JSON.stringify(previous.record) !== JSON.stringify(value.record)
      )
        throw new Error('REGISTRY_CORRUPT');
      cache.set(id, value);
    }
  }
  async function recover() {
    if (closed || recovering) return;
    recovering = true;
    const started = performance.now();
    const existing = [...cache.keys()];
    try {
      const rows = await options.store.read(ids, context());
      if (closed || controller.signal.aborted || performance.now() - started >= 1000)
        throw new Error('REGISTRY_ABORTED');
      const present = new Set(rows.map((row) => row.record.instrument.id));
      if (existing.some((id) => !present.has(id))) throw new Error('REGISTRY_INCOMPLETE');
      apply(rows);
      // Age is measured from read start, never rejuvenated by a delayed response.
      freshUntil = started + 1000;
      ready = true;
    } catch {
      ready = false;
    } finally {
      recovering = false;
    }
  }
  await recover();
  if (!ready) {
    closed = true;
    controller.abort();
    await options.store.close();
    throw new Error('REGISTRY_RECOVERY_FAILED');
  }
  const timer = setInterval(() => {
    void recover();
  }, 250);
  timer.unref();
  const validScope = (s: MarketScope, id: string) =>
    marketScopeSchema.safeParse(s).success && sameMarketScope(scope, s) && allowed.has(id);
  function get(s: MarketScope, id: string, time: number): Result<InstrumentRecord> {
    if (closed) return failure('CLOSED');
    if (!validScope(s, id) || !timestampSchema.safeParse(time).success)
      return failure('SCOPE_MISMATCH');
    if (!ready || performance.now() >= freshUntil) return failure('UNAVAILABLE');
    const value = cache.get(id)?.record;
    if (!value) return failure('NOT_FOUND');
    if (
      value.rules.effectiveAt > time ||
      value.rules.expiresAt <= time ||
      value.instrument.status !== 'TRADING' ||
      (value.instrument.expiryAt !== null && value.instrument.expiryAt <= time)
    )
      return failure('STALE_METADATA');
    return success(value);
  }
  async function publish(
    input: readonly InstrumentRecord[],
    time: number,
    io: RegistryIo,
  ): Promise<Result<readonly InstrumentRecord[]>> {
    if (closed) return failure('CLOSED');
    if (io.signal.aborted || io.deadline <= Date.now()) return failure('ABORTED');
    try {
      if (!timestampSchema.safeParse(time).success || !input.length || input.length > ids.length)
        return failure('INVALID_REQUEST');
      const records = input.map((v) => immutable(instrumentRecordSchema.parse(v)));
      if (
        new Set(records.map((v) => v.instrument.id)).size !== records.length ||
        records.some(
          (v) =>
            !validScope(v.instrument.scope, v.instrument.id) ||
            !sameMarketScope(v.rules.scope, scope) ||
            v.rules.instrumentId !== v.instrument.id ||
            v.rules.effectiveAt > time ||
            v.rules.expiresAt <= time,
        )
      )
        return failure('INVALID_RESPONSE');
      const committed = await options.store.publish(records, io);
      if (closed || io.signal.aborted || io.deadline <= Date.now()) {
        ready = false;
        return failure('UNAVAILABLE');
      }
      const decoded = decode(committed);
      if (
        decoded.size !== records.length ||
        records.some(
          (v) => JSON.stringify(decoded.get(v.instrument.id)?.record) !== JSON.stringify(v),
        )
      )
        throw new Error('REGISTRY_CORRUPT');
      apply(committed);
      return success(immutable(records));
    } catch {
      ready = false;
      return failure('INVALID_RESPONSE');
    }
  }
  const registry = Object.freeze({
    get,
    async readCurrent(
      s: MarketScope,
      id: string,
      time: number,
      io: RegistryIo,
    ): Promise<Result<InstrumentRecord>> {
      if (closed) return failure('CLOSED');
      if (!validScope(s, id) || !timestampSchema.safeParse(time).success)
        return failure('SCOPE_MISMATCH');
      try {
        const rows = await options.store.read([id], io);
        if (closed || io.signal.aborted || io.deadline <= Date.now()) return failure('ABORTED');
        const current = decode(rows).get(id)?.record;
        if (!current) {
          if (cache.has(id)) ready = false;
          return failure('NOT_FOUND');
        }
        apply(rows);
        if (
          current.rules.effectiveAt > time ||
          current.rules.expiresAt <= time ||
          current.instrument.status !== 'TRADING' ||
          (current.instrument.expiryAt !== null && current.instrument.expiryAt <= time)
        )
          return failure('STALE_METADATA');
        return success(current);
      } catch {
        ready = false;
        return failure('UNAVAILABLE');
      }
    },
    put: async (
      record: InstrumentRecord,
      time: number,
      io: RegistryIo = context(),
    ): Promise<Result<InstrumentRecord>> => {
      const result = await publish([record], time, io);
      return result.ok ? success(result.value[0]!) : result;
    },
    putBatch: publish,
    async close() {
      if (closed) return;
      closed = true;
      ready = false;
      clearInterval(timer);
      controller.abort();
      cache.clear();
      await options.store.close();
    },
    health: () => ({
      ready: !closed && ready && performance.now() < freshUntil,
      retained: cache.size,
      capacity: ids.length,
    }),
  });
  runtimeOwners.add(registry);
  return registry;
}
