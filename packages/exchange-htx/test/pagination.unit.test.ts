import { afterEach, describe, expect, it } from 'vitest';
import type { ExchangeAdapter } from '@ctp/exchange-core';
import { harness } from './harness.js';
import { linearOrder, now, spotOrder } from './fixtures.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
describe('HTX bounded private snapshot lifecycle', () => {
  it('terminal consumption immediately frees a slot without evicting live cursors', async () => {
    const x = harness();
    adapters.push(x.adapter);
    await x.warm();
    x.state.orders = [
      spotOrder,
      { ...spotOrder, id: '90071992547409940000', 'client-order-id': 'Client2' },
    ];
    const cursors: string[] = [];
    for (let i = 0; i < 16; i++) {
      const result = await x.adapter.getOpenOrders(
        { instrumentId: x.symbol, queryId: `query${i}`, limit: 1, cursor: null },
        x.context(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      cursors.push(result.value.nextCursor!);
    }
    expect(
      await x.adapter.getOpenOrders(
        { instrumentId: x.symbol, queryId: 'overflow', limit: 1, cursor: null },
        x.context(),
      ),
    ).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(
      await x.adapter.getOpenOrders(
        { instrumentId: x.symbol, queryId: 'query0', limit: 1, cursor: cursors[0]! },
        x.context(),
      ),
    ).toMatchObject({ ok: true, value: { nextCursor: null } });
    expect(
      await x.adapter.getOpenOrders(
        { instrumentId: x.symbol, queryId: 'replacement', limit: 1, cursor: null },
        x.context(),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await x.adapter.getOpenOrders(
        { instrumentId: x.symbol, queryId: 'query1', limit: 1, cursor: cursors[1]! },
        x.context(),
      ),
    ).toMatchObject({ ok: true, value: { nextCursor: null } });
  });
  it('each cursor is single use; consuming a page rotates the continuation', async () => {
    const x = harness();
    adapters.push(x.adapter);
    await x.warm();
    x.state.orders = [0, 1, 2].map((i) => ({
      ...spotOrder,
      id: String(BigInt(spotOrder.id) + BigInt(i)),
      'client-order-id': `Client${i}`,
    }));
    const query = { instrumentId: x.symbol, queryId: 'rotate', limit: 1, cursor: null };
    const first = await x.adapter.getOpenOrders(query, x.context());
    if (!first.ok) throw new Error();
    const second = await x.adapter.getOpenOrders(
      { ...query, cursor: first.value.nextCursor },
      x.context(),
    );
    expect(second.ok).toBe(true);
    expect(
      await x.adapter.getOpenOrders({ ...query, cursor: first.value.nextCursor }, x.context()),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
  it('multiple executions of one order are not mistaken for duplicate orders', async () => {
    const x = harness('htx-linear-live-v1');
    adapters.push(x.adapter);
    await x.warm();
    x.state.fills = [1, 2].map((i) => ({
      ...linearOrder,
      query_id: String(i),
      id: `12-order1-${i}`,
      match_id: '12',
      trade_volume: '1',
      trade_price: '50000',
      trade_fee: '-0.1',
      fee_asset: 'USDT',
      create_date: now - 1000,
    }));
    expect(
      await x.adapter.getTrades(
        {
          instrumentId: x.symbol,
          queryId: 'executions',
          limit: 10,
          cursor: null,
          from: now - 2000,
          to: now,
        },
        x.context(),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        items: [{ fillId: '12.12-order1-1' }, { fillId: '12.12-order1-2' }],
        nextCursor: null,
      },
    });
  });
  it('a foreign query cannot consume another live cursor', async () => {
    const x = harness();
    adapters.push(x.adapter);
    await x.warm();
    x.state.orders = [
      spotOrder,
      { ...spotOrder, id: '90071992547409940000', 'client-order-id': 'Client2' },
    ];
    const result = await x.adapter.getOpenOrders(
      { instrumentId: x.symbol, queryId: 'owner', limit: 1, cursor: null },
      x.context(),
    );
    if (!result.ok) throw new Error();
    expect(
      await x.adapter.getOpenOrders(
        { instrumentId: x.symbol, queryId: 'foreign', limit: 1, cursor: result.value.nextCursor },
        x.context(),
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(
      await x.adapter.getOpenOrders(
        { instrumentId: x.symbol, queryId: 'owner', limit: 1, cursor: result.value.nextCursor },
        x.context(),
      ),
    ).toMatchObject({ ok: true });
  });
});
