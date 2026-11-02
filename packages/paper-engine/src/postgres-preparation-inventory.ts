import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { riskSnapshotKeySchema } from '@ctp/risk-engine';
import { openPaperAdmissionDatabase } from './admission-database.js';
import { preparePaperExecutionAttempt } from './execution-attempt.js';
import { decodePaperExecutionSource } from './postgres-execution-source.js';
import type { PaperFundingIo } from './funding-domain.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const epoch = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const requestSchema = z.strictObject({
  kind: z.literal('PAPER_PREPARATION_INVENTORY_CAPTURE'),
  admission: z.strictObject({
    binding: riskSnapshotKeySchema.shape.binding,
    orderId: uuid,
    intentId: uuid,
    operation: z.literal('PLACE'),
    commandHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  authorization: z.strictObject({
    permissionEpoch: epoch,
    userSessionEpoch: epoch.refine((v) => BigInt(v) <= 2147483647n),
  }),
});
const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('MISSING'), intentId: uuid }),
  z.strictObject({ kind: z.literal('PREPARED'), intentId: uuid, key, preparation: z.unknown() }),
]);
const packetSchema = z.strictObject({
  kind: z.literal('PAPER_PREPARATION_INVENTORY_CAPTURE'),
  request: requestSchema,
  asOf: timestampSchema,
  capture: z.unknown(),
  entries: z.array(entrySchema).min(1).max(300),
});
export type PaperPreparationInventoryRequest = z.infer<typeof requestSchema>;
export type PaperPreparationInventorySource = ReturnType<typeof decodeInventory>;
export interface PaperPreparationInventoryReader {
  read(
    request: PaperPreparationInventoryRequest,
    io: PaperFundingIo,
  ): Promise<PaperPreparationInventorySource>;
  close(): Promise<void>;
}
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
function bounded(raw: unknown, request = false) {
  const active = new WeakSet<object>();
  let nodes = 0,
    bytes = 0;
  function visit(value: unknown, depth: number, field = '') {
    if (++nodes > (request ? 256 : 300000) || depth > (request ? 12 : 24)) fail();
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      if (value.length > (request ? 16384 : 1048576)) fail();
      bytes += Buffer.byteLength(value);
    } else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) fail();
    } else if (typeof value === 'object') {
      const capacity = field === 'entries' || field === 'candidates' ? 300 : 10000;
      if (active.has(value) || (Array.isArray(value) && (request || value.length > capacity)))
        fail();
      const proto = Object.getPrototypeOf(value) as unknown;
      if (
        proto !== Object.prototype &&
        proto !== null &&
        !(Array.isArray(value) && proto === Array.prototype)
      )
        fail();
      const fields = Reflect.ownKeys(value);
      if (fields.length > (Array.isArray(value) ? 10001 : 64)) fail();
      active.add(value);
      for (const k of fields) {
        if (Array.isArray(value) && k === 'length') continue;
        if (typeof k !== 'string' || k.length > 128) fail();
        const p = Object.getOwnPropertyDescriptor(value, k);
        if (!p || !p.enumerable || !('value' in p)) fail();
        bytes += Buffer.byteLength(k);
        visit(p.value, depth + 1, k);
      }
      active.delete(value);
    } else fail();
    if (bytes > (request ? 16384 : 16777216)) fail();
  }
  visit(raw, 0);
}
function lookup(raw: unknown): PaperPreparationInventoryRequest {
  try {
    bounded(raw, true);
    const r = requestSchema.parse(raw),
      b = r.admission.binding;
    if (
      b.mode !== 'PAPER' ||
      b.connectionId !== null ||
      b.profile.market !== 'SPOT' ||
      b.profile.accountMode !== 'SIMULATED' ||
      b.profile.endpointProfileId !== 'paper-spot-v1' ||
      b.profile.profileVersion !== 'spot-l2-taker-v1'
    )
      fail();
    return r;
  } catch {
    fail('PAPER_ADMISSION_INPUT');
  }
}
// Internal composition only; absent from all package entrypoints. Decoding
// caller content cannot establish storage provenance or grant authority.
export { decodeInventory as decodePaperPreparationInventory };
function decodeInventory(raw: unknown, expected: PaperPreparationInventoryRequest, now: number) {
  try {
    bounded(raw);
    const w = packetSchema.parse(raw);
    if (canonical(w.request) !== canonical(expected) || w.asOf > now) fail();
    const source = decodePaperExecutionSource(
      w.capture,
      { ...expected, kind: 'PAPER_EXECUTION_CAPTURE' },
      now,
    );
    if (source.asOf > w.asOf || w.entries.length !== source.candidates.length) fail();
    const keys = new Set<string>(),
      attempts = new Set<string>();
    const entries = w.entries.map((entry, i) => {
      const c = source.candidates[i]!;
      if (entry.intentId !== c.intentId) fail();
      if (entry.kind === 'MISSING') return entry;
      const rawState = entry.preparation as { request?: unknown } | null;
      const preparation = preparePaperExecutionAttempt(rawState?.request);
      if (
        canonical(preparation) !== canonical(entry.preparation) ||
        preparation.request.preparedAt > source.asOf
      )
        fail();
      const a = preparation.request.admission;
      if (
        canonical(a) !==
        canonical({
          binding: expected.admission.binding,
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
      if (keys.has(entry.key) || attempts.has(preparation.request.attemptId)) fail();
      keys.add(entry.key);
      attempts.add(preparation.request.attemptId);
      return { ...entry, preparation };
    });
    return immutable({
      kind: 'PAPER_PREPARATION_INVENTORY_SOURCE' as const,
      request: expected,
      asOf: w.asOf,
      validUntil: source.validUntil,
      hash: createHash('sha256').update(canonical(w)).digest('hex'),
      source,
      entries,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'PAPER_ADMISSION_EXPIRED') throw error;
    fail();
  }
}
/** Read-only original preparations for complete pristine admission FIFO. Neither
 * PREPARED nor MISSING proves START, eligibility, permission or shared liquidity. */
export async function createPostgresPaperPreparationInventorySource(
  options: unknown,
): Promise<PaperPreparationInventoryReader> {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async read(raw: PaperPreparationInventoryRequest, io: PaperFundingIo) {
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
          return decodeInventory(rows.rows[0]!.result, expected, Date.now());
        },
      );
      if (io.signal.aborted || Date.now() >= io.deadline) fail('PAPER_ADMISSION_ABORTED');
      if (Date.now() >= result.validUntil) fail('PAPER_ADMISSION_EXPIRED');
      return result;
    },
    close: database.close,
  });
}
