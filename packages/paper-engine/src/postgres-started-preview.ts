import { createHash } from 'node:crypto';
import { immutable } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { openPaperAdmissionDatabase } from './admission-database.js';
import {
  decodePaperStartedRiskWire,
  lookupPaperStartedRiskRequest,
} from './postgres-started-risk.js';
import type { PaperStartedRiskRequest } from './postgres-started-risk.js';
import { preparePaperFrame } from './model.js';
import { calculatePaperStartedExecutionPortfolio } from './started-execution.js';
import type { PaperFundingIo } from './funding-domain.js';

export type PaperStartedExecutionPreview = Awaited<
  ReturnType<PaperStartedExecutionPreviewReader['preview']>
>;
export interface PaperStartedExecutionPreviewReader {
  preview(request: PaperStartedRiskRequest, io: PaperFundingIo): Promise<Preview>;
  close(): Promise<void>;
}
type Preview = Readonly<{
  kind: 'PAPER_STARTED_EXECUTION_PREVIEW';
  version: 'paper-pristine-started-preview-v1';
  evaluatedAt: number;
  validUntil: number;
  hash: string;
  source: ReturnType<typeof decodePaperStartedRiskWire>;
  execution: ReturnType<typeof calculatePaperStartedExecutionPortfolio>;
}>;
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
function current(validUntil: number, io: PaperFundingIo) {
  const now = Date.now();
  if (io.signal.aborted || now >= io.deadline) fail('PAPER_ADMISSION_ABORTED');
  if (now >= validUntil) fail('PAPER_ADMISSION_EXPIRED');
}

/** Server-only readonly preview from one locked current source. This creates no
 * grant, permit, allocation, reservation, fill journal or monetary effect. The
 * future financial writer must reconstruct and revalidate current storage and
 * atomically own one-use execution, shared liquidity and all monetary effects.
 */
export async function createPostgresPaperStartedExecutionPreview(
  options: unknown,
): Promise<PaperStartedExecutionPreviewReader> {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async preview(raw: PaperStartedRiskRequest, io: PaperFundingIo) {
      const expected = lookupPaperStartedRiskRequest(raw);
      const result = await database.transaction(
        expected.admission.binding.tenantId,
        io,
        async (sql) => {
          const rows = await sql.query<{ result: unknown }>(
            'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
            [canonical(expected)],
          );
          if (rows.rows.length !== 1) fail();
          const evaluatedAt = Date.now();
          const source = decodePaperStartedRiskWire(rows.rows[0]!.result, expected, evaluatedAt);
          const captured = source.started.source;
          let execution: ReturnType<typeof calculatePaperStartedExecutionPortfolio>;
          try {
            const frame = preparePaperFrame({
              now: evaluatedAt,
              model: captured.model,
              record: captured.market.record,
              book: captured.market.book,
              trade: captured.market.trade,
            });
            execution = calculatePaperStartedExecutionPortfolio({
              now: evaluatedAt,
              attempt: source.started.journal.state,
              frame,
              portfolio: captured.portfolio,
            });
          } catch {
            fail();
          }
          const preview = immutable({
            kind: 'PAPER_STARTED_EXECUTION_PREVIEW' as const,
            version: 'paper-pristine-started-preview-v1' as const,
            evaluatedAt,
            validUntil: source.validUntil,
            hash: createHash('sha256')
              .update(canonical({ sourceHash: source.hash, evaluatedAt, execution }))
              .digest('hex'),
            source,
            execution,
          });
          current(preview.validUntil, io);
          return preview;
        },
      );
      current(result.validUntil, io);
      return result;
    },
    close: database.close,
  });
}
