import { describe, expect, it } from 'vitest';
import { evaluateRiskPolicy, riskEvaluationInputSchema } from '../src/index.js';
import { parseDecimal, type AdapterProfile } from '@ctp/exchange-core';
import { NOW, newOrderFixture } from '../../exchange-core/test/fixtures/domain.js';
import { fixture } from './fixtures.js';
import {
  adapterProfile as binance,
  getBinanceProfile,
} from '../../exchange-binance/src/profiles.js';
import { adapterProfile as bybit, getBybitProfile } from '../../exchange-bybit/src/profiles.js';
import { adapterProfile as okx, getOkxProfile } from '../../exchange-okx/src/profiles.js';
import { adapterProfile as htx, getHtxProfile } from '../../exchange-htx/src/profiles.js';
import { normalizeExchangeInfo } from '../../exchange-binance/src/public-data.js';
import { normalizeInstrument as normalizeBybit } from '../../exchange-bybit/src/public-data.js';
import { normalizeInstrument as normalizeOkx } from '../../exchange-okx/src/public-data.js';
import { normalizeInstrument as normalizeHtx } from '../../exchange-htx/src/public-data.js';
import {
  exchangeInfo,
  spotSymbol,
  futuresSymbol,
} from '../../exchange-binance/test/fixtures/public-data.js';
import { nativeInstrument as bybitInstrument } from '../../exchange-bybit/test/fixtures.js';
import { nativeInstrument as okxInstrument } from '../../exchange-okx/test/fixtures.js';
import { spot, swap } from '../../exchange-htx/test/fixtures.js';

const profiles = [
  binance(getBinanceProfile('binance-spot-testnet-v1')),
  bybit(getBybitProfile('bybit-spot-testnet-v1')),
  okx(getOkxProfile('okx-spot-demo-v1')),
  htx(getHtxProfile('htx-spot-live-v1')),
  binance(getBinanceProfile('binance-usdm-testnet-v1')),
  bybit(getBybitProfile('bybit-linear-testnet-v1')),
  okx(getOkxProfile('okx-swap-demo-v1')),
  htx(getHtxProfile('htx-linear-live-v1')),
];
function nativeFixture(profile: AdapterProfile) {
  const f = riskEvaluationInputSchema.parse(fixture()),
    linear = profile.market !== 'SPOT',
    { exchange, region, market, environment } = profile,
    scope = { exchange, region, market, environment };
  f.binding.profile = profile;
  f.binding.mode = profile.environment;
  f.snapshot.binding = structuredClone(f.binding);
  f.record = structuredClone(
    exchange === 'BINANCE'
      ? normalizeExchangeInfo(
          exchangeInfo([linear ? futuresSymbol() : spotSymbol()]),
          scope,
          NOW,
        )[0]!
      : exchange === 'BYBIT'
        ? normalizeBybit(bybitInstrument(linear), scope, NOW, 'risk-native-profile').record
        : exchange === 'OKX'
          ? normalizeOkx(okxInstrument(linear), scope, NOW, 'risk-native-profile').record
          : normalizeHtx(linear ? swap : spot, scope, NOW, 'risk-native-profile').record,
  );
  // Separate server risk-tier evidence; the native symbol normalizers do not provide a tier table.
  if (linear)
    f.record.rules.leverageTiers = [
      { notionalCap: '1000', maxLeverage: '5' },
    ] as typeof f.record.rules.leverageTiers;
  f.order = newOrderFixture(f.record);
  f.snapshot.instrumentId = f.record.instrument.id;
  f.capabilities = f.capabilities.map((c) => ({ ...c, profile }));
  f.snapshot.market.kind = linear ? 'MARK' : 'LAST';
  f.snapshot.positionEvidence = {
    ...f.snapshot.positionEvidence,
    mode: linear ? (exchange === 'HTX' ? 'HEDGE' : 'ONE_WAY') : 'SPOT',
    accountMode: profile.accountMode,
    instrumentId: f.order.instrumentId,
  };
  return f;
}
const rejected = (input: unknown, reason: string) =>
  expect(evaluateRiskPolicy(input)).toEqual({ kind: 'REJECTED', reasons: [reason] });
