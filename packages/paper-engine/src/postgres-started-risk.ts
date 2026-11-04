import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { openPaperAdmissionDatabase } from './admission-database.js';
import {
  executionRiskLookup,
  paperExecutionRiskRequestSchema,
  decodePaperStartedExecutionRiskEvidence,
} from './execution-risk-domain.js';
import { decodePaperStartedExecutionSourceWire } from './postgres-started-source.js';
import type { PaperFundingIo } from './funding-domain.js';

const requestSchema = paperExecutionRiskRequestSchema.extend({
  kind: z.literal('PAPER_STARTED_RISK_CAPTURE'),
  startKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
});
const packet = z.strictObject({
  kind: z.literal('PAPER_STARTED_RISK_CAPTURE'),
  request: requestSchema,
  asOf: timestampSchema,
  started: z.unknown(),
  risk: z.unknown(),
});
export type PaperStartedRiskRequest = z.infer<typeof requestSchema>;
export type PaperStartedRiskSource = ReturnType<typeof decode>;
export interface PaperStartedRiskReader {
  read(request: PaperStartedRiskRequest, io: PaperFundingIo): Promise<PaperStartedRiskSource>;
  close(): Promise<void>;
}
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
function bounded(raw: unknown, request: boolean) {
  const active = new WeakSet<object>();
  let nodes = 0,
    bytes = 0;
  const arrays: Record<string, number> = {
    candidates: 300,
    entries: 300,
    policies: 2,
    policyHeads: 2,
    debits: 1,
    orderTypes: 4,
    timeInForce: 4,
    leverageTiers: 64,
    balances: 3200,
    holds: 1000,
    reservations: 1000,
    orders: 1000,
    accountIds: 100,
    bids: 1000,
    asks: 1000,
  };
  function visit(v: unknown, depth: number, key: string) {
    if (++nodes > (request ? 256 : 400000) || depth > (request ? 16 : 28))
      fail('PAPER_ADMISSION_LIMIT');
    if (typeof v === 'string') {
      if (v.length > (request ? 16384 : 1048576)) fail('PAPER_ADMISSION_LIMIT');
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
          v.length > (arrays[key] ?? 1000) ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          fail();
        for (let n = 0; n < v.length; n++) {
          const d = Object.getOwnPropertyDescriptor(v, String(n));
          if (!d?.enumerable || !('value' in d)) fail();
          visit(d.value, depth + 1, key);
        }
      } else {
        const proto = Object.getPrototypeOf(v) as unknown;
        if (proto !== Object.prototype && proto !== null) fail();
        const keys = Reflect.ownKeys(v);
        if (keys.length > 64) fail();
        for (const key of keys) {
          if (typeof key !== 'string' || key.length > 64) fail();
          const d = Object.getOwnPropertyDescriptor(v, key);
          if (!d?.enumerable || !('value' in d)) fail();
          bytes += Buffer.byteLength(key);
          visit(d.value, depth + 1, key);
        }
      }
      active.delete(v);
    } else fail();
    if (bytes > (request ? 16384 : 16777216)) fail('PAPER_ADMISSION_LIMIT');
  }
  visit(raw, 0, '');
}
const riskRequest = (r: PaperStartedRiskRequest) =>
  executionRiskLookup({
    kind: 'PAPER_EXECUTION_RISK_CAPTURE',
    preparationKey: r.preparationKey,
    admission: r.admission,
    authorization: r.authorization,
  });
function lookup(raw: unknown) {
  try {
    bounded(raw, true);
    const r = requestSchema.parse(raw);
    riskRequest(r);
    return immutable(r);
  } catch {
    fail('PAPER_ADMISSION_INPUT');
  }
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function decode(raw: unknown, request: PaperStartedRiskRequest, now: number) {
  try {
    bounded(raw, false);
    const w = packet.parse(raw);
    if (!same(w.request, request) || w.asOf > now) fail();
    const started = decodePaperStartedExecutionSourceWire(
      w.started,
      { ...request, kind: 'PAPER_STARTED_EXECUTION_CAPTURE' },
      now,
    );
    const risk = decodePaperStartedExecutionRiskEvidence(
      w.risk,
      riskRequest(request),
      now,
      started,
    );
    if (
      risk.asOf < started.asOf ||
      risk.asOf > w.asOf ||
      risk.runtime.asOf < started.context.asOf ||
      !same(risk.runtime.configuration, started.context.configuration) ||
      !same(risk.runtime.current, started.context.current)
    )
      fail();
    const validUntil = Math.min(started.validUntil, risk.validUntil);
    if (now >= validUntil) fail('PAPER_ADMISSION_EXPIRED');
    return immutable({
      kind: 'PAPER_STARTED_RISK_SOURCE' as const,
      request,
      asOf: w.asOf,
      validUntil,
      hash: createHash('sha256').update(canonical(w)).digest('hex'),
      started,
      risk,
    });
  } catch (e) {
    if (e instanceof Error && /^PAPER_ADMISSION_(LIMIT|EXPIRED)$/u.test(e.message)) throw e;
    fail();
  }
}
/** Current read/re-evaluation only. No grant, permit, reservation or financial
 * effect is created. The future fixed writer must revalidate atomically. */
export async function createPostgresPaperStartedRiskSource(
  options: unknown,
): Promise<PaperStartedRiskReader> {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async read(raw: PaperStartedRiskRequest, io: PaperFundingIo) {
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
