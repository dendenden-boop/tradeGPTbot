import { afterEach, expect, it } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { harness } from './harness.js';
import { createSigner } from '../src/auth.js';
import { createRestClient } from '../src/client.js';
import { getBybitProfile } from '../src/profiles.js';
import { createBookAssembler, normalizeInstrument } from '../src/public-data.js';
import { account, nativeInstrument, now, scope } from './fixtures.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
it.each(['rest', 'ws'] as const)(
  'permission expiry during credential wait rejects %s signing',
  async (method) => {
    const x = harness();
    adapters.push(x.adapter);
    const signer = createSigner(
      getBybitProfile(x.options.profileId),
      { account, credentialRef: 'fixture-reference' },
      {
        resolve: () => {
          x.state.time += 10001;
          return Promise.resolve({
            profileId: x.options.profileId,
            account,
            apiKey: 'fixture-key',
            secret: 'fixture-secret',
          });
        },
      },
      x.permissions,
      () => ({ serverTime: now, sampledAt: now, roundTripMs: 0 }),
      () => x.state.time,
    );
    const context = { ...x.context(), deadline: now + 20000 };
    await expect(
      method === 'rest' ? signer.rest('', context) : signer.ws(context),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
  },
);
it('native rate backoff precedes a hung observer', async () => {
  const x = harness();
  adapters.push(x.adapter);
  let entered: (() => void) | undefined;
  const observed = new Promise<void>((r) => {
    entered = r;
  });
  x.limiter.observe.mockImplementation(async () => {
    entered!();
    await new Promise<void>(() => {});
  });
  x.state.route = () => x.response({}, 10006);
  const client = createRestClient(
    getBybitProfile(x.options.profileId),
    x.io,
    x.limiter,
    account,
    () => x.state.time,
  );
  const controller = new AbortController();
  const first = client
    .call({ path: '/v5/market/time' }, { ...x.context(), signal: controller.signal })
    .catch(() => undefined);
  await observed;
  const second = client.call({ path: '/v5/market/time' }, x.context());
  const rejection = expect(second).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  controller.abort();
  await first;
  await rejection;
  expect(x.request).toHaveBeenCalledTimes(1);
});
it('conflicting book duplicate cannot silently discard changed levels', () => {
  const record = normalizeInstrument(nativeInstrument(), scope, now, 'duplicate').record;
  const book = createBookAssembler(record, 10);
  book.update(
    {
      type: 'snapshot',
      ts: now,
      data: { s: 'BTCUSDT', u: 1, seq: 1, b: [['49999', '1']], a: [['50001', '1']] },
    },
    now,
  );
  const delta = {
    type: 'delta',
    ts: now,
    data: { s: 'BTCUSDT', u: 2, seq: 2, b: [['49999', '2']], a: [] },
  };
  book.update(delta, now);
  expect(book.update(delta, now)).toBeNull();
  expect(() =>
    book.update({ ...delta, data: { ...delta.data, b: [['49999', '3']] } }, now),
  ).toThrow();
});