describe('Risk position mode and currency proof', () => {
  it.each(profiles)('uses native metadata and exact $endpointProfileId profile', (profile) => {
    const f = nativeFixture(profile);
    if (profile.exchange === 'HTX' && profile.market === 'LINEAR_PERPETUAL')
      rejected(f, 'RISK_POSITION_MODE_UNPROVED');
    else if (profile.exchange === 'OKX' && profile.market === 'LINEAR_PERPETUAL')
      rejected(f, 'RISK_UNSUPPORTED');
    else expect(evaluateRiskPolicy(f).kind).toBe('EVALUATED');
    f.capabilities = f.capabilities.map((c) => ({
      ...c,
      profile: { ...profile, profileVersion: 'different' },
    }));
    if (f.order.size.kind === 'BASE_QUANTITY') rejected(f, 'RISK_CAPABILITY');
  });
  it.each([
    'HEDGE',
    'account',
    'accountMode',
    'instrument',
    'revision',
    'source',
    'side',
    'quantity',
    'stale',
    'future',
  ] as const)('rejects contradictory ONE_WAY %s proof', (variant) => {
    const f = nativeFixture(profiles[4]!),
      e = f.snapshot.positionEvidence;
    if (variant === 'HEDGE') e.mode = 'HEDGE';
    if (variant === 'account') e.accountId = '33333333-3333-4333-8333-333333333333';
    if (variant === 'accountMode') e.accountMode = 'HEDGE';
    if (variant === 'instrument') e.instrumentId = 'OTHER';
    if (variant === 'revision') e.revision = '1';
    if (variant === 'source') e.sourceId = 'old-source';
    if (variant === 'side') e.side = 'LONG';
    if (variant === 'quantity') e.quantity = parseDecimal('1');
    if (variant === 'stale') e.asOf = NOW - 5001;
    if (variant === 'future') e.asOf = NOW + 1;
    rejected(f, 'RISK_POSITION_MODE_UNPROVED');
  });
  it('cannot relabel the HTX HEDGE profile as ONE_WAY', () => {
    const f = nativeFixture(profiles[7]!);
    f.snapshot.positionEvidence.mode = 'ONE_WAY';
    rejected(f, 'RISK_POSITION_MODE_UNPROVED');
  });
  it('converts native USDT prices to USD exposure once and compares USD liquidity losslessly', () => {
    const f = riskEvaluationInputSchema.parse(fixture());
    f.platform.valuationAsset = f.user.valuationAsset = f.snapshot.valuationAsset = 'USD';
    f.snapshot.market = {
      ...f.snapshot.market,
      fxKind: 'OBSERVED',
      quoteToValuation: parseDecimal('1.2'),
      fxSourceId: 'usdt-usd-native-rate',
      fxToAsset: 'USD',
      liquidityAsset: 'USD',
      liquidityNotional: parseDecimal('60'),
    };
    expect(evaluateRiskPolicy(f)).toMatchObject({
      kind: 'EVALUATED',
      notional: '6',
      proposal: { asset: 'USDT', amount: '5.05' },
    });
    f.platform.minLiquidityNotional = parseDecimal('60.000000000000000001');
    rejected(f, 'RISK_LIQUIDITY');
    f.platform.minLiquidityNotional = parseDecimal('1');
    f.snapshot.market.liquidityNotional = parseDecimal('5.999999999999999999');
    rejected(f, 'RISK_LIQUIDITY');
  });
  it.each([
    'liquidityAsset',
    'priceAsset',
    'fxFromAsset',
    'fxToAsset',
    'fxKind',
    'identityRate',
  ] as const)('rejects conflicting %s currency evidence', (variant) => {
    const f = riskEvaluationInputSchema.parse(fixture());
    if (variant === 'identityRate') f.snapshot.market.quoteToValuation = parseDecimal('0.99');
    else if (variant === 'fxKind') f.snapshot.market.fxKind = 'OBSERVED';
    else f.snapshot.market[variant] = 'USD';
    rejected(f, 'RISK_CURRENCY_UNPROVED');
  });
  it('does not infer stablecoin parity from IDENTITY evidence', () => {
    const f = riskEvaluationInputSchema.parse(fixture());
    f.platform.valuationAsset = f.user.valuationAsset = f.snapshot.valuationAsset = 'USDC';
    f.snapshot.market.fxToAsset = f.snapshot.market.liquidityAsset = 'USDC';
    rejected(f, 'RISK_CURRENCY_UNPROVED');
  });
});
