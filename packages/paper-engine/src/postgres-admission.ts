import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  immutable,
  timestampSchema,
  positiveAmountSchema,
  decimalCompare,
  parseDecimal,
  instrumentRecordSchema,
  newOrderSchema,
  sameMarketScope,
  nonNegativeAmountSchema,
} from '@ctp/exchange-core';
import { canonical, eventSchema, stateSchema, reducePortfolio } from '@ctp/portfolio';
import {
  riskSnapshotKeySchema,
  riskEvaluationInputSchema,
  evaluateRiskPolicy,
  intersectRiskLimits,
  riskLimitsSchema,
  type OrderRiskApprovalInput,
} from '@ctp/risk-engine';
import type { PaperFundingIo } from './funding-domain.js';
import { paperOwnerSchema } from './configuration-domain.js';
import { paperModelSchema } from './model.js';
import { calculatePaperRiskBudget } from './risk-budget.js';
import { openPaperAdmissionDatabase } from './admission-database.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const digest = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/u);
const epoch = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .pipe(z.string().refine((v) => v.trim() === v && BigInt(v) <= 9223372036854775807n));
const revision = epoch.refine((v) => v !== '0');
const request = z.strictObject({
  binding: riskSnapshotKeySchema.shape.binding,
  state: z.object({ id: uuid }), // All other caller state is ignored; fixed SQL rereads it.
  intentId: uuid,
  operation: z.enum(['PLACE', 'CANCEL', 'AMEND']),
  commandHash: digest,
});
const lookupSchema = z.strictObject({
  binding: request.shape.binding,
  orderId: uuid,
  intentId: uuid,
  operation: z.literal('PLACE'),
  commandHash: digest,
});
const receipt = z.strictObject({
  decisionId: uuid,
  reservationId: uuid,
  permissionEpoch: epoch,
  expiresAt: timestampSchema,
});
const loss = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('UTC_CASH'),
    utcDayStart: timestampSchema,
    baselineAt: timestampSchema,
    openingEquity: positiveAmountSchema,
    asset: z.string().min(1).max(32),
  }),
  z.strictObject({
    kind: z.literal('PAPER_INCEPTION'),
    utcDayStart: timestampSchema,
    baselineAt: timestampSchema,
    genesisId: uuid,
    fundingId: uuid,
    initialCapital: positiveAmountSchema,
    asset: z.string().min(1).max(32),
  }),
]);
const debit = z.strictObject({
  asset: z.string().min(1).max(32),
  amount: positiveAmountSchema,
  holdId: uuid,
});
const reply = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('REPLAY'), request: lookupSchema, receipt }),
  z.strictObject({
    kind: z.literal('RESERVED'),
    request: lookupSchema,
    receipt,
    certificate: z.strictObject({
      id: uuid,
      revision,
      sourceHash: digest,
      createdAt: timestampSchema,
      expiresAt: timestampSchema,
    }),
    permissionEpoch: epoch,
    loss,
    policy: z.unknown(),
    budget: z.unknown(),
    debits: z.array(debit).min(1).max(2),
    portfolio: z.strictObject({
      bookId: uuid,
      previousRevision: revision,
      revision,
      before: stateSchema,
      events: z.array(eventSchema).min(1).max(2),
      afterText: z.string().min(1).max(4194304),
      afterHash: digest,
    }),
  }),
]);
const budgetFields = z.object({
  owner: paperOwnerSchema,
  target: z.strictObject({ orderId: uuid, intentId: uuid }),
  model: paperModelSchema,
  record: instrumentRecordSchema,
  order: newOrderSchema,
  platform: riskLimitsSchema,
  user: riskLimitsSchema,
  evidence: z.object({
    positions: z.array(z.unknown()),
    orders: z.array(z.object({ status: z.enum(['PENDING', 'OPEN', 'UNKNOWN']) })),
    reservations: z.array(z.object({ unknown: z.boolean() })),
    holds: z.array(
      z.object({
        id: z.string(),
        accountId: uuid,
        asset: z.string(),
        amount: positiveAmountSchema,
        unknown: z.boolean(),
        reflected: z.boolean(),
      }),
    ),
    balances: z.array(
      z.object({ accountId: uuid, asset: z.string(), available: nonNegativeAmountSchema }),
    ),
  }),
});
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function singleResult(rows: { result: unknown }[]): unknown {
  if (rows.length !== 1 || Buffer.byteLength(canonical(rows[0]!.result), 'utf8') > 4194304) fail();
  return rows[0]!.result;
}
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw new Error(code);
}
function lookup(raw: OrderRiskApprovalInput) {
  const checked = request.safeParse(raw);
  if (!checked.success) fail('PAPER_ADMISSION_INPUT');
  const x = checked.data,
    b = x.binding;
  if (
    b.mode !== 'PAPER' ||
    b.connectionId !== null ||
    b.profile.accountMode !== 'SIMULATED' ||
    b.profile.endpointProfileId !== 'paper-spot-v1' ||
    b.profile.market !== 'SPOT'
  )
    fail('PAPER_ADMISSION_UNSUPPORTED');
  if (x.operation !== 'PLACE') fail('PAPER_ADMISSION_UNSUPPORTED');
  return immutable({
    binding: b,
    orderId: x.state.id,
    intentId: x.intentId,
    operation: 'PLACE' as const,
    commandHash: x.commandHash,
  });
}

