import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { harness } from './harness.js';
import { now, account, linearOrder } from './fixtures.js';
import { until } from './fixtures/io.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const a of adapters.splice(0)) await a.disconnect();
});
function h(...args: Parameters<typeof harness>) {
  const x = harness(...args);
  adapters.push(x.adapter);
  return x;
}
describe('HTX native WS handshake/heartbeat/observation boundary', () => {
  it.each(['htx-spot-live-v1', 'htx-linear-live-v1'] as const)(
    'subscribe ACK precedes public ticker DATA %s',
    async (profile) => {
      const x = h(profile);
      await x.warm();
      const result = await x.adapter.subscribeTicker({ instrumentId: x.symbol }, x.context());
      if (!result.ok) throw new Error(result.error.code);
      const iterator = result.value[Symbol.asyncIterator]();
      x.emit({
        ch: `market.${x.symbol}.detail`,
        ts: now,
        tick: { close: '50000', amount: '2', vol: '100000' },
      });
      expect(await iterator.next()).toMatchObject({
        value: { kind: 'DATA', data: { instrumentId: x.symbol, last: { value: '50000' } } },
      });
      await result.value.unsubscribe();
      expect(x.state.socketClosed).toBe(1);
    },
  );
  it.each(['htx-spot-live-v1', 'htx-linear-live-v1'] as const)(
    'public gzip protocol ping uses exact pong and shared control budget %s',
    async (profile) => {
      const x = h(profile);
      await x.warm();
      const result = await x.adapter.subscribeTicker({ instrumentId: x.symbol }, x.context());
      if (!result.ok) throw new Error();
      x.emit({ ping: now });
      await until(() => x.state.controls.some((x) => x.pong === String(now)));
      expect(x.state.controls.at(-1)).toEqual({ pong: String(now) });
      expect(x.limiter.reserve.mock.calls.map(([r]) => r)).toEqual(
        expect.arrayContaining([expect.objectContaining({ method: 'WS', controlMessages: 1 })]),
      );
      await result.value.unsubscribe();
    },
  );
  it.each(['htx-spot-live-v1', 'htx-linear-live-v1'] as const)(
    'private WS auth versions and heartbeat variants stay separate %s',
    async (profile) => {
      const x = h(profile);
      await x.warm();
      const result = await x.adapter.subscribePrivateOrders(
        { instrumentId: x.symbol },
        x.context(),
      );
      if (!result.ok) throw new Error(result.error.code);
      x.emit(x.endpoint.spot ? { action: 'ping', data: { ts: now } } : { op: 'ping', ts: now });
      await until(() => x.state.controls.some((x) => x.action === 'pong' || x.op === 'pong'));
      expect(x.state.controls.at(-1)).toEqual(
        x.endpoint.spot
          ? { action: 'pong', data: { ts: String(now) } }
          : { op: 'pong', ts: String(now) },
      );
      await result.value.unsubscribe();
    },
  );
  it('Spot private heartbeat lease survives the documented 20s interval', async () => {
    vi.useFakeTimers();
    const x = h();
    await x.warm();
    const result = await x.adapter.subscribePrivateOrders(
      { instrumentId: x.symbol },
      x.context(30000),
    );
    if (!result.ok) throw new Error();
    x.state.time += 16000;
    await vi.advanceTimersByTimeAsync(16000);
    expect(result.value.health().status).toBe('ACTIVE');
    await result.value.unsubscribe();
  });
  it('same ticker timestamp with a conflicting payload requires resync', async () => {
    const x = h();
    await x.warm();
    const result = await x.adapter.subscribeTicker({ instrumentId: x.symbol }, x.context());
    if (!result.ok) throw new Error();
    const iterator = result.value[Symbol.asyncIterator]();
    x.emit({ ch: `market.${x.symbol}.detail`, ts: now, tick: { close: '50000' } });
    await iterator.next();
    x.emit({ ch: `market.${x.symbol}.detail`, ts: now, tick: { close: '50001' } });
    expect(result.value.health().status).toBe('RESYNC_REQUIRED');
    expect(await iterator.next()).toMatchObject({ value: { kind: 'RESYNC_REQUIRED' } });
  });
  it('same book version with a conflicting snapshot requires resync', async () => {
    const x = h();
    await x.warm();
    const result = await x.adapter.subscribeOrderBook(
      { instrumentId: x.symbol, depth: 20 },
      x.context(),
    );
    if (!result.ok) throw new Error();
    x.emit({
      ch: `market.${x.symbol}.depth.step0`,
      tick: { version: '100', ts: now, bids: [['50000', '1']], asks: [['50001', '2']] },
    });
    x.emit({
      ch: `market.${x.symbol}.depth.step0`,
      tick: { version: '100', ts: now, bids: [['50000', '2']], asks: [['50001', '2']] },
    });
    expect(result.value.health().status).toBe('RESYNC_REQUIRED');
  });
  it('private order delta fetches full REST observation with known identities', async () => {
    const x = h();
    await x.warm();
    const result = await x.adapter.subscribePrivateOrders({ instrumentId: x.symbol }, x.context());
    if (!result.ok) throw new Error();
    const iterator = result.value[Symbol.asyncIterator]();
    x.emit({
      action: 'push',
      ch: `orders#${x.symbol}`,
      data: {
        symbol: x.symbol,
        orderId: x.state.order.id,
        accountId: '123',
        lastActTime: now,
        eventType: 'trade',
      },
    });
    expect(await iterator.next()).toMatchObject({
      value: {
        kind: 'DATA',
        data: { exchangeOrderId: x.state.order.id, quantity: '0.01', filledQuantity: '0.005' },
      },
    });
    await result.value.unsubscribe();
  });
  it('derivative private push rejects a foreign native UID', async () => {
    const x = h('htx-linear-live-v1');
    await x.warm();
    const result = await x.adapter.subscribePrivateOrders({ instrumentId: x.symbol }, x.context());
    if (!result.ok) throw new Error();
    x.emit({
      op: 'notify',
      topic: `orders_cross.${x.symbol}`,
      uid: 'other',
      ts: now,
      data: [linearOrder],
    });
    expect(result.value.health().status).toBe('RESYNC_REQUIRED');
  });
  it('private native auth validates UID and failed acknowledgements never publish data', async () => {
    const x = h('htx-linear-live-v1');
    await x.warm();
    x.state.ack = false;
    const promise = x.adapter.subscribePrivateOrders({ instrumentId: x.symbol }, x.context());
    await until(() => x.state.controls.some((x) => x.op === 'auth'));
    x.emit({ op: 'auth', 'err-code': 0, data: { uid: 'other' } });
    expect(await promise).toMatchObject({ ok: false });
  });
  it('metadata replacement closes an existing public stream before next event', async () => {
    const x = h();
    const r = await x.warm();
    const result = await x.adapter.subscribeTicker({ instrumentId: x.symbol }, x.context());
    if (!result.ok) throw new Error();
    expect(
      (
        await x.options.registry.put(
          {
            ...r,
            instrument: { ...r.instrument, metadataVersion: 'replacement-meta' },
            rules: { ...r.rules, version: 'replacement-rules' },
          },
          now,
        )
      ).ok,
    ).toBe(true);
    x.emit({ ch: `market.${x.symbol}.detail`, ts: now, tick: { close: '50000' } });
    expect(result.value.health().status).toBe('RESYNC_REQUIRED');
  });
  it('a denied heartbeat budget produces resync and closes source', async () => {
    const x = h();
    await x.warm();
    const result = await x.adapter.subscribeTicker({ instrumentId: x.symbol }, x.context());
    if (!result.ok) throw new Error();
    x.limiter.reserve.mockResolvedValue(false);
    x.emit({ ping: now });
    await until(() => result.value.health().status === 'RESYNC_REQUIRED');
    expect(x.state.socketClosed).toBe(1);
  });
  it('source close requires resync; no automatic reconnect/replay', async () => {
    const x = h();
    await x.warm();
    const result = await x.adapter.subscribeTicker({ instrumentId: x.symbol }, x.context());
    if (!result.ok) throw new Error();
    x.state.ended?.();
    expect(result.value.health().status).toBe('RESYNC_REQUIRED');
    expect(x.openSocket).toHaveBeenCalledTimes(1);
  });
  it('wrong native topic never crosses instrument scope', async () => {
    const x = h();
    await x.warm();
    const result = await x.adapter.subscribeTicker({ instrumentId: x.symbol }, x.context());
    if (!result.ok) throw new Error();
    x.emit({ ch: 'market.ethusdt.detail', ts: now, tick: { close: '10' } });
    expect(result.value.health().status).toBe('RESYNC_REQUIRED');
  });
  it('unsupported wallet/Spot position sources fail without I/O through the Core stream error envelope', async () => {
    const x = h();
    await x.warm();
    expect(await x.adapter.subscribeBalances({}, x.context())).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
    expect(
      await x.adapter.subscribePositions({ instrumentId: x.symbol }, x.context()),
    ).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(x.openSocket).not.toHaveBeenCalled();
    expect(x.adapter.account).toEqual(account);
  });
});
