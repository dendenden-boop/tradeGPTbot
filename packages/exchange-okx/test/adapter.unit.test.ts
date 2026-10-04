import { afterEach, describe, expect, it } from 'vitest';
import { parseDecimal, type ExchangeAdapter } from '@ctp/exchange-core';
import * as production from '../src/index.js';
import { harness } from './harness.js';
import { okxProfileIds } from '../src/profiles.js';
const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disconnect();
});
function h(...args: Parameters<typeof harness>) {
  const x = harness(...args);
  adapters.push(x.adapter);
  return x;
}
describe('OKX Core integration with private signing and admission', () => {
  it('only factory is a runtime production export', () => {
    expect(Object.keys(production)).toEqual(['createOkxAdapter']);
  });
  it.each([
    'rest',
    'publicWs',
    'privateWs',
    'businessWs',
    'apiKey',
    'secret',
    'passphrase',
    'tenantId',
    'account',
    'io',
  ])('rejects caller-controlled %s', (field) => {
    const x = h();
    expect(() => production.createOkxAdapter({ ...x.options, [field]: 'untrusted' })).toThrow(
      'INVALID_OKX_CONFIGURATION',
    );
  });
  it.each(okxProfileIds)('public reads stay within immutable profile %s', async (profile) => {
    const x = h(profile);
    await x.warm();
    expect((await x.adapter.getTicker({ instrumentId: x.symbol }, x.context())).ok).toBe(true);
    for (const [r] of x.request.mock.calls) {
      expect(r.url.origin).toBe('https://openapi.okx.com');
      expect(r.headers?.['x-simulated-trading']).toBe(profile.includes('demo') ? '1' : undefined);
    }
  });
  it.each(['okx-spot-demo-v1', 'okx-swap-demo-v1'] as const)(
    'creates exact native size once with proof %s',
    async (profile) => {
      const x = h(profile),
        version = await x.warm(),
        r = await x.adapter.createOrder(x.permit('createOrder', x.order(version)), x.context());
      expect(r.kind).toBe('ACCEPTED');
      const posts = x.request.mock.calls.map(([r]) => r).filter((r) => r.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(x.signed(posts[0]!)).toBe(true);
      const body = JSON.parse(posts[0]!.body!) as Record<string, unknown>;
      expect(body).toMatchObject({
        instId: x.symbol,
        clOrdId: 'Client1',
        sz: profile.includes('swap') ? '2' : '0.01',
        tdMode: profile.includes('swap') ? 'cross' : 'cash',
      });
      if (profile.includes('spot'))
        expect(body).toMatchObject({ tgtCcy: 'base_ccy', banAmend: true, tradeQuoteCcy: 'USDT' });
      expect(posts[0]!.headers?.expTime).toBe(String(x.context().deadline));
    },
  );
  it.each(['okx-spot-live-v1', 'okx-swap-live-v1'] as const)(
    'LIVE blocks before private authorization/dispatch %s',
    async (profile) => {
      const x = h(profile),
        v = await x.warm();
      x.request.mockClear();
      expect(
        await x.adapter.createOrder(x.permit('createOrder', x.order(v)), x.context()),
      ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'LIVE_DISABLED' } });
      expect(x.request).not.toHaveBeenCalled();
      expect(x.authorization.authorize).not.toHaveBeenCalled();
    },
  );
  it.each([
    { uid: 'other' },
    { perm: 'read_only' },
    { perm: 'read_only,trade,withdraw' },
    { acctLv: '3' },
    { posMode: 'long_short_mode' },
    { autoLoan: true },
  ])('native configuration refuses mutation %j', async (fields) => {
    const x = h(),
      v = await x.warm();
    Object.assign(x.state.config, fields);
    expect(
      await x.adapter.createOrder(x.permit('createOrder', x.order(v)), x.context()),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED' });
    expect(x.request.mock.calls.some(([r]) => r.method === 'POST')).toBe(false);
  });
  it('unknown native constraint denies before admission or POST', async () => {
    const x = h();
    x.state.instrument.futureConstraint = '1';
    const v = await x.warm();
    expect(
      await x.adapter.createOrder(x.permit('createOrder', x.order(v)), x.context()),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED', error: { code: 'UNSUPPORTED' } });
    expect(x.admission.validate).not.toHaveBeenCalled();
    expect(x.request.mock.calls.some(([r]) => r.method === 'POST')).toBe(false);
  });
  it('missing Risk/native admission or Demo acceptance port fails closed', async () => {
    for (const overrides of [
      { orderAdmission: undefined },
      { sandboxAcceptance: undefined },
      { permissions: undefined },
      { authorization: undefined },
    ]) {
      const x = h('okx-spot-demo-v1', overrides),
        v = await x.warm();
      expect(
        (await x.adapter.createOrder(x.permit('createOrder', x.order(v)), x.context())).kind,
      ).toBe('DEFINITIVELY_REJECTED');
      expect(x.request.mock.calls.some(([r]) => r.method === 'POST')).toBe(false);
    }
  });
  it.each(['', 'WrongClient'])(
    'malformed/mismatched successful native receipt is UNKNOWN client=%s',
    async (clOrdId) => {
      const x = h(),
        v = await x.warm();
      x.state.route = (input) =>
        input.method === 'POST'
          ? x.response([{ sCode: '0', ordId: 'native1', clOrdId }])
          : x.native(input);
      expect(
        await x.adapter.createOrder(x.permit('createOrder', x.order(v)), x.context()),
      ).toMatchObject({ kind: 'UNKNOWN' });
      expect(x.request.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
    },
  );
  it.each([50004, 51603, 99999])(
    'post-dispatch unknown code %s stays UNKNOWN without retry',
    async (code) => {
      const x = h(),
        v = await x.warm();
      x.state.route = (input) => (input.method === 'POST' ? x.response([], code) : x.native(input));
      expect(
        await x.adapter.createOrder(x.permit('createOrder', x.order(v)), x.context()),
      ).toMatchObject({ kind: 'UNKNOWN' });
      expect(x.request.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
    },
  );
  it('per-item sCode rejection is not accepted despite top code zero', async () => {
    const x = h(),
      v = await x.warm();
    x.state.route = (input) =>
      input.method === 'POST'
        ? x.response([{ sCode: '51000', ordId: '', clOrdId: 'Client1' }])
        : x.native(input);
    expect(
      await x.adapter.createOrder(x.permit('createOrder', x.order(v)), x.context()),
    ).toMatchObject({ kind: 'DEFINITIVELY_REJECTED' });
  });
  it('connection loss after dispatch reconciles by client ID via read, never replays POST', async () => {
    const x = h(),
      v = await x.warm();
    x.state.route = (input) => {
      if (input.method === 'POST') throw new Error('connection-loss');
      return x.native(input);
    };
    const permit = x.permit('createOrder', x.order(v));
    expect((await x.adapter.createOrder(permit, x.context())).kind).toBe('UNKNOWN');
    expect(
      await x.adapter.getOrder(
        { instrumentId: x.symbol, locator: { kind: 'CLIENT_ID', id: 'Client1' } },
        x.context(),
      ),
    ).toMatchObject({ ok: true, value: { kind: 'FOUND', order: { clientOrderId: 'Client1' } } });
    expect(x.request.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
  });
  it('order not-found is indeterminate, not authoritative absence', async () => {
    const x = h();
    await x.warm();
    x.state.route = (input) =>
      input.url.pathname === '/api/v5/trade/order' ? x.response([], 51603) : x.native(input);
    expect(
      await x.adapter.getOrder(
        { instrumentId: x.symbol, locator: { kind: 'CLIENT_ID', id: 'Client1' } },
        x.context(),
      ),
    ).toMatchObject({ ok: true, value: { kind: 'INDETERMINATE' } });
  });
  it('SWAP BASE size cannot silently become contracts', async () => {
    const x = h('okx-swap-demo-v1'),
      v = await x.warm(),
      order = {
        ...x.order(v),
        size: { kind: 'BASE_QUANTITY' as const, value: parseDecimal('0.02'), asset: 'BTC' },
      };
    expect((await x.adapter.createOrder(x.permit('createOrder', order), x.context())).kind).toBe(
      'DEFINITIVELY_REJECTED',
    );
    expect(x.request.mock.calls.some(([r]) => r.method === 'POST')).toBe(false);
  });
});
