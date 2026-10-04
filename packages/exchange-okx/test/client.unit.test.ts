import { describe, expect, it, vi } from 'vitest';
import { createRestClient, readResponse } from '../src/client.js';
import { getOkxProfile } from '../src/profiles.js';
import type { NetworkIo, HttpRequest } from '../src/io.js';
import { now, account } from './fixtures.js';
const context = () => ({ signal: new AbortController().signal, deadline: now + 5000 });
function fixture(body = '{"code":"0","data":[{"ts":"1791100000000"}]}', status = 200) {
  const request = vi.fn((input: HttpRequest) =>
    Promise.resolve({
      status: input.method === 'GET' || input.method === 'POST' ? status : 400,
      headers: { 'x-limit': '17' },
      body,
    }),
  );
  const io: NetworkIo = {
    request,
    openSocket: () => Promise.reject(new Error('NO_WS')),
    close: async () => {},
  };
  const limiter = { reserve: vi.fn(() => Promise.resolve(true)), observe: vi.fn(async () => {}) };
  return {
    request,
    limiter,
    client: createRestClient(getOkxProfile('okx-spot-demo-v1'), io, limiter, account, () => now),
  };
}
describe('OKX REST native protocol and trusted budgets', () => {
  it('signs exact escaped path/query with empty GET body after reservation, with Demo header', async () => {
    const f = fixture(),
      sign = vi.fn(() => Promise.resolve({ 'OK-ACCESS-SIGN': 'signature' }));
    await f.client.call(
      { path: '/api/v5/trade/order', params: { instId: 'BTC-USDT', clOrdId: 'A+B' }, sign },
      context(),
    );
    expect(sign).toHaveBeenCalledWith(
      'GET',
      '/api/v5/trade/order?instId=BTC-USDT&clOrdId=A%2BB',
      '',
      expect.anything(),
    );
    expect(f.request.mock.calls[0]?.[0].headers).toMatchObject({
      'x-simulated-trading': '1',
      'OK-ACCESS-SIGN': 'signature',
    });
    expect(f.limiter.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      sign.mock.invocationCallOrder[0]!,
    );
  });
  it('signs exactly the POST JSON bytes dispatched once and keeps expTime header', async () => {
    const f = fixture(),
      sign = vi.fn(() => Promise.resolve({ 'OK-ACCESS-SIGN': 'signature' })),
      body = { instId: 'BTC-USDT', sz: '0.00000001', banAmend: true };
    await f.client.call(
      { path: '/api/v5/trade/order', body, sign, expTime: now + 2000 },
      context(),
    );
    expect(sign).toHaveBeenCalledWith(
      'POST',
      '/api/v5/trade/order',
      JSON.stringify(body),
      expect.anything(),
    );
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      body: JSON.stringify(body),
      headers: { expTime: String(now + 2000) },
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('denied rate reservation prevents credentials and dispatch', async () => {
    const f = fixture(),
      sign = vi.fn();
    f.limiter.reserve.mockResolvedValue(false);
    await expect(
      f.client.call({ path: '/api/v5/account/config', sign }, context()),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(sign).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('local ban precedes observer settlement and has no fallback host', async () => {
    const f = fixture('{}', 403);
    await expect(f.client.call({ path: '/api/v5/public/time' }, context())).rejects.toThrow();
    await expect(f.client.call({ path: '/api/v5/public/time' }, context())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.limiter.observe).toHaveBeenCalledTimes(1);
  });
  it.each(['{"code":"0","data":{}}', '{"code":false,"data":[]}', '{"code":"0"}'])(
    'rejects malformed envelope %s while observing headers',
    async (body) => {
      const f = fixture(body);
      await expect(f.client.call({ path: '/api/v5/public/time' }, context())).rejects.toThrow();
      expect(f.limiter.observe).toHaveBeenCalledTimes(1);
    },
  );
  it('unknown native failure is never reported as successful read', async () => {
    const f = fixture('{"code":"50004","data":[]}');
    const r = await f.client.call({ path: '/api/v5/public/time' }, context());
    expect(() => readResponse(r)).toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('caller routes cannot access wallet transfer, withdraw or arbitrary URLs', async () => {
    const f = fixture();
    for (const path of [
      '/api/v5/asset/withdrawal',
      'https://caller.invalid',
      '/api/v5/trade/order-algo',
    ])
      await expect(f.client.call({ path }, context())).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
    expect(f.request).not.toHaveBeenCalled();
  });
});
