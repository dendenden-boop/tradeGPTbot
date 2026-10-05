import { describe, expect, it } from 'vitest';
import { evaluateRiskPolicy, intersectRiskLimits } from '../src/index.js';
import { parseDecimal } from '@ctp/exchange-core';
import { grantSchema } from '../../order-engine/src/domain.js';
import { NOW, recordFixture, newOrderFixture } from '../../exchange-core/test/fixtures/domain.js';
import { capabilities, profile } from '../../exchange-core/test/fixtures/adapter.js';

function fixture() {
  const record = recordFixture();
  const binding = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    mode: 'TESTNET',
    profile,
  };
  const limits = {
    valuationAsset: 'USDT',
    maxOrderNotional: '100',
    maxInstrumentExposure: '200',
    maxAssetExposure: '300',
    maxAccountExposure: '400',
    maxUserExposure: '500',
    maxConcurrentPositions: 3,
    maxOpenOrders: 5,
    maxLeverage: '5',
    maxDailyRealizedLoss: '20',
    maxDailyTotalLoss: '30',
    maxDrawdownRate: '0.2',
    maxOrdersPerMinute: 10,
    minAvailableBalance: '1',
    maxPriceDeviationRate: '0.1',
    maxSpreadRate: '0.02',
    minLiquidityNotional: '50',
    maxEvidenceAgeMs: 5000,
  };
  return {
    now: NOW,
    binding,
    adapterVersion: 'v1',
    platform: { ...limits },
    user: { ...limits },
    order: newOrderFixture(record),
    record,
    capabilities: capabilities
      .filter((x) => ['LIMIT_ORDER', 'MARKET_ORDER', 'REDUCE_ONLY'].includes(x.feature))
      .map((x) => ({ ...x, profile, checkedAt: NOW - 1000, expiresAt: NOW + 60000 })),
    snapshot: {
      binding: structuredClone(binding),
      instrumentId: record.instrument.id,
      revision: '9007199254740993',
      sourceId: 'certified-fixture',
      sourceAt: NOW - 100,
      reconciledAt: NOW - 50,
      complete: true,
      unknownExposure: false,
      valuationAsset: 'USDT',
      instrumentExposure: '10',
      assetExposure: '20',
      accountExposure: '30',
      userExposure: '40',
      positionQuantity: '0',
      committedReductionQuantity: '0',
      instrumentHasPendingEntry: false,
      concurrentPositions: 1,
      openOrders: 1,
      ordersInLastMinute: 1,
      leverage: '1',
      availableAsset: 'USDT',
      availableAmount: '1000',
      dailyNetRealizedPnl: '0',
      adjustedOpeningEquity: '100',
      adjustedCurrentEquity: '100',
      adjustedPeakEquity: '100',
      utcDayStart: Math.floor(NOW / 86400000) * 86400000,
      lossBaselineComplete: true,
      pauses: { global: false, user: false, connection: false, strategy: false },
      circuit: 'CLOSED',
      health: {
        database: 'HEALTHY',
        limiter: 'HEALTHY',
        authentication: 'HEALTHY',
        exchangeRest: 'HEALTHY',
        privateStream: 'HEALTHY',
        clock: 'HEALTHY',
        latency: 'HEALTHY',
        rejectRate: 'HEALTHY',
        maintenance: 'HEALTHY',
      },
      market: {
        sourceId: 'book-and-price-fixture',
        asOf: NOW - 20,
        complete: true,
        referencePrice: '10',
        lowerExecutionPrice: '9.9',
        upperExecutionPrice: '10.1',
        bid: '9.95',
        ask: '10.05',
        liquidityNotional: '1000',
        quoteToValuation: '1',
        fxSourceId: 'identity-fx',
        fxAsOf: NOW - 20,
        kind: 'LAST',
        executionBoundEnforced: true,
        feeAsset: 'USDT',
        maxFeeRate: '0.01',
      },
    },
  };
}
const rejected = (input: unknown, reason: string) =>
  expect(evaluateRiskPolicy(input)).toEqual({ kind: 'REJECTED', reasons: [reason] });
