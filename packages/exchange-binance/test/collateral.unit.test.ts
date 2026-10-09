import { expect, it } from 'vitest';
import { order, privateRecord } from './fixtures/private-data.js';
import { NOW } from './fixtures/public-data.js';
import * as protocol from '../src/amendment.js';

const native = () => ({
  ...order(),
  orderListId: '-1',
  icebergQty: '0',
  origQuoteOrderQty: '0',
  isWorking: true,
  selfTradePreventionMode: 'NONE',
});
const check = (raw: unknown) => {
  const validator = Reflect.get(protocol, 'checkBinanceCollateralOrder');
  validator(raw, privateRecord().instrument.exchangeSymbol);
};
it('accepts only explicitly working standalone Spot LIMIT/GTC native collateral evidence', () => {
  expect(() => check(native())).not.toThrow();
});
it.each(['isWorking', 'orderListId', 'icebergQty', 'origQuoteOrderQty', 'selfTradePreventionMode'])(
  'rejects missing native eligibility %s instead of inferring it',
  (field) => {
    const raw: Record<string, unknown> = { ...native() };
    delete raw[field];
    expect(() => check(raw)).toThrow('INVALID_RESPONSE');
  },
);
it.each([
  { isWorking: false },
  { orderListId: '9223372036854775807' },
  { icebergQty: '0.01' },
  { origQuoteOrderQty: '10' },
  { usedSor: true },
  { trailingDelta: '1' },
  { pegPriceType: 'PRIMARY_PEG' },
  { status: 'CANCELED' },
  { type: 'MARKET' },
  { timeInForce: 'IOC' },
  { preventedQuantity: '0.01' },
  { unknownConstraint: '0' },
  { updateTime: String(NOW), workingFloor: 'EXCHANGE' },
])('rejects unsupported or ambiguous native collateral semantics %#', (patch) => {
  expect(() => check({ ...native(), ...patch })).toThrow('INVALID_RESPONSE');
});
