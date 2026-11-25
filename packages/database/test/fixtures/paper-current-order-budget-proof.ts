import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { canonical } from '@ctp/portfolio';
import { currentOrderRiskCaptureQuery } from '../../../paper-engine/src/current-order-risk-query.js';
import { paperRuntimeDependencies } from '../../../paper-engine/src/runtime-domain.js';
import { startFixtureSql } from './paper-execution-start.js';

function seal(value: unknown) {
  const text = canonical(value);
  return { text, hash: createHash('sha256').update(text).digest('hex') };
}

function operationalFixture(at: number) {
  const owner = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    accountId: '00000000-0000-4000-8000-000000000002',
    mode: 'PAPER',
  };
  const configurationId = '00000000-0000-4000-8000-000000000003';
  const configuration = seal({
    configuration: { id: configurationId, owner },
    createdAt: at - 10000,
  });
  const authorization = { permissionEpoch: '7', userSessionEpoch: '12' };
  const current = { ...authorization, accountVersion: 3 };
  const observation = {
    owner,
    configurationId,
    configurationHash: configuration.hash,
    ...current,
    health: Object.fromEntries(
      paperRuntimeDependencies.map((key) => [key, { status: 'HEALTHY', asOf: at - 3 }]),
    ),
  };
  const globalKill = {
    scope: { kind: 'GLOBAL' },
    kind: 'KILL_SWITCH',
    key: 'kill',
    state: 'RUNNING',
  };
  return {
    owner,
    configuration,
    authorization,
    current,
    observation,
    expiresAt: at + 1000,
    controls: {
      global: [globalKill],
      tenant: [] as { kind: string; state: string }[],
      activePauses: [] as string[],
      circuits: [] as { state: string }[],
    },
  };
}

