import { afterEach, expect, it, vi } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import type { NetworkSocket } from '../src/io.js';
import { harness } from './harness.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
it('native linear snapshot before subscribe ACK is buffered and emitted only after ACK', async () => {
  const x = harness('bybit-linear-testnet-v1');
  adapters.push(x.adapter);
  await x.warm();
  x.socket.send = vi.fn<NetworkSocket['send']>((text) => {
    const c = JSON.parse(text) as { op: string; req_id: string };
    queueMicrotask(() => {
      x.state.message?.(
        JSON.stringify({
          topic: 'tickers.BTCUSDT',
          type: 'snapshot',
          ts: x.state.time,
          data: { symbol: 'BTCUSDT', lastPrice: '50000' },
        }),
      );
      x.state.message?.(JSON.stringify({ op: c.op, req_id: c.req_id, success: true }));
    });
    return Promise.resolve();
  });
  const r = await x.adapter.subscribeTicker({ instrumentId: 'BTCUSDT' }, x.context());
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error.code);
  expect(await r.value[Symbol.asyncIterator]().next()).toMatchObject({
    value: { kind: 'DATA', data: { last: { state: 'AVAILABLE', value: '50000' } } },
  });
});
it('pre-ACK observation buffer overflow fails closed and closes source', async () => {
  const x = harness('bybit-linear-testnet-v1');
  adapters.push(x.adapter);
  await x.warm();
  x.socket.send = vi.fn<NetworkSocket['send']>(() => {
    queueMicrotask(() => {
      for (let i = 0; i < 17; i++)
        x.state.message?.(
          JSON.stringify({
            topic: 'tickers.BTCUSDT',
            type: 'snapshot',
            ts: x.state.time,
            data: { symbol: 'BTCUSDT', lastPrice: '50000' },
          }),
        );
    });
    return Promise.resolve();
  });
  expect(await x.adapter.subscribeTicker({ instrumentId: 'BTCUSDT' }, x.context())).toMatchObject({
    ok: false,
  });
  expect(x.state.socketClosed).toBe(1);
});
