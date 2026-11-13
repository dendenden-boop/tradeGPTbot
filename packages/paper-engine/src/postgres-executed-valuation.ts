import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  decimalSubtract,
  immutable,
  parseDecimal,
  positiveDecimalSchema,
  sameMarketScope,
  timestampSchema,
} from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { marketSnapshotPublicationSchema } from '@ctp/market-data';
import { openPaperAdmissionDatabase } from './admission-database.js';
import {
  lookupPaperExecutionCommitRequest,
  decodePaperCommittedExecutionContents,
  projectPaperExecutedBookSource,
} from './postgres-execution-commit.js';
import type { PaperExecutionCommitRequest } from './postgres-execution-commit.js';
import type { PaperFundingIo } from './funding-domain.js';

export type PaperExecutedValuationRequest = Omit<PaperExecutionCommitRequest, 'kind'> & {
  kind: 'PAPER_EXECUTED_VALUATION_CAPTURE';
};
const counter = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const wire = z.strictObject({
  kind: z.literal('PAPER_EXECUTED_VALUATION_CAPTURE'),
  request: z.unknown(),
  asOf: timestampSchema,
  execution: z.unknown(),
  markets: z
    .array(
      z.strictObject({
        id: z.uuid(),
        revision: counter,
        hash: z.string().regex(/^[a-f0-9]{64}$/u),
        publicationText: z.string().min(1).max(1048576),
      }),
    )
    .max(64),
});
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const sub = (a: string, b: string) => decimalSubtract(parseDecimal(a), parseDecimal(b));
const mul = (a: string, b: string) => decimalMultiply(parseDecimal(a), parseDecimal(b));
const cmp = (a: string, b: string) => decimalCompare(parseDecimal(a), parseDecimal(b));

