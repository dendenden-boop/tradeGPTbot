import { afterEach, describe, expect, it } from 'vitest';
import type { ExchangeAdapter } from '../src/index.js';
import { harness as htx } from '../../exchange-htx/test/harness.js';
import { harness as bybit } from '../../exchange-bybit/test/harness.js';
import { harness as okx } from '../../exchange-okx/test/harness.js';

const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.disconnect();
});

describe('cross-adapter long-lived stream lifecycle', () => {
  it('HTX supports 1100 current-candle revisions and rejects a prior open time', async () => {
    const x = htx();
    adapters.push(x.adapter);
    await x.warm();
    const result = await x.adapter.subscribeCandles(
      { instrumentId: x.symbol, timeframe: '1m' },
      x.context(30000),
    );
    if (!result.ok) throw new Error(result.error.code);
    const iterator = result.value[Symbol.asyncIterator](),
      open = Math.floor(x.state.time / 60000) * 60;
    const send = (id: number, amount: string) =>
      x.emit({
        ch: `market.${x.symbol}.kline.1min`,
        tick: {
          id,
          open: '50000',
          high: '50000',
          low: '50000',
          close: '50000',
          amount,
          vol: '50000',
          count: 1,
        },
      });
    for (let i = 0; i < 1100; i++) {
      send(open, String(i + 1));
      expect((await iterator.next()).value).toMatchObject({ kind: 'DATA', data: { revision: i } });
    }
    send(open - 60, '1');
    expect(result.value.health().status).toBe('RESYNC_REQUIRED');
  });
  it.each(['BYBIT', 'OKX'] as const)(
    '%s rejects conflicting evidence at an equal native order time',
    async (exchange) => {
      const x = exchange === 'BYBIT' ? bybit() : okx();
      adapters.push(x.adapter);
      await x.warm();
      const symbol = exchange === 'BYBIT' ? 'BTCUSDT' : (x as ReturnType<typeof okx>).symbol;
      const result = await x.adapter.subscribePrivateOrders({ instrumentId: symbol }, x.context());
      if (!result.ok) throw new Error(result.error.code);
      const iterator = result.value[Symbol.asyncIterator]();
      const send = (price: string) => {
        if (exchange === 'BYBIT') {
          const b = x as ReturnType<typeof bybit>;
          b.state.message?.(
            JSON.stringify({
              topic: 'order.spot',
              data: [
                {
                  ...b.state.nativeOrder,
                  avgPrice: price,
                },
              ],
            }),
          );
        } else {
          const o = x as ReturnType<typeof okx>;
          o.state.message?.(
            JSON.stringify({
              arg: { channel: 'orders', instType: 'SPOT', instId: symbol },
              data: [{ ...o.state.nativeOrder, avgPx: price }],
            }),
          );
        }
      };
      send('50000');
      expect((await iterator.next()).value).toMatchObject({ kind: 'DATA' });
      send('50001');
      expect(result.value.health().status).toBe('RESYNC_REQUIRED');
    },
  );
  it.each(['BYBIT', 'OKX', 'HTX'] as const)(
    '%s accepts 1000 terminal identities without age-based resync',
    async (exchange) => {
      const x = exchange === 'BYBIT' ? bybit() : exchange === 'OKX' ? okx() : htx();
      adapters.push(x.adapter);
      await x.warm();
      const symbol = exchange === 'BYBIT' ? 'BTCUSDT' : 'symbol' in x ? x.symbol : '';
      const result = await x.adapter.subscribePrivateOrders({ instrumentId: symbol }, x.context());
      if (!result.ok) throw new Error(result.error.code);
      const iterator = result.value[Symbol.asyncIterator]();
      for (let i = 0; i < 1000; i++) {
        // Clocks stay within the original rule and permission leases.
        const time = x.state.time - 1000 + i;
        if (exchange === 'BYBIT') {
          const b = x as ReturnType<typeof bybit>;
          b.state.message?.(
            JSON.stringify({
              topic: 'order.spot',
              data: [
                {
                  ...b.state.nativeOrder,
                  orderId: `order-${i}`,
                  orderLinkId: `client-${i}`,
                  createdTime: String(time - 1),
                  updatedTime: String(time),
                },
              ],
            }),
          );
        } else if (exchange === 'OKX') {
          const o = x as ReturnType<typeof okx>;
          o.state.message?.(
            JSON.stringify({
              arg: { channel: 'orders', instType: 'SPOT', instId: symbol },
              data: [
                {
                  ...o.state.nativeOrder,
                  ordId: String(10000 + i),
                  clOrdId: `Client${i}`,
                  cTime: String(time - 1),
                  uTime: String(time),
                },
              ],
            }),
          );
        } else {
          const h = x as ReturnType<typeof htx>;
          h.state.order = {
            ...h.state.order,
            id: String(10000 + i),
            'client-order-id': `Client${i}`,
            state: 'filled',
            'filled-amount': '0.01',
            'created-at': time - 1,
            'finished-at': time,
          };
          h.emit({
            action: 'push',
            ch: `orders#${symbol}`,
            data: {
              symbol,
              orderId: h.state.order.id,
              accountId: '123',
              lastActTime: time,
              eventType: 'trade',
            },
          });
        }
        expect((await iterator.next()).value).toMatchObject({ kind: 'DATA' });
        expect(result.value.health()).toEqual({ status: 'ACTIVE', queued: 0 });
      }
      await result.value.unsubscribe();
    },
    30000,
  );

  it.each(['BOOK', 'TRADE', 'CANDLE'] as const)(
    'HTX %s subscription survives advancing healthy history',
    async (kind) => {
      const x = htx();
      adapters.push(x.adapter);
      await x.warm();
      const result =
        kind === 'BOOK'
          ? await x.adapter.subscribeOrderBook(
              { instrumentId: x.symbol, depth: 20 },
              x.context(30000),
            )
          : kind === 'TRADE'
            ? await x.adapter.subscribeTrades({ instrumentId: x.symbol }, x.context(30000))
            : await x.adapter.subscribeCandles(
                { instrumentId: x.symbol, timeframe: '1m' },
                x.context(30000),
              );
      if (!result.ok) throw new Error(result.error.code);
      const iterator = result.value[Symbol.asyncIterator]();
      const count = kind === 'CANDLE' ? 1100 : 10000;
      const startedAt = x.state.time;
      for (let i = 0; i < count; i++) {
        const ts = startedAt + Math.floor(i / 10);
        if (kind !== 'CANDLE') x.state.time = ts;
        if (kind === 'BOOK')
          x.emit({
            ch: `market.${x.symbol}.depth.step0`,
            tick: {
              version: String(90071992547409930n + BigInt(i)),
              ts,
              bids: [['50000', '1']],
              asks: [['50001', '1']],
            },
          });
        else if (kind === 'TRADE')
          x.emit({
            ch: `market.${x.symbol}.trade.detail`,
            tick: {
              data: [
                {
                  id: String(i + 1),
                  ts,
                  direction: 'buy',
                  price: '50000',
                  amount: '1',
                },
              ],
            },
          });
        else
          x.emit({
            ch: `market.${x.symbol}.kline.1min`,
            tick: {
              id: Math.floor(x.state.time / 60000) * 60 - (count - i) * 60,
              open: '50000',
              high: '50000',
              low: '50000',
              close: '50000',
              amount: '1',
              vol: '50000',
              count: 1,
            },
          });
        expect((await iterator.next()).value).toMatchObject({ kind: 'DATA' });
        expect(result.value.health()).toEqual({ status: 'ACTIVE', queued: 0 });
      }
      await result.value.unsubscribe();
    },
    30000,
  );
});
