import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  decimalCompare,
  decimalSubtract,
  immutable,
  newOrderSchema,
  parseDecimal,
  timestampSchema,
} from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { paperOwnerSchema } from './configuration-domain.js';
import { openPaperAdmissionDatabase } from './admission-database.js';
import { currentOrderRiskCaptureQuery } from './current-order-risk-query.js';
import { lookupPaperExecutionCommitRequest } from './postgres-execution-commit.js';
import {
  decodePaperCurrentRiskContents,
  decodePaperCurrentLossProgressContents,
  validatePaperCurrentRiskJson,
  type PaperCurrentRiskRequest,
  type PaperCurrentRiskCertificate,
  type PaperCurrentLossProgress,
} from './postgres-current-risk.js';
import {
  calculatePaperStoredOrderRiskEvaluation,
  type PaperCurrentRiskEvaluationCalculation,
} from './current-risk-evaluation.js';
import type { PaperFundingIo } from './funding-domain.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u),
  uuid = z.uuid().transform((s) => s.toLowerCase()),
  selection = z.strictObject({ orderId: uuid, intentId: uuid, commandHash: digest }),
  cashProofSchema = z.strictObject({
    asset: z.string(),
    amount: z.string(),
    available: z.string(),
    remaining: z.string(),
  }),
  budgetProofSchema = z.strictObject({
    notional: z.string(),
    currentExposure: z.string(),
    projectedExposure: z.string(),
    openOrders: z.int().nonnegative(),
    potentialPositions: z.int().nonnegative(),
    ordersInLastMinute: z.int().positive(),
    withinLimits: z.literal(true),
  }),
  policyProofSchema = z.strictObject({
    liquidity: z.string(),
    marketAllowed: z.literal(true),
    lossAllowed: z.literal(true),
  }),
  operationalProofSchema = z.strictObject({
    runtimeReady: z.literal(true),
    tradingReady: z.literal(true),
  }),
  orderProofSchema = z.strictObject({
    rulesAllowed: z.literal(true),
    capabilityReady: z.literal(true),
  }),
  commitmentProofSchema = z.strictObject({
    bookId: uuid,
    revision: z.string(),
    nextRevision: z.string(),
    ready: z.literal(true),
    after: z.record(z.string(), z.unknown()),
  }),
  requestSchema = z.strictObject({
    kind: z.literal('PAPER_CURRENT_ORDER_RISK_CAPTURE'),
    source: z.unknown(),
    target: selection,
  }),
  targetSchema = z.strictObject({
    owner: paperOwnerSchema,
    orderId: uuid,
    intentId: uuid,
    dbInstrumentId: uuid,
    dbRuleId: uuid,
    command: newOrderSchema,
    commandHash: digest,
    createdAt: timestampSchema,
    status: z.literal('CREATED'),
    orderVersion: z.literal(0),
  }),
  packetSchema = z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('CAPTURED'),
      request: z.unknown(),
      capturedAt: timestampSchema,
      target: targetSchema,
      certificate: z.unknown(),
    }),
    z.strictObject({
      kind: z.literal('ADVANCED'),
      request: z.unknown(),
      capturedAt: timestampSchema,
      target: targetSchema,
      source: z.unknown(),
    }),
    z.strictObject({ kind: z.literal('MISSING') }),
    z.strictObject({ kind: z.literal('REPLACED') }),
    z.strictObject({ kind: z.literal('INCOMPLETE') }),
  ]);
