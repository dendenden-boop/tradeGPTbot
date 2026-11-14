import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { immutable, sameMarketScope, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { marketSnapshotPublicationSchema, marketTradePublicationSchema } from '@ctp/market-data';
import { intersectRiskLimits, policyHeadSchema, riskEvaluationInputSchema } from '@ctp/risk-engine';
import { openPaperAdmissionDatabase } from './admission-database.js';
import {
  lookupPaperExecutionCommitRequest,
  type PaperExecutionCommitRequest,
} from './postgres-execution-commit.js';
import { decodePaperHistoricalInventoryContents } from './postgres-historical-inventory.js';
import { decodePaperRuntimeSource, paperRuntimeDependencies } from './runtime-domain.js';
import { paperExecutionControlsSchema } from './risk-authority-domain.js';
import { projectPaperCurrentLoss } from './current-loss-domain.js';
import { preparePaperFrame } from './model.js';
import type { PaperFundingIo } from './funding-domain.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u),
  counter = z
    .string()
    .refine((s) => /^[1-9][0-9]{0,18}$/u.exec(s)?.[0] === s && BigInt(s) <= 9223372036854775807n),
  seal = z.strictObject({ text: z.string().min(1).max(16777216), hash: digest });
const captureSchema = z.strictObject({
  kind: z.literal('PAPER_CURRENT_RISK_CAPTURE'),
  request: z.unknown(),
  asOf: timestampSchema,
  inventory: seal,
  runtime: z.unknown(),
  policies: z.tuple([policyHeadSchema, policyHeadSchema]),
  controls: seal,
  market: z.strictObject({ snapshot: seal, trade: seal }),
  capability: z.strictObject({
    adapterVersion: z.literal('paper-spot-l2-taker-v1'),
    modelHash: digest,
    checkedAt: timestampSchema,
    expiresAt: timestampSchema,
  }),
  lossInput: z.unknown(),
  loss: seal,
  lossReference: z.strictObject({
    id: z.uuid(),
    revision: counter,
    dayStart: timestampSchema,
    hash: digest,
  }),
  fingerprint: digest,
  sourceHeads: digest,
  ordersInLastMinute: z.number().int().min(0).max(1000000),
});
const certificateSchema = z.strictObject({
  kind: z.literal('PAPER_CURRENT_RISK_CERTIFICATE'),
  version: z.literal('paper-current-risk-v1'),
  id: z.uuid(),
  revision: counter,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  source: captureSchema,
});
const replySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('CERTIFIED'), certificate: seal }),
  z.strictObject({ kind: z.literal('ADVANCED'), source: captureSchema }),
  z.strictObject({ kind: z.literal('MISSING') }),
  z.strictObject({ kind: z.literal('REPLACED') }),
  z.strictObject({ kind: z.literal('INCOMPLETE') }),
]);
const D = Decimal.clone({
  precision: 120,
  rounding: Decimal.ROUND_HALF_EVEN,
  minE: -100,
  maxE: 100,
  toExpNeg: -100,
  toExpPos: 100,
  crypto: false,
});
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function fail(code = 'EVIDENCE'): never {
  throw Error('PAPER_CURRENT_RISK_' + code);
}
export type PaperCurrentRiskRequest = Omit<PaperExecutionCommitRequest, 'kind'> & {
  kind: 'PAPER_CURRENT_RISK_CERTIFY';
};
function lookup(raw: unknown) {
  const value = lookupPaperExecutionCommitRequest(raw, 'PAPER_CURRENT_RISK_CERTIFY');
  return immutable({ ...value, kind: 'PAPER_CURRENT_RISK_CERTIFY' as const });
}
function bounded(raw: unknown) {
  const active = new WeakSet<object>();
  let nodes = 0,
    bytes = 0;
  function walk(v: unknown, depth: number) {
    if (++nodes > 400000 || depth > 40) fail('LIMIT');
    if (typeof v === 'string') bytes += Buffer.byteLength(v);
    else if (v === null || typeof v === 'boolean') return;
    else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) fail();
    } else if (typeof v === 'object') {
      if (active.has(v)) fail();
      active.add(v);
      if (Array.isArray(v)) {
        if (v.length > 10000 || Reflect.ownKeys(v).length !== v.length + 1) fail('LIMIT');
        for (let i = 0; i < v.length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d?.enumerable || !('value' in d)) fail();
          walk(d.value, depth + 1);
        }
      } else {
        const proto = Object.getPrototypeOf(v) as unknown,
          keys = Reflect.ownKeys(v);
        if ((proto !== Object.prototype && proto !== null) || keys.length > 64) fail();
        for (const k of keys) {
          if (typeof k !== 'string' || k.length > 128) fail();
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d?.enumerable || !('value' in d)) fail();
          bytes += Buffer.byteLength(k);
          walk(d.value, depth + 1);
        }
      }
      active.delete(v);
    } else fail();
    if (bytes > 16777216) fail('LIMIT');
  }
  walk(raw, 0);
}
function contents(raw: z.infer<typeof seal>): unknown {
  if (hash(raw.text) !== raw.hash) fail();
  const value: unknown = JSON.parse(raw.text);
  bounded(value);
  return value;
}

