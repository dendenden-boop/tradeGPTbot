import { createHash } from 'node:crypto';
import {
  canonical,
  createState,
  reducePortfolio,
  type PortfolioEvent,
  type PortfolioState,
} from '@ctp/portfolio';
import { calculatePaperRiskBudget } from '../src/risk-budget.js';
import { fixture as marketFixture } from './fixtures.js';
import { fixture as policyFixture } from '../../risk-engine/test/fixtures.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const wireNow = 2 * 86400000 + 200000;
export const wireHash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');

/** SQL protocol fixture only. This does not establish database source authority,
 * current inventory completeness, durable issuance, loss provenance or a grant. */
export function admissionWire(captureAt = wireNow) {
  const m = marketFixture(),
    p = policyFixture(),
    now = captureAt;
  const owner = { tenantId: id(1), accountId: id(2), mode: 'PAPER' as const };
  const profile = {
    ...m.record.instrument.scope,
    accountMode: 'SIMULATED',
    endpointProfileId: 'paper-spot-v1',
    profileVersion: m.model.version,
  };
  const binding = { ...owner, profile, connectionId: null, externalAccountId: 'paper-fixture' };
  const policyBinding = { ...owner, profile };
  const record = {
    ...m.record,
    rules: { ...m.record.rules, effectiveAt: now - 1000, expiresAt: now + 60000 },
  };
  const order = m.execution.order;
  const expected = {
    binding,
    orderId: id(3),
    intentId: id(4),
    operation: 'PLACE' as const,
    commandHash: wireHash({ operation: 'createOrder', command: order, binding }),
  };
  const budget = {
    now,
    model: m.model,
    record,
    order,
    book: { ...m.book, receivedAt: now, exchangeTime: now },
    trade: { ...m.trade, receivedAt: now, exchangeTime: now },
    owner,
    target: { orderId: expected.orderId, intentId: expected.intentId },
    platform: p.platform,
    user: p.user,
    fx: {
      from: 'USDT',
      to: 'USDT',
      rate: '1',
      kind: 'IDENTITY' as const,
      sourceId: 'identity',
      asOf: now,
    },
    evidence: {
      scope: { tenantId: owner.tenantId, mode: 'PAPER' as const, valuationAsset: 'USDT' },
      asOf: now,
      complete: true,
      accountIds: [owner.accountId],
      positions: [],
      orders: [],
      reservations: [],
      holds: [],
      balances: [{ accountId: owner.accountId, asset: 'USDT', available: '1000' }],
    },
  };
  const computed = calculatePaperRiskBudget(budget),
    sourceId = 'paper-certified:' + id(5);
  const revision = '9007199254740993';
  const policy = {
    ...p,
    now,
    binding: policyBinding,
    adapterVersion: 'paper-spot-l2-taker-v1',
    order,
    record,
    capabilities: p.capabilities
      .filter((c) => c.feature !== 'REDUCE_ONLY')
      .map((c) => ({
        ...c,
        profile,
        implementation: 'SYNTHETIC',
        adapterVersion: 'paper-spot-l2-taker-v1',
        checkedAt: now - 1000,
        expiresAt: now + 60000,
      })),
    snapshot: {
      ...p.snapshot,
      binding: policyBinding,
      sourceId,
      revision,
      sourceAt: now,
      reconciledAt: now,
      instrumentExposure: computed.current.instrument,
      assetExposure: computed.current.asset,
      accountExposure: computed.current.account,
      userExposure: computed.current.user,
      positionEvidence: {
        ...p.snapshot.positionEvidence,
        accountId: owner.accountId,
        accountMode: 'SIMULATED',
        sourceId,
        revision,
        asOf: now,
      },
      concurrentPositions: computed.potentialPositions.current,
      openOrders: computed.orders.current,
      ordersInLastMinute: 0,
      availableAmount: computed.coverage.debits[0]!.available,
      utcDayStart: Math.floor(now / 86400000) * 86400000,
      market: {
        ...p.snapshot.market,
        asOf: now,
        fxAsOf: now,
        lowerExecutionPrice: computed.coverage.envelope.executionPrice.minimum,
        upperExecutionPrice: computed.coverage.envelope.executionPrice.maximum,
        maxFeeRate: m.model.takerFeeRate,
      },
    },
  };
  const bookId = id(6);
  const before: PortfolioState = {
    ...createState({
      ...owner,
      connectionId: null,
      externalAccountId: binding.externalAccountId,
      walletId: 'paper-initial:' + bookId,
      scope: record.instrument.scope,
    }),
    status: 'RECONCILED' as const,
    snapshotAt: now,
    snapshotId: 'funding',
    balances: [{ asset: 'USDT', total: '1000', free: '1000', locked: '0', available: '1000' }],
  };
  const debits = computed.coverage.debits.map((d, i) => ({
    asset: d.asset,
    amount: d.amount,
    holdId: id(10 + i),
  }));
  const events: PortfolioEvent[] = debits.map((d, i) => ({
    type: 'COMMITMENT',
    id: id(20 + i),
    timestamp: now,
    hold: { id: d.holdId, asset: d.asset, amount: d.amount, status: 'RESERVED', reflected: false },
  }));
  let after: PortfolioState = before;
  for (const event of events)
    after = reducePortfolio(after, event, { now: () => now, holdWatermark: null }).state;
  const packet = {
    kind: 'RESERVED' as const,
    request: expected,
    receipt: {
      decisionId: id(7),
      reservationId: id(8),
      permissionEpoch: '9007199254740993',
      expiresAt: now + 1000,
    },
    certificate: {
      id: id(5),
      revision,
      sourceHash: 'a'.repeat(64),
      createdAt: now,
      expiresAt: now + 1000,
    },
    permissionEpoch: '9007199254740993',
    loss: {
      kind: 'UTC_CASH' as const,
      utcDayStart: Math.floor(now / 86400000) * 86400000,
      baselineAt: Math.floor(now / 86400000) * 86400000,
      openingEquity: '100',
      asset: 'USDT',
    },
    policy,
    budget,
    debits,
    portfolio: {
      bookId,
      previousRevision: revision,
      revision: (BigInt(revision) + BigInt(events.length)).toString(),
      before,
      events,
      afterText: canonical(after),
      afterHash: wireHash(after),
    },
  };
  return {
    packet,
    expected,
    request: {
      binding,
      state: { id: expected.orderId },
      intentId: expected.intentId,
      operation: 'PLACE' as const,
      commandHash: expected.commandHash,
    },
  };
}
