import { createHash } from 'node:crypto';
import { immutable, positiveAmountSchema, timestampSchema } from '@ctp/exchange-core';
import { canonical, holdSchema, reducePortfolio } from '@ctp/portfolio';
import { z } from 'zod';
import { openPaperAdmissionDatabase } from './admission-database.js';
import type { PaperFundingIo } from './funding-domain.js';
import {
  decodePaperCurrentOrderRiskEvidence,
  lookupPaperCurrentOrderRiskRequest,
  type PaperCurrentOrderRiskRequest,
} from './postgres-current-order-risk.js';
import { validatePaperCurrentRiskJson } from './postgres-current-risk.js';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const uuid = z.uuid().refine((id) => id === id.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptSchema = z.strictObject({
  kind: z.literal('PAPER_POSTEXECUTION_RESERVED'),
  key,
  orderId: uuid,
  intentId: uuid,
  decisionId: uuid,
  reservationId: uuid,
  certificateId: uuid,
  bookId: uuid,
  revision: z.string().regex(/^[1-9][0-9]{0,15}$/u),
  debits: z.tuple([
    z.strictObject({
      asset: holdSchema.shape.asset,
      amount: positiveAmountSchema,
      holdId: uuid,
    }),
  ]),
});
const missing = z.strictObject({ kind: z.literal('MISSING'), key });
const proof = {
  receipt: receiptSchema,
  evidence: z.strictObject({
    result: z.unknown(),
    cashProof: z.unknown(),
    budgetProof: z.unknown(),
    policyProof: z.unknown(),
    operationalProof: z.unknown(),
    orderProof: z.unknown(),
    commitmentProof: z.unknown(),
  }),
  event: z.strictObject({
    id: uuid,
    type: z.literal('COMMITMENT'),
    timestamp: timestampSchema,
    hold: holdSchema,
  }),
  eventHash: digest,
  book: z.strictObject({
    previousHash: digest,
    state: z.string().max(1048576),
    stateHash: digest,
  }),
  watermark: z.strictObject({
    timestamp: timestampSchema,
    fingerprint: digest,
    released: z.literal(false),
    unknown: z.literal(false),
  }),
  ledger: z.null(),
};
const written = z.strictObject({ kind: z.literal('WRITTEN'), ...proof });
const replySchema = z.discriminatedUnion('kind', [
  missing,
  z.strictObject({ kind: z.literal('REPLAYED'), receipt: receiptSchema }),
  written,
]);
const basisSchema = z.discriminatedUnion('kind', [
  missing,
  z.strictObject({ kind: z.literal('PAPER_POSTEXECUTION_BASIS'), ...proof }),
]);
type Request = Omit<PaperCurrentOrderRiskRequest, 'kind'> & { readonly key: string };
type Receipt = z.infer<typeof receiptSchema>;
type Proof = Omit<z.infer<typeof written>, 'kind'>;
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const requestSchema = z.strictObject({ key, source: z.unknown(), target: z.unknown() });

function fail(): never {
  throw Error('PAPER_ADMISSION_EVIDENCE');
}

function verifyCommitment(packet: Proof, request: PaperCurrentOrderRiskRequest, now: number) {
  const source = decodePaperCurrentOrderRiskEvidence(packet.evidence, request, 'CAPTURE', now);
  if (source.kind !== 'CAPTURED') fail();
  const { commitmentBasis: basis, certificate } = source.value;
  const { receipt, event, book } = packet;
  const [debit] = receipt.debits;
  const account = certificate.inventory.accounts.find(
    (a) => a.accountId === source.value.target.owner.accountId,
  );
  if (
    !basis ||
    !account ||
    now >= basis.certificate.validUntil ||
    event.timestamp < certificate.createdAt ||
    event.timestamp > now ||
    receipt.certificateId !== basis.certificate.id ||
    receipt.bookId !== basis.book.id ||
    receipt.revision !== basis.book.nextRevision ||
    book.previousHash !== basis.book.stateHash ||
    debit.asset !== basis.hold.asset ||
    debit.amount !== basis.hold.amount ||
    canonical(event.hold) !== canonical({ ...basis.hold, id: debit.holdId }) ||
    packet.eventHash !== hash(canonical(event))
  )
    fail();
  const reduction = reducePortfolio(account.state, event, { now: () => now, holdWatermark: null });
  if (
    reduction.ignored ||
    reduction.postings.length !== 0 ||
    canonical(reduction.holdWatermark) !== canonical(packet.watermark) ||
    canonical(reduction.state) !== book.state ||
    hash(book.state) !== book.stateHash
  )
    fail();
  return {
    target: source.value.target,
    previousRevision: basis.book.revision,
    originalValidUntil: basis.certificate.validUntil,
    state: reduction.state,
  };
}

function lookup(raw: Request) {
  try {
    validatePaperCurrentRiskJson(raw);
    const parsed = requestSchema.parse(raw);
    const request = lookupPaperCurrentOrderRiskRequest({
      kind: 'PAPER_CURRENT_ORDER_RISK_CAPTURE',
      source: parsed.source,
      target: parsed.target,
    });
    return { request, key: parsed.key };
  } catch {
    throw Error('PAPER_ADMISSION_INPUT');
  }
}

function requireReceipt(receipt: Receipt, key: string, { target }: PaperCurrentOrderRiskRequest) {
  if (
    receipt.key !== key ||
    receipt.orderId !== target.orderId ||
    receipt.intentId !== target.intentId ||
    BigInt(receipt.revision) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    fail();
}

/** Private server port. The receipt carries no execution authority. */
export async function createPostgresPaperPostexecutionReservation(options: unknown) {
  const database = await openPaperAdmissionDatabase(options);
  async function operate(raw: Request, io: PaperFundingIo, read: boolean) {
    const { request, key: operationKey } = lookup(raw);
    return database.transaction(request.source.admission.binding.tenantId, io, async (sql) => {
      const rows = await sql.query<{ result: unknown }>(
        read
          ? 'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result'
          : 'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
        [
          canonical({
            kind: read ? 'PAPER_POSTEXECUTION_READ' : 'PAPER_POSTEXECUTION_RESERVE',
            key: operationKey,
            source: request.source,
            target: request.target,
          }),
        ],
      );
      try {
        if (rows.rows.length !== 1) fail();
        const packet = replySchema.parse(rows.rows[0]!.result);
        if (packet.kind === 'MISSING') {
          if (!read || packet.key !== operationKey) fail();
          return null;
        }
        const { receipt } = packet;
        requireReceipt(receipt, operationKey, request);
        if (packet.kind === 'WRITTEN') {
          if (read) fail();
          const verified = verifyCommitment(packet, request, Date.now());
          if (Date.now() >= verified.originalValidUntil) fail();
        }
        return immutable(receipt);
      } catch {
        fail();
      }
    });
  }

  return Object.freeze({
    async reserve(request: Request, io: PaperFundingIo): Promise<Readonly<Receipt>> {
      return (await operate(request, io, false)) ?? fail();
    },
    read(request: Request, io: PaperFundingIo) {
      return operate(request, io, true);
    },
    /** Historical preparation input only. Current eligibility is checked separately. */
    async readPreparationBasis(raw: Request, io: PaperFundingIo) {
      const { request, key } = lookup(raw);
      return database.transaction(request.source.admission.binding.tenantId, io, async (sql) => {
        const rows = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
          [
            canonical({
              kind: 'PAPER_POSTEXECUTION_BASIS_READ',
              key,
              source: request.source,
              target: request.target,
            }),
          ],
        );
        try {
          if (rows.rows.length !== 1) fail();
          const packet = basisSchema.parse(rows.rows[0]!.result);
          if (packet.kind === 'MISSING') {
            if (packet.key !== key) fail();
            return null;
          }
          requireReceipt(packet.receipt, key, request);
          const appliedAt = packet.event.timestamp;
          if (appliedAt > Date.now()) fail();
          const verified = verifyCommitment(packet, request, appliedAt);
          return immutable({
            kind: 'PAPER_POSTEXECUTION_PREPARATION_BASIS' as const,
            receipt: packet.receipt,
            target: verified.target,
            appliedAt,
            originalValidUntil: verified.originalValidUntil,
            hold: packet.event.hold,
            watermark: packet.watermark,
            book: {
              id: packet.receipt.bookId,
              revision: packet.receipt.revision,
              previousRevision: verified.previousRevision,
              previousHash: packet.book.previousHash,
              stateHash: packet.book.stateHash,
              state: verified.state,
            },
          });
        } catch {
          fail();
        }
      });
    },
    close: database.close,
  });
}