function capture(raw: unknown, request: PaperCurrentRiskRequest, now: number) {
  const w = captureSchema.parse(raw);
  if (!same(w.request, request) || w.asOf > now) fail();
  const inventoryWire = contents(w.inventory),
    inventory = decodePaperHistoricalInventoryContents(
      inventoryWire,
      { ...request, kind: 'PAPER_EXECUTION_COMMIT' as const },
      w.asOf,
    ),
    owner = {
      tenantId: request.admission.binding.tenantId,
      accountId: request.admission.binding.accountId,
      mode: 'PAPER' as const,
    },
    target = inventory.accounts.find((a) => a.accountId === owner.accountId);
  if (!target) fail();
  const execution = z
      .object({
        executed: z.object({
          execution: z.object({
            receipt: z.object({ executionId: z.uuid() }),
            input: z.object({
              attempt: z.object({
                request: z.object({
                  admission: z.object({
                    dbInstrumentId: z.uuid(),
                    command: z.object({ instrumentId: z.string() }),
                  }),
                }),
              }),
            }),
          }),
        }),
      })
      .parse(inventoryWire),
    admitted = execution.executed.execution.input.attempt.request.admission;
  const runtime = decodePaperRuntimeSource(w.runtime, owner, w.asOf),
    cfg = target.configuration.configuration,
    [platform, user] = w.policies;
  if (
    platform.mode !== 'PAPER' ||
    platform.scope.kind !== 'PLATFORM' ||
    user.mode !== 'PAPER' ||
    user.scope.kind !== 'USER' ||
    user.scope.tenantId !== owner.tenantId
  )
    fail();
  const limits = intersectRiskLimits(platform.limits, user.limits),
    age = Math.min(5000, cfg.model.maxEvidenceAgeMs, limits.maxEvidenceAgeMs);
  if (
    limits.valuationAsset !== inventory.valuation.quote ||
    limits.valuationAsset !== cfg.valuationAsset ||
    !same(runtime.configuration, target.configuration) ||
    runtime.current.permissionEpoch !== request.authorization.permissionEpoch ||
    runtime.current.userSessionEpoch !== request.authorization.userSessionEpoch ||
    runtime.current.accountVersion !== target.accountState.version ||
    runtime.current.permissionEpoch !== target.accountState.permissionEpoch ||
    runtime.current.externalAccountId !== request.admission.binding.externalAccountId ||
    runtime.asOf > w.asOf
  )
    fail();
  const snapshot = marketSnapshotPublicationSchema.parse(contents(w.market.snapshot)),
    trade = marketTradePublicationSchema.parse(contents(w.market.trade));
  if (
    snapshot.kind !== 'SNAPSHOT' ||
    trade.kind !== 'TRADE' ||
    snapshot.ticker.last.state !== 'AVAILABLE'
  )
    fail();
  if (
    !sameMarketScope(snapshot.key.scope, cfg.source) ||
    !sameMarketScope(trade.key.scope, cfg.source) ||
    snapshot.key.dbInstrumentId !== admitted.dbInstrumentId ||
    trade.key.dbInstrumentId !== snapshot.key.dbInstrumentId ||
    trade.key.dbRuleId !== snapshot.key.dbRuleId ||
    trade.key.instrumentId !== snapshot.key.instrumentId ||
    snapshot.key.instrumentId !== admitted.command.instrumentId ||
    snapshot.record.instrument.quoteAsset !== cfg.valuationAsset
  )
    fail();
  const reference = inventory.markets.find((m) => m.id === snapshot.id);
  if (
    !reference ||
    reference.hash !== w.market.snapshot.hash ||
    reference.dbRuleId !== snapshot.key.dbRuleId
  )
    fail();
  preparePaperFrame({
    now: w.asOf,
    model: cfg.model,
    record: snapshot.record,
    book: snapshot.book,
    trade: trade.trade,
  });
  if (
    !sameMarketScope(request.admission.binding.profile, cfg.source) ||
    request.admission.binding.profile.accountMode !== 'SIMULATED' ||
    request.admission.binding.profile.endpointProfileId !== 'paper-spot-v1' ||
    request.admission.binding.profile.profileVersion !== cfg.model.version
  )
    fail();
  const controls = paperExecutionControlsSchema.parse(contents(w.controls)),
    all = [...controls.global, ...controls.tenant];
  if (
    controls.global.some((c) => c.scope.kind !== 'GLOBAL') ||
    controls.tenant.some((c) => c.scope.kind === 'GLOBAL' || c.scope.tenantId !== owner.tenantId) ||
    new Set(all.map((c) => canonical([c.scope, c.kind, c.key]))).size !== all.length ||
    new Set(controls.activePauses).size !== controls.activePauses.length ||
    new Set(controls.circuits.map((c) => c.id)).size !== controls.circuits.length
  )
    fail();
  const global = controls.global.find((c) => c.kind === 'KILL_SWITCH' && c.key === 'kill');
  if (!global) fail();
  const loss = projectPaperCurrentLoss(w.lossInput, w.asOf),
    storedLoss = contents(w.loss),
    lossFacts = z
      .object({
        maxEvidenceAgeMs: z.number(),
        capturedAt: timestampSchema,
        current: z.object({ sourceHash: digest, sourceAt: timestampSchema }),
      })
      .parse(w.lossInput);
  if (
    !same(loss, storedLoss) ||
    loss.asOf !== w.asOf ||
    lossFacts.capturedAt !== w.asOf ||
    lossFacts.maxEvidenceAgeMs !== age ||
    lossFacts.current.sourceHash !== w.inventory.hash ||
    lossFacts.current.sourceAt !== inventory.asOf ||
    loss.scope.tenantId !== owner.tenantId ||
    loss.scope.mode !== 'PAPER' ||
    loss.scope.valuationAsset !== limits.valuationAsset ||
    loss.executionId !== execution.executed.execution.receipt.executionId ||
    loss.actualEquity !== inventory.valuation.equity ||
    w.lossReference.hash !== w.loss.hash ||
    w.lossReference.dayStart !== loss.utcDayStart
  )
    fail();
  const times = [
    snapshot.timestamp,
    snapshot.book.receivedAt,
    snapshot.book.exchangeTime,
    snapshot.ticker.receivedAt,
    snapshot.ticker.exchangeTime,
    trade.timestamp,
    trade.trade.receivedAt,
    trade.trade.exchangeTime,
    ...paperRuntimeDependencies.map((k) => runtime.health[k].asOf),
  ].filter((t): t is number => t !== null);
  if (
    times.some((t) => t > w.asOf || now - t > age) ||
    w.capability.modelHash !== hash(canonical(cfg.model)) ||
    w.capability.checkedAt !== runtime.reference.publishedAt ||
    w.capability.expiresAt <= w.capability.checkedAt
  )
    fail();
  const sourceUntil = Math.min(
    inventory.validUntil,
    runtime.validUntil,
    loss.validUntil,
    ...times.map((t) => t + age + 1),
  );
  if (w.capability.expiresAt > sourceUntil) fail();
  const validUntil = Math.min(sourceUntil, w.capability.expiresAt);
  if (now >= validUntil) fail('EXPIRED');
  const rawInventory = z
    .object({
      catalog: z.unknown(),
      executed: z.object({ execution: z.unknown() }),
      books: z.array(z.object({ accountId: z.uuid(), book: z.record(z.string(), z.unknown()) })),
      markets: z.array(z.object({ id: z.uuid(), revision: counter, hash: digest })),
    })
    .parse(inventoryWire);
  const sourceHeads = hash(
    canonical({
      request,
      catalog: rawInventory.catalog,
      executionHash: hash(canonical(rawInventory.executed.execution)),
      books: rawInventory.books.map(({ accountId, book }) => {
        const stable = Object.fromEntries(Object.entries(book).filter(([key]) => key !== 'asOf'));
        return { accountId, hash: hash(canonical(stable)) };
      }),
      markets: rawInventory.markets.map(({ id, revision, hash }) => ({ id, revision, hash })),
      runtime: runtime.reference,
      policies: w.policies,
      controlsHash: w.controls.hash,
      trade: {
        id: trade.id,
        revision: String(BigInt(trade.expectedRevision) + 1n),
        hash: w.market.trade.hash,
      },
      modelHash: w.capability.modelHash,
      ordersInLastMinute: w.ordersInLastMinute,
    }),
  );
  if (w.sourceHeads !== sourceHeads) fail();
  const fingerprint = hash(
    canonical({
      sourceHeads,
      lossHash: w.loss.hash,
      lossReference: w.lossReference,
      capability: w.capability,
    }),
  );
  if (w.fingerprint !== fingerprint) fail();
  return {
    w,
    inventory,
    target,
    runtime,
    cfg,
    platform,
    user,
    limits,
    snapshot,
    trade,
    controls,
    global,
    loss,
    validUntil,
  };
}

