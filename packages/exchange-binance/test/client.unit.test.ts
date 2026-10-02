import { describe, expect, it, vi } from 'vitest';
import { createRestClient, readResponse } from '../src/client.js';
import { getBinanceProfile } from '../src/profiles.js';
import type { NetworkIo } from '../src/io.js';

function harness(status = 200, body = '{"serverTime":1800000000000}') {
  const request = vi.fn(() =>
    Promise.resolve({
      status,
      body,
      headers: {
        'retry-after': '2',
        'x-mbx-used-weight-1m': '10',
        authorization: 'secret-must-not-leave',
      },
    }),
  );
  const io: NetworkIo = { request, openSocket: vi.fn(), close: vi.fn(async () => {}) };
  const limiter = { reserve: vi.fn(() => Promise.resolve(true)), observe: vi.fn(async () => {}) };
  const client = createRestClient(
    getBinanceProfile('binance-spot-testnet-v1'),
    io,
    limiter,
    null,
    Date.now,
  );
  const controller = new AbortController();
  const context = { signal: controller.signal, deadline: Date.now() + 2000 };
  return { request, limiter, client, controller, context };
}
const spec = { path: '/api/v3/ticker/24hr', weight: 2, params: { symbol: 'BTCUSDT' } };
describe('Binance REST admission and status contract', () => {
  it('does not sign when rate admission denies dispatch', async () => {
    const h = harness();
    h.limiter.reserve.mockResolvedValueOnce(false);
    const prepare = vi.fn(() => Promise.resolve({ params: { signature: 'test' }, headers: {} }));
    await expect(h.client.call({ ...spec, prepare }, h.context)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
  it('aborts hung signing without dispatch or a late marker', async () => {
    const h = harness();
    const onDispatch = vi.fn();
    const prepare = vi.fn(() => new Promise<never>(() => {}));
    const pending = h.client.call({ ...spec, prepare, onDispatch }, h.context);
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(h.request).not.toHaveBeenCalled();
    expect(onDispatch).not.toHaveBeenCalled();
  });
  it('supports documented numeric route segments', async () => {
    const h = harness();
    await h.client.call(spec, h.context);
    expect(h.request).toHaveBeenCalledOnce();
  });
  it.each([418, 429])('honors non-JSON rate limit response %s with no retry', async (status) => {
    const h = harness(status, '<html>blocked</html>');
    const result = await h.client.call(spec, h.context);
    expect(() => readResponse(result)).toThrow('RATE_LIMITED');
    await expect(h.client.call(spec, h.context)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(h.request).toHaveBeenCalledOnce();
  });
  it('sends only rate headers to trusted observation port', async () => {
    const h = harness();
    await h.client.call(spec, h.context);
    expect(h.limiter.observe).toHaveBeenCalledWith(
      expect.anything(),
      200,
      { 'retry-after': '2', 'x-mbx-used-weight-1m': '10' },
      h.context,
    );
  });
  it.each(['reserve', 'observe'] as const)(
    'bounded abort terminates a hung %s port',
    async (port) => {
      const h = harness();
      h.limiter[port].mockImplementationOnce(() => new Promise<never>(() => {}));
      const pending = h.client.call({ ...spec, path: '/api/v3/time' }, h.context);
      await new Promise((resolve) => setTimeout(resolve, 5));
      h.controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
      expect(h.request).toHaveBeenCalledTimes(port === 'reserve' ? 0 : 1);
    },
  );
  it.each(['reserve', 'observe'] as const)('deadline terminates a hung %s port', async (port) => {
    const h = harness();
    h.limiter[port].mockImplementationOnce(() => new Promise<never>(() => {}));
    await expect(
      h.client.call({ ...spec, path: '/api/v3/time' }, { ...h.context, deadline: Date.now() + 30 }),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  });
  it.each([
    '/api/v3/../orders',
    '/api/v3/order?secret=x',
    'https://example.org/api/v3/order',
    '/fapi/v1/order',
  ])('rejects route injection %s before rate/HTTP', async (path) => {
    const h = harness();
    await expect(h.client.call({ ...spec, path }, h.context)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.limiter.reserve).not.toHaveBeenCalled();
  });
});
