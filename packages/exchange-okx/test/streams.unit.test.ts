import { afterEach, describe, expect, it } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { createHmac } from 'node:crypto';
import { harness } from './harness.js';
const adapters: ExchangeAdapter[] = [];
const iterators = new WeakMap<object, AsyncIterator<unknown>>();
async function next(sub: AsyncIterable<unknown>) {
  let it = iterators.get(sub);
  if (!it) {
    it = sub[Symbol.asyncIterator]();
    iterators.set(sub, it);
  }
  const result = await it.next();
  return result.done ? undefined : result.value;
}

afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
function h(...args: Parameters<typeof harness>) {
  const x = harness(...args);
  adapters.push(x.adapter);
  return x;
}
const emit = (x: ReturnType<typeof h>, arg: unknown, data: unknown, action?: string) =>
  x.state.message?.(JSON.stringify({ arg, data, ...(action ? { action } : {}) }));
describe('OKX native WS login, subscription and continuity contracts', () => {
  it('public ticker needs subscribe ACK and actual timestamp', async () => {
    const x = h();
    await x.warm();
    const r = await x.adapter.subscribeTicker({ instrumentId: x.symbol }, x.context());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    emit(x, { channel: 'tickers', instId: x.symbol }, [
      {
        instId: x.symbol,
        instType: 'SPOT',
        ts: String(x.state.time),
        last: '50000',
        bidPx: '49999',
        askPx: '50001',
      },
    ]);
    expect(await next(r.value)).toMatchObject({ kind: 'DATA', data: { last: { value: '50000' } } });
    await r.value.unsubscribe();
    expect(x.state.socketClosed).toBe(1);
  });
  it('public candles use business socket and UTC interval', async () => {
    const x = h();
    await x.warm();
    const r = await x.adapter.subscribeCandles(
      { instrumentId: x.symbol, timeframe: '1d' },
      x.context(),
    );
    expect(r.ok).toBe(true);
    expect(x.openSocket).toHaveBeenCalledWith(
      new URL('wss://wspap.okx.com/ws/v5/business'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(x.state.controls.at(-1)?.args).toEqual([{ channel: 'candle1Dutc', instId: x.symbol }]);
  });
  it('private login includes passphrase and exact native users/self/verify signature', async () => {
    const x = h();
    await x.warm();
    const r = await x.adapter.subscribePrivateOrders({ instrumentId: x.symbol }, x.context());
    expect(r.ok).toBe(true);
    const control = x.state.controls.find((c) => c.op === 'login')!,
      args = control.args as Record<string, string>[];
    expect(args[0]).toMatchObject({ apiKey: 'fixture-key', passphrase: 'fixture-passphrase' });
    expect(args[0]!.sign).toBe(
      createHmac('sha256', 'fixture-secret')
        .update(args[0]!.timestamp + 'GET/users/self/verify')
        .digest('base64'),
    );
    expect(x.state.controls.at(-1)?.args).toEqual([
      { channel: 'orders', instType: 'SPOT', instId: x.symbol },
    ]);
  });
  it('private duplicate events normalize once, while fill regression forces resync', async () => {
    const x = h();
    await x.warm();
    const r = await x.adapter.subscribePrivateOrders({ instrumentId: x.symbol }, x.context());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const arg = { channel: 'orders', instType: 'SPOT', instId: x.symbol };
    emit(x, arg, [x.state.nativeOrder]);
    emit(x, arg, [x.state.nativeOrder]);
    expect(await next(r.value)).toMatchObject({ kind: 'DATA', data: { status: 'FILLED' } });
    emit(x, arg, [{ ...x.state.nativeOrder, state: 'live', accFillSz: '0', avgPx: '' }]);
    expect(await next(r.value)).toMatchObject({ kind: 'RESYNC_REQUIRED' });
    expect(x.state.socketClosed).toBe(1);
  });
  it('book supports native sequence reset with actual previous linkage, then rejects a gap', async () => {
    const x = h('okx-swap-demo-v1');
    await x.warm();
    const r = await x.adapter.subscribeOrderBook(
      { instrumentId: x.symbol, depth: 10 },
      x.context(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const arg = { channel: 'books', instId: x.symbol },
      frame = {
        ts: String(x.state.time),
        seqId: '10',
        prevSeqId: '-1',
        checksum: '0',
        bids: [['49999', '2', '0', '1']],
        asks: [['50001', '1', '0', '1']],
      };
    emit(x, arg, [frame], 'snapshot');
    expect(await next(r.value)).toMatchObject({
      kind: 'DATA',
      data: { bids: [{ quantity: '0.02' }] },
    });
    emit(x, arg, [{ ...frame, seqId: '3', prevSeqId: '10', bids: [], asks: [] }], 'update');
    expect(await next(r.value)).toMatchObject({ kind: 'DATA', data: { sourceSequence: '3' } });
    emit(x, arg, [{ ...frame, seqId: '5', prevSeqId: '2', bids: [], asks: [] }], 'update');
    expect(await next(r.value)).toMatchObject({ kind: 'RESYNC_REQUIRED' });
  });
  it('foreign channel cannot enter scoped stream', async () => {
    const x = h();
    await x.warm();
    const r = await x.adapter.subscribeTicker({ instrumentId: x.symbol }, x.context());
    if (!r.ok) throw new Error();
    emit(x, { channel: 'tickers', instId: 'ETH-USDT' }, [
      { instId: 'ETH-USDT', ts: String(x.state.time) },
    ]);
    expect(await next(r.value)).toMatchObject({ kind: 'RESYNC_REQUIRED' });
  });
  it('service upgrade notice closes source and requests reconciliation', async () => {
    const x = h();
    await x.warm();
    const r = await x.adapter.subscribeTicker({ instrumentId: x.symbol }, x.context());
    if (!r.ok) throw new Error();
    x.state.message?.('{"event":"notice","code":"64008"}');
    expect(await next(r.value)).toMatchObject({ kind: 'RESYNC_REQUIRED' });
  });
  it('resubscription after source loss reauthenticates fresh native account', async () => {
    const x = h();
    await x.warm();
    const first = await x.adapter.subscribePrivateOrders({ instrumentId: x.symbol }, x.context());
    if (!first.ok) throw new Error();
    x.state.ended?.();
    expect(await next(first.value)).toMatchObject({ kind: 'RESYNC_REQUIRED' });
    const second = await x.adapter.subscribePrivateOrders({ instrumentId: x.symbol }, x.context());
    expect(second.ok).toBe(true);
    expect(x.state.controls.filter((c) => c.op === 'login')).toHaveLength(2);
    expect(x.request.mock.calls.filter(([r]) => r.url.pathname.endsWith('/config'))).toHaveLength(
      2,
    );
  });
});