function decodeCertificate(raw: unknown, request: PaperCurrentRiskRequest, now: number) {
  const sealed = seal.parse(raw),
    c = certificateSchema.parse(contents(sealed));
  if (
    c.createdAt < c.source.asOf ||
    c.createdAt > now ||
    c.expiresAt <= c.createdAt ||
    c.expiresAt <= now
  )
    fail('EXPIRED');
  const s = capture(c.source, request, now);
  if (!s.loss.complete || c.expiresAt > s.validUntil) fail('INCOMPLETE');
  if (s.snapshot.ticker.last.state !== 'AVAILABLE') fail();
  const i = s.snapshot.record.instrument,
    binding = {
      tenantId: request.admission.binding.tenantId,
      accountId: request.admission.binding.accountId,
      mode: 'PAPER' as const,
      profile: request.admission.binding.profile,
    },
    id = 'paper-current-risk:' + c.id,
    balance = s.inventory.valuation.accounts
      .find((a) => a.accountId === binding.accountId)
      ?.balances.find((b) => b.asset === s.cfg.valuationAsset),
    position = s.inventory.evidence.positions.find(
      (p) => p.accountId === binding.accountId && p.instrumentId === i.id,
    ),
    bid = s.snapshot.book.bids[0]!,
    ask = s.snapshot.book.asks[0]!,
    quantity = D.min(bid.quantity, ask.quantity, s.trade.trade.quantity)
      .mul(s.cfg.model.participationRate)
      .div(s.snapshot.record.rules.stepSize)
      .floor()
      .mul(s.snapshot.record.rules.stepSize),
    liquidity = quantity
      .mul(D.min(bid.price, ask.price))
      .toDecimalPlaces(18, Decimal.ROUND_FLOOR)
      .toFixed();
  if (!balance || balance.spendable === null) fail();
  const snapshot = riskEvaluationInputSchema.shape.snapshot.parse({
    binding,
    instrumentId: i.id,
    revision: c.revision,
    sourceId: id,
    sourceAt: s.inventory.asOf,
    reconciledAt: c.source.asOf,
    complete: true,
    unknownExposure: false,
    valuationAsset: s.cfg.valuationAsset,
    instrumentExposure: s.inventory.exposure.instrumentExposure,
    assetExposure: s.inventory.exposure.assetExposure,
    accountExposure: s.inventory.exposure.accountExposure,
    userExposure: s.inventory.exposure.userExposure,
    positionQuantity: position?.quantity ?? '0',
    positionEvidence: {
      mode: 'SPOT',
      accountMode: 'SIMULATED',
      accountId: binding.accountId,
      instrumentId: i.id,
      sourceId: id,
      revision: c.revision,
      asOf: position?.at ?? s.inventory.asOf,
      side: 'NET',
      quantity: position?.quantity ?? '0',
    },
    committedReductionQuantity: s.inventory.exposure.committedReductionQuantity,
    instrumentHasPendingEntry: s.inventory.exposure.instrumentHasPendingEntry,
    concurrentPositions: s.inventory.exposure.concurrentPositions,
    openOrders: s.inventory.exposure.openOrders,
    ordersInLastMinute: c.source.ordersInLastMinute,
    leverage: '1',
    availableAsset: s.cfg.valuationAsset,
    availableAmount: balance.spendable,
    dailyNetRealizedPnl: s.loss.dailyNetRealizedPnl,
    adjustedOpeningEquity: s.loss.adjustedOpeningEquity,
    adjustedCurrentEquity: s.loss.adjustedCurrentEquity,
    adjustedPeakEquity: s.loss.adjustedPeakEquity,
    utcDayStart: s.loss.utcDayStart,
    lossBaselineComplete: true,
    pauses: {
      global: s.global.state !== 'RUNNING',
      user:
        s.controls.activePauses.length > 0 ||
        s.controls.tenant.some((h) => h.kind === 'KILL_SWITCH' && h.state !== 'RUNNING'),
      connection: false,
      strategy: false,
    },
    circuit:
      [...s.controls.global, ...s.controls.tenant].some(
        (h) => h.kind === 'CIRCUIT' && h.state !== 'CLOSED',
      ) || s.controls.circuits.some((h) => h.state !== 'CLOSED')
        ? 'OPEN'
        : 'CLOSED',
    health: {
      database: s.runtime.health.database.status,
      limiter: s.runtime.health.limiter.status,
      authentication: s.runtime.health.authentication.status,
      exchangeRest: s.runtime.health.publicMarket.status,
      privateStream: s.runtime.health.executor.status,
      clock: s.runtime.health.clock.status,
      latency: s.runtime.health.latency.status,
      rejectRate: s.runtime.health.rejectRate.status,
      maintenance: s.runtime.health.maintenance.status,
    },
    market: {
      sourceId: 'paper-market:' + s.snapshot.id,
      asOf: s.inventory.asOf,
      complete: true,
      referencePrice: s.snapshot.ticker.last.value,
      lowerExecutionPrice: bid.price,
      upperExecutionPrice: ask.price,
      bid: bid.price,
      ask: ask.price,
      liquidityNotional: liquidity,
      liquidityAsset: s.cfg.valuationAsset,
      priceAsset: i.quoteAsset,
      quoteToValuation: '1',
      fxFromAsset: i.quoteAsset,
      fxToAsset: s.cfg.valuationAsset,
      fxKind: 'IDENTITY',
      fxSourceId: 'paper-identity-fx',
      fxAsOf: s.inventory.asOf,
      kind: 'LAST',
      // Current state is not a command-bound execution authorization.
      executionBoundEnforced: false,
      feeAsset: i.quoteAsset,
      maxFeeRate: s.cfg.model.takerFeeRate,
    },
  });
  const capabilities = riskEvaluationInputSchema.shape.capabilities.parse(
    ['LIMIT_ORDER', 'MARKET_ORDER'].map((feature) => ({
      profile: binding.profile,
      feature,
      support: 'SUPPORTED',
      implementation: 'SYNTHETIC',
      constraints: { instrumentIds: [i.id] },
      evidenceUrl:
        'https://github.com/dendenden-boop/tradeGPTbot/blob/8dd14f4b77c3bda8a5f0df3003be54adde55bd07/packages/paper-engine/src/model.ts',
      checkedAt: c.source.capability.checkedAt,
      expiresAt: c.source.capability.expiresAt,
      adapterVersion: 'paper-spot-l2-taker-v1',
    })),
  );
  return immutable({
    kind: 'PAPER_CURRENT_RISK_CERTIFICATE' as const,
    version: c.version,
    id: c.id,
    revision: c.revision,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    hash: sealed.hash,
    sourceFingerprint: c.source.fingerprint,
    scope: {
      ...binding,
      connectionId: null,
      externalAccountId: request.admission.binding.externalAccountId,
      instrumentId: i.id,
      dbInstrumentId: s.snapshot.key.dbInstrumentId,
      dbRuleId: s.snapshot.key.dbRuleId,
      executionKey: request.executionKey,
    },
    inventory: s.inventory,
    loss: { ...s.loss, reference: s.w.lossReference },
    policies: { platform: s.platform, user: s.user, effective: s.limits },
    capabilities: { adapterVersion: c.source.capability.adapterVersion, features: capabilities },
    runtime: s.runtime,
    controls: s.controls,
    snapshot,
  });
}

