import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { harness } from './harness.js';
import { createRestClient } from '../src/client.js';
import { getBybitProfile } from '../src/profiles.js';
import { createSigner } from '../src/auth.js';
import { account } from './fixtures.js';
import type { BybitRateLimitPort } from '../src/ports.js';
import type { NetworkSocket } from '../src/io.js';

const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
function h(...args: Parameters<typeof harness>) {
  const x = harness(...args);
  adapters.push(x.adapter);
  return x;
}
describe('Bybit rate and bounded stream contracts', () => {
  it('HTTP 403 HTML still observes rate headers and enforces 10 minute backoff', async () => {
    const x = h();
    const client = createRestClient(
      getBybitProfile(x.options.profileId),
      x.io,
      x.limiter,
      account,
      () => x.state.time,
    );
    x.state.route = () => ({
      status: 403,
      headers: { 'x-bapi-limit': '0' },
      body: '<html>Forbidden</html>',
    });
    await expect(client.call({ path: '/v5/market/time' }, x.context())).rejects.toBeDefined();
    expect(x.limiter.observe).toHaveBeenCalledTimes(1);
    x.state.route = undefined;
    await expect(client.call({ path: '/v5/market/time' }, x.context())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(x.request).toHaveBeenCalledTimes(1);
  });
  it('signature is refreshed after REST limiter wait', async () => {
    const x = h();
    await x.warm();
    x.limiter.reserve
      .mockImplementationOnce(() => Promise.resolve(true))
      .mockImplementationOnce(() => Promise.resolve(true))
      .mockImplementationOnce(() => {
        x.state.time += 1000;
        return Promise.resolve(true);
      });
    expect(await x.adapter.getBalances({}, x.context())).toMatchObject({ ok: true });
    const r = x.request.mock.calls
      .map(([r]) => r)
      .find((r) => r.url.pathname === '/v5/account/wallet-balance')!;
    expect(x.signed(r)).toBe(true);
    expect(Number(r.headers?.['X-BAPI-TIMESTAMP'])).toBe(x.state.time);
  });
  it('private WS auth signs after control limiter wait', async () => {
    const x = h();
    await x.warm();
    const reserve = x.limiter.reserve;
    x.limiter.reserve = vi.fn<BybitRateLimitPort['reserve']>(async (request, context) => {
      if (request.method === 'WS' && request.controlMessages === 1 && x.state.controls.length === 0)
        x.state.time += 1000;
      return reserve(request, context);
    });
    const r = await x.adapter.subscribePrivateOrders({ instrumentId: 'BTCUSDT' }, x.context());
    expect(r.ok).toBe(true);
    const args = x.state.controls[0]?.args as [string, number, string];
    expect(args[1]).toBe(x.state.time + 5000);
    expect(args[2]).toBe(
      createHmac('sha256', 'fixture-secret').update(`GET/realtime${args[1]}`).digest('hex'),
    );
  });
  it('bad subscription ACK closes bounded source and cannot publish DATA', async () => {
    const x = h();
    await x.warm();
    x.socket.send = vi.fn<NetworkSocket['send']>((text) => {
      const command = JSON.parse(text) as { op: string; req_id: string };
      queueMicrotask(() =>
        x.state.message?.(
          JSON.stringify({ op: command.op, req_id: command.req_id, success: false }),
        ),
      );
      return Promise.resolve();
    });
    expect(await x.adapter.subscribeTicker({ instrumentId: 'BTCUSDT' }, x.context())).toMatchObject(
      { ok: false },
    );
    expect(x.state.socketClosed).toBe(1);
  });
  it('book delta before snapshot produces explicit resync', async () => {
    const x = h();
    await x.warm();
    const r = await x.adapter.subscribeOrderBook(
      { instrumentId: 'BTCUSDT', depth: 50 },
      x.context(),
    );
    if (!r.ok) throw new Error(r.error.code);
    const next = r.value[Symbol.asyncIterator]().next();
    x.state.message?.(
      JSON.stringify({
        topic: 'orderbook.50.BTCUSDT',
        type: 'delta',
        ts: x.state.time,
        data: { s: 'BTCUSDT', u: 10, seq: 10, b: [], a: [] },
      }),
    );
    expect(await next).toMatchObject({ done: false, value: { kind: 'RESYNC_REQUIRED' } });
  });
  it('public ticker delta merges partial fields without discarding last price', async () => {
    const x = h();
    await x.warm();
    const r = await x.adapter.subscribeTicker({ instrumentId: 'BTCUSDT' }, x.context());
    if (!r.ok) throw new Error(r.error.code);
    const iterator = r.value[Symbol.asyncIterator]();
    const send = (type: string, data: unknown) =>
      x.state.message?.(JSON.stringify({ topic: 'tickers.BTCUSDT', type, ts: x.state.time, data }));
    send('snapshot', { symbol: 'BTCUSDT', lastPrice: '50000', bid1Price: '49999' });
    expect(await iterator.next()).toMatchObject({
      value: { kind: 'DATA', data: { last: { value: '50000' } } },
    });
    send('delta', { symbol: 'BTCUSDT', bid1Price: '49998' });
    expect(await iterator.next()).toMatchObject({
      value: { kind: 'DATA', data: { last: { value: '50000' }, bid: { value: '49998' } } },
    });
  });
  it('credential/permission resolver with hung promise times out and rejects static error', async () => {
    const x = h();
    const signer = createSigner(
      getBybitProfile(x.options.profileId),
      { account, credentialRef: 'fixture-reference' },
      x.credentials,
      { verify: () => new Promise(() => {}) },
      () => ({ serverTime: x.state.time, sampledAt: x.state.time, roundTripMs: 0 }),
      () => x.state.time,
    );
    await expect(
      signer.rest('', { signal: new AbortController().signal, deadline: x.state.time + 20 }),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(x.credentials.resolve).not.toHaveBeenCalled();
  });
  it('WS local abort closes socket and stops late events', async () => {
    const x = h();
    await x.warm();
    const controller = new AbortController();
    const r = await x.adapter.subscribeTicker(
      { instrumentId: 'BTCUSDT' },
      x.context(controller.signal),
    );
    if (!r.ok) throw new Error(r.error.code);
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(x.state.socketClosed).toBe(1);
    const iterator = r.value[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { kind: 'CLOSED' } });
    x.state.message?.(
      JSON.stringify({
        topic: 'tickers.BTCUSDT',
        type: 'snapshot',
        ts: x.state.time,
        data: { symbol: 'BTCUSDT', lastPrice: '1' },
      }),
    );
    expect(await iterator.next()).toMatchObject({ done: true });
  });
});
