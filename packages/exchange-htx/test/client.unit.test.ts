import { describe, expect, it, vi } from 'vitest';
import { createRestClient } from '../src/client.js';
import { getHtxProfile } from '../src/profiles.js';
import { now } from './fixtures.js';
import type { NetworkIo, HttpResponse } from '../src/io.js';
function client(profile: 'htx-spot-live-v1' | 'htx-linear-live-v1' = 'htx-spot-live-v1') {
  let body = '{"status":"ok","data":1791129600000}',
    status = 200;
  const request = vi.fn(() =>
    Promise.resolve<HttpResponse>({
      status,
      body,
      headers: { 'x-hb-ratelimit-requests-remain': '0' },
    }),
  );
  const io: NetworkIo = {
      request,
      openSocket: () => Promise.reject(new Error()),
      close: () => Promise.resolve(),
    },
    limiter = {
      reserve: vi.fn(() => Promise.resolve(true)),
      observe: vi.fn(() => Promise.resolve()),
    };
  const c = createRestClient(getHtxProfile(profile), io, limiter, null, () => now),
    context = { signal: new AbortController().signal, deadline: now + 5000 };
  return {
    c,
    context,
    request,
    limiter,
    set(raw: unknown, httpStatus = 200) {
      body = JSON.stringify(raw);
      status = httpStatus;
    },
  };
}
describe('HTX REST protocol boundaries', () => {
  it.each([
    [1032, 'RATE_LIMITED'],
    [1010, 'UNAVAILABLE'],
    [1034, 'UNAVAILABLE'],
    [1031, 'UNAVAILABLE'],
    [1253, 'AUTHORIZATION_REQUIRED'],
    [12007, 'AUTHORIZATION_REQUIRED'],
  ])('official derivative error %s preserves its meaning', async (err_code, code) => {
    const x = client('htx-linear-live-v1');
    x.set({ status: 'error', err_code });
    await expect(x.c.call({ path: '/api/v1/timestamp' }, x.context)).rejects.toMatchObject({
      code,
    });
    expect(x.request).toHaveBeenCalledTimes(1);
    expect(x.limiter.observe).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: 'ok', code: 500, data: 1 },
    { status: 'error', code: 200, data: 1 },
    { status: 'unknown', data: 1 },
  ])('contradictory or unknown native success envelope is rejected %j', (raw) => {
    const x = client();
    x.set(raw);
    return expect(x.c.call({ path: '/v1/common/timestamp' }, x.context)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
  it.each([
    '/v1/order/orders/place',
    '/v1/order/orders/123/submitcancel',
    '/linear-swap-api/v1/swap_cross_order',
    'https://user.example',
  ])('no native mutation/caller path is whitelisted %s', (path) => {
    const x = client();
    return expect(x.c.call({ path, body: { amount: '1' } }, x.context)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
  it('observes native rate headers on failure and applies bounded no-retry backoff', async () => {
    const x = client();
    x.set({ status: 'error', 'err-code': 'too-many-requests' }, 429);
    await expect(x.c.call({ path: '/v1/common/timestamp' }, x.context)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await expect(x.c.call({ path: '/v1/common/timestamp' }, x.context)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(x.request).toHaveBeenCalledTimes(1);
    expect(x.limiter.observe).toHaveBeenCalledTimes(1);
  });
  it('credentials and raw messages never occur in thrown native error', async () => {
    const x = client();
    x.set({
      status: 'error',
      'err-code': 'api-signature-not-valid',
      'err-msg': 'SECRET RAW PAYLOAD',
    });
    await expect(x.c.call({ path: '/v1/common/timestamp' }, x.context)).rejects.toMatchObject({
      message: 'AUTHORIZATION_REQUIRED',
    });
  });
  it('maintenance is unavailable rather than an empty successful collection', async () => {
    const x = client('htx-linear-live-v1');
    x.set({ status: 'maintain' });
    await expect(x.c.call({ path: '/api/v1/timestamp' }, x.context)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});