// Bound the complete RPC packet before Zod, hashing or historical decoding.
// Descriptors are inspected without executing getters or accepting prototypes.
function bounded(raw: unknown) {
  let nodes = 0,
    bytes = 0;
  const active = new WeakSet<object>();
  function visit(v: unknown, depth: number, name: string) {
    if (++nodes > 400000 || depth > 40) fail('PAPER_ADMISSION_LIMIT');
    if (typeof v === 'string') {
      if (v.length > 1048576) fail('PAPER_ADMISSION_LIMIT');
      bytes += Buffer.byteLength(v);
    } else if (v === null || typeof v === 'boolean') return;
    else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) fail();
    } else if (typeof v === 'object') {
      if (active.has(v)) fail();
      active.add(v);
      const keys = Reflect.ownKeys(v);
      if (Array.isArray(v)) {
        if (v.length > (name === 'markets' ? 64 : 3200) || keys.length !== v.length + 1)
          fail('PAPER_ADMISSION_LIMIT');
        for (let n = 0; n < v.length; n++) {
          const d = Object.getOwnPropertyDescriptor(v, String(n));
          if (!d?.enumerable || !('value' in d)) fail();
          visit(d.value, depth + 1, name);
        }
      } else {
        const proto = Object.getPrototypeOf(v) as unknown;
        if ((proto !== Object.prototype && proto !== null) || keys.length > 64) fail();
        for (const key of keys) {
          if (typeof key !== 'string' || key.length > 128) fail();
          const d = Object.getOwnPropertyDescriptor(v, key);
          if (!d?.enumerable || !('value' in d)) fail();
          bytes += Buffer.byteLength(key);
          visit(d.value, depth + 1, key);
        }
      }
      active.delete(v);
    } else fail();
    if (bytes > 16777216) fail('PAPER_ADMISSION_LIMIT');
  }
  visit(raw, 0, '');
}
function decode(raw: unknown, request: PaperExecutionCommitRequest, now: number) {
  try {
    bounded(raw);
    const w = wire.parse(raw);
    const selection = { ...request, kind: 'PAPER_EXECUTED_VALUATION_CAPTURE' as const };
    if (canonical(w.request) !== canonical(selection)) fail();
    const decoded = decodePaperCommittedExecutionContents(w.execution, request),
      cfg = decoded.source.started.context.configuration.configuration,
      age = Math.min(5000, cfg.model.maxEvidenceAgeMs),
      book = projectPaperExecutedBookSource(request, decoded, w.asOf),
      state = book.content.portfolio,
      original = decoded.source.started.source.market;
    if (w.asOf < decoded.evaluatedAt || w.asOf > now) fail();
    if (now - w.asOf > age) fail('PAPER_ADMISSION_EXPIRED');
    if (
      cfg.source.market !== 'SPOT' ||
      state.binding.mode !== 'PAPER' ||
      state.binding.connectionId !== null ||
      !sameMarketScope(cfg.source, state.binding.scope) ||
      state.positions.length > 1 ||
      state.balances.length > 64
    )
      fail();
    let validUntil = w.asOf + age + 1;
    const markets = w.markets.map((m) => {
      if (createHash('sha256').update(m.publicationText).digest('hex') !== m.hash) fail();
      const p = marketSnapshotPublicationSchema.parse(JSON.parse(m.publicationText));
      if (
        p.kind !== 'SNAPSHOT' ||
        p.id !== m.id ||
        p.key.scope.market !== 'SPOT' ||
        !sameMarketScope(p.key.scope, cfg.source) ||
        p.record.instrument.quoteAsset !== cfg.valuationAsset ||
        p.ticker.last.state !== 'AVAILABLE' ||
        BigInt(p.expectedRevision) >= BigInt(m.revision) ||
        p.record.rules.effectiveAt > now ||
        p.record.rules.expiresAt <= now
      )
        fail();
      const price = positiveDecimalSchema.parse(p.ticker.last.value);
      const times = [
        p.timestamp,
        p.ticker.receivedAt,
        p.ticker.exchangeTime,
        p.book.receivedAt,
        p.book.exchangeTime,
      ].filter((t): t is number => t !== null);
      if (times.some((t) => t > now || now - t > age)) fail('PAPER_ADMISSION_EXPIRED');
      const at = Math.min(...times);
      validUntil = Math.min(validUntil, at + age + 1, p.record.rules.expiresAt);
      if (
        p.record.instrument.baseAsset === original.record.instrument.baseAsset &&
        (p.key.dbInstrumentId !== original.dbInstrumentId ||
          p.key.instrumentId !== original.record.instrument.id)
      )
        fail();
      return { m, p, price, at };
    });
    if (
      new Set(markets.map((m) => m.m.id)).size !== markets.length ||
      new Set(markets.map((m) => m.p.record.instrument.baseAsset)).size !== markets.length
    )
      fail();
    const used = new Set<string>();
    const price = (asset: string) => {
      if (asset === cfg.valuationAsset) return '1';
      const m = markets.find((m) => m.p.record.instrument.baseAsset === asset);
      if (!m) fail();
      used.add(m.m.id);
      return m.price;
    };
    let equity = '0';
    const balances = state.balances.map((b) => {
      if (cmp(b.total, '0') < 0) fail();
      const value = mul(b.total, price(b.asset));
      equity = add(equity, value);
      return { ...b, value };
    });
    const positions = state.positions.map((p) => {
      if (
        p.instrumentId !== original.record.instrument.id ||
        p.bucket !== 'SPOT' ||
        p.positionSide !== 'NET' ||
        p.quote !== cfg.valuationAsset ||
        p.base !== original.record.instrument.baseAsset ||
        cmp(p.quantity, '0') < 0 ||
        p.basis === null ||
        p.realizedGross === null ||
        p.feesQuote === null
      )
        fail();
      const balance = balances.find((b) => b.asset === p.base);
      if (!balance || cmp(balance.total, p.quantity) < 0) fail();
      return {
        ...p,
        unrealizedGross: sub(mul(p.quantity, price(p.base)), p.basis),
        netRealized: add(sub(p.realizedGross, p.feesQuote), p.fundingQuote),
        pnlAsset: p.quote,
      };
    });
    if (used.size !== markets.length) fail();
    const references = markets
      .map(({ m, p, at }) => ({
        id: m.id,
        revision: m.revision,
        hash: m.hash,
        dbInstrumentId: p.key.dbInstrumentId,
        dbRuleId: p.key.dbRuleId,
        asOf: at,
        expiresAt: p.record.rules.expiresAt,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const valuation = { quote: cfg.valuationAsset, equity, balances, positions };
    if (validUntil <= now) fail('PAPER_ADMISSION_EXPIRED');
    return immutable({
      kind: 'PAPER_EXECUTED_VALUATION_SOURCE' as const,
      asOf: w.asOf,
      validUntil,
      book,
      valuation,
      markets: references,
      hash: hash({ bookHash: book.hash, valuation, markets: references }),
    });
  } catch (error) {
    if (error instanceof Error && /^PAPER_ADMISSION_(EXPIRED|LIMIT)$/u.test(error.message))
      throw error;
    fail();
  }
}
export type PaperExecutedValuationSource = ReturnType<typeof decode>;
// Internal content validation only; absent from every package entrypoint.
export { decode as decodePaperExecutedValuationContents };
export interface PaperExecutedValuationReader {
  read(
    request: PaperExecutedValuationRequest,
    io: PaperFundingIo,
  ): Promise<
    Readonly<{ kind: 'MISSING' } | { kind: 'CAPTURED'; source: PaperExecutedValuationSource }>
  >;
  close(): Promise<void>;
}

/** Server-owned coherent readonly book/price capture. Historical timestamps are
 * preserved. This is not complete tenant inventory, Risk authority or permission
 * to execute another order. No financial write or automatic retry is exposed. */
export async function createPostgresPaperExecutedValuationSource(
  options: unknown,
): Promise<PaperExecutedValuationReader> {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async read(raw: PaperExecutedValuationRequest, io: PaperFundingIo) {
      const request = lookupPaperExecutionCommitRequest(raw, 'PAPER_EXECUTED_VALUATION_CAPTURE');
      const selection = { ...request, kind: 'PAPER_EXECUTED_VALUATION_CAPTURE' as const };
      const result = await database.transaction(
        request.admission.binding.tenantId,
        io,
        async (sql) => {
          const rows = await sql.query<{ result: unknown }>(
            'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
            [canonical(selection)],
          );
          if (rows.rows.length !== 1) fail();
          const raw = rows.rows[0]!.result;
          bounded(raw);
          const missing = z
            .strictObject({ kind: z.literal('MISSING'), request: z.unknown() })
            .safeParse(raw);
          if (missing.success) {
            if (canonical(missing.data.request) !== canonical(selection)) fail();
            return immutable({ kind: 'MISSING' as const });
          }
          return immutable({ kind: 'CAPTURED' as const, source: decode(raw, request, Date.now()) });
        },
      );
      if (io.signal.aborted || Date.now() >= io.deadline) fail('PAPER_ADMISSION_ABORTED');
      if (result.kind === 'CAPTURED' && Date.now() >= result.source.validUntil)
        fail('PAPER_ADMISSION_EXPIRED');
      return result;
    },
    close: database.close,
  });
}
