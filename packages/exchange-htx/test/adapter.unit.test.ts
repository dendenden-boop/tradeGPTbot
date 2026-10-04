import { afterEach, describe, expect, it } from 'vitest';
import { type ExchangeAdapter } from '@ctp/exchange-core';
import * as production from '../src/index.js';
import { harness } from './harness.js';
import { htxProfileIds } from '../src/profiles.js';
import { account, now, spotOrder } from './fixtures.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
function h(...args: Parameters<typeof harness>) {
  const x = harness(...args);
  adapters.push(x.adapter);
  return x;
}
describe('HTX production/Core and native read contracts', () => {
  it.each([-5001, 1001])(
    'rejects a position snapshot with invalid native clock offset %s',
    async (offset) => {
      const x = h('htx-linear-live-v1');
      await x.warm();
      x.state.route = (r) =>
        r.url.pathname.endsWith('swap_cross_position_info')
          ? x.response([], { ts: now + offset })
          : x.native(r);
      expect(
        await x.adapter.getPositions(
          { instrumentId: x.symbol, limit: 10, cursor: null, queryId: 'positions1' },
          x.context(),
        ),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } });
      expect(
        x.request.mock.calls.some(([r]) => r.url.pathname.endsWith('swap_cross_position_info')),
      ).toBe(true);
    },
  );
  it('exports only factory at runtime and requires an explicit runtime registry', () => {
    expect(Object.keys(production)).toEqual(['createHtxAdapter']);
    const x = h();
    const { registry: explicitRegistry, ...missing } = x.options;
    expect(explicitRegistry).toBeDefined();
    // @ts-expect-error Production construction cannot silently allocate a reference registry.
    expect(() => production.createHtxAdapter(missing)).toThrow('INVALID_HTX_CONFIGURATION');
    expect(() =>
      production.createHtxAdapter({ ...x.options, registry: { get: () => {} } as never }),
    ).toThrow();
  });
  it.each([
    'rest',
    'publicWs',
    'privateWs',
    'tenantId',
    'account',
    'apiKey',
    'secret',
    'io',
    'authorization',
    'sandboxAcceptance',
  ])('rejects caller controlled %s', (field) => {
    const x = h();
    expect(() => production.createHtxAdapter({ ...x.options, [field]: 'untrusted' })).toThrow(
      'INVALID_HTX_CONFIGURATION',
    );
  });
  it.each(htxProfileIds)('public and native account reads preserve profile %s', async (profile) => {
    const x = h(profile);
    await x.warm();
    expect(await x.adapter.getTicker({ instrumentId: x.symbol }, x.context())).toMatchObject({
      ok: true,
      value: { last: { value: '50000' } },
    });
    expect(await x.adapter.getAccountInfo({}, x.context())).toMatchObject({
      ok: true,
      value: { account, positionMode: x.endpoint.spot ? 'NOT_APPLICABLE' : 'HEDGE' },
    });
    expect(await x.adapter.getBalances({}, x.context())).toMatchObject({
      ok: true,
      value: { balances: [{ asset: 'USDT', total: '10' }] },
    });
    expect(await x.adapter.testConnection({}, x.context())).toMatchObject({
      ok: true,
      value: { authenticated: true, canRead: true, canTrade: false },
    });
    for (const [r] of x.request.mock.calls) {
      expect(['https://api.huobi.pro', 'https://api.hbdm.com']).toContain(r.url.origin);
      if (r.method === 'POST')
        expect(r.url.pathname).toBe('/linear-swap-api/v1/swap_cross_account_info');
    }
  });
  it.each(htxProfileIds)(
    'LIVE has no mutation dispatch or fake sandbox authorization %s',
    async (profile) => {
      const x = h(profile),
        r = await x.warm();
      x.request.mockClear();
      x.permissions.verify.mockClear();
      const command = x.order(r.rules.version);
      expect(await x.adapter.createOrder(x.permit(command), x.context())).toMatchObject({
        kind: 'DEFINITIVELY_REJECTED',
        error: { code: 'LIVE_DISABLED' },
      });
      expect(x.request).not.toHaveBeenCalled();
      expect(x.permissions.verify).not.toHaveBeenCalled();
    },
  );
  it('native UID mismatch refuses private data without exposing key/signature/messages', async () => {
    const x = h();
    x.state.uid = '1234';
    const r = await x.adapter.getBalances({}, x.context());
    expect(r).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    expect(JSON.stringify(r)).not.toMatch(/fixture-secret|fixture-key|Signature|DO_NOT_EXPOSE/);
    expect(x.request.mock.calls.some(([r]) => r.url.pathname.endsWith('/balance'))).toBe(false);
  });
  it.each([
    { withdrawalEnabled: true },
    { canRead: false },
    { accountMode: 'MULTI_ASSET' },
    { profileId: 'other' },
    { account: { ...account, externalAccountId: 'other' } },
    { checkedAt: now - 30001 },
    { expiresAt: now },
  ])('trusted permission port fails closed %j', (fields) => {
    const x = h();
    x.permissions.verify.mockImplementation(() =>
      Promise.resolve({
        ...fields,
        profileId: 'htx-spot-live-v1',
        account,
        credentialRef: 'fixture-reference',
        accountMode: 'SPOT_CASH',
        canRead: true,
        canTrade: true,
        withdrawalEnabled: false,
        checkedAt: now,
        expiresAt: now + 30000,
        ...fields,
      } as never),
    );
    return expect(x.adapter.getBalances({}, x.context())).resolves.toMatchObject({ ok: false });
  });
  it.each([2, 3, 5])('does not guess v1/v3/v5 account type %s', async (type) => {
    const x = h('htx-linear-live-v1');
    x.state.accountType = type;
    expect(await x.adapter.getBalances({}, x.context())).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED' },
    });
    expect(
      x.request.mock.calls.some(([r]) => r.url.pathname.endsWith('swap_cross_account_info')),
    ).toBe(false);
  });
  it('read POST signing is allowed with read-only proof and no order budget', async () => {
    const x = h('htx-linear-live-v1');
    x.permissions.verify.mockImplementation(() =>
      Promise.resolve({
        profileId: 'htx-linear-live-v1',
        account,
        credentialRef: 'fixture-reference',
        accountMode: 'SINGLE_ASSET_CROSS_HEDGE',
        canRead: true,
        canTrade: false,
        withdrawalEnabled: false,
        checkedAt: now,
        expiresAt: now + 30000,
      }),
    );
    expect((await x.adapter.getBalances({}, x.context())).ok).toBe(true);
    expect(x.limiter.reserve.mock.calls.map(([r]) => r)).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: 'POST', orders: 0 })]),
    );
    const post = x.request.mock.calls.map(([r]) => r).find((r) => r.method === 'POST')!;
    expect(post.url.searchParams.get('Signature')).toBeTruthy();
    expect(post.body).toBe('{"margin_account":"USDT"}');
    expect(post.url.searchParams.has('margin_account')).toBe(false);
  });
  it.each(htxProfileIds)(
    'empty/native not-found client lookup is indeterminate and never retried %s',
    async (profile) => {
      const x = h(profile);
      await x.warm();
      x.state.route = (r) =>
        r.url.pathname.endsWith('getClientOrder') ||
        r.url.pathname.endsWith('swap_cross_order_info')
          ? x.response(x.endpoint.spot ? null : [])
          : x.native(r);
      expect(
        await x.adapter.getOrder(
          {
            instrumentId: x.symbol,
            locator: { kind: 'CLIENT_ID', id: x.endpoint.spot ? 'Client1' : '123456' },
          },
          x.context(),
        ),
      ).toMatchObject({ ok: true, value: { kind: 'INDETERMINATE', reason: 'NOT_AUTHORITATIVE' } });
      expect(
        x.request.mock.calls.filter(
          ([r]) =>
            r.url.pathname.endsWith('getClientOrder') ||
            r.url.pathname.endsWith('swap_cross_order_info'),
        ),
      ).toHaveLength(1);
    },
  );
  it.each(htxProfileIds)(
    'found lookup must match requested stable client ID %s',
    async (profile) => {
      const x = h(profile);
      await x.warm();
      expect(
        await x.adapter.getOrder(
          {
            instrumentId: x.symbol,
            locator: { kind: 'CLIENT_ID', id: x.endpoint.spot ? 'Client1' : '123456' },
          },
          x.context(),
        ),
      ).toMatchObject({ ok: true, value: { kind: 'FOUND' } });
      expect(
        await x.adapter.getOrder(
          {
            instrumentId: x.symbol,
            locator: { kind: 'CLIENT_ID', id: x.endpoint.spot ? 'Other' : '654321' },
          },
          x.context(),
        ),
      ).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    },
  );
  it('rechecks metadata after asynchronous ticker HTTP', async () => {
    const x = h();
    await x.warm();
    x.state.time += 59000;
    x.state.route = (r) => {
      const result = x.native(r);
      if (r.url.pathname.endsWith('detail/merged')) x.state.time += 1001;
      return result;
    };
    expect(await x.adapter.getTicker({ instrumentId: x.symbol }, x.context())).toMatchObject({
      ok: false,
      error: { code: 'STALE_METADATA' },
    });
  });
  it('does not dispatch behind a denied or hung rate port', async () => {
    const x = h();
    x.limiter.reserve.mockResolvedValue(false);
    expect(await x.adapter.getServerTime({}, x.context())).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(x.request).not.toHaveBeenCalled();
    x.limiter.reserve.mockImplementation(() => new Promise(() => {}));
    const start = Date.now();
    expect((await x.adapter.getServerTime({}, x.context(30))).ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
    expect(x.request).not.toHaveBeenCalled();
  });
  it('history walks to empty native page with exact bounds and stable IDs', async () => {
    const x = h();
    await x.warm();
    x.state.orders = [{ ...spotOrder }];
    expect(
      await x.adapter.getOrderHistory(
        {
          instrumentId: x.symbol,
          from: now - 2000,
          to: now,
          limit: 10,
          cursor: null,
          queryId: 'history1',
        },
        x.context(),
      ),
    ).toMatchObject({
      ok: true,
      value: { items: [{ exchangeOrderId: spotOrder.id }], nextCursor: null },
    });
    const requests = x.request.mock.calls
      .map(([r]) => r)
      .filter((r) => r.url.pathname === '/v1/order/orders');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url.searchParams.get('from')).toBe(spotOrder.id);
    expect(requests[0]!.url.searchParams.get('start-time')).toBe(String(now - 2000));
  });
  it('no private connection fails closed; public construction does not perform I/O', () => {
    const x = h('htx-spot-live-v1', {
      connection: undefined,
      credentials: undefined,
      permissions: undefined,
    });
    expect(x.adapter.account).toBe(null);
    expect(x.request).not.toHaveBeenCalled();
    expect(x.openSocket).not.toHaveBeenCalled();
  });
});