export type PaperCurrentRiskCertificate = ReturnType<typeof decodeCertificate>;
// Internal wire validation only; not exported by any package entrypoint.
export { decodeCertificate as decodePaperCurrentRiskContents };
export type PaperCurrentLossProgress = Readonly<{
  kind: 'PAPER_CURRENT_LOSS_PROGRESS';
  complete: boolean;
  loss: ReturnType<typeof projectPaperCurrentLoss>;
  reference: z.infer<typeof captureSchema>['lossReference'];
}>;
export interface PaperCurrentRiskCoordinator {
  certify(
    request: PaperCurrentRiskRequest,
    io: PaperFundingIo,
  ): Promise<PaperCurrentRiskCertificate>;
  readCurrent(
    request: PaperCurrentRiskRequest,
    io: PaperFundingIo,
  ): Promise<PaperCurrentRiskCertificate>;
  advanceLoss(
    request: PaperCurrentRiskRequest,
    io: PaperFundingIo,
  ): Promise<PaperCurrentLossProgress>;
  close(): Promise<void>;
}
/** Fixed server-only certification port. No caller evidence, backend, SQL,
 * role, clock, transport callback or Risk approval can be supplied here. */
export async function createPostgresPaperCurrentRiskCoordinator(
  options: unknown,
): Promise<PaperCurrentRiskCoordinator> {
  const database = await openPaperAdmissionDatabase(options);
  async function operate(
    raw: PaperCurrentRiskRequest,
    io: PaperFundingIo,
    operation: 'CERTIFY' | 'READ' | 'ADVANCE',
  ) {
    const request = lookup(raw),
      kind = {
        CERTIFY: 'PAPER_CURRENT_RISK_CERTIFY',
        READ: 'PAPER_CURRENT_RISK_READ',
        ADVANCE: 'PAPER_CURRENT_RISK_ADVANCE',
      }[operation];
    try {
      const result = await database.transaction(
        request.admission.binding.tenantId,
        io,
        async (sql) => {
          const rows = await sql.query<{ result: unknown }>(
            'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
            [canonical({ ...request, kind })],
          );
          if (rows.rows.length !== 1) fail();
          const rawReply = rows.rows[0]!.result;
          bounded(rawReply);
          const reply = replySchema.parse(rawReply);
          if (reply.kind === 'MISSING' || reply.kind === 'REPLACED' || reply.kind === 'INCOMPLETE')
            fail(reply.kind);
          if (reply.kind === 'CERTIFIED') {
            if (operation === 'ADVANCE') fail();
            return {
              kind: 'CERTIFIED' as const,
              value: decodeCertificate(reply.certificate, request, Date.now()),
            };
          }
          if (operation !== 'ADVANCE') fail();
          const source = capture(reply.source, request, Date.now());
          return {
            kind: 'ADVANCED' as const,
            value: immutable({
              kind: 'PAPER_CURRENT_LOSS_PROGRESS' as const,
              complete: source.loss.complete,
              loss: source.loss,
              reference: source.w.lossReference,
            }),
          };
        },
      );
      const now = Date.now(),
        until = result.kind === 'CERTIFIED' ? result.value.expiresAt : result.value.loss.validUntil,
        created = result.kind === 'CERTIFIED' ? result.value.createdAt : result.value.loss.asOf;
      if (io.signal.aborted || now >= io.deadline || now < created || now >= until) fail('EXPIRED');
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        /^PAPER_(CURRENT_RISK_[A-Z_]+|ADMISSION_[A-Z_]+)$/u.test(error.message)
      )
        throw error;
      fail();
    }
  }
  return Object.freeze({
    async certify(request: PaperCurrentRiskRequest, io: PaperFundingIo) {
      const result = await operate(request, io, 'CERTIFY');
      if (result.kind !== 'CERTIFIED') fail();
      return result.value;
    },
    async readCurrent(request: PaperCurrentRiskRequest, io: PaperFundingIo) {
      const result = await operate(request, io, 'READ');
      if (result.kind !== 'CERTIFIED') fail();
      return result.value;
    },
    async advanceLoss(request: PaperCurrentRiskRequest, io: PaperFundingIo) {
      const result = await operate(request, io, 'ADVANCE');
      if (result.kind !== 'ADVANCED') fail();
      return result.value;
    },
    close: database.close,
  });
}
