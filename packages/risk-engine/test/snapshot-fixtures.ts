import { randomUUID, createHash } from 'node:crypto';
import { canonical, createState, reducePortfolio } from '@ctp/portfolio';
import { binding, snapshot } from '../../portfolio/test/fixtures.js';
import { fixture as riskFixture } from './fixtures.js';
import { riskSnapshotKeySchema } from '../src/coordinator.js';
import { policyFingerprint } from '../src/policies.js';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** Isolated test source fixture; never exported as a runtime collector. */
export function captureFixture(
  identities = {
    tenantId: binding().tenantId,
    accountId: binding().accountId,
    connectionId: binding().connectionId,
  },
) {
  const risk = riskFixture(),
    now = Date.now() - 100;
  risk.binding.tenantId = identities.tenantId;
  risk.binding.accountId = identities.accountId;
  risk.record.rules.effectiveAt = now - 1000;
  risk.record.rules.expiresAt = now + 60000;
  risk.capabilities.forEach((c) => {
    c.checkedAt = now - 1000;
    c.expiresAt = now + 60000;
  });
  const key = riskSnapshotKeySchema.parse({
    binding: {
      ...risk.binding,
      connectionId: identities.connectionId,
      externalAccountId: binding().externalAccountId,
    },
    instrumentId: risk.record.instrument.id,
    dbInstrumentId: randomUUID(),
    dbRuleId: randomUUID(),
    dbCapabilityId: randomUUID(),
    intentId: randomUUID(),
  });
  const state = reducePortfolio(
    createState({ ...binding(), ...identities }),
    snapshot({ id: randomUUID(), timestamp: now }),
    { now: () => now },
  ).state;
  const stateText = canonical(state),
    marketId = randomUUID();
  const ticker = {
    scope: risk.record.instrument.scope,
    instrumentId: key.instrumentId,
    exchangeTime: now,
    receivedAt: now,
    last: { state: 'AVAILABLE', value: '10' },
    bid: { state: 'AVAILABLE', value: '9.95' },
    ask: { state: 'AVAILABLE', value: '10.05' },
    baseVolume: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
    quoteVolume: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
    change: { state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' },
    freshness: 'FRESH',
  };
  const book = {
    scope: risk.record.instrument.scope,
    instrumentId: key.instrumentId,
    exchangeTime: null,
    receivedAt: now,
    kind: 'SNAPSHOT',
    bids: [{ price: '9.95', quantity: '100' }],
    asks: [{ price: '10.05', quantity: '100' }],
    sourceSequence: '9007199254740993',
    previousSequence: null,
    checksum: null,
    snapshotVersion: 'native-book',
    stale: false,
  };
  const publication = {
    id: marketId,
    kind: 'SNAPSHOT',
    key: {
      scope: risk.record.instrument.scope,
      instrumentId: key.instrumentId,
      dbInstrumentId: key.dbInstrumentId,
      dbRuleId: key.dbRuleId,
    },
    expectedRevision: '0',
    timestamp: now,
    record: risk.record,
    ticker,
    book,
  };
  const { intentId: omitted, ...nativeKey } = key;
  void omitted;
  const observation = {
    key: nativeKey,
    permissionEpoch: '1',
    permissionsVersion: 1,
    positionMode: 'SPOT',
    leverage: '1',
    health: Object.fromEntries(
      Object.keys(risk.snapshot.health).map((k) => [
        k,
        { sourceId: 'native-' + k, asOf: now, status: 'HEALTHY' },
      ]),
    ),
    fee: { sourceId: 'native-fee', asOf: now, asset: 'USDT', maxRate: '0.001' },
    fx: [
      { sourceId: 'native-fx', asOf: now, from: 'USDT', to: 'USDT', rate: '1', kind: 'IDENTITY' },
    ],
    valuations: [],
    marks: [],
    execution: {
      marketId,
      lowerPrice: '9.9',
      upperPrice: '10.1',
      boundEnforced: false,
      sourceId: 'native-execution',
      asOf: now,
    },
  };
  const checkpoint = {
    scope: { tenantId: key.binding.tenantId, mode: key.binding.mode, valuationAsset: 'USDT' },
    dayStart: Math.floor(now / 86400000) * 86400000,
    sequence: '2',
    batchId: randomUUID(),
    coveredThrough: now,
    openingEquity: '1000',
    externalFlows: '0',
    netRealized: '0',
    adjustedCurrentEquity: '1000',
    adjustedPeakEquity: '1000',
  };
  const text = canonical(publication),
    observationText = canonical(observation),
    checkpointText = canonical(checkpoint);
  const raw = {
    key,
    capturedAt: now,
    user: { id: key.binding.tenantId, status: 'ACTIVE', sessionEpoch: '1' },
    portfolio: {
      scope: { tenantId: key.binding.tenantId, mode: key.binding.mode },
      accounts: [
        {
          id: key.binding.accountId,
          exchange: 'BINANCE',
          region: 'global',
          externalAccountId: key.binding.externalAccountId,
          accountMode: 'SPOT',
          status: 'ACTIVE',
          permissionEpoch: '1',
          reconciliationEpoch: '1',
          version: 1,
        },
      ],
      books: [
        {
          id: randomUUID(),
          accountId: key.binding.accountId,
          wallet: state.binding.walletId,
          revision: '1',
          stateText,
          hash: sha(stateText),
          holdWatermarks: [],
        },
      ],
    },
    policies: [
      {
        scope: { kind: 'PLATFORM' },
        mode: key.binding.mode,
        version: '1',
        eventId: randomUUID(),
        limits: risk.platform,
        limitsHash: policyFingerprint(risk.platform),
      },
      {
        scope: { kind: 'USER', tenantId: key.binding.tenantId },
        mode: key.binding.mode,
        version: '1',
        eventId: randomUUID(),
        limits: risk.user,
        limitsHash: policyFingerprint(risk.user),
      },
    ],
    metadata: {
      value: {
        record: risk.record,
        capabilities: risk.capabilities,
        adapterVersion: risk.adapterVersion,
      },
      revision: '1',
    },
    intent: { id: key.intentId!, operation: 'PLACE', command: risk.order },
    connection: {
      id: key.binding.connectionId,
      accountId: key.binding.accountId,
      mode: key.binding.mode,
      status: 'ACTIVE',
      permissionEpoch: '1',
      version: 1,
      permissionsVersion: 1,
      verifiedAt: now,
      disabledAt: null,
      withdrawalPermissionDetected: false,
      permissions: { read: true, trade: true, withdrawal: false },
    },
    observation: {
      id: randomUUID(),
      revision: '1',
      text: observationText,
      hash: sha(observationText),
    },
    markets: [{ id: marketId, revision: '1', text, hash: sha(text) }],
    loss: { checkpointText, hash: sha(checkpointText) },
    controls: {
      value: { pauses: risk.snapshot.pauses, circuit: 'CLOSED' },
      fingerprint: 'a'.repeat(64),
    },
    exposure: { orders: [], reservations: [] },
    ordersInLastMinute: 0,
  };
  return {
    raw,
    key,
    now,
    risk,
    observation,
    publication,
    rehashObservation() {
      raw.observation.text = canonical(observation);
      raw.observation.hash = sha(raw.observation.text);
    },
    rehashMarket() {
      raw.markets[0]!.text = canonical(publication);
      raw.markets[0]!.hash = sha(raw.markets[0]!.text);
    },
  };
}
