import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExchangeAdapter, RequestContext } from '@ctp/exchange-core';
import { createHtxAdapterWithIo } from '../src/adapter.js';
import { createNetworkIo, type NetworkIo } from '../src/io.js';
import { canonicalQuery } from '../src/auth.js';
import { harness } from './harness.js';
import { httpFixture, wsFixture, until } from './fixtures/io.js';
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close();
});
async function loopback(options: { hungWallet?: boolean; hungWs?: boolean } = {}) {
  const x = harness();
  disposers.push(() => x.adapter.disconnect());
  let hang = options.hungWallet ?? false,
    hangs = 0,
    signed = 0;
  const server = await httpFixture((req, res) => {
    const url = new URL(req.url ?? '/', 'https://api.huobi.pro');
    if (hang && url.pathname.endsWith('/balance')) {
      hangs++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      return;
    }
    const params = Object.fromEntries(url.searchParams),
      signature = params.Signature;
    delete params.Signature;
    if (signature !== undefined) {
      expect(signature).toBe(
        createHmac('sha256', 'fixture-secret')
          .update(`${req.method}\napi.huobi.pro\n${url.pathname}\n${canonicalQuery(params)}`)
          .digest('base64'),
      );
      signed++;
    }
    x.state.time = Date.now();
    const response = x.native({ url, method: 'GET' });
    res.writeHead(response.status, response.headers).end(response.body);
  });
  disposers.push(() => server.close());
  const ws = await wsFixture((socket) => {
    socket.on('message', (bytes) => {
      if (options.hungWs) return;
      const data = Array.isArray(bytes)
        ? Buffer.concat(bytes)
        : bytes instanceof ArrayBuffer
          ? Buffer.from(bytes)
          : bytes;
      const c = JSON.parse(data.toString()) as Record<string, unknown>;
      if (c.sub !== undefined) {
        socket.send(
          gzipSync(JSON.stringify({ status: 'ok', subbed: c.sub, id: c.id, ts: Date.now() })),
        );
        socket.send(
          gzipSync(
            JSON.stringify({
              ch: c.sub,
              ts: Date.now(),
              tick: { close: '50000', amount: '2', vol: '100000' },
            }),
          ),
        );
      } else if (c.action === 'req' && c.ch === 'auth') {
        const p = { ...(c.params as Record<string, string>) };
        delete p.authType;
        delete p.signature;
        expect((c.params as Record<string, string>).signature).toBe(
          createHmac('sha256', 'fixture-secret')
            .update(`GET\napi.huobi.pro\n/ws/v2\n${canonicalQuery(p)}`)
            .digest('base64'),
        );
        socket.send(JSON.stringify({ action: 'req', ch: 'auth', code: 200, data: {} }));
      } else if (c.action === 'sub')
        socket.send(JSON.stringify({ action: 'sub', ch: c.ch, code: 200, data: {} }));
    });
  });
  disposers.push(() => ws.close());
  const network = createNetworkIo(),
    remap: NetworkIo = {
      request(input, context) {
        const url = new URL(input.url.pathname + input.url.search, server.url);
        return network.request({ ...input, url }, context);
      },
      openSocket(_url, context, onMessage, onEnd) {
        return network.openSocket(ws.url, context, onMessage, onEnd);
      },
      close: () => network.close(),
    };
  const t = Date.now(),
    adapter: ExchangeAdapter = createHtxAdapterWithIo(
      {
        ...x.options,
        now: Date.now,
        permissions: {
          verify: () =>
            Promise.resolve({
              profileId: x.options.profileId,
              account: x.adapter.account!,
              credentialRef: 'fixture-reference',
              accountMode: 'SPOT_CASH',
              canRead: true,
              canTrade: false,
              withdrawalEnabled: false,
              checkedAt: Date.now(),
              expiresAt: Date.now() + 10000,
            }),
        },
        capabilities: x.options.capabilities.map((c) => ({
          ...c,
          checkedAt: t - 1,
          expiresAt: t + 30000,
        })),
      },
      remap,
    );
  disposers.push(() => adapter.disconnect());
  const context = (ms = 2500, signal = new AbortController().signal): RequestContext => ({
    profile: adapter.profile,
    account: adapter.account,
    signal,
    deadline: Date.now() + ms,
    correlationId: 'htx-loopback',
  });
  return {
    adapter,
    context,
    server,
    ws,
    x,
    get hangs() {
      return hangs;
    },
    get signed() {
      return signed;
    },
    release() {
      hang = false;
    },
  };
}
describe('real HTX HTTP/WS settling through Exchange Core', () => {
  it('16 hung private requests abort actual sockets and release all Core slots', async () => {
    const f = await loopback({ hungWallet: true }),
      controller = new AbortController(),
      ctx = f.context(5000, controller.signal),
      pending = Array.from({ length: 16 }, () => f.adapter.getBalances({}, ctx));
    await until(() => f.hangs === 16);
    expect(await f.adapter.getBalances({}, ctx)).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    controller.abort();
    expect((await Promise.all(pending)).every((r) => !r.ok)).toBe(true);
    await until(() => f.server.sockets.size === 0);
    f.release();
    expect(await f.adapter.getBalances({}, f.context())).toMatchObject({ ok: true });
    expect(f.signed).toBeGreaterThan(0);
  });
  it('deadline terminates a hung response body and allows a subsequent native read', async () => {
    const f = await loopback({ hungWallet: true });
    expect(await f.adapter.getBalances({}, f.context(200))).toMatchObject({
      ok: false,
      error: { code: 'DEADLINE_EXCEEDED' },
    });
    await until(() => f.server.sockets.size === 0);
    f.release();
    expect(await f.adapter.getBalances({}, f.context())).toMatchObject({ ok: true });
  });
  it('hung gzip WS ACK is bounded and releases subscription resources', async () => {
    const f = await loopback({ hungWs: true });
    expect(
      (await f.adapter.getSymbols({ limit: 200, cursor: null, queryId: 'warm' }, f.context())).ok,
    ).toBe(true);
    expect(
      await f.adapter.subscribeTicker({ instrumentId: 'btcusdt' }, f.context(100)),
    ).toMatchObject({ ok: false });
    await until(() => f.ws.sockets.size === 0);
  });
  it('real gzip public WS reaches Core DATA and unsubscribe closes actual socket', async () => {
    const f = await loopback();
    await f.adapter.getSymbols({ limit: 200, cursor: null, queryId: 'warm' }, f.context());
    const result = await f.adapter.subscribeTicker({ instrumentId: 'btcusdt' }, f.context());
    if (!result.ok) throw new Error();
    expect(await result.value[Symbol.asyncIterator]().next()).toMatchObject({
      value: { kind: 'DATA', data: { last: { value: '50000' } } },
    });
    await result.value.unsubscribe();
    await until(() => f.ws.sockets.size === 0);
  });
  it('real Spot WS HMAC authenticates; source close requires resync without reconnect', async () => {
    const f = await loopback();
    await f.adapter.getSymbols({ limit: 200, cursor: null, queryId: 'warm' }, f.context());
    const result = await f.adapter.subscribePrivateOrders({ instrumentId: 'btcusdt' }, f.context());
    if (!result.ok) throw new Error();
    const next = result.value[Symbol.asyncIterator]().next();
    for (const socket of f.ws.ws.clients) socket.terminate();
    expect(await next).toMatchObject({ value: { kind: 'RESYNC_REQUIRED' } });
    await until(() => f.ws.sockets.size === 0);
  });
});
