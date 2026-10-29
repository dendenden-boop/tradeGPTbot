import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  immutable,
  instrumentRecordSchema,
  newOrderSchema,
  orderBookSchema,
  positiveAmountSchema,
  sameMarketScope,
  tickerSchema,
  timestampSchema,
  tradeTickSchema,
  decimalCompare,
  parseDecimal,
} from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { evaluateRiskPolicy, intersectRiskLimits, policyHeadSchema } from '@ctp/risk-engine';
import {
  paperPreparedExecutionRequestSchema,
  decodePaperAttemptJournalView,
} from './postgres-attempt-journal.js';
import { decodePaperExecutionSource } from './postgres-execution-source.js';
import { paperRiskBudgetInputSchema } from './risk-budget.js';
import { calculatePaperRetainedRiskBudget } from './retained-risk-budget.js';
import { paperExecutionControlsSchema } from './risk-authority-domain.js';
import { decodePaperRuntimeSource, paperRuntimeDependencies } from './runtime-domain.js';
import type { PaperFundingIo } from './funding-domain.js';
const uuid = z.uuid().transform((v) => v.toLowerCase()),
  digest = z.string().regex(/^[a-f0-9]{64}$/u),
  counter = z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/u)
    .refine((v) => BigInt(v) < 2n ** 63n);
export const paperExecutionRiskRequestSchema = paperPreparedExecutionRequestSchema.extend({
  kind: z.literal('PAPER_EXECUTION_RISK_CAPTURE'),
});
export type PaperExecutionRiskSourceRequest = z.infer<typeof paperExecutionRiskRequestSchema>;
export type PaperExecutionRiskSource = ReturnType<typeof decodePaperExecutionRiskSource>;
export interface PaperExecutionRiskSourceReader {
  read(
    request: PaperExecutionRiskSourceRequest,
    io: PaperFundingIo,
  ): Promise<PaperExecutionRiskSource>;
  close(): Promise<void>;
}
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
const packet = z.strictObject({
  kind: z.literal('PAPER_EXECUTION_RISK_CAPTURE'),
  request: paperExecutionRiskRequestSchema,
  asOf: timestampSchema,
  capture: z.unknown(),
  journal: z.unknown(),
  evidence: paperRiskBudgetInputSchema.shape.evidence,
  market: z.strictObject({
    record: instrumentRecordSchema,
    book: orderBookSchema,
    trade: tradeTickSchema,
    ticker: tickerSchema,
    order: newOrderSchema,
    snapshotAt: timestampSchema,
    tradeAt: timestampSchema,
    dbInstrumentId: uuid,
    dbRuleId: uuid,
    snapshotId: uuid,
    snapshotRevision: counter,
    snapshotHash: digest,
    tradeId: uuid,
    tradeRevision: counter,
  }),
  runtime: z.unknown(),
  policies: z.tuple([policyHeadSchema, policyHeadSchema]),
  controls: z.strictObject({ text: z.string().max(1048576), hash: digest }),
  loss,
  ordersInLastMinuteExcludingTarget: z.number().int().min(0).max(1000000),
  reservation: z.strictObject({
    id: uuid,
    decisionId: uuid,
    status: z.literal('ACTIVE'),
    revision: z.literal('1'),
    expiresAt: timestampSchema,
  }),
});
const D = Decimal.clone({
  precision: 120,
  rounding: Decimal.ROUND_HALF_EVEN,
  modulo: Decimal.ROUND_FLOOR,
  minE: -100,
  maxE: 100,
  toExpNeg: -100,
  toExpPos: 100,
  crypto: false,
});
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
function bounded(raw: unknown) {
  const active = new WeakSet<object>();
  let nodes = 0,
    bytes = 0;
  const maximum: Record<string, number> = {
    candidates: 300,
    orders: 1000,
    reservations: 1000,
    holds: 1000,
    balances: 3200,
    accountIds: 100,
    bids: 1000,
    asks: 1000,
  };
  function visit(v: unknown, depth: number, key: string) {
    if (++nodes > 200000 || depth > 24) fail('PAPER_ADMISSION_LIMIT');
    if (typeof v === 'string') {
      if (v.length > 1048576) fail('PAPER_ADMISSION_LIMIT');
      bytes += Buffer.byteLength(v);
    } else if (v === null || typeof v === 'boolean') return;
    else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) fail();
    } else if (typeof v === 'object') {
      if (active.has(v)) fail();
      active.add(v);
      if (Array.isArray(v)) {
        if (v.length > (maximum[key] ?? 10000)) fail('PAPER_ADMISSION_LIMIT');
        for (let n = 0; n < v.length; n++) {
          const d = Object.getOwnPropertyDescriptor(v, String(n));
          if (!d || !d.enumerable || !('value' in d)) fail();
          visit(d.value, depth + 1, key);
        }
        if (Reflect.ownKeys(v).length !== v.length + 1) fail();
      } else {
        const proto = Object.getPrototypeOf(v) as unknown;
        if (proto !== Object.prototype && proto !== null) fail();
        const keys = Reflect.ownKeys(v);
        if (keys.length > 64) fail();
        for (const k of keys) {
          if (typeof k !== 'string' || k.length > 64) fail();
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d || !d.enumerable || !('value' in d)) fail();
          bytes += Buffer.byteLength(k);
          visit(d.value, depth + 1, k);
        }
      }
      active.delete(v);
    } else fail();
    if (bytes > 8388608) fail('PAPER_ADMISSION_LIMIT');
  }
  visit(raw, 0, '');
}
export function executionRiskLookup(raw: unknown): PaperExecutionRiskSourceRequest {
  const p = paperExecutionRiskRequestSchema.safeParse(raw);
  if (!p.success) fail('PAPER_ADMISSION_INPUT');
  const r = p.data,
    b = r.admission.binding;
  if (
    b.mode !== 'PAPER' ||
    b.connectionId !== null ||
    b.profile.market !== 'SPOT' ||
    b.profile.accountMode !== 'SIMULATED' ||
    b.profile.endpointProfileId !== 'paper-spot-v1' ||
    b.profile.profileVersion !== 'spot-l2-taker-v1'
  )
    fail('PAPER_ADMISSION_UNSUPPORTED');
  return immutable(r);
}
/** Internal wire decoder. Only fixed locked SQL establishes provenance. The
 * returned EVALUATED is current read evidence, never a durable grant/START or
 * one-use permit. The future writer must repeat this boundary atomically. */
