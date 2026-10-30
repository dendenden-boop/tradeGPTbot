import { createHash } from 'node:crypto';
import { immutable } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { openPaperAdmissionDatabase } from './admission-database.js';
import {
  decodePaperExecutionRiskSource,
  executionRiskLookup,
  type PaperExecutionRiskSourceRequest,
} from './execution-risk-domain.js';
import { decodePaperPreparationInventory } from './postgres-preparation-inventory.js';
import type { PaperFundingIo } from './funding-domain.js';

export type PaperExecutionContextRequest = PaperExecutionRiskSourceRequest;
export type PaperExecutionContextSource = Awaited<ReturnType<PaperExecutionContextReader['read']>>;
type Risk = ReturnType<typeof decodePaperExecutionRiskSource>;
type Inventory = ReturnType<typeof decodePaperPreparationInventory>;
export interface PaperExecutionContextReader {
  read(
    request: PaperExecutionContextRequest,
    io: PaperFundingIo,
  ): Promise<
    Readonly<{
      kind: 'PAPER_EXECUTION_CONTEXT_SOURCE';
      request: PaperExecutionContextRequest;
      asOf: number;
      validUntil: number;
      hash: string;
      risk: Risk;
      inventory: Inventory;
    }>
  >;
  close(): Promise<void>;
}
function fail(): never {
  throw Error('PAPER_ADMISSION_EVIDENCE');
}
/** Current read evidence only. Both fixed RPCs retain the accepted GLOBAL ->
 * tenant -> account/book/catalog locks on ONE physical transaction. Never join
 * separately committed readers or accept caller snapshots. No final gate,
 * certificate, START, eligibility, permit, shared allocation or money is issued.
 * A future financial writer must repeat current validation under its own locks. */
export async function createPostgresPaperExecutionContextSource(
  options: unknown,
): Promise<PaperExecutionContextReader> {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async read(raw: PaperExecutionContextRequest, io: PaperFundingIo) {
      const expected = executionRiskLookup(raw);
      const inventoryRequest = {
        kind: 'PAPER_PREPARATION_INVENTORY_CAPTURE' as const,
        admission: expected.admission,
        authorization: expected.authorization,
      };
      const result = await database.transaction(
        expected.admission.binding.tenantId,
        io,
        async (sql) => {
          const capture = async (request: unknown) => {
            const rows = await sql.query<{ result: unknown }>(
              'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
              [canonical(request)],
            );
            if (rows.rows.length !== 1) fail();
            return rows.rows[0]!.result;
          };
          const riskWire = await capture(expected);
          // Reject current Risk failures before doing additional work. Re-evaluate
          // after the second query too: the first check cannot freeze freshness.
          decodePaperExecutionRiskSource(riskWire, expected, Date.now());
          const inventoryWire = await capture(inventoryRequest);
          const now = Date.now(),
            risk = decodePaperExecutionRiskSource(riskWire, expected, now),
            inventory = decodePaperPreparationInventory(inventoryWire, inventoryRequest, now);
          // Read timestamps/hashes differ naturally. Every stable authoritative
          // field (including FIFO, original bounds, metadata, holds and heads)
          // must agree; neither reader can silently replace the other's source.
          const { asOf: riskAt, hash: riskHash, ...riskContent } = risk.source;
          const { asOf: inventoryAt, hash: inventoryHash, ...inventoryContent } = inventory.source;
          void riskHash;
          void inventoryHash;
          const target = inventory.entries.find((e) => e.intentId === expected.admission.intentId);
          if (
            inventory.asOf < risk.asOf ||
            inventoryAt < riskAt ||
            canonical(riskContent) !== canonical(inventoryContent) ||
            target?.kind !== 'PREPARED' ||
            target.key !== expected.preparationKey ||
            canonical(target.preparation) !== canonical(risk.preparation)
          )
            fail();
          const asOf = inventory.asOf,
            validUntil = Math.min(risk.validUntil, inventory.validUntil),
            hash = createHash('sha256')
              .update(
                canonical({
                  request: expected,
                  asOf,
                  validUntil,
                  risk: risk.hash,
                  inventory: inventory.hash,
                }),
              )
              .digest('hex');
          return immutable({
            kind: 'PAPER_EXECUTION_CONTEXT_SOURCE' as const,
            request: expected,
            asOf,
            validUntil,
            hash,
            risk,
            inventory,
          });
        },
      );
      if (io.signal.aborted || Date.now() >= io.deadline) throw Error('PAPER_ADMISSION_ABORTED');
      if (Date.now() >= result.validUntil) throw Error('PAPER_ADMISSION_EXPIRED');
      return result;
    },
    close: database.close,
  });
}
