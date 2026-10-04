import { afterEach, expect, it } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { harness } from './harness.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
it('concurrent initial private pages reserve capacity before awaiting IO', async () => {
  const x = harness();
  adapters.push(x.adapter);
  await x.warm();
  x.state.nativeOrder = {
    ...x.state.nativeOrder,
    orderStatus: 'New',
    cumExecQty: '0',
    avgPrice: '0',
  };
  x.state.route = (r) =>
    r.url.pathname === '/v5/order/realtime'
      ? x.response({ category: 'spot', list: [x.state.nativeOrder], nextPageCursor: 'more' })
      : x.native(r);
  const query = { instrumentId: 'BTCUSDT', limit: 1, cursor: null };
  for (let i = 0; i < 15; i++)
    expect(
      (await x.adapter.getOpenOrders({ ...query, queryId: `retain-${i}` }, x.context())).ok,
    ).toBe(true);
  const concurrent = await Promise.all(
    ['next-a', 'next-b'].map((queryId) =>
      x.adapter.getOpenOrders({ ...query, queryId }, x.context()),
    ),
  );
  expect(concurrent.filter((x) => x.ok)).toHaveLength(1);
  expect(concurrent.filter((x) => !x.ok)).toMatchObject([{ ok: false, error: { code: 'BUSY' } }]);
});
it('concurrent continuation cannot consume the same live cursor twice', async () => {
  const x = harness();
  adapters.push(x.adapter);
  await x.warm();
  x.state.nativeOrder = {
    ...x.state.nativeOrder,
    orderStatus: 'New',
    cumExecQty: '0',
    avgPrice: '0',
  };
  x.state.route = (r) =>
    r.url.pathname === '/v5/order/realtime'
      ? x.response({
          category: 'spot',
          list: [x.state.nativeOrder],
          nextPageCursor: r.url.searchParams.has('cursor') ? '' : 'more',
        })
      : x.native(r);
  const query = { instrumentId: 'BTCUSDT', limit: 1, cursor: null, queryId: 'one' };
  const first = await x.adapter.getOpenOrders(query, x.context());
  if (!first.ok) throw new Error(first.error.code);
  const concurrent = await Promise.all(
    Array.from({ length: 2 }, () =>
      x.adapter.getOpenOrders({ ...query, cursor: first.value.nextCursor }, x.context()),
    ),
  );
  expect(concurrent.filter((x) => x.ok)).toHaveLength(1);
  expect(concurrent.filter((x) => !x.ok)).toHaveLength(1);
});
