import { afterEach, describe, expect, it } from 'vitest';
import {
  operations,
  createInstrumentRegistry,
  parseDecimal,
  type ExchangeAdapter,
} from '@ctp/exchange-core';
import * as production from '../src/index.js';
import { harness } from './harness.js';
import { bybitProfileIds } from '../src/profiles.js';
import { nativeOrder } from './fixtures.js';

const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
function h(...args: Parameters<typeof harness>) {
  const x = harness(...args);
  adapters.push(x.adapter);
  return x;
}
describe('Bybit adapter security and native protocol integration', () => {
  it('exports factory/types only; raw IO/signer/testing are private', () => {
    expect(Object.keys(production)).toEqual(['createBybitAdapter']);
  });
  it.each(['rest', 'publicWs', 'privateWs', 'apiKey', 'secret', 'account', 'tenantId', 'io'])(
    'rejects untrusted configuration field %s',
    (field) => {
      const x = h();
      expect(() =>
        production.createBybitAdapter({ ...x.options, [field]: 'untrusted-value' }),
      ).toThrow('INVALID_BYBIT_CONFIGURATION');
    },
  );
  it.each(bybitProfileIds)('routes public reads on exact server profile %s', async (profile) => {
    const x = h(profile);
    await x.warm();
    const r = await x.adapter.getTicker({ instrumentId: 'BTCUSDT' }, x.context());
    expect(r.ok).toBe(true);
    expect(
      x.request.mock.calls.every(
        ([req]) =>
          req.url.origin ===
          new URL(
            x.options.profileId.includes('demo')
              ? 'https://api-demo.bybit.com'
              : x.options.profileId.includes('testnet')
                ? 'https://api-testnet.bybit.com'
                : 'https://api.bybit.com',
          ).origin,
      ),
    ).toBe(true);
  });
  it.each([false, true])(
    'creates BASE market only with signed exact bytes linear=%s',
    async (linear) => {
      const x = h(linear ? 'bybit-linear-testnet-v1' : 'bybit-spot-testnet-v1');
      const version = await x.warm();
      const command = { ...x.order(), ruleVersion: version };
      const result = await x.adapter.createOrder(x.permit('createOrder', command), x.context());
      expect(result.kind).toBe('ACCEPTED');
      const posts = x.request.mock.calls.map(([r]) => r).filter((r) => r.method === 'POST');
      expect(posts).toHaveLength(1);
      const req = posts[0]!;
      expect(x.signed(req)).toBe(true);
      const body = JSON.parse(req.body!) as Record<string, unknown>;
      expect(body.qty).toBe('0.01');
      expect(body.orderLinkId).toBe('client-1');
      expect(linear ? body.positionIdx : body.marketUnit).toBe(linear ? 0 : 'baseCoin');
      if (!linear) expect(body.isLeverage).toBe(0);
    },
  );
  it('LIVE rejects before authorization/network mutation', async () => {
    const x = h('bybit-spot-live-v1');
    const version = await x.warm();
    x.request.mockClear();
    const r = await x.adapter.createOrder(
      x.permit('createOrder', { ...x.order(), ruleVersion: version }),
      x.context(),
    );
    expect(r).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'LIVE_DISABLED' } });
    expect(x.request).not.toHaveBeenCalled();
    expect(x.authorization.authorize).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'new unknown constraint blocks new-risk dispatch linear=%s',
    async (linear) => {
      const x = h(linear ? 'bybit-linear-testnet-v1' : 'bybit-spot-testnet-v1');
      x.state.instrument.priceFilter = {
        ...(x.state.instrument.priceFilter as object),
        futureConstraint: '1',
      };
      const version = await x.warm();
      const r = await x.adapter.createOrder(
        x.permit('createOrder', { ...x.order(), ruleVersion: version }),
        x.context(),
      );
      expect(r).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'UNSUPPORTED' } });
      expect(x.admission.validate).not.toHaveBeenCalled();
      expect(x.request.mock.calls.some(([r]) => r.method === 'POST')).toBe(false);
    },
  );
  it.each([0, 3, 4])('rejects non-UTA2 native account %s', async (uta) => {
    const x = h();
    x.state.uta = uta;
    const r = await x.adapter.getAccountInfo({}, x.context());
    expect(r).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
  });
  it('rejects Portfolio Margin, withdrawal permission and mismatched server credentials', async () => {
    const x = h();
    x.state.margin = 'PORTFOLIO_MARGIN';
    expect(await x.adapter.getAccountInfo({}, x.context())).toMatchObject({ ok: false });
    x.state.margin = 'REGULAR_MARGIN';
    x.state.permissionWithdrawal = true;
    expect(await x.adapter.getBalances({}, x.context())).toMatchObject({
      ok: false,
      error: { code: 'AUTHORIZATION_REQUIRED' },
    });
    x.state.permissionWithdrawal = false;
    x.credentials.resolve.mockResolvedValue({
      ...(await x.credentials.resolve()),
      profileId: 'bybit-spot-demo-v1',
    });
    expect(await x.adapter.getBalances({}, x.context())).toMatchObject({
      ok: false,
      error: { code: 'SCOPE_MISMATCH' },
    });
  });
  it.each([1, 2])('hedge positionIdx %s rejects mutations', async (idx) => {
    const x = h('bybit-linear-testnet-v1');
    x.state.positionIdx = idx;
    const version = await x.warm();
    expect(
      await x.adapter.createOrder(
        x.permit('createOrder', { ...x.order(), ruleVersion: version }),
        x.context(),
      ),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'UNSUPPORTED' } });
    expect(x.request.mock.calls.some(([r]) => r.method === 'POST')).toBe(false);
  });
  it.each(['bybit-spot-demo-v1', 'bybit-linear-demo-v1'] as const)(
    'Demo validates server permissions without unavailable key-info API %s',
    async (profile) => {
      const x = h(profile);
      expect(await x.adapter.testConnection({}, x.context())).toMatchObject({
        ok: true,
        value: { authenticated: true, canRead: true, canTrade: true },
      });
      expect(x.request.mock.calls.some(([r]) => r.url.pathname === '/v5/user/query-api')).toBe(
        false,
      );
      expect(x.permissions.verify).toHaveBeenCalled();
    },
  );
  it.each([10000, 10016, 10014, 110072, 10006])(
    'retCode %s after dispatch is UNKNOWN, no POST retry',
    async (code) => {
      const x = h();
      const version = await x.warm();
      x.state.route = (r) => (r.method === 'POST' ? x.response({}, code) : x.native(r));
      const command = { ...x.order(), ruleVersion: version };
      expect(
        await x.adapter.createOrder(x.permit('createOrder', command), x.context()),
      ).toMatchObject({ kind: 'UNKNOWN', error: { code: 'UNKNOWN_OUTCOME' } });
      expect(x.request.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
    },
  );
  it('lost create ACK reconciles by stable orderLinkId without another POST', async () => {
    const x = h();
    const version = await x.warm();
    x.state.route = (r) => {
      if (r.method === 'POST') throw new Error('fixture-secret-connection-lost');
      return x.native(r);
    };
    expect(
      await x.adapter.createOrder(
        x.permit('createOrder', { ...x.order(), ruleVersion: version }),
        x.context(),
      ),
    ).toMatchObject({ kind: 'UNKNOWN' });
    const lookup = await x.adapter.getOrder(
      { instrumentId: 'BTCUSDT', locator: { kind: 'CLIENT_ID', id: 'client-1' } },
      x.context(),
    );
    expect(lookup).toMatchObject({
      ok: true,
      value: { kind: 'FOUND', order: { status: 'FILLED' } },
    });
    expect(x.request.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(lookup)).not.toContain('fixture-secret');
  });
  it('empty realtime and delayed history stay INDETERMINATE', async () => {
    const x = h();
    await x.warm();
    x.state.route = (r) =>
      ['/v5/order/realtime', '/v5/order/history'].includes(r.url.pathname)
        ? x.response({ category: 'spot', list: [], nextPageCursor: '' })
        : x.native(r);
    expect(
      await x.adapter.getOrder(
        { instrumentId: 'BTCUSDT', locator: { kind: 'CLIENT_ID', id: 'client-1' } },
        x.context(),
      ),
    ).toMatchObject({ ok: true, value: { kind: 'INDETERMINATE', reason: 'NOT_AUTHORITATIVE' } });
  });
  it('durable permit mismatch and cross-tenant scope block all network calls', async () => {
    const x = h();
    const version = await x.warm();
    x.request.mockClear();
    const permit = x.permit('createOrder', { ...x.order(), ruleVersion: version });
    expect(
      await x.adapter.createOrder(
        { ...permit, command: { ...permit.command, clientOrderId: 'changed-id' } },
        x.context(),
      ),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'AUTHORIZATION_REQUIRED' } });
    const context = {
      ...x.context(),
      account: { ...x.adapter.account!, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    };
    expect(await x.adapter.getBalances({}, context)).toMatchObject({
      ok: false,
      error: { code: 'SCOPE_MISMATCH' },
    });
    expect(x.request).not.toHaveBeenCalled();
  });
  it('metadata change while admission awaits rejects before dispatch', async () => {
    const registry = createInstrumentRegistry({ capacity: 16 });
    const x = h('bybit-spot-testnet-v1', { registry });
    const version = await x.warm();
    x.admission.validate.mockImplementationOnce(() => {
      const current = registry.get(x.adapter.profile, 'BTCUSDT', x.state.time);
      if (!current.ok) throw new Error();
      expect(
        registry.put(
          {
            ...current.value,
            instrument: { ...current.value.instrument, metadataVersion: 'changed-metadata' },
            rules: { ...current.value.rules, version: 'changed-rules' },
          },
          x.state.time,
        ).ok,
      ).toBe(true);
      return Promise.resolve(true);
    });
    expect(
      await x.adapter.createOrder(
        x.permit('createOrder', { ...x.order(), ruleVersion: version }),
        x.context(),
      ),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED' });
    expect(x.request.mock.calls.some(([r]) => r.method === 'POST')).toBe(false);
  });
  it('release all 16 Core pending slots after hung permission resolver abort', async () => {
    const x = h();
    x.permissions.verify.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const context = x.context(controller.signal);
    const requests = Array.from({ length: 16 }, () => x.adapter.getBalances({}, context));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await x.adapter.getBalances({}, context)).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    controller.abort();
    expect((await Promise.all(requests)).every((r) => !r.ok)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    x.permissions.verify.mockImplementation(() =>
      Promise.resolve({
        profileId: x.options.profileId,
        account: x.adapter.account!,
        credentialRef: 'fixture-reference',
        canRead: true,
        canTrade: true,
        withdrawalEnabled: false,
        checkedAt: x.state.time,
        expiresAt: x.state.time + 5000,
      }),
    );
    expect(await x.adapter.getBalances({}, x.context())).toMatchObject({ ok: true });
  });
  it('denies empty historical window without exchange history dispatch', async () => {
    const x = h();
    await x.warm();
    x.request.mockClear();
    expect(
      await x.adapter.getOrderHistory(
        {
          instrumentId: 'BTCUSDT',
          from: x.state.time,
          to: x.state.time,
          limit: 10,
          cursor: null,
          queryId: 'empty',
        },
        x.context(),
      ),
    ).toMatchObject({ ok: true, value: { items: [], nextCursor: null } });
    expect(x.request.mock.calls.some(([r]) => r.url.pathname === '/v5/order/history')).toBe(false);
  });
  it('leverage outside native bounds rejects before POST', async () => {
    const x = h('bybit-linear-testnet-v1');
    await x.warm();
    expect(
      await x.adapter.setLeverage(
        x.permit('setLeverage', { instrumentId: 'BTCUSDT', leverage: parseDecimal('101') }),
        x.context(),
      ),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'INVALID_REQUEST' } });
    expect(x.request.mock.calls.some(([r]) => r.method === 'POST')).toBe(false);
  });
  it('pagination releases consumed cursor capacity and keeps live cursors', async () => {
    const x = h();
    await x.warm();
    x.state.nativeOrder = { ...nativeOrder(), orderStatus: 'New', cumExecQty: '0', avgPrice: '0' };
    x.state.route = (r) =>
      r.url.pathname === '/v5/order/realtime'
        ? x.response({
            category: 'spot',
            list: [x.state.nativeOrder],
            nextPageCursor: r.url.searchParams.has('cursor') ? '' : 'native+cursor',
          })
        : x.native(r);
    const query = { instrumentId: 'BTCUSDT', limit: 1, cursor: null, queryId: 'first' };
    const pages = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        x.adapter.getOpenOrders({ ...query, queryId: `q-${i}` }, x.context()),
      ),
    );
    expect(pages.every((p) => p.ok && p.value.nextCursor !== null)).toBe(true);
    expect(await x.adapter.getOpenOrders(query, x.context())).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    const first = pages[0]!;
    if (!first.ok) throw new Error();
    expect(
      await x.adapter.getOpenOrders(
        { ...query, queryId: 'q-0', cursor: first.value.nextCursor },
        x.context(),
      ),
    ).toMatchObject({ ok: true, value: { nextCursor: null } });
    expect(await x.adapter.getOpenOrders(query, x.context())).toMatchObject({ ok: true });
    const retained = pages[1]!;
    if (!retained.ok) throw new Error();
    expect(
      await x.adapter.getOpenOrders(
        { ...query, queryId: 'q-1', cursor: retained.value.nextCursor },
        x.context(),
      ),
    ).toMatchObject({ ok: true });
  });
  it('duplicate Filled does not emit twice; terminal rollback produces resync', async () => {
    const x = h();
    await x.warm();
    const r = await x.adapter.subscribePrivateOrders({ instrumentId: 'BTCUSDT' }, x.context());
    if (!r.ok) throw new Error(r.error.code);
    const iterator = r.value[Symbol.asyncIterator]();
    const next = iterator.next();
    const send = (order: Record<string, unknown>) =>
      x.state.message?.(
        JSON.stringify({ topic: 'order.spot', creationTime: x.state.time, data: [order] }),
      );
    send(x.state.nativeOrder);
    expect(await next).toMatchObject({
      done: false,
      value: { kind: 'DATA', data: { status: 'FILLED' } },
    });
    send({
      ...x.state.nativeOrder,
      rejectReason: 'EC_OrigClOrdIDDoesNotExist',
      cancelType: 'CancelByUser',
    });
    send({ ...x.state.nativeOrder, orderStatus: 'New', updatedTime: String(x.state.time + 1) });
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { kind: 'RESYNC_REQUIRED' },
    });
    expect(x.state.socketClosed).toBe(1);
  });
  it('all unimplemented features stay explicitly unsupported', () => {
    const x = h();
    for (const feature of [
      'ALGO_ORDERS',
      'AMEND_ORDER',
      'TRIGGER_ORDER',
      'QUOTE_BUDGET_MARKET_BUY',
      'CHANGE_POSITION_MODE',
    ])
      expect(x.adapter.capabilities.find((c) => c.feature === feature)?.support).toBe(
        'UNSUPPORTED',
      );
    expect(Object.keys(operations)).toHaveLength(33);
  });
});
