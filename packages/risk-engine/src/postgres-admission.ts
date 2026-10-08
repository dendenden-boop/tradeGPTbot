import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, sameMarketScope } from '@ctp/exchange-core';
import { canonical, reducePortfolio } from '@ctp/portfolio';
import {
  openCertificationDatabase,
  type CertificationDatabaseOptions,
} from './postgres-certification.js';
import {
  riskSnapshotKeySchema,
  prepareRiskSnapshot,
  riskEvidenceHash,
  riskSnapshotCertificateSchema,
  type SnapshotIo,
} from './coordinator.js';
import { decodeRiskSnapshotCapture, riskCapturedIntentSchema } from './snapshot-capture.js';
import { decodeRiskPortfolioSource } from './portfolio-source.js';
import {
  evaluateRiskPolicy,
  evaluateRiskAmendmentPolicy,
  riskAmendmentRetentionSchema,
  intersectRiskLimits,
} from './policy.js';
import { certificateDeadline } from './certificate-deadline.js';

const request = z.strictObject({
  binding: riskSnapshotKeySchema.shape.binding,
  state: z.object({ id: z.uuid() }), // Only its id is used; current state is reread by fixed SQL.
  intentId: z.uuid(),
  operation: z.enum(['PLACE', 'CANCEL', 'AMEND']),
  commandHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type OrderRiskApprovalInput = z.input<typeof request>;
const grant = z.strictObject({
  decisionId: z.uuid(),
  reservationId: z.uuid(),
  permissionEpoch: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  expiresAt: z.number().int().nonnegative().safe(),
});
const prepared = z.union([
  z.strictObject({ replay: grant }),
  z.strictObject({
    replay: z.null(),
    key: riskSnapshotKeySchema,
    capture: z.unknown(),
    allocation: z.strictObject({
      certificateId: z.uuid(),
      revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
      decisionId: z.uuid(),
      reservationId: z.uuid(),
    }),
    commandHash: z.string().regex(/^[a-f0-9]{64}$/),
    orderId: z.uuid(),
  }),
]);
/** Server-only production admission. No caller snapshot, proposal, certificate,
 * policy, URL/profile override or financial writer is accepted by approve(). */
export async function createPostgresOrderRiskPort(options: CertificationDatabaseOptions) {
  const database = await openCertificationDatabase(options, 'ADMISSION');
  return Object.freeze({
    async approve(raw: OrderRiskApprovalInput, io: SnapshotIo) {
      const checked = request.safeParse(raw);
      if (!checked.success) throw new Error('RISK_ADMISSION_INPUT');
      const input = checked.data;
      if (!['TESTNET', 'DEMO'].includes(input.binding.mode)) throw new Error('RISK_MODE_DISABLED');
      const lookup = immutable({
        binding: input.binding,
        orderId: input.state.id,
        intentId: input.intentId,
        operation: input.operation,
        commandHash: input.commandHash,
      });
      const approved = await database.transaction(input, io, async (sql) => {
        const row = await sql.query<{ result: unknown }>(
          'SELECT ctp_admission.prepare($1::jsonb) AS result',
          [canonical(lookup)],
        );
        const current = prepared.parse(row.rows[0]?.result);
        if (current.replay !== null) return immutable(current.replay);
        if (
          current.commandHash !== input.commandHash ||
          current.orderId !== input.state.id ||
          current.key.intentId !== input.intentId ||
          riskEvidenceHash(current.key.binding) !== riskEvidenceHash(input.binding)
        )
          throw new Error('RISK_ADMISSION_CONFLICT');
        if (input.operation !== 'PLACE' && input.operation !== 'AMEND')
          throw new Error('RISK_ADMISSION_OPERATION_UNSUPPORTED');
        const now = Date.now(),
          sources = decodeRiskSnapshotCapture(current.capture, current.key, now);
        const projection = prepareRiskSnapshot(
          sources,
          current.key,
          { id: current.allocation.certificateId, revision: current.allocation.revision },
          now,
        );
        const limits = intersectRiskLimits(projection.platform.limits, projection.user.limits);
        const certificate = riskSnapshotCertificateSchema.parse({
          id: current.allocation.certificateId,
          revision: current.allocation.revision,
          hash: riskEvidenceHash(projection),
          projection,
          createdAt: now,
          expiresAt: certificateDeadline(projection, io.deadline),
        });
        const captured = z
          .object({
            intent: riskCapturedIntentSchema,
            retention: riskAmendmentRetentionSchema.optional(),
          })
          .parse(current.capture);
        if (captured.intent.operation !== input.operation)
          throw new Error('RISK_ADMISSION_CONFLICT');
        const sourceIntent =
          captured.intent.operation === 'PLACE'
            ? captured.intent.command
            : captured.intent.command.replacement;
        const calculation = {
          now,
          binding: projection.snapshot.binding,
          order: sourceIntent,
          record: projection.metadata.record,
          capabilities: projection.metadata.capabilities,
          adapterVersion: projection.metadata.adapterVersion,
          platform: projection.platform.limits,
          user: projection.user.limits,
          snapshot: projection.snapshot,
        };
        const evaluation =
          captured.intent.operation === 'PLACE'
            ? evaluateRiskPolicy(calculation)
            : evaluateRiskAmendmentPolicy({
                evaluation: calculation,
                command: captured.intent.command,
                retention: captured.retention,
              });
        if (evaluation.kind === 'REJECTED')
          throw new Error(evaluation.reasons[0] ?? 'RISK_ADMISSION_DENIED');
        const rawPortfolio = z.object({ portfolio: z.unknown() }).parse(current.capture).portfolio;
        const portfolio = decodeRiskPortfolioSource(
          rawPortfolio,
          {
            tenantId: input.binding.tenantId,
            mode: input.binding.mode,
            targetAccountId: input.binding.accountId,
            maxEvidenceAgeMs: limits.maxEvidenceAgeMs,
          },
          now,
        );
        const books = portfolio.books.filter(
          (b) =>
            b.accountId === input.binding.accountId &&
            b.state.binding.connectionId === input.binding.connectionId &&
            sameMarketScope(b.state.binding.scope, input.binding.profile),
        );
        if (books.length !== 1) throw new Error('RISK_ADMISSION_WALLET');
        const book = books[0]!;
        const event = {
          type: 'COMMITMENT' as const,
          id: `risk-reserve-${current.allocation.reservationId}`,
          timestamp: now,
          hold: {
            id: current.allocation.reservationId,
            asset: evaluation.proposal.asset,
            amount: evaluation.proposal.amount,
            status: 'RESERVED' as const,
            reflected: false,
          },
        };
        if (book.state.holds.some((h) => h.id === event.hold.id))
          throw new Error('RISK_ADMISSION_CONFLICT');
        const reduced = reducePortfolio(book.state, event, { now: () => now, holdWatermark: null });
        if (reduced.ignored || !reduced.holdWatermark || reduced.postings.length)
          throw new Error('RISK_ADMISSION_PORTFOLIO');
        const stateText = canonical(reduced.state),
          payload = {
            certificate,
            evaluation,
            allocation: current.allocation,
            portfolio: {
              bookId: book.id,
              expectedRevision: book.revision,
              event,
              watermark: reduced.holdWatermark,
              stateText,
              hash: createHash('sha256').update(stateText).digest('hex'),
            },
          };
        const result = await sql.query<{ result: unknown }>(
          'SELECT ctp_admission.persist($1::jsonb,$2::text) AS result',
          [canonical(lookup), canonical(payload)],
        );
        const receipt = grant.parse(result.rows[0]?.result);
        if (
          receipt.decisionId !== current.allocation.decisionId ||
          receipt.reservationId !== current.allocation.reservationId ||
          receipt.permissionEpoch !== projection.permissionEpoch ||
          receipt.expiresAt > certificate.expiresAt
        )
          throw new Error('RISK_ADMISSION_RECEIPT');
        if (receipt.expiresAt <= Date.now()) throw new Error('RISK_ADMISSION_EXPIRED');
        return immutable(receipt);
      });
      // Known COMMIT can settle after original source expiry. Persisted history
      // remains authoritative, but an expired receipt is never returned as a grant.
      if (approved.expiresAt <= Date.now()) throw new Error('RISK_ADMISSION_EXPIRED');
      return approved;
    },
    close: database.close,
  });
}
