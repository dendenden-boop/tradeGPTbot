import { expect, it } from 'vitest';
import { deriveRiskExposure } from '../src/evidence.js';

const accountId = '22222222-2222-4222-8222-222222222222';
const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  mode: 'TESTNET' as const,
  valuationAsset: 'USDT',
};
function input() {
  const effect = {
    accountId,
    instrumentId: 'BTCUSDT',
    base: 'BTC',
    notional: '5',
    reductionQuantity: '0',
  };
  return {
    scope,
    now: 1000,
    maxEvidenceAgeMs: 5000,
    accountIds: [accountId],
    complete: true,
    positions: [],
    orders: [{ id: 'order', ...effect, status: 'OPEN' }],
    reservations: [
      {
        id: 'primary',
        orderId: 'order',
        ...effect,
        asset: 'USDT',
        amount: '5.005',
        holdId: 'primary',
        unknown: false,
      },
    ],
    holds: [
      {
        id: 'primary',
        accountId,
        asset: 'USDT',
        amount: '5.005',
        unknown: false,
        reflected: false,
      },
      { id: 'control', accountId, asset: 'USDT', amount: '0', unknown: false, reflected: false },
    ],
    controls: [
      {
        id: 'control',
        intentId: 'amend',
        orderId: 'order',
        primaryReservationId: 'primary',
        accountId,
        asset: 'USDT',
        amount: '0',
        holdId: 'control',
        unknown: false,
      },
    ],
  };
}
const derive = (value: unknown) => deriveRiskExposure(value, scope, accountId, 'BTCUSDT', 'BTC');
it('includes a durable zero-delta control reservation without another financial or logical order effect', () => {
  const f = input();
  const original = { ...f, holds: f.holds.slice(0, 1) };
  Reflect.deleteProperty(original, 'controls');
  expect(derive(f)).toEqual(derive(original));
});
it.each(['PARENT', 'AMOUNT', 'ACCOUNT', 'DUPLICATE', 'UNKNOWN_PRIMARY'] as const)(
  'rejects %s control evidence instead of ignoring the reservation',
  (kind) => {
    const f = input();
    if (kind === 'PARENT') f.controls[0]!.primaryReservationId = 'missing';
    if (kind === 'AMOUNT') f.controls[0]!.amount = '1';
    if (kind === 'ACCOUNT') f.controls[0]!.accountId = '33333333-3333-4333-8333-333333333333';
    if (kind === 'DUPLICATE') f.controls.push({ ...f.controls[0]! });
    if (kind === 'UNKNOWN_PRIMARY') {
      f.controls[0]!.unknown = true;
      f.holds[1]!.unknown = true;
    }
    expect(() => derive(f)).toThrow();
  },
);
it('keeps UNKNOWN control and its primary reservation bounded once', () => {
  const f = input();
  f.controls[0]!.unknown = true;
  f.reservations[0]!.unknown = true;
  for (const hold of f.holds) hold.unknown = true;
  f.orders[0]!.status = 'UNKNOWN';
  expect(derive(f)).toMatchObject({
    instrumentExposure: '5',
    accountExposure: '5',
    openOrders: 1,
    // UNKNOWN outcome has a known conservative bound; this is the existing
    // exposure contract, not permission to release or dispatch the control.
    unknownExposure: false,
  });
});
