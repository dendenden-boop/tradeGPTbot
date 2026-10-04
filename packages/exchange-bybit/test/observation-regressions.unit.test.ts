import { afterEach, expect, it, vi } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { normalizeInstrument, normalizeTicker } from '../src/public-data.js';
import { normalizeOrder } from '../src/private-data.js';
import { nativeInstrument, nativeOrder, scope, account, now } from './fixtures.js';
import { harness } from './harness.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
it('native padded zero prices stay unavailable instead of failing public observation', () => {
  const r = normalizeInstrument(nativeInstrument(), scope, now, 'zero').record;
  expect(
    normalizeTicker(
      { symbol: 'BTCUSDT', lastPrice: '50000', bid1Price: '0.00000000', ask1Price: '' },
      r,
      now,
      now,
    ).bid,
  ).toEqual({ state: 'UNAVAILABLE', reason: 'NOT_PROVIDED' });
});
it.each([
  { orderStatus: 'New', cumExecQty: '0.01' },
  { orderStatus: 'PartiallyFilled', cumExecQty: '0' },
  { orderStatus: 'PartiallyFilled', cumExecQty: '0.01' },
])('native status and execution quantity cannot contradict %j', (fields) => {
  const r = normalizeInstrument(nativeInstrument(), scope, now, 'status').record;
  expect(() =>
    normalizeOrder({ ...nativeOrder(), ...fields }, r, account, {
      internalOrderId: '33333333-3333-4333-8333-333333333333',
      intentId: '44444444-4444-4444-8444-444444444444',
    }),
  ).toThrow();
});
it('foreign native symbol never invokes server identity resolver', async () => {
  const order = vi.fn(() => ({
    internalOrderId: '33333333-3333-4333-8333-333333333333',
    intentId: '44444444-4444-4444-8444-444444444444',
  }));
  const x = harness('bybit-spot-testnet-v1', {
    identities: {
      order,
      fill: () => ({ internalOrderId: '33333333-3333-4333-8333-333333333333' }),
    },
  });
  adapters.push(x.adapter);
  await x.warm();
  x.state.nativeOrder = { ...nativeOrder(), symbol: 'ETHUSDT' };
  expect(
    await x.adapter.getOrder(
      { instrumentId: 'BTCUSDT', locator: { kind: 'CLIENT_ID', id: 'client-1' } },
      x.context(),
    ),
  ).toMatchObject({ ok: false });
  expect(order).not.toHaveBeenCalled();
});
it('cancel ACK for a different exchangeOrderId stays UNKNOWN', async () => {
  const x = harness();
  adapters.push(x.adapter);
  await x.warm();
  x.state.route = (r) =>
    r.url.pathname === '/v5/order/cancel'
      ? x.response({ orderId: 'another-native-id', orderLinkId: 'client-1' })
      : x.native(r);
  expect(
    await x.adapter.cancelOrder(
      x.permit('cancelOrder', {
        instrumentId: 'BTCUSDT',
        locator: { kind: 'EXCHANGE_ID', id: 'native-order-1' },
      }),
      x.context(),
    ),
  ).toMatchObject({ kind: 'UNKNOWN' });
});
it('ticker time regression terminates stream with explicit resync', async () => {
  const x = harness();
  adapters.push(x.adapter);
  await x.warm();
  const r = await x.adapter.subscribeTicker({ instrumentId: 'BTCUSDT' }, x.context());
  if (!r.ok) throw new Error(r.error.code);
  const iterator = r.value[Symbol.asyncIterator]();
  x.state.message?.(
    JSON.stringify({
      topic: 'tickers.BTCUSDT',
      type: 'snapshot',
      ts: x.state.time,
      data: { symbol: 'BTCUSDT', lastPrice: '50000' },
    }),
  );
  await iterator.next();
  x.state.message?.(
    JSON.stringify({
      topic: 'tickers.BTCUSDT',
      type: 'delta',
      ts: x.state.time - 1,
      data: { symbol: 'BTCUSDT', lastPrice: '49000' },
    }),
  );
  expect(await iterator.next()).toMatchObject({ value: { kind: 'RESYNC_REQUIRED' } });
});
it('conflicting same-version position changes require resync instead of silent loss', async () => {
  const x = harness('bybit-linear-testnet-v1');
  adapters.push(x.adapter);
  await x.warm();
  const r = await x.adapter.subscribePositions({ instrumentId: 'BTCUSDT' }, x.context());
  if (!r.ok) throw new Error(r.error.code);
  const iterator = r.value[Symbol.asyncIterator]();
  const position = {
    category: 'linear',
    symbol: 'BTCUSDT',
    positionIdx: 0,
    side: 'Buy',
    size: '0.01',
    avgPrice: '50000',
    leverage: '10',
    liqPrice: '',
    updatedTime: String(x.state.time),
  };
  const send = (data: unknown) =>
    x.state.message?.(
      JSON.stringify({ topic: 'position.linear', data: [data], creationTime: x.state.time }),
    );
  send(position);
  await iterator.next();
  send({ ...position, size: '0.02' });
  expect(await iterator.next()).toMatchObject({ value: { kind: 'RESYNC_REQUIRED' } });
});
