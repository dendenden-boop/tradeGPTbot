import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  idSchema,
  timestampSchema,
  marketScopeSchema,
  tickerSchema,
  orderBookSchema,
  newOrderSchema,
  decimalAdd,
  decimalMultiply,
  decimalCompare,
  parseDecimal,
  sameMarketScope,
} from '@ctp/exchange-core';
import {
  riskSnapshotSourcesSchema,
  riskEvidenceHash,
  riskSnapshotKeySchema,
  type RiskSnapshotKey,
  type RiskSnapshotCertificate,
  type RiskSnapshotSources,
} from './coordinator.js';
import { decodeRiskPortfolioSource } from './portfolio-source.js';
import { policyHeadSchema } from './policies.js';
import { intersectRiskLimits } from './policy.js';
import { lossCheckpointSchema } from './loss-journal.js';
import { riskNativeObservationSchema } from './snapshot-observations.js';

const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const durableText = z.strictObject({ id: z.uuid(), revision, text: z.string().max(1048576), hash });
const publication = z.strictObject({
  id: z.uuid(),
  kind: z.literal('SNAPSHOT'),
  key: z.strictObject({
    scope: marketScopeSchema,
    instrumentId: idSchema,
    dbInstrumentId: z.uuid(),
    dbRuleId: z.uuid(),
  }),
  expectedRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  timestamp: timestampSchema,
  record: riskSnapshotSourcesSchema.shape.metadata.shape.value.shape.record,
  ticker: tickerSchema,
  book: orderBookSchema,
});
const capture = z.strictObject({
  key: riskSnapshotKeySchema,
  capturedAt: timestampSchema,
  user: z.strictObject({
    id: z.uuid(),
    status: z.literal('ACTIVE'),
    sessionEpoch: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  }),
  portfolio: z.unknown(),
  policies: z.tuple([policyHeadSchema, policyHeadSchema]),
  metadata: z.strictObject({
    value: riskSnapshotSourcesSchema.shape.metadata.shape.value,
    revision,
  }),
  intent: z.strictObject({
    id: z.uuid(),
    operation: z.enum(['PLACE', 'CANCEL', 'AMEND']),
    command: newOrderSchema,
  }),
  connection: z.strictObject({
    id: z.uuid(),
    accountId: z.uuid(),
    mode: z.enum(['TESTNET', 'DEMO', 'LIVE']),
    status: z.literal('ACTIVE'),
    permissionEpoch: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
    version: z.number().int().nonnegative(),
    permissionsVersion: z.number().int().nonnegative(),
    verifiedAt: timestampSchema,
    disabledAt: z.null(),
    withdrawalPermissionDetected: z.literal(false),
    permissions: z.strictObject({
      read: z.literal(true),
      trade: z.literal(true),
      withdrawal: z.literal(false),
    }),
  }),
  observation: durableText,
  markets: z.array(durableText).min(1).max(1000),
  loss: z.strictObject({ checkpointText: z.string().max(8192), hash }),
  controls: z.strictObject({
    value: riskSnapshotSourcesSchema.shape.controls.shape.value,
    fingerprint: hash,
  }),
  exposure: riskSnapshotSourcesSchema.shape.exposure.shape.value.pick({
    orders: true,
    reservations: true,
  }),
  ordersInLastMinute: z.number().int().nonnegative().max(1000000),
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const equal = (a: unknown, b: unknown) => riskEvidenceHash(a) === riskEvidenceHash(b);
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const mul = (a: string, b: string) => decimalMultiply(parseDecimal(a), parseDecimal(b));
const fresh = (at: number, now: number, age: number) => at <= now && now - at <= age;

/** Only the fixed SQL capture calls this decoder. Shapes/hashes are never source authority by themselves. */
export function decodeRiskSnapshotCapture(
  raw: unknown,
  rawKey: RiskSnapshotKey,
  now: number,
  previous: RiskSnapshotCertificate | null = null,
): RiskSnapshotSources {
  try {
    const key = riskSnapshotKeySchema.parse(rawKey),
      e = capture.parse(raw);
    if (
      !key.intentId ||
      !equal(e.key, key) ||
      e.user.id !== key.binding.tenantId ||
      e.intent.id !== key.intentId
    )
      throw new Error('RISK_SNAPSHOT_SCOPE');
    const limits = intersectRiskLimits(e.policies[0].limits, e.policies[1].limits);
    if (!fresh(e.capturedAt, now, limits.maxEvidenceAgeMs)) throw new Error('RISK_SNAPSHOT_STALE');
    const portfolio = decodeRiskPortfolioSource(
      e.portfolio,
      {
        tenantId: key.binding.tenantId,
        mode: key.binding.mode,
        targetAccountId: key.binding.accountId,
        maxEvidenceAgeMs: limits.maxEvidenceAgeMs,
      },
      now,
    );
    const account = portfolio.accounts.find((a) => a.id === key.binding.accountId);
    if (
      !account ||
      account.status !== 'ACTIVE' ||
      account.permissionEpoch !== e.connection.permissionEpoch ||
      account.accountMode !== key.binding.profile.accountMode ||
      account.externalAccountId !== key.binding.externalAccountId ||
      account.exchange !== key.binding.profile.exchange ||
      account.region !== key.binding.profile.region ||
      e.connection.id !== key.binding.connectionId ||
      e.connection.accountId !== key.binding.accountId ||
      e.connection.mode !== key.binding.mode ||
      !fresh(e.connection.verifiedAt, now, limits.maxEvidenceAgeMs)
    )
      throw new Error('RISK_SNAPSHOT_PERMISSION');
    if (
      digest(e.observation.text) !== e.observation.hash ||
      digest(e.loss.checkpointText) !== e.loss.hash
    )
      throw new Error('RISK_SNAPSHOT_CORRUPT');
    const observation = riskNativeObservationSchema.parse(
      JSON.parse(e.observation.text) as unknown,
    );
    const { intentId: omittedIntent, ...nativeKey } = key;
    void omittedIntent;
    if (
      !equal(observation.key, nativeKey) ||
      observation.permissionEpoch !== e.connection.permissionEpoch ||
      observation.permissionsVersion !== e.connection.permissionsVersion
    )
      throw new Error('RISK_SNAPSHOT_PERMISSION');
    for (const fact of [
      ...Object.values(observation.health),
      observation.fee,
      observation.execution,
      ...observation.fx,
      ...observation.marks,
    ])
      if (!fresh(fact.asOf, now, limits.maxEvidenceAgeMs)) throw new Error('RISK_SNAPSHOT_STALE');
    if (
      new Set(observation.fx.map((f) => JSON.stringify([f.from, f.to]))).size !==
      observation.fx.length
    )
      throw new Error('RISK_SNAPSHOT_FX');
    const fxFor = (from: string) => {
      const fx = observation.fx.find((f) => f.from === from && f.to === limits.valuationAsset);
      if (
        !fx ||
        (fx.from === fx.to) !== (fx.kind === 'IDENTITY') ||
        (fx.kind === 'IDENTITY' && fx.rate !== '1')
      )
        throw new Error('RISK_SNAPSHOT_FX');
      return fx;
    };
    const markets = new Map(
      e.markets.map((row) => {
        if (digest(row.text) !== row.hash) throw new Error('RISK_SNAPSHOT_CORRUPT');
        const p = publication.parse(JSON.parse(row.text) as unknown);
        if (
          row.id !== p.id ||
          p.book.kind !== 'SNAPSHOT' ||
          p.book.stale ||
          p.book.previousSequence !== null ||
          p.book.bids.length === 0 ||
          p.book.asks.length === 0 ||
          p.ticker.freshness !== 'FRESH' ||
          !sameMarketScope(p.key.scope, p.record.instrument.scope) ||
          !sameMarketScope(p.key.scope, p.book.scope) ||
          !sameMarketScope(p.key.scope, p.ticker.scope) ||
          p.key.instrumentId !== p.record.instrument.id ||
          p.book.instrumentId !== p.key.instrumentId ||
          p.ticker.instrumentId !== p.key.instrumentId ||
          !fresh(p.timestamp, now, limits.maxEvidenceAgeMs) ||
          !fresh(p.book.receivedAt, now, limits.maxEvidenceAgeMs) ||
          !fresh(p.ticker.receivedAt, now, limits.maxEvidenceAgeMs) ||
          (p.book.exchangeTime === null && p.book.sourceSequence === null) ||
          (p.book.exchangeTime !== null &&
            !fresh(p.book.exchangeTime, now, limits.maxEvidenceAgeMs)) ||
          !fresh(p.ticker.exchangeTime, now, limits.maxEvidenceAgeMs)
        )
          throw new Error('RISK_SNAPSHOT_MARKET');
        return [row.id, { row, p }] as const;
      }),
    );
    if (markets.size !== e.markets.length) throw new Error('RISK_SNAPSHOT_MARKET');
    if (new Set(observation.marks.map((m) => m.marketId)).size !== observation.marks.length)
      throw new Error('RISK_SNAPSHOT_MARKET');
    const priceFor = (marketId: string) => {
      const n = markets.get(marketId);
      if (!n) throw new Error('RISK_SNAPSHOT_MARKET');
      if (n.p.key.scope.market === 'SPOT') {
        if (n.p.ticker.last.state !== 'AVAILABLE') throw new Error('RISK_SNAPSHOT_MARKET');
        return { value: n.p.ticker.last.value, asOf: n.p.ticker.exchangeTime };
      }
      const mark = observation.marks.find((m) => m.marketId === marketId);
      if (!mark || mark.priceAsset !== n.p.record.instrument.quoteAsset)
        throw new Error('RISK_SNAPSHOT_MARKET');
      return { value: mark.price, asOf: mark.asOf };
    };
    const native = markets.get(observation.execution.marketId);
    if (
      !native ||
      native.p.key.dbInstrumentId !== key.dbInstrumentId ||
      native.p.key.dbRuleId !== key.dbRuleId ||
      native.p.key.instrumentId !== key.instrumentId ||
      !sameMarketScope(native.p.key.scope, key.binding.profile) ||
      !equal(native.p.record, e.metadata.value.record) ||
      e.intent.command.instrumentId !== key.instrumentId ||
      e.intent.command.ruleVersion !== native.p.record.rules.version
    )
      throw new Error('RISK_SNAPSHOT_METADATA');
    const positions: RiskSnapshotSources['exposure']['value']['positions'] = [];
    const holds: RiskSnapshotSources['exposure']['value']['holds'] = [];
    let positionQuantity = '0';
    const books = portfolio.books.filter(
      (b) =>
        b.accountId === key.binding.accountId &&
        b.state.binding.connectionId === key.binding.connectionId &&
        sameMarketScope(b.state.binding.scope, key.binding.profile),
    );
    if (books.length !== 1) throw new Error('RISK_SNAPSHOT_WALLET');
    const book = books[0]!;
    for (const b of portfolio.books) {
      for (const h of b.state.holds)
        holds.push({
          id: h.id,
          accountId: b.accountId,
          asset: h.asset,
          amount: parseDecimal(h.amount),
          unknown: h.status === 'UNKNOWN',
          reflected: h.reflected,
        });
      for (const p of b.state.positions) {
        if (p.positionSide !== 'NET') throw new Error('RISK_SNAPSHOT_POSITION_MODE');
        if (b.id === book.id && p.instrumentId === key.instrumentId)
          positionQuantity = add(positionQuantity, p.quantity);
        if (p.quantity === '0') continue;
        const matches = observation.valuations.filter(
          (v) =>
            v.accountId === b.accountId &&
            v.bookId === b.id &&
            v.snapshotId === b.state.snapshotId &&
            v.instrumentId === p.instrumentId,
        );
        if (matches.length !== 1) throw new Error('RISK_SNAPSHOT_POSITION_VALUATION');
        const n = markets.get(matches[0]!.marketId),
          fx = fxFor(p.quote);
        if (
          !n ||
          n.p.key.instrumentId !== p.instrumentId ||
          n.p.record.instrument.baseAsset !== p.base ||
          n.p.record.instrument.quoteAsset !== p.quote ||
          !sameMarketScope(n.p.key.scope, b.state.binding.scope)
        )
          throw new Error('RISK_SNAPSHOT_POSITION_VALUATION');
        const price = priceFor(n.row.id);
        positions.push({
          id: `position-${riskEvidenceHash([b.id, p.instrumentId, p.bucket])}`,
          accountId: b.accountId,
          instrumentId: p.instrumentId,
          base: p.base,
          quantity: parseDecimal(p.quantity),
          price: price.value,
          priceAsset: p.quote,
          at: b.state.snapshotAt!,
          fx: {
            from: fx.from,
            to: fx.to,
            rate: fx.rate,
            kind: fx.kind,
            sourceId: fx.sourceId,
            at: fx.asOf,
          },
        });
      }
    }
    const target = native.p.record.instrument;
    const availableAsset =
      key.binding.profile.market === 'SPOT' && e.intent.command.side === 'SELL'
        ? target.baseAsset
        : (target.settlementAsset ?? target.quoteAsset);
    const balance = book.state.balances.find((b) => b.asset === availableAsset);
    if (!balance || (balance.available === null && balance.free === null))
      throw new Error('RISK_SNAPSHOT_COLLATERAL');
    const quoteFx = fxFor(target.quoteAsset),
      ticker = native.p.ticker,
      depth = native.p.book;
    const price = priceFor(native.row.id);
    const sideNotional = (side: typeof depth.bids) =>
      side.reduce((sum, level) => add(sum, mul(level.price, level.quantity)), '0');
    const bidNotional = sideNotional(depth.bids),
      askNotional = sideNotional(depth.asks);
    const market: RiskSnapshotSources['market']['value'] = {
      sourceId: native.row.id,
      asOf: Math.min(
        native.p.timestamp,
        ticker.exchangeTime,
        ticker.receivedAt,
        depth.exchangeTime ?? depth.receivedAt,
        depth.receivedAt,
        price.asOf,
        observation.execution.asOf,
        observation.fee.asOf,
      ),
      complete: true,
      referencePrice: price.value,
      lowerExecutionPrice: observation.execution.lowerPrice,
      upperExecutionPrice: observation.execution.upperPrice,
      bid: depth.bids[0]!.price,
      ask: depth.asks[0]!.price,
      liquidityNotional: mul(
        decimalCompare(parseDecimal(bidNotional), parseDecimal(askNotional)) <= 0
          ? bidNotional
          : askNotional,
        quoteFx.rate,
      ),
      liquidityAsset: limits.valuationAsset,
      priceAsset: target.quoteAsset,
      quoteToValuation: quoteFx.rate,
      fxFromAsset: quoteFx.from,
      fxToAsset: quoteFx.to,
      fxKind: quoteFx.kind,
      fxSourceId: quoteFx.sourceId,
      fxAsOf: quoteFx.asOf,
      kind: key.binding.profile.market === 'SPOT' ? 'LAST' : 'MARK',
      executionBoundEnforced: observation.execution.boundEnforced,
      feeAsset: observation.fee.asset,
      maxFeeRate: observation.fee.maxRate,
    };
    const values = {
      identity: { key, accountIds: portfolio.accounts.map((a) => a.id) },
      policies: e.policies,
      metadata: e.metadata.value,
      portfolio: {
        sourceAt: portfolio.asOf,
        reconciledAt: portfolio.asOf,
        permissionEpoch: e.connection.permissionEpoch,
        permissionVerifiedAt: e.connection.verifiedAt,
        tradeAllowed: true,
        withdrawalAllowed: false,
        positionMode: observation.positionMode,
        positionSide: 'NET' as const,
        positionQuantity,
        positionAsOf: book.state.snapshotAt!,
        availableAsset,
        availableAmount: balance.available ?? balance.free!,
        leverage: observation.leverage,
        ordersInLastMinute: e.ordersInLastMinute,
      },
      exposure: {
        scope: {
          tenantId: key.binding.tenantId,
          mode: key.binding.mode,
          valuationAsset: limits.valuationAsset,
        },
        now: Math.max(
          portfolio.asOf,
          ...observation.fx.map((f) => f.asOf),
          ...observation.marks.map((m) => m.asOf),
          ...[...markets.values()].map((m) =>
            Math.max(m.p.ticker.exchangeTime, m.p.ticker.receivedAt),
          ),
        ),
        maxEvidenceAgeMs: limits.maxEvidenceAgeMs,
        accountIds: portfolio.accounts.map((a) => a.id),
        complete: true,
        positions,
        holds,
        ...e.exposure,
      },
      loss: lossCheckpointSchema.parse({
        ...z.record(z.string(), z.unknown()).parse(JSON.parse(e.loss.checkpointText)),
        hash: e.loss.hash,
      }),
      market,
      controls: e.controls.value,
      health: Object.fromEntries(Object.entries(observation.health).map(([k, f]) => [k, f.status])),
    };
    const result: Record<string, unknown> = {};
    for (const [kind, value] of Object.entries(values)) {
      const contentHash = riskEvidenceHash(value);
      const config = ['identity', 'policies', 'metadata', 'controls'].includes(kind);
      const id =
        kind === 'loss'
          ? values.loss.batchId
          : kind === 'market'
            ? native.row.id
            : kind === 'health'
              ? e.observation.id
              : `${kind}-${riskEvidenceHash(kind === 'identity' ? [e.user, portfolio.accounts, e.connection] : kind === 'controls' ? e.controls.fingerprint : value)}`;
      const rev =
        kind === 'loss'
          ? values.loss.sequence
          : kind === 'market'
            ? native.row.revision
            : kind === 'health'
              ? e.observation.revision
              : kind === 'metadata'
                ? e.metadata.revision
                : '1';
      const prior = previous?.projection.sources.find((s) => s.kind === kind)?.reference;
      const checkedAt =
        config && prior?.id === id && prior.revision === rev && prior.hash === contentHash
          ? prior.asOf
          : e.capturedAt;
      const at = config
        ? checkedAt
        : kind === 'loss'
          ? values.loss.coveredThrough
          : kind === 'market'
            ? market.asOf
            : kind === 'health'
              ? Math.min(...Object.values(observation.health).map((h) => h.asOf))
              : portfolio.asOf;
      result[kind] = {
        value,
        reference: { id, revision: rev, hash: contentHash, asOf: at, complete: true },
      };
    }
    return riskSnapshotSourcesSchema.parse(result);
  } catch (error) {
    const code =
      error instanceof Error && /^RISK_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'RISK_SNAPSHOT_CAPTURE_INVALID';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Malformed private evidence is retained only in its protected database source.
      cause: new Error('RISK_SNAPSHOT_CAPTURE_FAILED'),
    });
  }
}