export function decodePaperExecutionRiskSource(
  raw: unknown,
  request: PaperExecutionRiskSourceRequest,
  now: number,
) {
  try {
    bounded(raw);
    const w = packet.parse(raw);
    if (!same(w.request, request) || w.asOf > now) fail();
    const binding = request.admission.binding,
      owner = { tenantId: binding.tenantId, accountId: binding.accountId, mode: 'PAPER' as const };
    const captureRequest = {
      kind: 'PAPER_EXECUTION_CAPTURE' as const,
      admission: request.admission,
      authorization: request.authorization,
    };
    const source = decodePaperExecutionSource(w.capture, captureRequest, now);
    const journalRequest = {
      kind: 'PAPER_ATTEMPT_PREPARE' as const,
      key: request.preparationKey,
      admission: request.admission,
      authorization: request.authorization,
    };
    const journal = decodePaperAttemptJournalView(w.journal, journalRequest, 'COMMITTED');
    if (
      journal.kind !== 'COMMITTED' ||
      journal.withdrawal !== null ||
      journal.state.phase !== 'PREPARED'
    )
      fail();
    const preparation = journal.preparation,
      a = preparation.request.admission,
      target = source.candidates.find((c) => c.orderId === a.orderId && c.intentId === a.intentId);
    if (
      !target ||
      !same(a, {
        binding,
        orderId: target.orderId,
        intentId: target.intentId,
        decisionId: target.decisionId,
        reservationId: target.reservationId,
        dbInstrumentId: target.dbInstrumentId,
        dbRuleId: target.dbRuleId,
        command: target.command,
        commandHash: target.commandHash,
        admissionSequence: target.admissionSequence,
        admittedAt: target.admittedAt,
        expiresAt: target.original.expiresAt,
      }) ||
      preparation.request.preparedAt > w.asOf ||
      source.asOf > w.asOf ||
      w.evidence.asOf > w.asOf
    )
      fail();
    const [platform, user] = w.policies;
    if (
      platform.scope.kind !== 'PLATFORM' ||
      user.scope.kind !== 'USER' ||
      user.scope.tenantId !== owner.tenantId ||
      platform.mode !== 'PAPER' ||
      user.mode !== 'PAPER'
    )
      fail();
    const effective = intersectRiskLimits(platform.limits, user.limits),
      age = Math.min(effective.maxEvidenceAgeMs, source.model.maxEvidenceAgeMs);
    if (
      source.maxEvidenceAgeMs !== age ||
      effective.valuationAsset !== source.market.record.instrument.quoteAsset
    )
      fail();
    const runtime = decodePaperRuntimeSource(w.runtime, owner, now),
      cfg = runtime.configuration.configuration;
    if (
      runtime.asOf > w.asOf ||
      cfg.id !== source.configurationId ||
      !same(cfg.model, source.model) ||
      !sameMarketScope(cfg.source, binding.profile) ||
      cfg.valuationAsset !== effective.valuationAsset ||
      runtime.current.permissionEpoch !== request.authorization.permissionEpoch ||
      runtime.current.userSessionEpoch !== request.authorization.userSessionEpoch ||
      runtime.current.externalAccountId !== binding.externalAccountId
    )
      fail();
    const market = w.market,
      s = source.market;
    if (
      !same(market.record, s.record) ||
      !same(market.book, s.book) ||
      !same(market.trade, s.trade) ||
      !same(market.order, a.command) ||
      market.dbInstrumentId !== s.dbInstrumentId ||
      market.dbRuleId !== s.dbRuleId ||
      market.snapshotId !== s.snapshot.id ||
      market.snapshotRevision !== s.snapshot.revision ||
      market.snapshotHash !== s.snapshot.hash ||
      market.tradeId !== s.tradeReference.id ||
      market.tradeRevision !== s.tradeReference.revision ||
      market.snapshotAt !== s.snapshotAt ||
      market.tradeAt !== s.tradeAt
    )
      fail();
    const ticker = market.ticker;
    if (
      !sameMarketScope(ticker.scope, binding.profile) ||
      ticker.instrumentId !== a.command.instrumentId ||
      ticker.last.state !== 'AVAILABLE' ||
      ticker.exchangeTime === null
    )
      fail();
    const targetBalances = w.evidence.balances.filter((b) => b.accountId === owner.accountId),
      targetHolds = w.evidence.holds.filter((h) => h.accountId === owner.accountId);
    if (
      !same(
        targetBalances.map(({ asset, available }) => ({ asset, available })),
        source.portfolio.balances.map(({ asset, available }) => ({ asset, available })),
      ) ||
      !same(
        targetHolds
          .map((h) => ({
            id: h.id,
            asset: h.asset,
            amount: h.amount,
            status: h.unknown ? 'UNKNOWN' : 'RESERVED',
            reflected: h.reflected,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        [...source.portfolio.holds].sort((a, b) => a.id.localeCompare(b.id)),
      )
    )
      fail();
    const controlsRaw = JSON.parse(w.controls.text) as unknown;
    bounded(controlsRaw);
    if (createHash('sha256').update(w.controls.text).digest('hex') !== w.controls.hash) fail();
    const controls = paperExecutionControlsSchema.parse(controlsRaw);
    if (
      controls.global.some((h) => h.scope.kind !== 'GLOBAL') ||
      controls.tenant.some((h) => h.scope.kind === 'GLOBAL' || h.scope.tenantId !== owner.tenantId)
    )
      fail();
    const all = [...controls.global, ...controls.tenant];
    if (
      new Set(all.map((h) => canonical([h.scope, h.kind, h.key]))).size !== all.length ||
      new Set(controls.activePauses).size !== controls.activePauses.length ||
      new Set(controls.circuits.map((c) => c.id)).size !== controls.circuits.length
    )
      fail();
    const globalKill = controls.global.find((h) => h.kind === 'KILL_SWITCH' && h.key === 'kill');
    const pauses = {
      global: !globalKill || globalKill.state !== 'RUNNING',
      user:
        controls.activePauses.length > 0 ||
        controls.tenant.some((h) => h.kind === 'KILL_SWITCH' && h.state !== 'RUNNING'),
      connection: false,
      strategy: false,
    };
    const circuit = [...all.filter((h) => h.kind === 'CIRCUIT'), ...controls.circuits].some(
      (h) => h.state !== 'CLOSED',
    )
      ? ('OPEN' as const)
      : ('CLOSED' as const);
    const facts = paperRuntimeDependencies.map((k) => runtime.health[k]),
      times = [
        source.asOf,
        w.evidence.asOf,
        ticker.receivedAt,
        ticker.exchangeTime,
        ...facts.map((f) => f.asOf),
      ];
    if (times.some((at) => at > w.asOf || now - at > age)) fail('PAPER_ADMISSION_EXPIRED');
    const day = Math.floor(w.asOf / 86400000) * 86400000,
      loss = w.loss;
    if (
      loss.utcDayStart !== day ||
      loss.asset !== effective.valuationAsset ||
      loss.baselineAt > w.asOf ||
      (loss.kind === 'UTC_CASH' ? loss.baselineAt !== day : loss.baselineAt < day)
    )
      fail();
    const opening = loss.kind === 'UTC_CASH' ? loss.openingEquity : loss.initialCapital;
    const validUntil = Math.min(
      a.expiresAt,
      source.validUntil,
      runtime.validUntil,
      day + 86400000,
      ...times.map((t) => t + age + 1),
    );
    if (now >= validUntil) fail('PAPER_ADMISSION_EXPIRED');
    const budgetInput = {
      now,
      owner,
      target: { orderId: a.orderId, intentId: a.intentId },
      model: source.model,
      record: s.record,
      book: s.book,
      trade: s.trade,
      order: a.command,
      platform: platform.limits,
      user: user.limits,
      fx: {
        from: s.record.instrument.quoteAsset,
        to: effective.valuationAsset,
        rate: '1',
        kind: 'IDENTITY' as const,
        sourceId: 'paper-identity-fx',
        asOf: w.evidence.asOf,
      },
      evidence: w.evidence,
    };
    const retained = calculatePaperRetainedRiskBudget({
        now,
        deadline: validUntil,
        preparation,
        metadata: { instrumentId: s.dbInstrumentId, ruleId: s.dbRuleId },
        reservation: w.reservation,
        budget: budgetInput,
      }),
      b = retained.budget;
    const referencePrice = ticker.last.value,
      bid = s.book.bids[0]!.price,
      ask = s.book.asks[0]!.price,
      step = new D(s.record.rules.stepSize);
    const liquidity = D.min(s.book.bids[0]!.quantity, s.book.asks[0]!.quantity, s.trade.quantity)
      .mul(source.model.participationRate)
      .div(step)
      .floor()
      .mul(step)
      .mul(D.min(bid, ask))
      .toFixed();
    const sourceAt = Math.min(
        ...times,
        market.snapshotAt,
        market.tradeAt,
        s.book.receivedAt,
        s.book.exchangeTime ?? s.book.receivedAt,
        s.trade.receivedAt,
        s.trade.exchangeTime,
      ),
      sourceId = 'paper-execution-risk:' + preparation.request.attemptId,
      revision = a.admissionSequence;
    const profile = binding.profile,
      policyBinding = { ...owner, profile };
    const capabilities = (['LIMIT_ORDER', 'MARKET_ORDER'] as const).map((feature) => ({
      profile,
      feature,
      support: 'SUPPORTED',
      implementation: 'SYNTHETIC',
      constraints: { instrumentIds: [a.command.instrumentId] },
      evidenceUrl:
        'https://github.com/dendenden-boop/tradeGPTbot/blob/8dd14f4b77c3bda8a5f0df3003be54adde55bd07/packages/paper-engine/src/model.ts',
      checkedAt: w.asOf,
      expiresAt: validUntil,
      adapterVersion: 'paper-spot-l2-taker-v1',
    }));
    const evaluation = evaluateRiskPolicy({
      now,
      binding: policyBinding,
      adapterVersion: 'paper-spot-l2-taker-v1',
      platform: platform.limits,
      user: user.limits,
      order: a.command,
      record: { instrument: s.record.instrument, rules: s.record.rules },
      capabilities,
      snapshot: {
        binding: policyBinding,
        instrumentId: a.command.instrumentId,
        revision,
        sourceId,
        sourceAt,
        reconciledAt: w.asOf,
        complete: true,
        unknownExposure: false,
        valuationAsset: effective.valuationAsset,
        instrumentExposure: b.current.instrument,
        assetExposure: b.current.asset,
        accountExposure: b.current.account,
        userExposure: b.current.user,
        positionQuantity: '0',
        positionEvidence: {
          mode: 'SPOT',
          accountMode: 'SIMULATED',
          accountId: owner.accountId,
          instrumentId: a.command.instrumentId,
          sourceId,
          revision,
          asOf: w.asOf,
          side: 'NET',
          quantity: '0',
        },
        committedReductionQuantity: '0',
        instrumentHasPendingEntry: w.evidence.reservations.some(
          (r) =>
            r.id !== a.reservationId &&
            r.accountId === owner.accountId &&
            r.instrumentId === a.command.instrumentId,
        ),
        concurrentPositions: b.potentialPositions.current,
        openOrders: b.orders.current,
        ordersInLastMinute: w.ordersInLastMinuteExcludingTarget,
        leverage: '1',
        availableAsset: effective.valuationAsset,
        availableAmount: b.coverage.debits[0]!.available,
        dailyNetRealizedPnl: '0',
        adjustedOpeningEquity: opening,
        adjustedCurrentEquity: opening,
        adjustedPeakEquity: opening,
        utcDayStart: day,
        lossBaselineComplete: true,
        pauses,
        circuit,
        health: {
          database: runtime.health.database.status,
          limiter: runtime.health.limiter.status,
          authentication: runtime.health.authentication.status,
          exchangeRest: runtime.health.publicMarket.status,
          privateStream: runtime.health.executor.status,
          clock: runtime.health.clock.status,
          latency: runtime.health.latency.status,
          rejectRate: runtime.health.rejectRate.status,
          maintenance: runtime.health.maintenance.status,
        },
        market: {
          sourceId: 'paper-market:' + s.snapshot.id,
          asOf: sourceAt,
          complete: true,
          referencePrice,
          lowerExecutionPrice: b.coverage.envelope.executionPrice.minimum,
          upperExecutionPrice: b.coverage.envelope.executionPrice.maximum,
          bid,
          ask,
          liquidityNotional: liquidity,
          liquidityAsset: effective.valuationAsset,
          priceAsset: s.record.instrument.quoteAsset,
          quoteToValuation: '1',
          fxFromAsset: s.record.instrument.quoteAsset,
          fxToAsset: effective.valuationAsset,
          fxKind: 'IDENTITY',
          fxSourceId: 'paper-identity-fx',
          fxAsOf: w.evidence.asOf,
          kind: 'LAST',
          executionBoundEnforced: true,
          feeAsset: s.record.instrument.quoteAsset,
          maxFeeRate: source.model.takerFeeRate,
        },
      },
    });
    if (evaluation.kind === 'REJECTED') fail('PAPER_ADMISSION_LIMIT');
    if (
      evaluation.effect !== 'INCREASE' ||
      evaluation.notional !== b.notional ||
      evaluation.proposal.asset !== retained.retained[0]!.asset ||
      decimalCompare(
        parseDecimal(evaluation.proposal.amount),
        parseDecimal(retained.retained[0]!.amount),
      ) > 0
    )
      fail();
    return immutable({
      kind: 'PAPER_EXECUTION_RISK_SOURCE' as const,
      request,
      asOf: w.asOf,
      validUntil,
      hash: hash(w),
      source,
      preparation,
      policies: { platform, user, effective },
      controls,
      runtime,
      loss,
      retained,
      evaluation,
    });
  } catch (error) {
    if (error instanceof Error && /^PAPER_ADMISSION_(LIMIT|EXPIRED)$/u.test(error.message))
      throw error;
    fail();
  }
}
