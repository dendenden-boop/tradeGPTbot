import { canonical } from '@ctp/portfolio';
import { openPaperAdmissionDatabase } from './admission-database.js';
import type { PaperFundingIo } from './funding-domain.js';
import {
  decodePaperExecutionRiskSource,
  executionRiskLookup,
  type PaperExecutionRiskSourceReader,
} from './execution-risk-domain.js';
/** Server-owned current read/re-evaluation only. Not a durable grant/START or
 * permit. A future writer must repeat the boundary atomically at handoff. */
export async function createPostgresPaperExecutionRiskSource(
  options: unknown,
): Promise<PaperExecutionRiskSourceReader> {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async read(raw: unknown, io: PaperFundingIo) {
      const expected = executionRiskLookup(raw);
      const result = await database.transaction(
        expected.admission.binding.tenantId,
        io,
        async (sql) => {
          const rows = await sql.query<{ result: unknown }>(
            'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
            [canonical(expected)],
          );
          if (rows.rows.length !== 1) throw Error('PAPER_ADMISSION_EVIDENCE');
          return decodePaperExecutionRiskSource(rows.rows[0]!.result, expected, Date.now());
        },
      );
      if (io.signal.aborted || Date.now() >= io.deadline) throw Error('PAPER_ADMISSION_ABORTED');
      if (Date.now() >= result.validUntil) throw Error('PAPER_ADMISSION_EXPIRED');
      return result;
    },
    close: database.close,
  });
}
