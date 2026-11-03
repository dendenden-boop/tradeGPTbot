import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, sameMarketScope, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { openPaperAdmissionDatabase } from './admission-database.js';
import { executionRiskLookup, paperExecutionRiskRequestSchema } from './execution-risk-domain.js';
import { preparePaperExecutionAttempt } from './execution-attempt.js';
import { decodePaperExecutionSource } from './postgres-execution-source.js';
import { decodePaperExecutionStartRead } from './postgres-execution-start.js';
import { decodePaperRuntimeContext } from './runtime-domain.js';
import type { PaperFundingIo } from './funding-domain.js';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const requestSchema = paperExecutionRiskRequestSchema.extend({
  kind: z.literal('PAPER_STARTED_EXECUTION_CAPTURE'),
  startKey: key,
});
const entryBase = {
  intentId: z.uuid().transform((v) => v.toLowerCase()),
  key,
  preparation: z.unknown(),
};
const packet = z.strictObject({
  kind: z.literal('PAPER_STARTED_EXECUTION_CAPTURE'),
  request: requestSchema,
  asOf: timestampSchema,
  validUntil: timestampSchema,
  capture: z.unknown(),
  journal: z.unknown(),
  context: z.unknown(),
  entries: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ ...entryBase, kind: z.literal('STARTED'), state: z.unknown() }),
        z.strictObject({ ...entryBase, kind: z.literal('PREPARED') }),
      ]),
    )
    .min(1)
    .max(300),
});
export type PaperStartedExecutionSourceRequest = z.infer<typeof requestSchema>;
export type PaperStartedExecutionSource = ReturnType<typeof decode>;
export interface PaperStartedExecutionSourceReader {
  read(
    request: PaperStartedExecutionSourceRequest,
    io: PaperFundingIo,
  ): Promise<PaperStartedExecutionSource>;
  close(): Promise<void>;
}
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function bounded(raw: unknown, request: boolean) {
  const active = new WeakSet<object>();
  let nodes = 0,
    bytes = 0;
  const arrays: Record<string, number> = {
    candidates: 300,
    entries: 300,
    debits: 1,
    policyHeads: 2,
    orderTypes: 4,
    timeInForce: 4,
    leverageTiers: 64,
    asks: 1000,
    bids: 1000,
  };
  function visit(v: unknown, depth: number, name: string) {
    if (++nodes > (request ? 256 : 400000) || depth > (request ? 16 : 24)) fail();
    if (typeof v === 'string') {
      if (v.length > (request ? 16384 : 4194304)) fail();
      bytes += Buffer.byteLength(v);
    } else if (v === null || typeof v === 'boolean') return;
    else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) fail();
    } else if (typeof v === 'object') {
      if (active.has(v)) fail();
      active.add(v);
      if (Array.isArray(v)) {
        if (
          request ||
          !Object.hasOwn(arrays, name) ||
          v.length > arrays[name]! ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          fail();
        for (let n = 0; n < v.length; n++) {
          const d = Object.getOwnPropertyDescriptor(v, String(n));
          if (!d?.enumerable || !('value' in d)) fail();
          visit(d.value, depth + 1, '');
        }
      } else {
        const prototype = Object.getPrototypeOf(v) as unknown;
        if (prototype !== Object.prototype && prototype !== null) fail();
        const keys = Reflect.ownKeys(v);
        if (keys.length > 64) fail();
        for (const k of keys) {
          if (typeof k !== 'string' || k.length > 64) fail();
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d?.enumerable || !('value' in d)) fail();
          bytes += Buffer.byteLength(k);
          visit(d.value, depth + 1, k);
        }
      }
      active.delete(v);
    } else fail();
    if (bytes > (request ? 16384 : 16777216)) fail();
  }
  visit(raw, 0, '');
}
function lookup(raw: unknown): PaperStartedExecutionSourceRequest {
  try {
    bounded(raw, true);
    const r = requestSchema.parse(raw);
    executionRiskLookup({
      kind: 'PAPER_EXECUTION_RISK_CAPTURE',
      preparationKey: r.preparationKey,
      admission: r.admission,
      authorization: r.authorization,
    });
    return immutable(r);
  } catch {
    fail('PAPER_ADMISSION_INPUT');
  }
}
function decode(raw: unknown, request: PaperStartedExecutionSourceRequest, now: number) {
  try {
    bounded(raw, false);
    const w = packet.parse(raw);
    if (!same(w.request, request) || w.asOf > now) fail();
    const journal = decodePaperExecutionStartRead(w.journal, {
      ...request,
      kind: 'PAPER_EXECUTION_START',
    });
    if (
      journal.kind !== 'COMMITTED' ||
      journal.state.phase !== 'STARTED' ||
      journal.unknown !== null
    )
      fail();
    const captureRequest = {
      kind: 'PAPER_EXECUTION_CAPTURE' as const,
      admission: request.admission,
      authorization: request.authorization,
    };
    const source = decodePaperExecutionSource(w.capture, captureRequest, now);
    const binding = request.admission.binding;
    const context = decodePaperRuntimeContext(
      w.context,
      { tenantId: binding.tenantId, accountId: binding.accountId, mode: 'PAPER' },
      now,
    );
    const configuration = context.configuration.configuration;
    const atStart = journal.receipt.validation.book;
    if (
      source.asOf < journal.receipt.startedAt ||
      source.asOf > w.asOf ||
      context.asOf < source.asOf ||
      context.asOf > w.asOf ||
      source.configurationId !== configuration.id ||
      !same(source.model, configuration.model) ||
      !sameMarketScope(configuration.source, binding.profile) ||
      context.current.permissionEpoch !== request.authorization.permissionEpoch ||
      context.current.userSessionEpoch !== request.authorization.userSessionEpoch ||
      context.current.externalAccountId !== binding.externalAccountId ||
      source.book.bookId !== atStart.id ||
      BigInt(source.book.revision) < BigInt(atStart.revision) ||
      (source.book.revision === atStart.revision && source.book.hash !== atStart.hash) ||
      source.candidates[0]?.intentId !== request.admission.intentId ||
      w.entries.length !== source.candidates.length
    )
      fail();
    const entries = w.entries.map((entry, index) => {
      const c = source.candidates[index]!;
      const content = z.object({ request: z.unknown() }).parse(entry.preparation);
      const preparation = preparePaperExecutionAttempt(content.request);
      if (
        !same(preparation, entry.preparation) ||
        entry.intentId !== c.intentId ||
        preparation.request.preparedAt > source.asOf ||
        !same(preparation.request.admission, {
          binding,
          orderId: c.orderId,
          intentId: c.intentId,
          decisionId: c.decisionId,
          reservationId: c.reservationId,
          dbInstrumentId: c.dbInstrumentId,
          dbRuleId: c.dbRuleId,
          command: c.command,
          commandHash: c.commandHash,
          admissionSequence: c.admissionSequence,
          admittedAt: c.admittedAt,
          expiresAt: c.original.expiresAt,
        })
      )
        fail();
      if (index === 0) {
        if (
          entry.kind !== 'STARTED' ||
          entry.key !== request.preparationKey ||
          !same(preparation, journal.preparation) ||
          !same(entry.state, journal.state)
        )
          fail();
        return immutable({ ...entry, preparation, state: journal.state });
      }
      if (entry.kind !== 'PREPARED') fail();
      return immutable({ ...entry, preparation });
    });
    const validUntil = Math.min(
      source.validUntil,
      context.validUntil,
      ...source.candidates.map((c) => c.original.expiresAt),
    );
    if (w.validUntil !== validUntil) fail();
    if (now >= validUntil) fail('PAPER_ADMISSION_EXPIRED');
    return immutable({
      kind: 'PAPER_STARTED_EXECUTION_SOURCE' as const,
      request,
      asOf: w.asOf,
      validUntil,
      hash: createHash('sha256').update(canonical(w)).digest('hex'),
      journal,
      source,
      context,
      entries,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'PAPER_ADMISSION_EXPIRED') throw error;
    fail();
  }
}
/** Coherent server-owned data for one known START, not current Risk approval or
 * a financial permit. The fixed writer must repeat current authority/history
 * validation atomically with one-use allocation and monetary effects. */
export async function createPostgresPaperStartedExecutionSource(
  options: unknown,
): Promise<PaperStartedExecutionSourceReader> {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async read(raw: PaperStartedExecutionSourceRequest, io: PaperFundingIo) {
      const expected = lookup(raw);
      const result = await database.transaction(
        expected.admission.binding.tenantId,
        io,
        async (sql) => {
          const rows = await sql.query<{ result: unknown }>(
            'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
            [canonical(expected)],
          );
          if (rows.rows.length !== 1) fail();
          return decode(rows.rows[0]!.result, expected, Date.now());
        },
      );
      if (io.signal.aborted || Date.now() >= io.deadline) fail('PAPER_ADMISSION_ABORTED');
      if (Date.now() >= result.validUntil) fail('PAPER_ADMISSION_EXPIRED');
      return result;
    },
    close: database.close,
  });
}
