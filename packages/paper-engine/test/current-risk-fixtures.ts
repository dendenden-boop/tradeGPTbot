import { randomUUID } from 'node:crypto';
import { canonical } from '@ctp/portfolio';
import { marketTradePublicationSchema } from '@ctp/market-data';
import { policyFingerprint, policyHeadSchema } from '@ctp/risk-engine';
import { paperConfigurationReceiptSchema } from '../src/configuration-domain.js';
import { projectPaperCurrentLoss } from '../src/current-loss-domain.js';
import { decodePaperHistoricalInventoryContents } from '../src/postgres-historical-inventory.js';
import { paperRuntimeDependencies } from '../src/runtime-domain.js';
import { historicalInventoryFixture } from './historical-inventory-fixtures.js';
import { admissionWire, wireHash } from './admission-wire-fixtures.js';

// Test-only wire graph. No fixture, hash or serialized source is authority.
// Production provenance, locking and persistence require native PostgreSQL.
export function currentRiskFixture() {
  const f = historicalInventoryFixture(1),
    now = f.now,
    request = { ...f.request, kind: 'PAPER_CURRENT_RISK_CERTIFY' as const },
    cfg = paperConfigurationReceiptSchema.parse(
      JSON.parse(f.packet.source.started.context.configuration.receiptText),
    ),
    inventory = decodePaperHistoricalInventoryContents(f.wire, f.packet.request, now),
    owner = f.owner;
  const seal = (value: unknown) => ({ text: canonical(value), hash: wireHash(value) });
  const runtimePublication = {
    id: randomUUID(),
    expectedRevision: '9007199254740993',
    observation: {
      owner,
      configurationId: cfg.configuration.id,
      configurationHash: wireHash(cfg),
      permissionEpoch: request.authorization.permissionEpoch,
      userSessionEpoch: request.authorization.userSessionEpoch,
      accountVersion: inventory.accounts[0]!.accountState.version,
      health: Object.fromEntries(
        paperRuntimeDependencies.map((key) => [
          key,
          { sourceId: key + ':test-current', asOf: now - 1, status: 'HEALTHY' },
        ]),
      ),
    },
  };
  const runtime = {
    kind: 'PAPER_RUNTIME_CAPTURE',
    owner,
    asOf: now,
    configuration: { receiptText: canonical(cfg), hash: wireHash(cfg) },
    current: {
      permissionEpoch: request.authorization.permissionEpoch,
      userSessionEpoch: request.authorization.userSessionEpoch,
      accountVersion: inventory.accounts[0]!.accountState.version,
      ...cfg.accountIdentity,
    },
    publication: {
      id: runtimePublication.id,
      revision: '9007199254740994',
      text: canonical(runtimePublication),
      hash: wireHash(runtimePublication),
      publishedAt: now,
    },
  };
  const policies = (['PLATFORM', 'USER'] as const).map((kind) => {
    const limits = admissionWire().packet.budget.platform;
    return policyHeadSchema.parse({
      scope: kind === 'PLATFORM' ? { kind } : { kind, tenantId: owner.tenantId },
      mode: 'PAPER',
      version: '9007199254740993',
      eventId: randomUUID(),
      limits,
      limitsHash: policyFingerprint(limits),
    });
  });
  const trade = marketTradePublicationSchema.parse({
    kind: 'TRADE',
    id: randomUUID(),
    key: f.publication.key,
    expectedRevision: '9007199254740994',
    timestamp: now,
    record: f.publication.record,
    trade: { ...f.packet.input.frame.trade, receivedAt: now, exchangeTime: now },
  });
  const baselineAt = cfg.createdAt + 1,
    fundingId = randomUUID(),
    day = Math.floor(now / 86400000) * 86400000,
    originalCash = f.packet.input.portfolio.balances.find((b) => b.asset === 'USDT')!.total;
  const lossInput = {
    scope: { tenantId: owner.tenantId, mode: 'PAPER', valuationAsset: 'USDT' },
    executionId: f.receipt.executionId,
    capturedAt: now,
    validUntil: now + 1000,
    maxEvidenceAgeMs: 5000,
    baseline: {
      kind: 'PAPER_INCEPTION',
      id: randomUUID(),
      sourceHash: wireHash(cfg),
      utcDayStart: day,
      at: baselineAt,
      equity: originalCash,
      expiresAt: day + 86400000,
      fundingId,
    },
    flows: [
      {
        id: fundingId,
        sourceHash: wireHash(cfg),
        accountId: owner.accountId,
        at: baselineAt,
        asset: 'USDT',
        amount: originalCash,
      },
    ],
    realized: [],
    points: [],
    previous: null,
    current: {
      id: f.publication.id,
      sourceHash: wireHash(f.wire),
      at: now,
      sourceAt: inventory.asOf,
      equity: inventory.valuation.equity,
    },
    coverage: {
      id: randomUUID(),
      sourceHash: wireHash(f.wire),
      from: baselineAt,
      through: now,
      complete: true,
      previousHash: null,
    },
  };
  const loss = projectPaperCurrentLoss(lossInput, now),
    lossSeal = seal(loss),
    lossReference = {
      id: randomUUID(),
      revision: '9007199254740993',
      dayStart: day,
      hash: lossSeal.hash,
    },
    capability = {
      adapterVersion: 'paper-spot-l2-taker-v1',
      modelHash: wireHash(cfg.configuration.model),
      checkedAt: now,
      expiresAt: now + 1000,
    },
    controls = seal({
      global: [
        {
          scope: { kind: 'GLOBAL' },
          kind: 'KILL_SWITCH',
          key: 'kill',
          state: 'RUNNING',
          epoch: '1',
        },
      ],
      tenant: [],
      activePauses: [],
      circuits: [],
    });
  const sourceHeads = wireHash({
    request,
    catalog: f.wire.catalog,
    executionHash: wireHash(f.wire.executed.execution),
    books: [],
    markets: f.wire.markets.map(({ id, revision, hash }) => ({ id, revision, hash })),
    runtime: {
      id: runtime.publication.id,
      revision: runtime.publication.revision,
      hash: runtime.publication.hash,
      publishedAt: now,
    },
    policies,
    controlsHash: controls.hash,
    trade: {
      id: trade.id,
      revision: (BigInt(trade.expectedRevision) + 1n).toString(),
      hash: wireHash(trade),
    },
    modelHash: capability.modelHash,
    ordersInLastMinute: 1,
  });
  const source = {
    kind: 'PAPER_CURRENT_RISK_CAPTURE',
    request,
    asOf: now,
    inventory: seal(f.wire),
    runtime,
    policies,
    controls,
    market: {
      snapshot: { text: f.wire.markets[0]!.publicationText, hash: f.wire.markets[0]!.hash },
      trade: seal(trade),
    },
    capability,
    lossInput,
    loss: lossSeal,
    lossReference,
    sourceHeads,
    fingerprint: wireHash({ sourceHeads, lossHash: lossSeal.hash, lossReference, capability }),
    ordersInLastMinute: 1,
  };
  const certificate = {
    kind: 'PAPER_CURRENT_RISK_CERTIFICATE',
    version: 'paper-current-risk-v1',
    id: randomUUID(),
    revision: '9007199254740994',
    createdAt: now,
    expiresAt: now + 1000,
    source,
  };
  return {
    now,
    request,
    inventory,
    loss,
    source,
    certificate,
    seal,
    reply: () => ({ kind: 'CERTIFIED', certificate: seal(certificate) }),
  };
}
