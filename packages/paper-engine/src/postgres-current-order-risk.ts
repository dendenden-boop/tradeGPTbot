import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, newOrderSchema, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { paperOwnerSchema } from './configuration-domain.js';
import { openPaperAdmissionDatabase } from './admission-database.js';
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
function lookup(raw: unknown): PaperCurrentOrderRiskRequest {
  try {
    validatePaperCurrentRiskJson(raw);
    const p = requestSchema.parse(raw);
    const source = lookupPaperExecutionCommitRequest(p.source, 'PAPER_CURRENT_RISK_CERTIFY');
    return immutable({ ...p, source: { ...source, kind: 'PAPER_CURRENT_RISK_CERTIFY' as const } });
  } catch {
    throw Error('PAPER_CURRENT_ORDER_RISK_INPUT');
  }
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
    const request = lookup(raw);
    try {
      const value = await database.transaction(
        request.source.admission.binding.tenantId,
        io,
        async (sql) => {
          const rows = await sql.query<{ result: unknown }>(
            'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
            [canonical({ ...request, kind: 'PAPER_CURRENT_ORDER_RISK_' + op })],
          );
          if (rows.rows.length !== 1) fail();
          const rawReply = rows.rows[0]!.result;
          validatePaperCurrentRiskJson(rawReply);
          const p = packetSchema.parse(rawReply),
            now = Date.now();
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
          const account = certificate.inventory.accounts.find(
            (a) => a.accountId === t.owner.accountId,
          );
          if (
            !account ||
            t.createdAt > certificate.createdAt ||
            (t.createdAt >= certificate.createdAt - 60000 &&
              certificate.snapshot.ordersInLastMinute < 1) ||
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
          return {
            kind: 'CAPTURED' as const,
            value: immutable({
              kind: 'PAPER_CURRENT_ORDER_RISK_SOURCE' as const,
              target: t,
              certificate,
              evaluation,
            }),
          };
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
