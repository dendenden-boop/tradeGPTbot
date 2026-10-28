import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  decimalCompare,
  immutable,
  instrumentRecordSchema,
  newOrderSchema,
  orderBookSchema,
  parseDecimal,
  positiveAmountSchema,
  positiveDecimalSchema,
  rateDecimalSchema,
  sameMarketScope,
  timestampSchema,
  tradeTickSchema,
  validateOrderAgainstRules,
} from '@ctp/exchange-core';
import { canonical, restorePortfolio, type PortfolioState } from '@ctp/portfolio';
import { riskSnapshotKeySchema } from '@ctp/risk-engine';
import { openPaperAdmissionDatabase } from './admission-database.js';
import type { PaperFundingIo } from './funding-domain.js';
import { paperModelSchema, preparePaperFrame } from './model.js';

const uuid = z.uuid().transform((v) => v.toLowerCase()),
  digest = z.string().regex(/^[a-f0-9]{64}$/u);
const epoch = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const counter = epoch.refine((v) => v !== '0');
const bookRevision = counter.refine((v) => BigInt(v) <= 9007199254740991n);
const request = z.strictObject({
  kind: z.literal('PAPER_EXECUTION_CAPTURE'),
  admission: z.strictObject({
    binding: riskSnapshotKeySchema.shape.binding,
    orderId: uuid,
    intentId: uuid,
    operation: z.literal('PLACE'),
    commandHash: digest,
  }),
  authorization: z.strictObject({
    permissionEpoch: epoch,
    userSessionEpoch: epoch.refine((v) => BigInt(v) <= 2147483647n),
  }),
});
const reference = z.strictObject({ id: uuid, revision: counter, hash: digest });
const candidate = z.strictObject({
  orderId: uuid,
  intentId: uuid,
  reservationId: uuid,
  decisionId: uuid,
  commandHash: digest,
  command: newOrderSchema,
  dbInstrumentId: uuid,
  dbRuleId: uuid,
  admissionSequence: counter,
  admittedAt: timestampSchema,
  original: z.strictObject({
    certificateId: uuid,
    sourceHash: digest,
    expiresAt: timestampSchema,
    executionBounds: z.strictObject({
      minimum: positiveDecimalSchema,
      maximum: positiveDecimalSchema,
      feeRate: rateDecimalSchema,
    }),
  }),
  debits: z
    .array(
      z.strictObject({
        holdId: uuid,
        asset: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/u),
        amount: positiveAmountSchema,
      }),
    )
    .length(1),
});
const wire = z.strictObject({
  kind: z.literal('PAPER_EXECUTION_CAPTURE'),
  request,
  asOf: timestampSchema,
  validUntil: timestampSchema,
  maxEvidenceAgeMs: z.number().int().min(1).max(3600000),
  configurationId: uuid,
  fundingId: uuid,
  model: paperModelSchema,
  portfolio: z.strictObject({
    bookId: uuid,
    revision: bookRevision,
    hash: digest,
    stateText: z.string().min(1).max(1048576),
  }),
  market: z.strictObject({
    record: instrumentRecordSchema,
    book: orderBookSchema,
    trade: tradeTickSchema,
    snapshotAt: timestampSchema,
    tradeAt: timestampSchema,
    dbInstrumentId: uuid,
    dbRuleId: uuid,
    snapshot: reference,
    tradeReference: reference,
  }),
  candidates: z.array(candidate).min(1).max(300),
});
export type PaperExecutionSourceRequest = z.infer<typeof request>;
export interface PaperExecutionSource {
  readonly kind: 'PAPER_EXECUTION_SOURCE';
  readonly asOf: number;
  readonly validUntil: number;
  readonly maxEvidenceAgeMs: number;
  readonly hash: string;
  readonly request: PaperExecutionSourceRequest;
  readonly configurationId: string;
  readonly fundingId: string;
  readonly model: z.infer<typeof paperModelSchema>;
  readonly portfolio: PortfolioState;
  readonly book: Readonly<{ bookId: string; revision: string; hash: string }>;
  readonly market: z.infer<typeof wire>['market'];
  readonly candidates: readonly z.infer<typeof candidate>[];
}
export interface PaperExecutionSourceReader {
  read(request: PaperExecutionSourceRequest, io: PaperFundingIo): Promise<PaperExecutionSource>;
  close(): Promise<void>;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
function lookup(raw: unknown) {
  const checked = request.safeParse(raw);
  if (!checked.success) fail('PAPER_ADMISSION_INPUT');
  const value = checked.data,
    b = value.admission.binding;
  if (
    b.mode !== 'PAPER' ||
    b.connectionId !== null ||
    b.profile.market !== 'SPOT' ||
    b.profile.accountMode !== 'SIMULATED' ||
    b.profile.endpointProfileId !== 'paper-spot-v1' ||
    b.profile.profileVersion !== 'spot-l2-taker-v1'
  )
    fail('PAPER_ADMISSION_UNSUPPORTED');
  return value;
}
export function decodePaperExecutionSource(
  raw: unknown,
  expected: PaperExecutionSourceRequest,
  now: number,
): PaperExecutionSource {
  try {
    // Bound cardinality before individual candidate parsing. The SQL RPC also
    // limits its complete result, never silently truncating a contender set.
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail();
    const fields = raw as Record<string, unknown>;
    if (
      !Array.isArray(fields['candidates']) ||
      fields['candidates'].length > 300 ||
      fields['candidates'].length < 1
    )
      fail();
    if (Buffer.byteLength(canonical(raw)) > 4194304) fail();
    const w = wire.parse(raw),
      b = expected.admission.binding,
      market = w.market;
    if (
      canonical(w.request) !== canonical(expected) ||
      w.asOf > now ||
      w.maxEvidenceAgeMs > w.model.maxEvidenceAgeMs ||
      w.model.version !== b.profile.profileVersion ||
      !sameMarketScope(market.record.instrument.scope, b.profile)
    )
      fail();
    preparePaperFrame({
      now: w.asOf,
      model: { ...w.model, maxEvidenceAgeMs: w.maxEvidenceAgeMs },
      record: market.record,
      book: market.book,
      trade: market.trade,
    });
    const times = [
      market.snapshotAt,
      market.tradeAt,
      market.book.receivedAt,
      market.trade.receivedAt,
      market.trade.exchangeTime,
      ...(market.book.exchangeTime === null ? [] : [market.book.exchangeTime]),
    ];
    const validUntil = Math.min(
      ...times.map((t) => t + w.maxEvidenceAgeMs + 1),
      market.record.rules.expiresAt,
      market.record.instrument.expiryAt ?? Infinity,
    );
    if (times.some((t) => t > w.asOf) || validUntil !== w.validUntil) fail();
    if (validUntil <= now) fail('PAPER_ADMISSION_EXPIRED');
    const state = restorePortfolio(JSON.parse(w.portfolio.stateText));
    if (
      hash(w.portfolio.stateText) !== w.portfolio.hash ||
      canonical(state) !== w.portfolio.stateText ||
      canonical(state.binding) !==
        canonical({
          tenantId: b.tenantId,
          accountId: b.accountId,
          mode: 'PAPER',
          connectionId: null,
          externalAccountId: b.externalAccountId,
          walletId: 'paper-initial:' + w.fundingId,
          scope: market.record.instrument.scope,
        }) ||
      state.status !== 'RECONCILED' ||
      state.snapshotAt === null ||
      state.snapshotId === null ||
      state.snapshotAt > w.asOf ||
      state.lastEconomicAt !== null ||
      state.positions.length ||
      state.pending.length ||
      state.differences.length ||
      state.balances.length !== 1 ||
      state.balances[0]!.asset !== market.record.instrument.quoteAsset ||
      state.holds.some((h) => h.status !== 'RESERVED' || h.reflected)
    )
      fail();
    for (const balance of state.balances)
      for (const amount of [balance.total, balance.free, balance.available])
        if (amount !== null && decimalCompare(parseDecimal(amount), parseDecimal('0')) < 0) fail();
    const identities = new Map<string, Set<string>>(),
      holdIds = new Set<string>();
    let previous = 0n,
      target = false;
    for (const c of w.candidates) {
      for (const key of [
        'orderId',
        'intentId',
        'reservationId',
        'decisionId',
        'admissionSequence',
      ] as const) {
        const seen = identities.get(key) ?? new Set<string>();
        if (seen.has(c[key])) fail();
        seen.add(c[key]);
        identities.set(key, seen);
      }
      if (BigInt(c.admissionSequence) <= previous) fail();
      previous = BigInt(c.admissionSequence);
      const command = c.command,
        terms = c.original.executionBounds;
      if (!validateOrderAgainstRules(command, market.record, w.asOf).ok) fail();
      if (
        c.admittedAt > w.asOf ||
        c.original.expiresAt <= c.admittedAt ||
        c.dbInstrumentId !== market.dbInstrumentId ||
        c.dbRuleId !== market.dbRuleId ||
        command.instrumentId !== market.record.instrument.id ||
        command.ruleVersion !== market.record.rules.version ||
        command.side !== 'BUY' ||
        !['MARKET', 'LIMIT'].includes(command.type) ||
        command.trigger !== null ||
        command.reduceOnly ||
        command.timeInForce === 'POST_ONLY' ||
        command.size.kind !== 'BASE_QUANTITY' ||
        command.size.asset !== market.record.instrument.baseAsset ||
        hash(canonical({ operation: 'createOrder', command, binding: b })) !== c.commandHash ||
        terms.feeRate !== w.model.takerFeeRate ||
        decimalCompare(terms.minimum, terms.maximum) > 0
      )
        fail();
      const seenClients = identities.get('clientId') ?? new Set<string>();
      if (seenClients.has(command.clientOrderId)) fail();
      seenClients.add(command.clientOrderId);
      identities.set('clientId', seenClients);
      for (const d of c.debits) {
        const hold = state.holds.find((h) => h.id === d.holdId);
        if (
          holdIds.has(d.holdId) ||
          d.asset !== market.record.instrument.quoteAsset ||
          !hold ||
          hold.asset !== d.asset ||
          hold.amount !== d.amount
        )
          fail();
        holdIds.add(d.holdId);
      }
      if (c.orderId === expected.admission.orderId) {
        if (
          c.intentId !== expected.admission.intentId ||
          c.commandHash !== expected.admission.commandHash
        )
          fail();
        target = true;
      }
    }
    if (!target) fail();
    return immutable({
      kind: 'PAPER_EXECUTION_SOURCE',
      asOf: w.asOf,
      validUntil: w.validUntil,
      maxEvidenceAgeMs: w.maxEvidenceAgeMs,
      hash: hash(canonical(w)),
      request: expected,
      configurationId: w.configurationId,
      fundingId: w.fundingId,
      model: w.model,
      portfolio: state,
      book: { bookId: w.portfolio.bookId, revision: w.portfolio.revision, hash: w.portfolio.hash },
      market: w.market,
      candidates: w.candidates,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'PAPER_ADMISSION_EXPIRED') throw error;
    fail();
  }
}

/** Server-owned, pristine issued-input capture only. It neither adopts a book
 * nor renews approval, assigns liquidity, starts an attempt or posts money.
 * A future fixed writer must reread the complete source atomically at its own
 * final boundary; this read result and its plain hashes grant no authority. */
export async function createPostgresPaperExecutionSource(
  options: unknown,
): Promise<PaperExecutionSourceReader> {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async read(raw: PaperExecutionSourceRequest, io: PaperFundingIo) {
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
          return decodePaperExecutionSource(rows.rows[0]!.result, expected, Date.now());
        },
      );
      if (io.signal.aborted || Date.now() >= io.deadline) fail('PAPER_ADMISSION_ABORTED');
      if (Date.now() >= result.validUntil) fail('PAPER_ADMISSION_EXPIRED');
      return result;
    },
    close: database.close,
  });
}
