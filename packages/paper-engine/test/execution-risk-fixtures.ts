import { canonical } from '@ctp/portfolio';
import { normalizedFixtures } from '../../exchange-core/test/fixtures/domain.js';
import { policyFingerprint } from '@ctp/risk-engine';
import {
  preparedSourceFixture,
  preparedSourceId as id,
} from './prepared-execution-source-fixtures.js';
import { admissionWire, wireHash, wireNow } from './admission-wire-fixtures.js';
import { runtimeFixture } from './runtime-fixtures.js';
import { calculatePaperRiskBudget } from '../src/risk-budget.js';

/** Wire content only; hashes/healthy fixtures prove no storage or probe authority. */
export function executionRiskFixture(count = 1) {
  const f = preparedSourceFixture(count),
    old = admissionWire(wireNow - 10).packet,
    binding = f.request.admission.binding;
  f.packet.market.book.bids = f.packet.market.book.bids.map((level) => ({
    ...level,
    quantity: '1000',
  }));
  f.packet.market.book.asks = f.packet.market.book.asks.map((level) => ({
    ...level,
    quantity: '1000',
  }));
  f.packet.market.trade.quantity = '1000';
  const request = { ...f.request, kind: 'PAPER_EXECUTION_RISK_CAPTURE' };
  const policies = (['PLATFORM', 'USER'] as const).map((kind, n) => ({
    scope: kind === 'PLATFORM' ? { kind } : { kind, tenantId: binding.tenantId },
    mode: 'PAPER',
    version: String(9007199254740993n + BigInt(n)),
    eventId: id(9500 + n),
    limits: {
      ...old.budget.platform,
      maxOrderNotional: '1000000',
      maxInstrumentExposure: '1000000',
      maxAssetExposure: '1000000',
      maxAccountExposure: '1000000',
      maxUserExposure: '1000000',
      maxConcurrentPositions: 1000,
      maxOpenOrders: 1000,
    },
    limitsHash: '',
  }));
  const r = runtimeFixture(wireNow),
    owner = { tenantId: binding.tenantId, accountId: binding.accountId, mode: 'PAPER' as const };
  const configuration = {
    ...r.configuration,
    configuration: {
      ...r.configuration.configuration,
      id: f.packet.configurationId,
      owner,
      source: { ...f.packet.market.record.instrument.scope },
      model: f.packet.model,
    },
    accountIdentity: {
      ...r.configuration.accountIdentity,
      externalAccountId: binding.externalAccountId,
    },
    createdAt: wireNow - 1000,
  };
  const runtime = {
    ...r.w,
    owner,
    current: {
      ...r.w.current,
      permissionEpoch: request.authorization.permissionEpoch,
      userSessionEpoch: request.authorization.userSessionEpoch,
      ...configuration.accountIdentity,
    },
  };
  const publication = {
    ...r.publication,
    observation: {
      ...r.publication.observation,
      owner,
      configurationId: f.packet.configurationId,
      permissionEpoch: runtime.current.permissionEpoch,
      userSessionEpoch: runtime.current.userSessionEpoch,
    },
  };
  const ticker = {
    ...normalizedFixtures().ticker,
    receivedAt: wireNow - 10,
    exchangeTime: wireNow - 10,
  };
  const budget = {
    ...old.budget,
    now: wireNow,
    model: f.packet.model,
    record: f.packet.market.record,
    book: f.packet.market.book,
    trade: f.packet.market.trade,
    order: f.packet.candidates[0]!.command,
    platform: policies[0]!.limits,
    user: policies[1]!.limits,
    evidence: {
      ...old.budget.evidence,
      asOf: wireNow,
      balances: [{ accountId: binding.accountId, asset: 'USDT', available: '1000000' }],
    },
  };
  const original = calculatePaperRiskBudget(budget);
  const evidence = {
    ...budget.evidence,
    orders: f.packet.candidates.map((c) => ({
      id: c.orderId,
      intentId: c.intentId,
      accountId: binding.accountId,
      instrumentId: c.command.instrumentId,
      base: f.packet.market.record.instrument.baseAsset,
      quote: 'USDT',
      side: 'BUY',
      notional: original.notional,
      status: 'PENDING',
    })),
    reservations: f.packet.candidates.map((c) => ({
      id: c.reservationId,
      orderId: c.orderId,
      intentId: c.intentId,
      accountId: binding.accountId,
      instrumentId: c.command.instrumentId,
      base: f.packet.market.record.instrument.baseAsset,
      quote: 'USDT',
      side: 'BUY',
      notional: original.notional,
      unknown: false,
      debits: c.debits,
    })),
    holds: f.portfolio.holds.map((h) => ({
      id: h.id,
      accountId: binding.accountId,
      asset: h.asset,
      amount: h.amount,
      unknown: false,
      reflected: false,
    })),
  };
  const controls = {
    global: [
      {
        scope: { kind: 'GLOBAL' },
        kind: 'KILL_SWITCH',
        key: 'kill',
        state: 'RUNNING',
        epoch: '9007199254740993',
      },
    ],
    tenant: [] as {
      scope: { kind: string; tenantId: string; targetId: string };
      kind: string;
      key: string;
      state: string;
      epoch: string;
    }[],
    activePauses: [] as string[],
    circuits: [] as { id: string; state: string }[],
  };
  const c = f.packet.candidates[0]!;
  const packet = {
    kind: 'PAPER_EXECUTION_RISK_CAPTURE',
    request,
    asOf: wireNow,
    capture: f.packet,
    journal: f.journal,
    evidence,
    market: {
      ...f.packet.market,
      ticker,
      order: c.command,
      snapshotId: f.packet.market.snapshot.id,
      snapshotRevision: f.packet.market.snapshot.revision,
      snapshotHash: f.packet.market.snapshot.hash,
      tradeId: f.packet.market.tradeReference.id,
      tradeRevision: f.packet.market.tradeReference.revision,
    },
    runtime,
    policies,
    controls: { text: '', hash: '' },
    loss: old.loss,
    ordersInLastMinuteExcludingTarget: 0,
    reservation: {
      id: c.reservationId,
      decisionId: c.decisionId,
      status: 'ACTIVE',
      revision: '1',
      expiresAt: c.original.expiresAt,
    },
  };
  // SQL market packet has references as flat fields, not the source wrappers.
  const { snapshot, tradeReference, ...market } = packet.market;
  void snapshot;
  void tradeReference;
  const wire = { ...packet, market };
  function seal() {
    policies.forEach((p) => (p.limitsHash = policyFingerprint(p.limits)));
    const receiptText = canonical(configuration);
    runtime.configuration = { receiptText, hash: wireHash(configuration) };
    publication.observation.configurationHash = runtime.configuration.hash;
    runtime.publication.text = canonical(publication);
    runtime.publication.hash = wireHash(publication);
    wire.controls = { text: canonical(controls), hash: wireHash(controls) };
  }
  seal();
  return {
    ...f,
    request: structuredClone(request),
    packet: wire,
    controls,
    publication,
    configuration,
    seal,
  };
}