// Exercise the production arithmetic on PostgreSQL with controlled captured
// content. The calling integration case separately authenticates real rows.
export async function verifyPaperCurrentOrderBudgetSql() {
  const query = currentOrderRiskCaptureQuery.replace(
    'ctp_paper.reconcile_admission($1::jsonb)',
    '$1::jsonb',
  );
  expect(query).not.toBe(currentOrderRiskCaptureQuery);
  const at = 1_700_000_000_000;
  const limits = {
    maxOrderNotional: '2.1',
    valuationAsset: 'USDT',
    maxLeverage: '1',
    maxPriceDeviationRate: '0.2',
    maxSpreadRate: '0.05',
    minLiquidityNotional: '500',
    maxDailyRealizedLoss: '0.6',
    maxDailyTotalLoss: '1.01',
    maxDrawdownRate: '0.02',
    maxInstrumentExposure: '7.75',
    maxAssetExposure: '7.75',
    maxAccountExposure: '7.75',
    maxUserExposure: '7.75',
    minAvailableBalance: '95.2579',
    maxOpenOrders: 2,
    maxConcurrentPositions: 1,
    maxOrdersPerMinute: 2,
  };
  const bookId = '00000000-0000-4000-8000-000000004010';
  const execution = {
    input: {
      attempt: { request: { admission: { command: { type: 'LIMIT', limitPrice: '10.55' } } } },
      original: { record: { rules: { tickSize: '0.05' } } },
    },
    effects: {
      order: { executedQuantity: '0.25', remainingQuantity: '0.25' },
      reservation: { status: 'ACTIVE' },
    },
    source: {
      started: {
        context: {
          configuration: {
            receiptText: canonical({
              configuration: { model: { takerFeeRate: '0.001', participationRate: '0.5' } },
            }),
          },
        },
      },
    },
  };
  const instrumentId = 'btc-usdt';
  const version = 'rules-v1';
  const dbInstrumentId = '00000000-0000-4000-8000-000000004000';
  const dbRuleId = '00000000-0000-4000-8000-000000004001';
  const scope = { exchange: 'BINANCE', market: 'SPOT', environment: 'TESTNET', region: 'global' };
  const snapshot = {
    key: { dbInstrumentId, dbRuleId, instrumentId, scope },
    record: {
      instrument: {
        id: instrumentId,
        scope,
        status: 'TRADING',
        expiryAt: null,
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
      },
      rules: {
        instrumentId,
        version,
        scope,
        effectiveAt: at - 10000,
        expiresAt: at + 10000,
        orderTypes: ['LIMIT', 'MARKET'],
        timeInForce: ['GTC', 'IOC'],
        quantityUnit: 'BASE',
        minQuantity: '0.1',
        maxQuantity: '0.2',
        marketMinQuantity: '0.2',
        marketMaxQuantity: '0.3',
        tickSize: '0.1',
        stepSize: '0.01',
        minPrice: '9.98',
        maxPrice: '10.55',
        minNotional: '1',
        maxNotional: '2.1',
      },
    },
    ticker: { last: { state: 'AVAILABLE', value: '12.05' } },
    book: {
      bids: [{ price: '10', quantity: '100' }],
      asks: [{ price: '10.5', quantity: '100' }],
    },
  };
  const loss = {
    utcDayStart: Math.floor(at / 86400000) * 86400000,
    complete: true,
    adjustedOpeningEquity: '100',
    adjustedCurrentEquity: '99',
    adjustedPeakEquity: '100',
    dailyNetRealizedPnl: '-0.5',
  };
  const capability = {
    adapterVersion: 'paper-spot-l2-taker-v1',
    checkedAt: at - 2,
  };
  const samples: {
    name: string;
    age?: number;
    platform?: Partial<typeof limits>;
    user?: Partial<typeof limits>;
    loss?: Partial<typeof loss>;
    market?: boolean;
    missingTrade?: boolean;
    budgetAllowed?: boolean;
    marketAllowed?: boolean;
    lossAllowed?: boolean;
    changeOperation?: (operation: ReturnType<typeof operationalFixture>) => void;
    runtimeReady?: boolean;
    tradingReady?: boolean;
    rules?: Partial<typeof snapshot.record.rules>;
    instrument?: Partial<typeof snapshot.record.instrument>;
    dbRuleId?: string;
    sizeAsset?: string;
    limitPrice?: string;
    capability?: Partial<typeof capability & { expiresAt: number }>;
    rulesAllowed?: boolean;
    capabilityReady?: boolean;
    originalRevision?: string;
    bookScope?: string;
    bookStatus?: string;
    duplicateHold?: boolean;
    holdUnknown?: boolean;
    quote?: { balance: string; available: string; remaining: string };
    commitmentReady?: boolean;
  }[] = [
    { name: 'exact boundaries' },
    {
      name: 'platform budget',
      platform: { maxUserExposure: '7.749999999999999999' },
      budgetAllowed: false,
    },
    {
      name: 'user budget',
      user: { maxUserExposure: '7.749999999999999999' },
      budgetAllowed: false,
    },
    { name: 'outside minute bucket', age: 60001, budgetAllowed: false },
    {
      name: 'platform liquidity',
      platform: { minLiquidityNotional: '500.000000000000000001' },
      marketAllowed: false,
    },
    { name: 'user spread', user: { maxSpreadRate: '0.04' }, marketAllowed: false },
    { name: 'unproved liquidity', missingTrade: true, marketAllowed: false },
    { name: 'bounded MARKET', market: true },
    {
      name: 'MARKET lower-bound deviation',
      market: true,
      user: { maxPriceDeviationRate: '0.15' },
      marketAllowed: false,
    },
    {
      name: 'daily realized loss equality',
      user: { maxDailyRealizedLoss: '0.5' },
      lossAllowed: false,
    },
    { name: 'daily total loss equality', platform: { maxDailyTotalLoss: '1' }, lossAllowed: false },
    { name: 'drawdown equality', user: { maxDrawdownRate: '0.01' }, lossAllowed: false },
    { name: 'incomplete loss baseline', loss: { complete: false }, lossAllowed: false },
    {
      name: 'previous UTC day',
      loss: { utcDayStart: loss.utcDayStart - 86400000 },
      lossAllowed: false,
    },
    {
      name: 'global kill switch is paused',
      changeOperation: (op) => {
        op.controls.global[0]!.state = 'PAUSED';
      },
      tradingReady: false,
    },
    {
      name: 'global kill switch is missing',
      changeOperation: (op) => {
        op.controls.global = [];
      },
      tradingReady: false,
    },
    {
      name: 'conflicting global kill heads',
      changeOperation: (op) => {
        op.controls.global.push({ ...op.controls.global[0]!, state: 'PAUSED' });
      },
      tradingReady: false,
    },
    {
      name: 'tenant kill switch is paused',
      changeOperation: (op) => {
        op.controls.tenant.push({ kind: 'KILL_SWITCH', state: 'PAUSED' });
      },
      tradingReady: false,
    },
    {
      name: 'active trading pause',
      changeOperation: (op) => {
        op.controls.activePauses.push('policy-pause');
      },
      tradingReady: false,
    },
    {
      name: 'global circuit is open',
      changeOperation: (op) => {
        op.controls.global.push({
          scope: { kind: 'GLOBAL' },
          kind: 'CIRCUIT',
          key: 'connectivity',
          state: 'OPEN',
        });
      },
      tradingReady: false,
    },
    {
      name: 'tenant circuit is half-open',
      changeOperation: (op) => {
        op.controls.tenant.push({ kind: 'CIRCUIT', state: 'HALF_OPEN' });
      },
      tradingReady: false,
    },
    {
      name: 'stored circuit is open',
      changeOperation: (op) => {
        op.controls.circuits.push({ state: 'OPEN' });
      },
      tradingReady: false,
    },
    {
      name: 'missing health dependency',
      changeOperation: (op) => {
        delete op.observation.health['clock'];
      },
      runtimeReady: false,
    },
    {
      name: 'unexpected health dependency',
      changeOperation: (op) => {
        op.observation.health['unregistered'] = { status: 'HEALTHY', asOf: at - 3 };
      },
      runtimeReady: false,
    },
    {
      name: 'failed health probe',
      changeOperation: (op) => {
        op.observation.health['database']!.status = 'FAILED';
      },
      runtimeReady: false,
    },
    {
      name: 'unknown health probe',
      changeOperation: (op) => {
        op.observation.health['executor']!.status = 'UNKNOWN';
      },
      runtimeReady: false,
    },
    {
      name: 'future health probe',
      changeOperation: (op) => {
        op.observation.health['clock']!.asOf = at - 1;
      },
      runtimeReady: false,
    },
    {
      name: 'stale health probe',
      changeOperation: (op) => {
        op.observation.health['clock']!.asOf = at - 5001;
      },
      runtimeReady: false,
    },
    {
      name: 'certificate outlives health evidence',
      changeOperation: (op) => {
        op.expiresAt = at + 4999;
      },
      runtimeReady: false,
    },
    {
      name: 'replaced permission epoch',
      changeOperation: (op) => {
        op.current.permissionEpoch = '8';
      },
      runtimeReady: false,
    },
    {
      name: 'conflicting selector session epoch',
      changeOperation: (op) => {
        op.authorization.userSessionEpoch = '13';
      },
      runtimeReady: false,
    },
    {
      name: 'replaced account revision',
      changeOperation: (op) => {
        op.current.accountVersion = 4;
      },
      runtimeReady: false,
    },
    {
      name: 'conflicting configuration hash',
      changeOperation: (op) => {
        op.observation.configurationHash = '0'.repeat(64);
      },
      runtimeReady: false,
    },
    {
      name: 'target rule key replaced',
      dbRuleId: '00000000-0000-4000-8000-000000004002',
      rulesAllowed: false,
    },
    { name: 'command rule version replaced', rules: { version: 'rules-v2' }, rulesAllowed: false },
    { name: 'rule effective in the future', rules: { effectiveAt: at + 1 }, rulesAllowed: false },
    {
      name: 'rule expires before certificate',
      rules: { expiresAt: at + 999 },
      rulesAllowed: false,
    },
    { name: 'instrument retired', instrument: { status: 'HALTED' }, rulesAllowed: false },
    { name: 'quote-sized asset rejected', sizeAsset: 'USDT', rulesAllowed: false },
    { name: 'limit type unavailable', rules: { orderTypes: ['MARKET'] }, rulesAllowed: false },
    { name: 'unsupported TIF', rules: { timeInForce: ['IOC'] }, rulesAllowed: false },
    { name: 'limit quantity too high', rules: { maxQuantity: '0.19' }, rulesAllowed: false },
    {
      name: 'market quantity uses its own floor',
      market: true,
      rules: { marketMinQuantity: '0.21' },
      rulesAllowed: false,
    },
    {
      name: 'off-tick limit even if rounded coverage fits',
      limitPrice: '10.51',
      rulesAllowed: false,
      marketAllowed: false,
    },
    {
      name: 'capability reviewed on a different publication',
      capability: { checkedAt: at - 3 },
      capabilityReady: false,
    },
    {
      name: 'capability expires before certificate',
      capability: { expiresAt: at + 999 },
      capabilityReady: false,
    },
    {
      name: 'unproved synthetic adapter',
      capability: { adapterVersion: 'other-adapter' },
      capabilityReady: false,
    },
    {
      name: 'largest supported successor revision',
      originalRevision: '9007199254740989',
    },
    {
      name: 'successor revision exhaustion',
      originalRevision: '9007199254740990',
      commitmentReady: false,
    },
    {
      name: 'different portfolio account',
      bookScope: '00000000-0000-4000-8000-000000004019',
      commitmentReady: false,
    },
    { name: 'gap in source book', bookStatus: 'GAP', commitmentReady: false },
    { name: 'an unresolved hold remains in the book', holdUnknown: true, commitmentReady: false },
    {
      name: 'same hold identity counted twice',
      duplicateHold: true,
      commitmentReady: false,
    },
    {
      name: 'second debit would overspend by one atom',
      quote: {
        balance: '4.742099999999999999',
        available: '2.102099999999999999',
        remaining: '-0.000000000000000001',
      },
      budgetAllowed: false,
      commitmentReady: false,
    },
  ];
  for (const sample of samples) {
    const age = sample.age ?? 60000;
    const op = operationalFixture(at);
    sample.changeOperation?.(op);
    const originalRevision = sample.originalRevision ?? '2';
    const book = {
      status: sample.bookStatus ?? 'RECONCILED',
      binding: {
        ...op.owner,
        accountId: sample.bookScope ?? op.owner.accountId,
        connectionId: null,
      },
      balances: [{ asset: 'USDT', available: sample.quote?.balance ?? '100' }],
      holds: [
        {
          asset: 'USDT',
          amount: '2.64',
          reflected: false,
          id: 'first-hold',
          status: sample.holdUnknown ? 'UNKNOWN' : 'RESERVED',
        },
        ...(sample.duplicateHold
          ? [{ id: 'first-hold', asset: 'USDT', amount: '0', reflected: true, status: 'RESERVED' }]
          : []),
      ],
    };
    const capturedExecution = {
      ...execution,
      effects: { ...execution.effects, state: book },
      source: {
        started: {
          ...execution.source.started,
          capture: { portfolio: { bookId, revision: originalRevision } },
        },
      },
    };
    const policies = (['PLATFORM', 'USER'] as const).map((kind) => ({
      scope: { kind },
      limits: {
        ...limits,
        ...(kind === 'PLATFORM' ? sample.platform : sample.user),
      },
    }));
    const packet = {
      kind: 'CAPTURED',
      target: {
        createdAt: at - age,
        owner: op.owner,
        dbInstrumentId,
        dbRuleId: sample.dbRuleId ?? dbRuleId,
        command: {
          instrumentId,
          ruleVersion: version,
          type: sample.market ? 'MARKET' : 'LIMIT',
          side: 'BUY',
          timeInForce: sample.market ? null : 'GTC',
          trigger: null,
          reduceOnly: false,
          limitPrice: sample.market ? null : (sample.limitPrice ?? '10.5'),
          size: { kind: 'BASE_QUANTITY', value: '0.2', asset: sample.sizeAsset ?? 'BTC' },
        },
      },
      certificate: {
        text: canonical({
          createdAt: at,
          expiresAt: op.expiresAt,
          source: {
            ordersInLastMinute: 2,
            request: { authorization: op.authorization },
            lossInput: { maxEvidenceAgeMs: 5000 },
            capability: { ...capability, expiresAt: op.expiresAt, ...sample.capability },
            controls: seal(op.controls),
            runtime: {
              owner: op.owner,
              asOf: at - 1,
              current: op.current,
              configuration: { receiptText: op.configuration.text, hash: op.configuration.hash },
              publication: { ...seal({ observation: op.observation }), publishedAt: at - 2 },
            },
            policies,
            market: {
              snapshot: {
                text: canonical({
                  ...snapshot,
                  record: {
                    instrument: { ...snapshot.record.instrument, ...sample.instrument },
                    rules: { ...snapshot.record.rules, ...sample.rules },
                  },
                }),
              },
              ...(sample.missingTrade
                ? {}
                : { trade: { text: canonical({ trade: { quantity: '100' } }) } }),
            },
            loss: { text: canonical({ ...loss, ...sample.loss }) },
            inventory: { text: canonical({ executed: { execution: capturedExecution } }) },
          },
        }),
      },
    };
    const { rows } = await startFixtureSql<{ budgetProof: unknown }>(query, [canonical(packet)]);
    expect(rows, sample.name).toEqual([
      {
        result: packet,
        cashProof: {
          asset: 'USDT',
          amount: '2.1021',
          available: sample.quote?.available ?? '97.36',
          remaining: sample.quote?.remaining ?? '95.2579',
        },
        budgetProof: {
          notional: '2.1',
          currentExposure: '5.65',
          projectedExposure: '7.75',
          openOrders: 1,
          potentialPositions: 1,
          ordersInLastMinute: age === 60000 ? 2 : 3,
          withinLimits: sample.budgetAllowed ?? true,
        },
        policyProof: {
          liquidity: sample.missingTrade ? null : '500',
          marketAllowed: sample.marketAllowed ?? true,
          lossAllowed: sample.lossAllowed ?? true,
        },
        operationalProof: {
          runtimeReady: sample.runtimeReady ?? true,
          tradingReady: sample.tradingReady ?? true,
        },
        orderProof: {
          rulesAllowed: sample.rulesAllowed ?? true,
          capabilityReady: sample.capabilityReady ?? true,
        },
        commitmentProof: {
          bookId,
          revision: (BigInt(originalRevision) + 1n).toString(),
          nextRevision: (BigInt(originalRevision) + 2n).toString(),
          ready: sample.commitmentReady ?? true,
          after:
            sample.commitmentReady === false
              ? null
              : {
                  ...book,
                  holds: [
                    ...book.holds,
                    { asset: 'USDT', amount: '2.1021', status: 'RESERVED', reflected: false },
                  ],
                },
        },
      },
    ]);
  }
}
