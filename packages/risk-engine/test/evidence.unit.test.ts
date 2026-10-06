import { describe, expect, it } from 'vitest';
import { deriveRiskExposure, reconstructUtcLoss } from '../src/evidence.js';

const day = Date.UTC(2026, 9, 6);
const tenantId = '11111111-1111-4111-8111-111111111111';
const account = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const scope = { tenantId, mode: 'TESTNET' as const, valuationAsset: 'USD' };
const loss = () => ({
  scope,
  utcDayStart: day,
  coveredThrough: day + 3000,
  complete: true,
  opening: { id: 'opening', sequence: '9007199254740993', at: day, equity: '100' },
  events: [
    { id: 'deposit', sequence: '9007199254740994', at: day + 1000, kind: 'FLOW', amount: '50' },
    { id: 'equity-1', sequence: '9007199254740995', at: day + 1000, kind: 'EQUITY', amount: '160' },
    { id: 'pnl-1', sequence: '9007199254740996', at: day + 2000, kind: 'REALIZED', amount: '-4' },
    { id: 'withdrawal', sequence: '9007199254740997', at: day + 3000, kind: 'FLOW', amount: '-20' },
    { id: 'equity-2', sequence: '9007199254740998', at: day + 3000, kind: 'EQUITY', amount: '120' },
  ],
});
const exposure = () => ({
  scope,
  now: day + 3000,
  maxEvidenceAgeMs: 5000,
  accountIds: [account, other],
  complete: true,
  positions: [
    {
      id: 'position',
      accountId: account,
      instrumentId: 'BTCUSD',
      base: 'BTC',
      quantity: '2',
      price: '10',
      priceAsset: 'USD',
      fx: {
        from: 'USD',
        to: 'USD',
        rate: '1',
        kind: 'IDENTITY',
        sourceId: 'identity',
        at: day + 3000,
      },
      at: day + 3000,
    },
  ],
  orders: [
    {
      id: 'order',
      accountId: account,
      instrumentId: 'BTCUSD',
      base: 'BTC',
      status: 'UNKNOWN',
      notional: '15',
      reductionQuantity: '0',
    },
  ],
  reservations: [
    {
      id: 'reservation',
      orderId: 'order',
      accountId: account,
      instrumentId: 'BTCUSD',
      base: 'BTC',
      notional: '15',
      reductionQuantity: '0',
      asset: 'USD',
      amount: '15.1',
      holdId: 'risk-reservation',
      unknown: true,
    },
  ],
  holds: [
    {
      id: 'risk-reservation',
      accountId: account,
      asset: 'USD',
      amount: '15.1',
      unknown: true,
      reflected: false,
    },
  ],
});
describe('coordinator evidence reconstruction, without granting dispatch authority', () => {
  it('reconstructs UTC loss and peak with external cash flows removed exactly once', () => {
    expect(reconstructUtcLoss(loss(), scope, day + 3000, 5000)).toEqual({
      utcDayStart: day,
      adjustedOpeningEquity: '100',
      adjustedCurrentEquity: '90',
      adjustedPeakEquity: '110',
      dailyNetRealizedPnl: '-4',
      externalFlows: '30',
      lastSequence: '9007199254740998',
    });
  });
  it('reconstruction is identical after JSON persistence/restart', () => {
    expect(reconstructUtcLoss(JSON.parse(JSON.stringify(loss())), scope, day + 3000, 5000)).toEqual(
      reconstructUtcLoss(loss(), scope, day + 3000, 5000),
    );
  });
  it('rejects a mid-day opening instead of reanchoring a loss baseline', () => {
    const x = loss();
    x.opening.at++;
    expect(() => reconstructUtcLoss(x, scope, day + 3000, 5000)).toThrow('RISK_LOSS_BASELINE');
  });
  it.each(['FLOW', 'REALIZED', 'EQUITY'])(
    'requires durable identity for every %s event',
    (kind) => {
      const x = loss();
      x.events.push({ ...x.events[0]!, kind, sequence: '9007199254740999' });
      expect(() => reconstructUtcLoss(x, scope, day + 3000, 5000)).toThrow('RISK_LOSS_REPLAY');
    },
  );
  it('rejects incomplete sequence coverage without Number rounding', () => {
    const x = loss();
    x.events[0]!.sequence = '9007199254740995';
    expect(() => reconstructUtcLoss(x, scope, day + 3000, 5000)).toThrow('RISK_LOSS_SEQUENCE');
  });
  it('does not accept old day, missing flow history, stale/future observations or scope mismatch', () => {
    for (const mutate of [
      (x: ReturnType<typeof loss>) => {
        x.utcDayStart -= 86400000;
      },
      (x: ReturnType<typeof loss>) => {
        x.complete = false;
      },
      (x: ReturnType<typeof loss>) => {
        x.coveredThrough = day + 4000;
      },
      (x: ReturnType<typeof loss>) => {
        x.scope = { ...scope, valuationAsset: 'USDT' };
      },
      (x: ReturnType<typeof loss>) => {
        x.events[4]!.at = day + 3001;
      },
    ]) {
      const x = loss();
      mutate(x);
      expect(() => reconstructUtcLoss(x, scope, day + 3000, 5000)).toThrow();
    }
    expect(() => reconstructUtcLoss(loss(), scope, day + 9000, 5000)).toThrow('RISK_LOSS_BASELINE');
  });
  it('requires a current equity mark after the last external flow', () => {
    const x = loss();
    x.events.pop();
    expect(() => reconstructUtcLoss(x, scope, day + 3000, 5000)).toThrow('RISK_LOSS_BASELINE');
  });
  it('does not count one order, reservation and Portfolio hold three times', () => {
    expect(deriveRiskExposure(exposure(), scope, account, 'BTCUSD', 'BTC')).toEqual({
      instrumentExposure: '35',
      assetExposure: '35',
      accountExposure: '35',
      userExposure: '35',
      concurrentPositions: 1,
      openOrders: 1,
      committedReductionQuantity: '0',
      instrumentHasPendingEntry: true,
      unknownExposure: false,
      unreflectedHolds: [{ accountId: account, asset: 'USD', amount: '15.1' }],
    });
  });
  it('counts UNKNOWN conservatively and keeps its hold after process restart', () => {
    const x = exposure();
    expect(
      deriveRiskExposure(JSON.parse(JSON.stringify(x)), scope, account, 'BTCUSD', 'BTC'),
    ).toEqual(deriveRiskExposure(x, scope, account, 'BTCUSD', 'BTC'));
  });
  it('counts an undispatched reservation once, including a different account under the user limit', () => {
    const x = exposure();
    x.orders = [];
    x.reservations[0]!.accountId = other;
    x.holds[0]!.accountId = other;
    expect(deriveRiskExposure(x, scope, account, 'BTCUSD', 'BTC')).toMatchObject({
      instrumentExposure: '20',
      accountExposure: '20',
      userExposure: '35',
      openOrders: 0,
    });
  });
  it('uses the larger correlated exposure when native order and reservation evidence differ', () => {
    const x = exposure();
    x.reservations[0]!.notional = '17';
    expect(deriveRiskExposure(x, scope, account, 'BTCUSD', 'BTC').instrumentExposure).toBe('37');
  });
  it('requires all active reservations to have an exact durable Portfolio commitment', () => {
    for (const mutate of [
      (x: ReturnType<typeof exposure>) => {
        x.holds = [];
      },
      (x: ReturnType<typeof exposure>) => {
        x.holds[0]!.amount = '15';
      },
      (x: ReturnType<typeof exposure>) => {
        x.holds[0]!.asset = 'USDT';
      },
      (x: ReturnType<typeof exposure>) => {
        x.holds[0]!.accountId = other;
      },
      (x: ReturnType<typeof exposure>) => {
        x.holds[0]!.unknown = false;
      },
    ]) {
      const x = exposure();
      mutate(x);
      expect(() => deriveRiskExposure(x, scope, account, 'BTCUSD', 'BTC')).toThrow(
        'RISK_HOLD_EVIDENCE',
      );
    }
  });
  it('rejects duplicate/conflicting identities and mismatched order/reservation scope', () => {
    for (const mutate of [
      (x: ReturnType<typeof exposure>) => {
        x.orders.push({ ...x.orders[0]! });
      },
      (x: ReturnType<typeof exposure>) => {
        x.reservations.push({ ...x.reservations[0]! });
      },
      (x: ReturnType<typeof exposure>) => {
        x.holds.push({ ...x.holds[0]! });
      },
      (x: ReturnType<typeof exposure>) => {
        x.positions.push({ ...x.positions[0]! });
      },
      (x: ReturnType<typeof exposure>) => {
        x.orders[0]!.accountId = other;
      },
      (x: ReturnType<typeof exposure>) => {
        x.orders[0]!.instrumentId = 'ETHUSD';
      },
    ]) {
      const x = exposure();
      mutate(x);
      expect(() => deriveRiskExposure(x, scope, account, 'BTCUSD', 'BTC')).toThrow();
    }
  });
  it('rejects incomplete account inventory, unmatched holds and unsupported valuation', () => {
    for (const mutate of [
      (x: ReturnType<typeof exposure>) => {
        x.complete = false;
      },
      (x: ReturnType<typeof exposure>) => {
        x.accountIds = [other];
      },
      (x: ReturnType<typeof exposure>) => {
        x.holds.push({ ...x.holds[0]!, id: 'unowned-hold' });
      },
      (x: ReturnType<typeof exposure>) => {
        x.positions[0]!.fx.to = 'USDT';
      },
      (x: ReturnType<typeof exposure>) => {
        x.positions[0]!.fx.rate = '0.99';
      },
      (x: ReturnType<typeof exposure>) => {
        x.positions[0]!.fx.at -= 5001;
      },
    ]) {
      const x = exposure();
      mutate(x);
      expect(() => deriveRiskExposure(x, scope, account, 'BTCUSD', 'BTC')).toThrow();
    }
  });
  it('unknown has a bounded worst case; missing monetary bounds never mean zero', () => {
    const x = exposure();
    expect(() =>
      deriveRiskExposure(
        { ...x, orders: [{ ...x.orders[0], notional: null }] },
        scope,
        account,
        'BTCUSD',
        'BTC',
      ),
    ).toThrow('RISK_EXPOSURE_INPUT');
  });
  it('does not treat UNKNOWN with zero exposure and no reduction proof as a bounded no-op', () => {
    const x = exposure();
    x.orders[0]!.notional = '0';
    x.reservations[0]!.notional = '0';
    expect(() => deriveRiskExposure(x, scope, account, 'BTCUSD', 'BTC')).toThrow(
      'RISK_ORDER_EVIDENCE',
    );
  });
  it('reflected native collateral is not subtracted twice, while the reservation remains active', () => {
    const x = exposure();
    x.holds[0]!.reflected = true;
    expect(deriveRiskExposure(x, scope, account, 'BTCUSD', 'BTC')).toMatchObject({
      userExposure: '35',
      unreflectedHolds: [],
    });
  });
  it('records competing reduction commitments exactly once without adding increasing notional', () => {
    const x = exposure();
    x.orders[0]!.reductionQuantity = '1';
    x.orders[0]!.notional = '0';
    x.reservations[0]!.reductionQuantity = '1';
    x.reservations[0]!.notional = '0';
    expect(deriveRiskExposure(x, scope, account, 'BTCUSD', 'BTC')).toMatchObject({
      userExposure: '20',
      committedReductionQuantity: '1',
      instrumentHasPendingEntry: false,
    });
  });
});