function verifyReserved(
  r: Extract<z.infer<typeof reply>, { kind: 'RESERVED' }>,
  expected: z.infer<typeof lookupSchema>,
) {
  const now = Date.now();
  const policyBinding = {
    tenantId: expected.binding.tenantId,
    accountId: expected.binding.accountId,
    mode: expected.binding.mode,
    profile: expected.binding.profile,
  };
  const policy = riskEvaluationInputSchema.parse({
      ...z.record(z.string(), z.unknown()).parse(r.policy),
      now,
    }),
    rawBudget = { ...z.record(z.string(), z.unknown()).parse(r.budget), now },
    fields = budgetFields.parse(rawBudget),
    budget = calculatePaperRiskBudget(rawBudget),
    limits = intersectRiskLimits(policy.platform, policy.user),
    c = r.certificate;
  if (
    !same(policy.binding, policyBinding) ||
    !same(fields.owner, {
      tenantId: expected.binding.tenantId,
      accountId: expected.binding.accountId,
      mode: 'PAPER',
    }) ||
    !same(fields.target, { orderId: expected.orderId, intentId: expected.intentId }) ||
    !same(policy.order, fields.order) ||
    !same(policy.record, { instrument: fields.record.instrument, rules: fields.record.rules }) ||
    !same(policy.platform, fields.platform) ||
    !same(policy.user, fields.user) ||
    fields.model.version !== expected.binding.profile.profileVersion ||
    policy.adapterVersion !== 'paper-spot-l2-taker-v1' ||
    policy.order.side !== 'BUY' ||
    !['LIMIT', 'MARKET'].includes(policy.order.type) ||
    hash(
      canonical({ operation: 'createOrder', command: policy.order, binding: expected.binding }),
    ) !== expected.commandHash
  )
    fail('PAPER_ADMISSION_CONFLICT');
  const s = policy.snapshot,
    day = Math.floor(now / 86400000) * 86400000;
  const age = Math.min(limits.maxEvidenceAgeMs, fields.model.maxEvidenceAgeMs);
  const originalTimes = [
    s.sourceAt,
    s.reconciledAt,
    s.positionEvidence.asOf,
    s.market.asOf,
    s.market.fxAsOf,
  ];
  const policyDeadline = Math.min(
    ...originalTimes.map((at) => at + age + 1),
    ...policy.capabilities.map((cap) => cap.expiresAt),
  );
  if (
    s.sourceId !== 'paper-certified:' + c.id ||
    s.revision !== c.revision ||
    r.receipt.permissionEpoch !== r.permissionEpoch ||
    r.receipt.expiresAt > c.expiresAt ||
    c.expiresAt > budget.validUntil ||
    c.expiresAt > policyDeadline ||
    c.expiresAt > day + 86400000 ||
    originalTimes.some((at) => at > c.createdAt) ||
    c.createdAt > now ||
    c.expiresAt <= now ||
    r.loss.utcDayStart !== day ||
    s.utcDayStart !== day ||
    r.loss.asset !== limits.valuationAsset
  )
    fail();
  if (r.loss.kind === 'UTC_CASH') {
    if (r.loss.baselineAt !== day || s.adjustedOpeningEquity !== r.loss.openingEquity) fail();
  } else if (
    r.loss.baselineAt < day ||
    r.loss.baselineAt > c.createdAt ||
    s.adjustedOpeningEquity !== r.loss.initialCapital
  )
    fail();
  // These equalities independently connect the common policy inputs to the
  // full-vector computation, rather than trusting a scalar SQL proposal.
  for (const name of ['instrument', 'asset', 'account', 'user'] as const) {
    const key = {
      instrument: 'instrumentExposure',
      asset: 'assetExposure',
      account: 'accountExposure',
      user: 'userExposure',
    }[name] as 'instrumentExposure' | 'assetExposure' | 'accountExposure' | 'userExposure';
    if (s[key] !== budget.current[name]) fail();
  }
  const unknown =
    fields.evidence.orders.some((o) => o.status === 'UNKNOWN') ||
    fields.evidence.reservations.some((r) => r.unknown) ||
    fields.evidence.holds.some((h) => h.unknown);
  if (
    s.unknownExposure !== unknown ||
    s.openOrders !== budget.orders.current ||
    s.concurrentPositions !== budget.potentialPositions.current ||
    s.market.lowerExecutionPrice !== budget.coverage.envelope.executionPrice.minimum ||
    s.market.upperExecutionPrice !== budget.coverage.envelope.executionPrice.maximum ||
    s.availableAsset !== fields.record.instrument.quoteAsset ||
    s.availableAmount !== budget.coverage.debits[0]!.available
  )
    fail();
  if (evaluateRiskPolicy(policy).kind === 'REJECTED') fail('PAPER_ADMISSION_LIMIT');
  if (
    budget.coverage.debits.some(
      (d) =>
        decimalCompare(parseDecimal(d.remaining), parseDecimal(limits.minAvailableBalance)) < 0,
    )
  )
    fail('PAPER_ADMISSION_LIMIT');
  if (
    !same(
      r.debits.map((d) => ({ asset: d.asset, amount: d.amount })),
      budget.coverage.debits.map((d) => ({ asset: d.asset, amount: d.amount })),
    )
  )
    fail();
  const p = r.portfolio,
    b = p.before.binding;
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const byAsset = (a: { asset: string }, b: { asset: string }) => a.asset.localeCompare(b.asset);
  // This initial admission slice is quote-cash only. A self-consistent after
  // hash cannot authorize a different pre-state, omit an existing hold or hide
  // unresolved economic evidence. SQL must additionally prove its private head.
  const targetBalances = fields.evidence.balances
    .filter((row) => row.accountId === b.accountId)
    .map((row) => ({
      asset: row.asset,
      total: row.available,
      free: row.available,
      locked: '0',
      available: row.available,
    }));
  const targetHolds = fields.evidence.holds
    .filter((row) => row.accountId === b.accountId)
    .map((row) => ({
      id: row.id,
      asset: row.asset,
      amount: row.amount,
      unknown: row.unknown,
      reflected: row.reflected,
    }));
  const bookHolds = p.before.holds.map((row) => ({
    id: row.id,
    asset: row.asset,
    amount: row.amount,
    unknown: row.status === 'UNKNOWN',
    reflected: row.reflected,
  }));
  if (
    b.tenantId !== expected.binding.tenantId ||
    b.accountId !== expected.binding.accountId ||
    b.mode !== 'PAPER' ||
    b.connectionId !== null ||
    b.externalAccountId !== expected.binding.externalAccountId ||
    b.walletId !== 'paper-initial:' + p.bookId ||
    !sameMarketScope(b.scope, expected.binding.profile) ||
    fields.record.instrument.quoteAsset !== limits.valuationAsset ||
    fields.evidence.positions.length !== 0 ||
    fields.evidence.balances.some((row) => row.asset !== limits.valuationAsset) ||
    fields.evidence.holds.some((row) => row.reflected) ||
    p.before.status !== 'RECONCILED' ||
    p.before.pending.length !== 0 ||
    p.before.positions.length !== 0 ||
    p.before.differences.length !== 0 ||
    p.before.lastEconomicAt !== null ||
    p.before.snapshotAt === null ||
    p.before.snapshotAt > c.createdAt ||
    p.before.snapshotId === null ||
    !same([...p.before.balances].sort(byAsset), targetBalances.sort(byAsset)) ||
    !same(bookHolds.sort(byId), targetHolds.sort(byId)) ||
    BigInt(p.revision) !== BigInt(p.previousRevision) + BigInt(p.events.length) ||
    p.events.length !== r.debits.length ||
    new Set(r.debits.map((d) => d.holdId)).size !== r.debits.length ||
    new Set(p.events.map((e) => e.id)).size !== p.events.length
  )
    fail();
  let state = p.before;
  for (const [i, event] of p.events.entries()) {
    const d = r.debits[i]!;
    if (
      event.type !== 'COMMITMENT' ||
      event.timestamp !== c.createdAt ||
      event.hold.id !== d.holdId ||
      event.hold.asset !== d.asset ||
      event.hold.amount !== d.amount ||
      event.hold.status !== 'RESERVED' ||
      event.hold.reflected ||
      state.holds.some((h) => h.id === d.holdId)
    )
      fail();
    const reduced = reducePortfolio(state, event, { now: () => now, holdWatermark: null });
    if (reduced.ignored || !reduced.holdWatermark || reduced.postings.length) fail();
    state = reduced.state;
  }
  if (canonical(state) !== p.afterText || hash(p.afterText) !== p.afterHash) fail();
}

