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
const replySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('MISSING'), key }),
  z.strictObject({ kind: z.literal('REPLAYED'), receipt: receiptSchema }),
  z.strictObject({
    kind: z.literal('WRITTEN'),
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
  }),
]);
type Request = Omit<PaperCurrentOrderRiskRequest, 'kind'> & { readonly key: string };
type Receipt = z.infer<typeof receiptSchema>;
type Written = Extract<z.infer<typeof replySchema>, { kind: 'WRITTEN' }>;
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const requestSchema = z.strictObject({ key, source: z.unknown(), target: z.unknown() });

function fail(): never {
  throw Error('PAPER_ADMISSION_EVIDENCE');
}

function verifyWrite(packet: Written, request: PaperCurrentOrderRiskRequest, now: number) {
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
    hash(book.state) !== book.stateHash ||
    Date.now() >= basis.certificate.validUntil
  )
    fail();
}

/** Private server port. The receipt carries no execution authority. */
export async function createPostgresPaperPostexecutionReservation(options: unknown) {
  const database = await openPaperAdmissionDatabase(options);
  async function operate(raw: Request, io: PaperFundingIo, read: boolean) {
    let request: PaperCurrentOrderRiskRequest, operationKey: string;
    try {
      validatePaperCurrentRiskJson(raw);
      const parsed = requestSchema.parse(raw);
      operationKey = parsed.key;
      request = lookupPaperCurrentOrderRiskRequest({
        kind: 'PAPER_CURRENT_ORDER_RISK_CAPTURE',
        source: parsed.source,
        target: parsed.target,
      });
    } catch {
      throw Error('PAPER_ADMISSION_INPUT');
    }
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
        if (
          receipt.key !== operationKey ||
          receipt.orderId !== request.target.orderId ||
          receipt.intentId !== request.target.intentId ||
          BigInt(receipt.revision) > BigInt(Number.MAX_SAFE_INTEGER)
        )
          fail();
        if (packet.kind === 'WRITTEN') {
          if (read) fail();
          verifyWrite(packet, request, Date.now());
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
    close: database.close,
  });
}
