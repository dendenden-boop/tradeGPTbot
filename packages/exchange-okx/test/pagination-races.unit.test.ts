import { afterEach, describe, expect, it } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { harness } from './harness.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
async function fixture() {
  const x = harness();
  adapters.push(x.adapter);
  await x.warm();
  x.state.nativeOrder = { ...x.state.nativeOrder, state: 'live', accFillSz: '0', avgPx: '' };
  x.state.route = (r) =>
    r.url.pathname === '/api/v5/trade/orders-pending'
      ? x.response(r.url.searchParams.has('after') ? [] : [x.state.nativeOrder])
      : x.native(r);
  return x;
}
describe('OKX native after cursor capacity and terminal release', () => {
  it('16 live cursors are never evicted and terminal consumption frees their slots immediately', async () => {
    const x = await fixture(),
      q = { instrumentId: x.symbol, limit: 1, cursor: null };
    const retained: { queryId: string; cursor: string }[] = [];
    for (let i = 0; i < 16; i++) {
      const queryId = `q${i}`,
        r = await x.adapter.getOpenOrders({ ...q, queryId }, x.context());
      if (!r.ok || !r.value.nextCursor) throw new Error('MISSING_CURSOR');
      retained.push({ queryId, cursor: r.value.nextCursor });
    }
    expect(await x.adapter.getOpenOrders({ ...q, queryId: 'overflow' }, x.context())).toMatchObject(
      { ok: false, error: { code: 'BUSY' } },
    );
    for (const query of retained) {
      const r = await x.adapter.getOpenOrders({ ...q, ...query }, x.context());
      expect(r).toMatchObject({ ok: true, value: { items: [], nextCursor: null } });
    }
    for (let i = 0; i < 16; i++)
      expect((await x.adapter.getOpenOrders({ ...q, queryId: `new${i}` }, x.context())).ok).toBe(
        true,
      );
  });
  it('reserves pending initial pages before await to prevent capacity race', async () => {
    const x = await fixture(),
      q = { instrumentId: x.symbol, limit: 1, cursor: null };
    for (let i = 0; i < 15; i++)
      expect((await x.adapter.getOpenOrders({ ...q, queryId: `held${i}` }, x.context())).ok).toBe(
        true,
      );
    const r = await Promise.all(
      ['a', 'b'].map((queryId) => x.adapter.getOpenOrders({ ...q, queryId }, x.context())),
    );
    expect(r.filter((v) => v.ok)).toHaveLength(1);
    expect(r.filter((v) => !v.ok)).toMatchObject([{ error: { code: 'BUSY' } }]);
  });
  it('single-consumer continuation and old token reuse are refused', async () => {
    const x = await fixture(),
      q = { instrumentId: x.symbol, limit: 1, cursor: null, queryId: 'one' },
      r = await x.adapter.getOpenOrders(q, x.context());
    if (!r.ok) throw new Error();
    const next = { ...q, cursor: r.value.nextCursor };
    const concurrent = await Promise.all([
      x.adapter.getOpenOrders(next, x.context()),
      x.adapter.getOpenOrders(next, x.context()),
    ]);
    expect(concurrent.filter((v) => v.ok)).toHaveLength(1);
    expect(concurrent.filter((v) => !v.ok)).toHaveLength(1);
    expect((await x.adapter.getOpenOrders(next, x.context())).ok).toBe(false);
  });
  it('query binding denies copied cursor without consuming live source', async () => {
    const x = await fixture(),
      q = { instrumentId: x.symbol, limit: 1, cursor: null, queryId: 'one' },
      r = await x.adapter.getOpenOrders(q, x.context());
    if (!r.ok) throw new Error();
    expect(
      (
        await x.adapter.getOpenOrders(
          { ...q, queryId: 'other', cursor: r.value.nextCursor },
          x.context(),
        )
      ).ok,
    ).toBe(false);
    expect(
      (await x.adapter.getOpenOrders({ ...q, cursor: r.value.nextCursor }, x.context())).ok,
    ).toBe(true);
  });
  it('history outside native window fails before dispatching history route', async () => {
    const x = await fixture();
    expect(
      (
        await x.adapter.getOrderHistory(
          {
            instrumentId: x.symbol,
            limit: 1,
            cursor: null,
            queryId: 'long',
            from: x.state.time - 8 * 86400000,
            to: x.state.time,
          },
          x.context(),
        )
      ).ok,
    ).toBe(false);
    expect(
      x.request.mock.calls.some(([r]) => r.url.pathname.endsWith('orders-history-archive')),
    ).toBe(false);
  });
});