export interface PaperCurrentOrderRiskRequest {
  readonly kind: 'PAPER_CURRENT_ORDER_RISK_CAPTURE';
  readonly source: PaperCurrentRiskRequest;
  readonly target: Readonly<z.infer<typeof selection>>;
}
export interface PaperCurrentOrderRiskSource {
  readonly kind: 'PAPER_CURRENT_ORDER_RISK_SOURCE';
  readonly target: Readonly<z.infer<typeof targetSchema>>;
  readonly certificate: PaperCurrentRiskCertificate;
  readonly evaluation: PaperCurrentRiskEvaluationCalculation;
  readonly commitmentBasis: Readonly<{
    kind: 'PAPER_CURRENT_ORDER_COMMITMENT_BASIS';
    target: PaperCurrentOrderRiskRequest['target'];
    book: Readonly<{ id: string; revision: string; nextRevision: string; stateHash: string }>;
    certificate: Readonly<{ id: string; hash: string; validUntil: number }>;
    hold: Readonly<{ asset: string; amount: string; status: 'RESERVED'; reflected: false }>;
    spendable: Readonly<{ before: string; after: string }>;
  }> | null;
}
export interface PaperCurrentOrderRiskReader {
  capture(
    request: PaperCurrentOrderRiskRequest,
    io: PaperFundingIo,
  ): Promise<PaperCurrentOrderRiskSource>;
  readCurrent(
    request: PaperCurrentOrderRiskRequest,
    io: PaperFundingIo,
  ): Promise<PaperCurrentOrderRiskSource>;
  advanceLoss(
    request: PaperCurrentOrderRiskRequest,
    io: PaperFundingIo,
  ): Promise<PaperCurrentLossProgress>;
  close(): Promise<void>;
}
function fail(): never {
  throw Error('PAPER_CURRENT_ORDER_RISK_EVIDENCE');
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Internal content check for the already decoded current book and evaluation. */
export function describeCurrentPaperCommitment(
  target: PaperCurrentOrderRiskRequest['target'],
  account: PaperCurrentRiskCertificate['inventory']['accounts'][number],
  certificate: PaperCurrentRiskCertificate,
  evaluation: PaperCurrentRiskEvaluationCalculation,
): PaperCurrentOrderRiskSource['commitmentBasis'] {
  if (evaluation.result.kind !== 'EVALUATED') return null;

  const { state } = account;
  const revision = BigInt(account.revision);
  const [debit] = evaluation.result.debits;
  const balance = state.balances.find((b) => b.asset === certificate.snapshot.availableAsset);
  if (
    state.status !== 'RECONCILED' ||
    revision < 2n ||
    revision >= BigInt(Number.MAX_SAFE_INTEGER) ||
    state.holds.length >= 1000 ||
    state.holds.some((hold) => hold.status === 'UNKNOWN') ||
    !debit ||
    evaluation.result.debits.length !== 1 ||
    !balance ||
    balance.available === null ||
    debit.asset !== balance.asset
  )
    fail();

  const zero = parseDecimal('0');
  const before = state.holds.reduce(
    (spendable, hold) =>
      hold.asset === balance.asset && !hold.reflected
        ? decimalSubtract(spendable, parseDecimal(hold.amount))
        : spendable,
    parseDecimal(balance.available),
  );
  const amount = parseDecimal(debit.amount);
  const after = decimalSubtract(before, amount);
  if (
    decimalCompare(amount, zero) <= 0 ||
    decimalCompare(after, zero) < 0 ||
    before !== certificate.snapshot.availableAmount ||
    before !== debit.available ||
    after !== debit.remaining
  )
    fail();

  return {
    kind: 'PAPER_CURRENT_ORDER_COMMITMENT_BASIS',
    target,
    book: {
      id: account.bookId,
      revision: account.revision,
      nextRevision: (revision + 1n).toString(),
      stateHash: createHash('sha256').update(canonical(state)).digest('hex'),
    },
    certificate: { id: certificate.id, hash: certificate.hash, validUntil: evaluation.validUntil },
    hold: { asset: debit.asset, amount, status: 'RESERVED', reflected: false },
    spendable: { before, after },
  };
}

export function lookupPaperCurrentOrderRiskRequest(raw: unknown): PaperCurrentOrderRiskRequest {
  try {
    validatePaperCurrentRiskJson(raw);
    const p = requestSchema.parse(raw);
    const source = lookupPaperExecutionCommitRequest(p.source, 'PAPER_CURRENT_RISK_CERTIFY');
    return immutable({ ...p, source: { ...source, kind: 'PAPER_CURRENT_RISK_CERTIFY' as const } });
  } catch {
    throw Error('PAPER_CURRENT_ORDER_RISK_INPUT');
  }
}

interface PaperCurrentOrderRiskEvidence {
  result: unknown;
  cashProof: unknown;
  budgetProof: unknown;
  policyProof: unknown;
  operationalProof: unknown;
  orderProof: unknown;
  commitmentProof: unknown;
}

/** Shared verification of the server-owned capture and the fixed PostgreSQL proof. */
export function decodePaperCurrentOrderRiskEvidence(
  row: PaperCurrentOrderRiskEvidence,
  request: PaperCurrentOrderRiskRequest,
  op: 'CAPTURE' | 'READ' | 'ADVANCE',
  now: number,
) {
  const {
    result: rawReply,
    cashProof,
    budgetProof,
    policyProof,
    operationalProof,
    orderProof,
    commitmentProof,
  } = row;
  validatePaperCurrentRiskJson(rawReply);
  const p = packetSchema.parse(rawReply);
  if (p.kind === 'MISSING' || p.kind === 'REPLACED' || p.kind === 'INCOMPLETE') fail();
  const t = p.target,
    b = request.source.admission.binding;
  if (
    !same(p.request, request) ||
    p.capturedAt > now ||
    t.createdAt > p.capturedAt ||
    t.orderId !== request.target.orderId ||
    t.intentId !== request.target.intentId ||
    t.commandHash !== request.target.commandHash ||
    t.owner.tenantId !== b.tenantId ||
    t.owner.accountId !== b.accountId ||
    t.owner.mode !== b.mode ||
    t.orderId === request.source.admission.orderId ||
    t.intentId === request.source.admission.intentId ||
    createHash('sha256')
      .update(canonical({ operation: 'createOrder', binding: b, command: t.command }))
      .digest('hex') !== t.commandHash
  )
    fail();
  if (p.kind === 'ADVANCED') {
    if (op !== 'ADVANCE') fail();
    return {
      kind: 'ADVANCED' as const,
      value: decodePaperCurrentLossProgressContents(p.source, request.source, now),
    };
  }
  if (op === 'ADVANCE') fail();
  const certificate = decodePaperCurrentRiskContents(p.certificate, request.source, now);
  const account = certificate.inventory.accounts.find((a) => a.accountId === t.owner.accountId);
  if (
    !account ||
    t.createdAt > certificate.createdAt ||
    (t.createdAt >= certificate.createdAt - 60000 && certificate.snapshot.ordersInLastMinute < 1) ||
    certificate.createdAt > p.capturedAt ||
    certificate.scope.dbInstrumentId !== t.dbInstrumentId ||
    certificate.scope.dbRuleId !== t.dbRuleId ||
    certificate.scope.instrumentId !== t.command.instrumentId ||
    !/^[1-9][0-9]{0,18}$/u.test(t.command.clientOrderId) ||
    BigInt(t.command.clientOrderId) > BigInt(account.accountState.clientIdHighWatermark)
  )
    fail();
  const evaluation = calculatePaperStoredOrderRiskEvaluation(
    {
      now,
      sourceRequest: request.source,
      certificate: p.certificate,
      target: {
        owner: t.owner,
        orderId: t.orderId,
        intentId: t.intentId,
        dbInstrumentId: t.dbInstrumentId,
        dbRuleId: t.dbRuleId,
        command: t.command,
      },
    },
    t.createdAt,
  );
  const commitmentBasis = describeCurrentPaperCommitment(
    request.target,
    account,
    certificate,
    evaluation,
  );
  if (evaluation.result.kind === 'EVALUATED') {
    if (!commitmentBasis) fail();
    const proof = cashProofSchema.parse(cashProof);
    const limits = budgetProofSchema.parse(budgetProof);
    const marketAndLoss = policyProofSchema.parse(policyProof);
    operationalProofSchema.parse(operationalProof);
    if (!orderProofSchema.safeParse(orderProof).success) throw Error('PAPER_ADMISSION_EVIDENCE');
    const transition = commitmentProofSchema.safeParse(commitmentProof);
    if (
      !transition.success ||
      transition.data.bookId !== commitmentBasis.book.id ||
      transition.data.revision !== commitmentBasis.book.revision ||
      transition.data.nextRevision !== commitmentBasis.book.nextRevision ||
      !same(transition.data.after, {
        ...account.state,
        holds: [...account.state.holds, commitmentBasis.hold],
      })
    )
      throw Error('PAPER_ADMISSION_EVIDENCE');
    const budget = evaluation.result.budget;
    const frequency =
      certificate.snapshot.ordersInLastMinute +
      (t.createdAt < certificate.createdAt - 60000 ? 1 : 0);
    if (
      proof.asset !== commitmentBasis.hold.asset ||
      proof.amount !== commitmentBasis.hold.amount ||
      proof.available !== commitmentBasis.spendable.before ||
      proof.remaining !== commitmentBasis.spendable.after ||
      limits.notional !== evaluation.result.notional ||
      Object.values(budget.current).some((value) => value !== limits.currentExposure) ||
      Object.values(budget.projected).some((value) => value !== limits.projectedExposure) ||
      limits.openOrders !== budget.orders.current ||
      limits.openOrders + 1 !== budget.orders.projected ||
      limits.potentialPositions !== budget.potentialPositions.current ||
      budget.potentialPositions.projected !== 1 ||
      frequency !== limits.ordersInLastMinute ||
      marketAndLoss.liquidity !== certificate.snapshot.market.liquidityNotional
    )
      fail();
  }
  return {
    kind: 'CAPTURED' as const,
    value: immutable({
      kind: 'PAPER_CURRENT_ORDER_RISK_SOURCE' as const,
      target: t,
      certificate,
      evaluation,
      commitmentBasis,
    }),
  };
}

/** Fixed private database capture/evaluate port, never a Risk grant or writer. */
export async function createPostgresPaperCurrentOrderRiskSource(
  options: unknown,
): Promise<PaperCurrentOrderRiskReader> {
  const database = await openPaperAdmissionDatabase(options);
  async function operate(
    raw: PaperCurrentOrderRiskRequest,
    io: PaperFundingIo,
    op: 'CAPTURE' | 'READ' | 'ADVANCE',
  ) {
    const request = lookupPaperCurrentOrderRiskRequest(raw);
    try {
      const value = await database.transaction(
        request.source.admission.binding.tenantId,
        io,
        async (sql) => {
          const rows = await sql.query<PaperCurrentOrderRiskEvidence>(
            currentOrderRiskCaptureQuery,
            [canonical({ ...request, kind: 'PAPER_CURRENT_ORDER_RISK_' + op })],
          );
          if (rows.rows.length !== 1) fail();
          return decodePaperCurrentOrderRiskEvidence(rows.rows[0]!, request, op, Date.now());
        },
      );
      const now = Date.now(),
        start =
          value.kind === 'CAPTURED' ? value.value.certificate.createdAt : value.value.loss.asOf,
        until =
          value.kind === 'CAPTURED'
            ? value.value.evaluation.validUntil
            : value.value.loss.validUntil;
      if (io.signal.aborted || now >= io.deadline || now < start || now >= until) fail();
      return value;
    } catch (error) {
      if (error instanceof Error && /^PAPER_[A-Z_]+$/u.test(error.message)) throw error;
      fail();
    }
  }
  return Object.freeze({
    async capture(r: PaperCurrentOrderRiskRequest, io: PaperFundingIo) {
      const result = await operate(r, io, 'CAPTURE');
      if (result.kind !== 'CAPTURED') fail();
      return result.value;
    },
    async readCurrent(r: PaperCurrentOrderRiskRequest, io: PaperFundingIo) {
      const result = await operate(r, io, 'READ');
      if (result.kind !== 'CAPTURED') fail();
      return result.value;
    },
    async advanceLoss(r: PaperCurrentOrderRiskRequest, io: PaperFundingIo) {
      const result = await operate(r, io, 'ADVANCE');
      if (result.kind !== 'ADVANCED') fail();
      return result.value;
    },
    close: database.close,
  });
}
