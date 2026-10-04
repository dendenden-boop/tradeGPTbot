import { afterEach, describe, expect, it } from 'vitest';
import { createInstrumentRegistry, type ExchangeAdapter } from '@ctp/exchange-core';
import { normalizeInstrument } from '../src/public-data.js';
import { harness } from './harness.js';
import { scope } from './fixtures.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
function h(...args: Parameters<typeof harness>) {
  const x = harness(...args);
  adapters.push(x.adapter);
  return x;
}
const bookFrame = (x: ReturnType<typeof h>) =>
  JSON.stringify({
    arg: { channel: 'books', instId: x.symbol },
    action: 'snapshot',
    data: [
      {
        ts: String(x.state.time),
        seqId: '10',
        prevSeqId: '-1',
        bids: [['49999', '2', '0', '1']],
        asks: [['50001', '1', '0', '1']],
      },
    ],
  });
describe('OKX metadata lifetime stays coherent with asynchronous market data', () => {
  it('metadata expiry cannot produce a fresh WS book using expired contract interpretation', async () => {
    const x = h('okx-swap-demo-v1');
    x.state.instrument.upcChg = [
      { param: 'tickSz', newValue: '1', effTime: String(x.state.time + 2000) },
    ];
    await x.warm();
    const r = await x.adapter.subscribeOrderBook(
      { instrumentId: x.symbol, depth: 10 },
      x.context(),
    );
    if (!r.ok) throw new Error(r.error.code);
    x.state.time += 2000;
    x.state.message?.(bookFrame(x));
    expect(await r.value[Symbol.asyncIterator]().next()).toMatchObject({
      value: { kind: 'RESYNC_REQUIRED' },
    });
    expect(x.state.socketClosed).toBe(1);
  });
  it('registry contract version replacement cannot let an existing WS source emit old BASE conversion', async () => {
    const registry = createInstrumentRegistry({ capacity: 1 }),
      x = h('okx-swap-demo-v1', { registry });
    await x.warm();
    const r = await x.adapter.subscribeOrderBook(
      { instrumentId: x.symbol, depth: 10 },
      x.context(),
    );
    if (!r.ok) throw new Error(r.error.code);
    const next = normalizeInstrument(
      { ...x.state.instrument, ctVal: '0.1' },
      { ...scope, market: 'LINEAR_PERPETUAL' },
      x.state.time,
      'replacement',
    );
    expect(registry.put(next.record, x.state.time).ok).toBe(true);
    x.state.message?.(bookFrame(x));
    expect(await r.value[Symbol.asyncIterator]().next()).toMatchObject({
      value: { kind: 'RESYNC_REQUIRED' },
    });
  });
  it('metadata expiring during REST cannot emit a fresh book from an old interpretation', async () => {
    const x = h('okx-swap-demo-v1');
    x.state.instrument.upcChg = [
      { param: 'tickSz', newValue: '1', effTime: String(x.state.time + 2000) },
    ];
    await x.warm();
    x.state.route = (input) => {
      if (input.url.pathname === '/api/v5/market/books') x.state.time += 2000;
      return x.native(input);
    };
    expect(
      await x.adapter.getOrderBook({ instrumentId: x.symbol, depth: 10 }, x.context()),
    ).toMatchObject({ ok: false, error: { code: 'STALE_METADATA' } });
  });
});