describe('PHASE 12 pure policy contract (does not issue RiskGrant)', () => {
  it('computes a conservative amount without changing command or claiming authority', () => {
    const input = fixture(),
      before = structuredClone(input),
      result = evaluateRiskPolicy(input);
    expect(result).toMatchObject({
      kind: 'EVALUATED',
      effect: 'INCREASE',
      notional: '5',
      proposal: { asset: 'USDT', amount: '5.05' },
    });
    expect(result).not.toHaveProperty('decisionId');
    expect(result).not.toHaveProperty('reservationId');
    expect(result).not.toHaveProperty('authorization');
    expect(grantSchema.safeParse(result).success).toBe(false);
    expect(input).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('intersects hard/user maxima and protection minima', () => {
    const f = fixture();
    f.user.maxOrderNotional = '1000';
    f.user.minAvailableBalance = '0';
    f.platform.minLiquidityNotional = '200';
    expect(intersectRiskLimits(f.platform, f.user)).toMatchObject({
      maxOrderNotional: '100',
      minAvailableBalance: '1',
      minLiquidityNotional: '200',
    });
    f.user.valuationAsset = 'USD';
    expect(() => intersectRiskLimits(f.platform, f.user)).toThrow('RISK_POLICY_INVALID');
  });
  it.each([
    'maxOrderNotional',
    'maxInstrumentExposure',
    'maxAssetExposure',
    'maxAccountExposure',
    'maxUserExposure',
  ] as const)('enforces %s at exact decimal boundaries', (key) => {
    const f = fixture(),
      current =
        key === 'maxOrderNotional'
          ? '0'
          : (
              {
                maxInstrumentExposure: '10',
                maxAssetExposure: '20',
                maxAccountExposure: '30',
                maxUserExposure: '40',
              } as const
            )[key];
    f.platform[key] = String(Number(current) + 5);
    expect(evaluateRiskPolicy(f).kind).toBe('EVALUATED');
    f.platform[key] = String(Number(current) + 4.99);
    rejected(
      f,
      'RISK_' +
        (
          {
            maxOrderNotional: 'MAX_ORDER_NOTIONAL',
            maxInstrumentExposure: 'MAX_INSTRUMENT_EXPOSURE',
            maxAssetExposure: 'MAX_ASSET_EXPOSURE',
            maxAccountExposure: 'MAX_ACCOUNT_EXPOSURE',
            maxUserExposure: 'MAX_USER_EXPOSURE',
          } as const
        )[key],
    );
  });
  it('uses lossless precision above Number safe integer and never rounds financial intermediates', () => {
    const f = fixture();
    f.snapshot.accountExposure = '9007199254740993';
    f.platform.maxAccountExposure = '9007199254740998';
    f.user.maxAccountExposure = '9007199254740998';
    f.snapshot.userExposure = '9007199254740993';
    f.platform.maxUserExposure = '9007199254741098';
    f.user.maxUserExposure = '9007199254741098';
    expect(evaluateRiskPolicy(f).kind).toBe('EVALUATED');
    f.user.maxAccountExposure = '9007199254740997.999999999999999999';
    rejected(f, 'RISK_MAX_ACCOUNT_EXPOSURE');
    const fine = fixture();
    fine.snapshot.market.maxFeeRate = '0.000000000000000001';
    fine.order.size.value = '0.55' as typeof fine.order.size.value;
    rejected(fine, 'RISK_ARITHMETIC_UNPROVED');
  });
  it.each(['maxConcurrentPositions', 'maxOpenOrders', 'maxOrdersPerMinute'] as const)(
    'counts next allocation for %s',
    (key) => {
      const f = fixture();
      f.platform[key] = 1;
      rejected(
        f,
        (
          {
            maxConcurrentPositions: 'RISK_MAX_CONCURRENT_POSITIONS',
            maxOpenOrders: 'RISK_MAX_OPEN_ORDERS',
            maxOrdersPerMinute: 'RISK_ORDER_FREQUENCY',
          } as const
        )[key],
      );
    },
  );
  it('does not allocate a second concurrent position to the same instrument', () => {
    const f = fixture();
    f.platform.maxConcurrentPositions = 1;
    f.snapshot.instrumentHasPendingEntry = true;
    expect(evaluateRiskPolicy(f).kind).toBe('EVALUATED');
  });
  it.each(['global', 'user', 'connection', 'strategy'] as const)('preserves %s pause', (key) => {
    const f = fixture();
    f.snapshot.pauses[key] = true;
    rejected(f, 'RISK_PAUSED');
  });
  it.each(['OPEN', 'HALF_OPEN'])('circuit %s grants no probe order', (circuit) => {
    const f = fixture();
    f.snapshot.circuit = circuit;
    rejected(f, 'RISK_CIRCUIT_OPEN');
  });
  it.each([
    'database',
    'limiter',
    'authentication',
    'exchangeRest',
    'privateStream',
    'clock',
    'latency',
    'rejectRate',
    'maintenance',
  ] as const)('fails closed on unhealthy %s', (key) => {
    const f = fixture();
    f.snapshot.health[key] = 'UNKNOWN';
    rejected(f, 'RISK_HEALTH');
  });
  it.each(['sourceAt', 'reconciledAt'] as const)('rejects stale or future %s', (key) => {
    const f = fixture();
    f.snapshot[key] = NOW - 5001;
    rejected(f, 'RISK_STALE_STATE');
    f.snapshot[key] = NOW + 1;
    rejected(f, 'RISK_STALE_STATE');
  });
  it('rejects stale market, incomplete reconciliation, UNKNOWN and crossed book', () => {
    const f = fixture();
    f.snapshot.market.asOf = NOW - 5001;
    rejected(f, 'RISK_STALE_MARKET');
    const i = fixture();
    i.snapshot.complete = false;
    rejected(i, 'RISK_STATE_UNPROVED');
    const u = fixture();
    u.snapshot.unknownExposure = true;
    rejected(u, 'RISK_STATE_UNPROVED');
    const c = fixture();
    c.snapshot.market.bid = '10.1';
    rejected(c, 'RISK_MARKET_UNPROVED');
  });
  it('rejects source scope, mode/environment and currency contradictions', () => {
    const f = fixture();
    f.snapshot.binding.accountId = '33333333-3333-4333-8333-333333333333';
    rejected(f, 'RISK_SCOPE');
    const m = fixture();
    m.binding.mode = 'DEMO';
    rejected(m, 'RISK_SCOPE');
    const fx = fixture();
    fx.snapshot.market.quoteToValuation = '0.99';
    rejected(fx, 'RISK_CURRENCY_UNPROVED');
  });
  it('enforces available funds, fee reserve and minimum free balance', () => {
    const f = fixture();
    f.snapshot.availableAmount = '6.05';
    expect(evaluateRiskPolicy(f).kind).toBe('EVALUATED');
    f.snapshot.availableAmount = '6.049999999999999999';
    rejected(f, 'RISK_AVAILABLE_BALANCE');
    f.snapshot.market.feeAsset = 'BNB';
    rejected(f, 'RISK_FEE_UNPROVED');
  });
  it.each(['realized', 'total', 'drawdown'] as const)(
    'blocks reached %s loss cap using adjusted UTC evidence',
    (kind) => {
      const f = fixture();
      if (kind === 'realized') f.snapshot.dailyNetRealizedPnl = '-20';
      if (kind === 'total') f.snapshot.adjustedCurrentEquity = '70';
      if (kind === 'drawdown') f.snapshot.adjustedCurrentEquity = '80';
      rejected(
        f,
        (
          {
            realized: 'RISK_DAILY_REALIZED_LOSS',
            total: 'RISK_DAILY_TOTAL_LOSS',
            drawdown: 'RISK_DRAWDOWN',
          } as const
        )[kind],
      );
    },
  );
  it('requires reconstructed daily baseline and positive high-water equity', () => {
    const f = fixture();
    f.snapshot.utcDayStart -= 86400000;
    rejected(f, 'RISK_LOSS_BASELINE');
    const z = fixture();
    z.snapshot.adjustedPeakEquity = '0';
    rejected(z, 'RISK_LOSS_BASELINE');
  });
  it('checks price deviation, spread, liquidity and leverage', () => {
    const f = fixture();
    f.order.limitPrice = '11.05' as typeof f.order.limitPrice;
    rejected(f, 'RISK_PRICE_DEVIATION');
    const s = fixture();
    s.snapshot.market.ask = '10.2';
    s.snapshot.market.upperExecutionPrice = '10.3';
    rejected(s, 'RISK_SPREAD');
    const l = fixture();
    l.snapshot.market.liquidityNotional = '49.99';
    rejected(l, 'RISK_LIQUIDITY');
    const lev = fixture();
    lev.snapshot.leverage = '6';
    rejected(lev, 'RISK_MAX_LEVERAGE');
  });
  it('checks current rules/capability and market-order notional bounds', () => {
    const stale = fixture();
    stale.order.ruleVersion = 'old';
    rejected(stale, 'RISK_ORDER_RULES');
    const cap = fixture();
    cap.capabilities.find((c) => c.feature === 'LIMIT_ORDER')!.support = 'UNSUPPORTED';
    rejected(cap, 'RISK_CAPABILITY');
    const m = fixture();
    m.order = { ...m.order, type: 'MARKET', limitPrice: null, timeInForce: null };
    m.record.rules.minNotional = '5' as typeof m.record.rules.minNotional;
    rejected(m, 'RISK_ORDER_NOTIONAL');
    const max = fixture();
    max.order = { ...max.order, type: 'MARKET', limitPrice: null, timeInForce: null };
    max.record.rules.maxNotional = '5' as typeof max.record.rules.maxNotional;
    rejected(max, 'RISK_ORDER_NOTIONAL');
  });
  it('rejects unbounded market execution, unsupported conditional commands and expired native capability', () => {
    const f = fixture();
    f.order = { ...f.order, type: 'MARKET', limitPrice: null, timeInForce: null };
    f.snapshot.market.executionBoundEnforced = false;
    rejected(f, 'RISK_MARKET_UNPROVED');
    const c = fixture();
    c.order = {
      ...c.order,
      type: 'STOP_LIMIT',
      trigger: { price: parseDecimal('9'), source: 'LAST' },
    };
    rejected(c, 'RISK_UNSUPPORTED');
    const e = fixture();
    e.capabilities = e.capabilities.map((c) => ({ ...c, expiresAt: NOW }));
    rejected(e, 'RISK_CAPABILITY');
  });
  it('requires fresh conversion provenance and rejects policy units mismatch', () => {
    const f = fixture();
    f.snapshot.market.fxAsOf = NOW - 5001;
    rejected(f, 'RISK_STALE_MARKET');
    const u = fixture();
    u.user.valuationAsset = 'USD';
    rejected(u, 'RISK_POLICY_INVALID');
    const p = fixture();
    p.snapshot.adjustedOpeningEquity = '0';
    rejected(p, 'RISK_LOSS_BASELINE');
  });
  it.each(['BINANCE', 'BYBIT', 'OKX', 'HTX'] as const)(
    'evaluates exact %s profile without adapter-specific permissive defaults',
    (exchange) => {
      const f = fixture();
      f.binding.profile = { ...f.binding.profile, exchange };
      f.snapshot.binding = structuredClone(f.binding);
      f.record = {
        instrument: { ...f.record.instrument, scope: { ...f.record.instrument.scope, exchange } },
        rules: { ...f.record.rules, scope: { ...f.record.rules.scope, exchange } },
      };
      f.capabilities = f.capabilities.map((c) => ({ ...c, profile: f.binding.profile }));
      expect(evaluateRiskPolicy(f).kind).toBe('EVALUATED');
      f.capabilities = f.capabilities.map((c) => ({
        ...c,
        profile: { ...c.profile, profileVersion: 'different' },
      }));
      rejected(f, 'RISK_CAPABILITY');
    },
  );
  it('preserves tighter platform maxima over a deterministic range of user limits', () => {
    for (let i = 0; i < 100; i++) {
      const f = fixture();
      f.platform.maxOrderNotional = '4.99';
      f.user.maxOrderNotional = String(5 + i);
      rejected(f, 'RISK_MAX_ORDER_NOTIONAL');
      const bounds = intersectRiskLimits(f.platform, f.user);
      expect(bounds.maxOrderNotional).toBe('4.99');
    }
  });
  it('sells reserve base including base fee; no cash borrowing', () => {
    const f = fixture();
    f.order.side = 'SELL';
    f.snapshot.market.feeAsset = 'BTC';
    f.snapshot.availableAsset = 'BTC';
    f.snapshot.availableAmount = '1';
    expect(evaluateRiskPolicy(f)).toMatchObject({
      kind: 'EVALUATED',
      proposal: { asset: 'BTC', amount: '0.505' },
    });
    f.snapshot.availableAmount = '0.504';
    rejected(f, 'RISK_AVAILABLE_BALANCE');
  });
  it('proves derivative reduction from position less concurrent closing commitments', () => {
    const f = fixture(),
      r = recordFixture({ market: 'LINEAR_PERPETUAL' });
    r.rules.quantityUnit = 'BASE';
    r.rules.leverageTiers = [
      { notionalCap: '1000', maxLeverage: '5' },
    ] as typeof r.rules.leverageTiers;
    f.record = r;
    f.order = newOrderFixture(r, { side: 'SELL', reduceOnly: true });
    f.binding.profile = { ...profile, market: 'LINEAR_PERPETUAL', accountMode: 'UNIFIED' };
    f.snapshot.binding = structuredClone(f.binding);
    f.capabilities = f.capabilities.map((x) => ({ ...x, profile: f.binding.profile }));
    f.snapshot.positionQuantity = '1';
    f.snapshot.committedReductionQuantity = '0.5';
    f.snapshot.availableAmount = '1.05';
    f.snapshot.market.kind = 'MARK';
    f.snapshot.pauses.global = true;
    f.snapshot.circuit = 'OPEN';
    expect(evaluateRiskPolicy(f)).toMatchObject({
      kind: 'EVALUATED',
      effect: 'REDUCE',
      proposal: { asset: 'USDT', amount: '0.05' },
    });
    f.snapshot.committedReductionQuantity = '0.6';
    rejected(f, 'RISK_REDUCTION_UNPROVED');
    f.snapshot.committedReductionQuantity = '0';
    f.order.side = 'BUY';
    rejected(f, 'RISK_REDUCTION_UNPROVED');
  });
  it('rejects malformed/extra/unbounded inputs and cannot issue transport grants', () => {
    const f = fixture();
    rejected({ ...f, tenantId: f.binding.tenantId }, 'RISK_INPUT');
    rejected({ ...f, platform: { ...f.platform, maxOrderNotional: 100 } }, 'RISK_INPUT');
    const bad = fixture();
    bad.snapshot.revision = '9007199254740993';
    bad.snapshot.market.sourceId = 's'.repeat(100000);
    rejected(bad, 'RISK_INPUT');
    const hostile = Object.defineProperty({}, 'now', {
      get() {
        throw new Error('secret');
      },
    });
    rejected(hostile, 'RISK_INPUT');
  });
  it.each(['aggregate', 'spot-short', 'position-count', 'pending-count'] as const)(
    'rejects internally contradictory %s evidence despite complete=true',
    (variant) => {
      const f = fixture();
      if (variant === 'aggregate') f.snapshot.userExposure = '29';
      if (variant === 'spot-short') f.snapshot.positionQuantity = '-1';
      if (variant === 'position-count') {
        f.snapshot.positionQuantity = '1';
        f.snapshot.concurrentPositions = 0;
      }
      if (variant === 'pending-count') {
        f.snapshot.instrumentHasPendingEntry = true;
        f.snapshot.openOrders = 0;
      }
      rejected(f, 'RISK_STATE_UNPROVED');
    },
  );
});