/** Server-only candidate backed by the fixed additive53 SQL authority. Full
 * PHASE13 acceptance is still required. No package root export, native mode
 * relaxation or Paper dispatch is introduced. This port never accepts a caller snapshot,
 * certificate, evaluation, financial writer or transport callback. */
export async function createPostgresPaperOrderRiskPort(options: unknown) {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async approve(raw: OrderRiskApprovalInput, io: PaperFundingIo) {
      const expected = lookup(raw);
      const approved = await database.transaction(expected.binding.tenantId, io, async (sql) => {
        const row = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
          [canonical(expected)],
        );
        try {
          const r = reply.parse(singleResult(row.rows));
          if (!same(r.request, expected)) fail('PAPER_ADMISSION_CONFLICT');
          if (r.kind === 'RESERVED') verifyReserved(r, expected);
          if (r.receipt.expiresAt <= Date.now()) fail('PAPER_ADMISSION_EXPIRED');
          return immutable(r.receipt);
        } catch (error) {
          throw new Error(
            error instanceof Error &&
              [
                'PAPER_ADMISSION_EVIDENCE',
                'PAPER_ADMISSION_CONFLICT',
                'PAPER_ADMISSION_EXPIRED',
                'PAPER_ADMISSION_LIMIT',
              ].includes(error.message)
              ? error.message
              : 'PAPER_ADMISSION_EVIDENCE',
            {
              // eslint-disable-next-line preserve-caught-error -- Source/SQL/book payloads remain inside the authority boundary.
              cause: new Error('PAPER_ADMISSION_REPLY_INVALID'),
            },
          );
        }
      });
      if (approved.expiresAt <= Date.now()) fail('PAPER_ADMISSION_EXPIRED');
      return approved;
    },
    async reconcileApproval(raw: OrderRiskApprovalInput, io: PaperFundingIo) {
      const expected = lookup(raw);
      return database.transaction(expected.binding.tenantId, io, async (sql) => {
        const row = await sql.query<{ result: unknown }>(
          'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
          [canonical(expected)],
        );
        try {
          const r = z
            .discriminatedUnion('kind', [
              z.strictObject({ kind: z.literal('MISSING'), request: lookupSchema }),
              z.strictObject({ kind: z.literal('COMMITTED'), request: lookupSchema, receipt }),
            ])
            .parse(singleResult(row.rows));
          if (!same(r.request, expected)) fail('PAPER_ADMISSION_CONFLICT');
          // Historical reconciliation is neither a usable grant nor permission
          // to retry a mutation or release money on a MISSING observation.
          return immutable(r);
        } catch {
          throw new Error('PAPER_ADMISSION_EVIDENCE');
        }
      });
    },
    close: database.close,
  });
}
