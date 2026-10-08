import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  idSchema,
  timestampSchema,
  nonNegativeDecimalSchema,
  positiveAmountSchema,
  decimalSubtract,
  decimalCompare,
  parseDecimal,
  immutable,
  sameMarketScope,
} from '@ctp/exchange-core';
import { riskEvaluationInputSchema, intersectRiskLimits } from './policy.js';
import { policyHeadSchema } from './policies.js';
import { certificateDeadline } from './certificate-deadline.js';
import { lossCheckpointSchema, consumeLossCheckpoint } from './loss-journal.js';
import {
  riskExposureEvidenceSchema,
  utcLossEvidenceSchema,
  deriveRiskExposure,
  reconstructUtcLoss,
} from './evidence.js';

const revision = z.string().regex(/^[1-9][0-9]{0,63}$/);
const epochPattern = /^(0|[1-9][0-9]{0,18})$/;
const permissionEpoch = z
  .string()
  .regex(epochPattern)
  .refine(
    (v) => epochPattern.test(v) && BigInt(v) <= 9223372036854775807n && BigInt(v).toString() === v,
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshot = riskEvaluationInputSchema.shape.snapshot;
const binding = riskEvaluationInputSchema.shape.binding
  .extend({
    connectionId: z.uuid().nullable(),
    externalAccountId: idSchema,
  })
  .superRefine((b, c) => {
    if (
      (b.mode === 'PAPER') !== (b.connectionId === null) ||
      (b.mode !== 'PAPER' && b.mode !== b.profile.environment)
    )
      c.addIssue({ code: 'custom', message: 'RISK_CERTIFICATE_SCOPE' });
  });
export const riskSnapshotKeySchema = z.strictObject({
  binding,
  instrumentId: idSchema,
  dbInstrumentId: z.uuid(),
  dbRuleId: z.uuid(),
  dbCapabilityId: z.uuid(),
  /** Required by the physical backend; reference fixtures remain compatible. */
  intentId: z.uuid().optional(),
});
export type RiskSnapshotKey = z.infer<typeof riskSnapshotKeySchema>;
const reference = z.strictObject({
  id: idSchema,
  revision,
  hash: digest,
  asOf: timestampSchema,
  complete: z.boolean(),
});
const source = <T extends z.ZodType>(value: T) => z.strictObject({ reference, value });
export const riskSnapshotSourcesSchema = z.strictObject({
  identity: source(
    z.strictObject({ key: riskSnapshotKeySchema, accountIds: z.array(z.uuid()).min(1).max(100) }),
  ),
  policies: source(z.tuple([policyHeadSchema, policyHeadSchema])),
  metadata: source(
    z.strictObject({
      record: riskEvaluationInputSchema.shape.record,
      capabilities: riskEvaluationInputSchema.shape.capabilities,
      adapterVersion: idSchema,
    }),
  ),
  portfolio: source(
    z.strictObject({
      sourceAt: timestampSchema,
      reconciledAt: timestampSchema,
      permissionEpoch,
      permissionVerifiedAt: timestampSchema,
      tradeAllowed: z.boolean(),
      withdrawalAllowed: z.boolean(),
      positionMode: z.enum(['SPOT', 'ONE_WAY', 'HEDGE']),
      positionSide: z.enum(['NET', 'LONG', 'SHORT']),
      positionQuantity: snapshot.shape.positionQuantity,
      positionAsOf: timestampSchema,
      availableAsset: idSchema,
      availableAmount: nonNegativeDecimalSchema,
      leverage: positiveAmountSchema,
      ordersInLastMinute: z.number().int().min(0).max(1_000_000),
    }),
  ),
  exposure: source(riskExposureEvidenceSchema),
  loss: source(z.union([utcLossEvidenceSchema, lossCheckpointSchema])),
  market: source(snapshot.shape.market),
  controls: source(
    z.strictObject({ pauses: snapshot.shape.pauses, circuit: snapshot.shape.circuit }),
  ),
  health: source(snapshot.shape.health),
});
export type RiskSnapshotSources = z.infer<typeof riskSnapshotSourcesSchema>;
export const riskSnapshotProjectionSchema = z.strictObject({
  key: riskSnapshotKeySchema,
  permissionEpoch,
  platform: policyHeadSchema,
  user: policyHeadSchema,
  metadata: riskSnapshotSourcesSchema.shape.metadata.shape.value,
  snapshot,
  sources: z
    .array(
      z.strictObject({
        kind: z.enum([
          'identity',
          'policies',
          'metadata',
          'portfolio',
          'exposure',
          'loss',
          'market',
          'controls',
          'health',
        ]),
        reference,
      }),
    )
    .length(9),
});
export type RiskSnapshotProjection = z.infer<typeof riskSnapshotProjectionSchema>;
export interface SnapshotIo {
  signal: AbortSignal;
  deadline: number;
}
export interface SnapshotIdentity {
  id: string;
  revision: string;
}
export const riskSnapshotCertificateSchema = z.strictObject({
  id: z.uuid(),
  revision,
  hash: digest,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  projection: riskSnapshotProjectionSchema,
});
export type RiskSnapshotCertificate = z.infer<typeof riskSnapshotCertificateSchema>;
/**
 * Required runtime persistence boundary. No reference/in-memory default exists.
 * The implementation must use one bounded PostgreSQL READ COMMITTED transaction,
 * GLOBAL -> exclusive tenant -> sorted accounts. capture() must read and prove
 * ALL source heads/current ownership, policies, rules, capabilities, books,
 * pending orders and reservations, holding their ordering locks through commit.
 * References must come from immutable durable sources, not request input.
 * insert() cannot replace a certificate or recycle a revision/identity. The
 * transaction resolves only AFTER known COMMIT; uncertainty returns no value.
 * Abort/deadline must terminate the underlying connection, not just its caller.
 */
export interface RiskSnapshotStore {
  transaction<T>(
    key: RiskSnapshotKey,
    io: SnapshotIo,
    work: (tx: {
      capture(): Promise<RiskSnapshotSources>;
      nextIdentity(): Promise<SnapshotIdentity>;
      insert(certificate: RiskSnapshotCertificate): Promise<void>;
      read(): Promise<RiskSnapshotCertificate | null>;
    }) => Promise<T>,
  ): Promise<T>;
}
/** Stable content hash; hash equality proves content, never source authority. */
export function riskEvidenceHash(value: unknown): string {
  function canonical(v: unknown): string {
    if (v === null || typeof v !== 'object') {
      const encoded = JSON.stringify(v);
      if (encoded === undefined) throw new Error('RISK_EVIDENCE_HASH');
      return encoded;
    }
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
const same = (a: unknown, b: unknown) => riskEvidenceHash(a) === riskEvidenceHash(b);
const fresh = (at: number, now: number, age: number) => at <= now && now - at <= age;

/** Internal reconstruction. Public request APIs must never accept raw sources. */
export function prepareRiskSnapshot(
  raw: unknown,
  rawKey: RiskSnapshotKey,
  identity: SnapshotIdentity,
  now: number,
): RiskSnapshotProjection {
  let s: RiskSnapshotSources, key: RiskSnapshotKey;
  try {
    s = riskSnapshotSourcesSchema.parse(raw);
    key = riskSnapshotKeySchema.parse(rawKey);
    z.strictObject({ id: z.uuid(), revision }).parse(identity);
    timestampSchema.parse(now);
  } catch {
    throw new Error('RISK_CERTIFICATE_INPUT');
  }
  const [platform, user] = s.policies.value;
  if (
    !same(s.identity.value.key, key) ||
    platform.scope.kind !== 'PLATFORM' ||
    user.scope.kind !== 'USER' ||
    user.scope.tenantId !== key.binding.tenantId ||
    platform.mode !== key.binding.mode ||
    user.mode !== key.binding.mode
  )
    throw new Error('RISK_CERTIFICATE_SCOPE');
  const limits = intersectRiskLimits(platform.limits, user.limits);
  for (const item of Object.values(s)) {
    if (
      !item.reference.complete ||
      !fresh(item.reference.asOf, now, limits.maxEvidenceAgeMs) ||
      item.reference.hash !== riskEvidenceHash(item.value)
    )
      throw new Error('RISK_CERTIFICATE_SOURCE');
  }
  const accounts = s.identity.value.accountIds;
  if (
    new Set(accounts).size !== accounts.length ||
    !accounts.includes(key.binding.accountId) ||
    !same([...accounts].sort(), [...s.exposure.value.accountIds].sort()) ||
    !fresh(s.exposure.value.now, now, limits.maxEvidenceAgeMs)
  )
    throw new Error('RISK_CERTIFICATE_COVERAGE');
  const m = s.metadata.value,
    p = s.portfolio.value;
  const r = m.record.rules,
    i = m.record.instrument;
  if (
    !sameMarketScope(i.scope, key.binding.profile) ||
    !sameMarketScope(r.scope, i.scope) ||
    i.status !== 'TRADING' ||
    r.effectiveAt > now ||
    r.expiresAt <= now ||
    !['SPOT', 'LINEAR_PERPETUAL'].includes(i.scope.market) ||
    r.quantityUnit !== 'BASE' ||
    new Set(m.capabilities.map((c) => c.feature)).size !== m.capabilities.length ||
    m.capabilities.length === 0 ||
    m.capabilities.some(
      (c) =>
        !same(c.profile, key.binding.profile) ||
        c.adapterVersion !== m.adapterVersion ||
        c.checkedAt > now ||
        c.expiresAt <= now,
    )
  )
    throw new Error('RISK_CERTIFICATE_METADATA');
  if (
    m.record.instrument.id !== key.instrumentId ||
    m.record.rules.instrumentId !== key.instrumentId ||
    !fresh(p.sourceAt, now, limits.maxEvidenceAgeMs) ||
    !fresh(p.reconciledAt, now, limits.maxEvidenceAgeMs) ||
    p.reconciledAt < p.sourceAt ||
    !fresh(p.permissionVerifiedAt, now, limits.maxEvidenceAgeMs) ||
    !p.tradeAllowed ||
    p.withdrawalAllowed
  )
    throw new Error('RISK_CERTIFICATE_AUTHORITY');
  const expectedAccountMode = {
    BINANCE: 'ONE_WAY',
    BYBIT: 'UTA2_ONE_WAY',
    OKX: 'FUTURES_MODE_NET',
    HTX: null,
  }[key.binding.profile.exchange];
  if (
    p.positionSide !== 'NET' ||
    p.positionMode !== (key.binding.profile.market === 'SPOT' ? 'SPOT' : 'ONE_WAY') ||
    (key.binding.profile.market !== 'SPOT' &&
      key.binding.profile.accountMode !== expectedAccountMode) ||
    !fresh(p.positionAsOf, now, limits.maxEvidenceAgeMs)
  )
    throw new Error('RISK_POSITION_MODE_UNPROVED');
  const scope = {
    tenantId: key.binding.tenantId,
    mode: key.binding.mode,
    valuationAsset: limits.valuationAsset,
  };
  const targetPositions = s.exposure.value.positions.filter(
    (x) => x.accountId === key.binding.accountId && x.instrumentId === key.instrumentId,
  );
  if (
    targetPositions.length > 1 ||
    (targetPositions[0]?.quantity ?? '0') !== p.positionQuantity ||
    (targetPositions[0] && targetPositions[0].base !== i.baseAsset)
  )
    throw new Error('RISK_CERTIFICATE_POSITION');
  const market = s.market.value;
  const compare = (a: string, b: string) => decimalCompare(parseDecimal(a), parseDecimal(b));
  if (
    !market.complete ||
    !fresh(market.asOf, now, limits.maxEvidenceAgeMs) ||
    !fresh(market.fxAsOf, now, limits.maxEvidenceAgeMs) ||
    market.priceAsset !== i.quoteAsset ||
    market.liquidityAsset !== limits.valuationAsset ||
    market.fxFromAsset !== i.quoteAsset ||
    market.fxToAsset !== limits.valuationAsset ||
    (market.fxFromAsset === market.fxToAsset) !== (market.fxKind === 'IDENTITY') ||
    (market.fxKind === 'IDENTITY' && market.quoteToValuation !== '1') ||
    market.kind !== (i.scope.market === 'SPOT' ? 'LAST' : 'MARK') ||
    compare(market.lowerExecutionPrice, market.upperExecutionPrice) > 0 ||
    compare(market.bid, market.ask) > 0
  )
    throw new Error('RISK_CERTIFICATE_MARKET');
  const exposures = deriveRiskExposure(
    { ...s.exposure.value, now, maxEvidenceAgeMs: limits.maxEvidenceAgeMs },
    scope,
    key.binding.accountId,
    key.instrumentId,
    m.record.instrument.baseAsset,
  );
  const lossValue = s.loss.value;
  if (
    'batchId' in lossValue &&
    (s.loss.reference.id !== lossValue.batchId ||
      s.loss.reference.revision !== lossValue.sequence ||
      s.loss.reference.asOf !== lossValue.coveredThrough)
  )
    throw new Error('RISK_CERTIFICATE_SOURCE');
  const loss =
    'batchId' in lossValue
      ? consumeLossCheckpoint(lossValue, scope, now, limits.maxEvidenceAgeMs)
      : reconstructUtcLoss(lossValue, scope, now, limits.maxEvidenceAgeMs);
  const nativeBinding = {
    tenantId: key.binding.tenantId,
    accountId: key.binding.accountId,
    mode: key.binding.mode,
    profile: key.binding.profile,
  };
  let available = p.availableAmount;
  for (const h of exposures.unreflectedHolds) {
    if (h.accountId === key.binding.accountId && h.asset === p.availableAsset)
      available = decimalSubtract(parseDecimal(available), parseDecimal(h.amount));
  }
  if (!nonNegativeDecimalSchema.safeParse(available).success)
    throw new Error('RISK_CERTIFICATE_COLLATERAL');
  const { unreflectedHolds: omitted, ...totals } = exposures;
  void omitted;
  const { externalFlows: flows, lastSequence: seq, ...daily } = loss;
  void flows;
  void seq;
  return immutable(
    riskSnapshotProjectionSchema.parse({
      key,
      permissionEpoch: p.permissionEpoch,
      platform,
      user,
      metadata: m,
      snapshot: {
        binding: nativeBinding,
        instrumentId: key.instrumentId,
        revision: identity.revision,
        sourceId: identity.id,
        sourceAt: Math.min(
          ...Object.values(s).map((x) => x.reference.asOf),
          p.sourceAt,
          market.fxAsOf,
          ...s.exposure.value.positions.flatMap((position) => [position.at, position.fx.at]),
        ),
        reconciledAt: p.reconciledAt,
        complete: true,
        valuationAsset: limits.valuationAsset,
        ...totals,
        positionQuantity: p.positionQuantity,
        positionEvidence: {
          mode: p.positionMode,
          accountMode: key.binding.profile.accountMode,
          accountId: key.binding.accountId,
          instrumentId: key.instrumentId,
          sourceId: identity.id,
          revision: identity.revision,
          asOf: p.positionAsOf,
          side: p.positionSide,
          quantity: p.positionQuantity,
        },
        availableAsset: p.availableAsset,
        availableAmount: available,
        leverage: p.leverage,
        ordersInLastMinute: p.ordersInLastMinute,
        ...daily,
        lossBaselineComplete: true,
        ...s.controls.value,
        health: s.health.value,
        market: s.market.value,
      },
      sources: Object.entries(s).map(([kind, item]) => ({ kind, reference: item.reference })),
    }),
  );
}
/** Server-only service; never trusts a caller snapshot or returns a RiskGrant. */
export function createRiskSnapshotCoordinator(options: {
  store: RiskSnapshotStore;
  now: () => number;
}) {
  if (
    !options.store ||
    typeof options.store.transaction !== 'function' ||
    typeof options.now !== 'function' ||
    Object.keys(options).some((k) => !['store', 'now'].includes(k))
  )
    throw new Error('RISK_COORDINATOR_OPTIONS');
  const check = (io: SnapshotIo) => {
    if (io.signal.aborted || !Number.isSafeInteger(io.deadline) || io.deadline <= Date.now())
      throw new Error('RISK_CERTIFICATE_ABORTED');
  };
  const verify = (raw: unknown, key: RiskSnapshotKey, now: number) => {
    const c = riskSnapshotCertificateSchema.parse(raw);
    if (
      !same(c.projection.key, key) ||
      c.hash !== riskEvidenceHash(c.projection) ||
      c.id !== c.projection.snapshot.sourceId ||
      c.revision !== c.projection.snapshot.revision ||
      c.createdAt > now ||
      c.createdAt < c.projection.snapshot.sourceAt ||
      c.expiresAt <= c.createdAt ||
      c.expiresAt > certificateDeadline(c.projection, Number.MAX_SAFE_INTEGER) ||
      c.expiresAt <= now
    )
      throw new Error('RISK_CERTIFICATE_INVALID');
    return c;
  };
  return Object.freeze({
    async certify(rawKey: RiskSnapshotKey, io: SnapshotIo): Promise<RiskSnapshotCertificate> {
      const key = immutable(riskSnapshotKeySchema.parse(rawKey));
      check(io);
      const result = await options.store.transaction(key, io, async (tx) => {
        const raw = await tx.capture();
        check(io);
        const identity = await tx.nextIdentity();
        check(io);
        const now = options.now();
        const projection = prepareRiskSnapshot(raw, key, identity, now);
        const certificate = riskSnapshotCertificateSchema.parse({
          ...identity,
          hash: riskEvidenceHash(projection),
          projection,
          createdAt: now,
          expiresAt: certificateDeadline(projection, io.deadline),
        });
        verify(certificate, key, now);
        check(io);
        await tx.insert(certificate);
        check(io);
        return certificate;
      });
      check(io);
      return immutable(verify(result, key, options.now()));
    },
    async readCurrent(rawKey: RiskSnapshotKey, io: SnapshotIo): Promise<RiskSnapshotCertificate> {
      const key = immutable(riskSnapshotKeySchema.parse(rawKey));
      check(io);
      const result = await options.store.transaction(key, io, async (tx) => {
        const c = verify(await tx.read(), key, options.now());
        check(io);
        const sources = await tx.capture();
        check(io);
        const current = prepareRiskSnapshot(
          sources,
          key,
          { id: c.id, revision: c.revision },
          options.now(),
        );
        if (!same(current, c.projection)) throw new Error('RISK_CERTIFICATE_REPLACED');
        return c;
      });
      check(io);
      return immutable(verify(result, key, options.now()));
    },
  });
}
