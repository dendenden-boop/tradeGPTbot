import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExchangeAdapter, RequestContext } from '@ctp/exchange-core';
import { createBybitAdapterWithIo } from '../src/adapter.js';
import { createNetworkIo, type NetworkIo } from '../src/io.js';
import { harness } from './harness.js';
import { httpFixture, wsFixture, until } from './fixtures/io.js';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close();
});
async function loopback(
  options: { hungWallet?: boolean; lostPost?: boolean; hungWs?: boolean } = {},
) {
  const x = harness();
  disposers.push(() => x.adapter.disconnect());
  let hang = options.hungWallet ?? false,
    hangs = 0,
    posts = 0,
    validSignatures = 0;
  const server = await httpFixture((req, res) => {
    const url = new URL(req.url ?? '/', 'https://api-testnet.bybit.com');
    if (hang && url.pathname === '/v5/account/wallet-balance') {
      hangs++;
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (part: string) => (body += part));
    req.on('end', () => {
      x.state.time = Date.now();
      const key = req.headers['x-bapi-api-key'],
        timestamp = req.headers['x-bapi-timestamp'],
        signature = req.headers['x-bapi-sign'];
      const payload = req.method === 'POST' ? body : url.searchParams.toString();
      if (
        key === 'fixture-key' &&
        typeof signature === 'string' &&
        signature ===
          createHmac('sha256', 'fixture-secret')
            .update(`${String(timestamp)}fixture-key5000${payload}`)
            .digest('hex')
      )
        validSignatures++;
      if (req.method === 'POST') {
        posts++;
        if (options.lostPost) {
          res.destroy();
          return;
        }
      }
      const response = x.native({
        url,
        method: req.method === 'POST' ? 'POST' : 'GET',
        ...(body === '' ? {} : { body }),
      });
      res.writeHead(response.status, response.headers).end(response.body);
    });
  });
  disposers.push(() => server.close());
  const ws = await wsFixture((socket) => {
    socket.on('message', (bytes) => {
      if (options.hungWs) return;
      const c = JSON.parse(
        (Array.isArray(bytes)
          ? Buffer.concat(bytes)
          : bytes instanceof ArrayBuffer
            ? Buffer.from(bytes)
            : bytes
        ).toString('utf8'),
      ) as { op: string; req_id: string; args: unknown[] };
      if (c.op === 'auth') {
        const [key, expires, signature] = c.args;
        expect(signature).toBe(
          createHmac('sha256', 'fixture-secret')
            .update(`GET/realtime${String(expires)}`)
            .digest('hex'),
        );
        expect(key).toBe('fixture-key');
      }
      socket.send(JSON.stringify({ op: c.op, req_id: c.req_id, success: true }));
    });
  });
  disposers.push(() => ws.close());
  const network = createNetworkIo();
  disposers.push(() => network.close());
  const remap: NetworkIo = {
    request: (request, context) => {
      const url = new URL(`${request.url.pathname}${request.url.search}`, server.url);
      return network.request({ ...request, url }, context);
    },
    openSocket: (_url, context, message, end) => network.openSocket(ws.url, context, message, end),
    close: () => network.close(),
  };
  const time = Date.now();
  const permissions = {
    verify: () =>
      Promise.resolve({
        profileId: x.options.profileId,
        account: x.adapter.account!,
        credentialRef: 'fixture-reference',
        canRead: true,
        canTrade: true,
        withdrawalEnabled: false,
        checkedAt: Date.now(),
        expiresAt: Date.now() + 10_000,
      }),
  };
  const adapter: ExchangeAdapter = createBybitAdapterWithIo(
    {
      ...x.options,
      now: Date.now,
      permissions,
      capabilities: x.options.capabilities.map((c) => ({
        ...c,
        checkedAt: time - 1,
        expiresAt: time + 30_000,
      })),
    },
    remap,
  );
  disposers.push(() => adapter.disconnect());
  const context = (ms = 2000, signal = new AbortController().signal): RequestContext => ({
    profile: adapter.profile,
    account: adapter.account,
    signal,
    deadline: Date.now() + ms,
    correlationId: 'loopback-bybit',
  });
  return {
    x,
    adapter,
    context,
    server,
    ws,
    get hangs() {
      return hangs;
    },
    get posts() {
      return posts;
    },
    get validSignatures() {
      return validSignatures;
    },
    releaseWallet() {
      hang = false;
    },
  };
}
describe('real Bybit HTTP/WS operation lifetime through Exchange Core', () => {
  it('aborts all 16 hung private requests, closes actual sockets and releases Core slots', async () => {
    const f = await loopback({ hungWallet: true });
    const controller = new AbortController(),
      context = f.context(2500, controller.signal);
    const pending = Array.from({ length: 16 }, () => f.adapter.getBalances({}, context));
    await until(() => f.hangs === 16);
    expect(await f.adapter.getBalances({}, context)).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    controller.abort();
    expect((await Promise.all(pending)).every((r) => !r.ok)).toBe(true);
    await until(() => f.server.sockets.size === 0);
    f.releaseWallet();
    expect(await f.adapter.getBalances({}, f.context())).toMatchObject({ ok: true });
    expect(f.validSignatures).toBeGreaterThan(0);
  });
  it('deadline terminates a hung HTTP body and allows later private read', async () => {
    const f = await loopback({ hungWallet: true });
    expect(await f.adapter.getBalances({}, f.context(150))).toMatchObject({
      ok: false,
      error: { code: 'DEADLINE_EXCEEDED' },
    });
    await until(() => f.server.sockets.size === 0);
    f.releaseWallet();
    expect(await f.adapter.getBalances({}, f.context())).toMatchObject({ ok: true });
  });
  it('lost real POST response remains UNKNOWN and stable client lookup finds Filled with one POST', async () => {
    const f = await loopback({ lostPost: true });
    const symbols = await f.adapter.getSymbols(
      { limit: 200, cursor: null, queryId: 'metadata' },
      f.context(),
    );
    if (!symbols.ok) throw new Error(symbols.error.code);
    const version = symbols.value.items[0]!.metadataVersion;
    const command = { ...f.x.order(), ruleVersion: version };
    f.x.state.time = Date.now();
    const permit = f.x.permit('createOrder', command);
    permit.authorization = {
      ...permit.authorization,
      profile: f.adapter.profile,
      account: f.adapter.account!,
    };
    expect(await f.adapter.createOrder(permit, f.context())).toMatchObject({ kind: 'UNKNOWN' });
    expect(
      await f.adapter.getOrder(
        { instrumentId: 'BTCUSDT', locator: { kind: 'CLIENT_ID', id: 'client-1' } },
        f.context(),
      ),
    ).toMatchObject({ ok: true, value: { kind: 'FOUND' } });
    expect(f.posts).toBe(1);
  });
  it('hung WS subscription ACK has finite deadline and no lingering sockets', async () => {
    const f = await loopback({ hungWs: true });
    expect(
      (await f.adapter.getSymbols({ limit: 200, cursor: null, queryId: 'meta' }, f.context())).ok,
    ).toBe(true);
    expect(
      await f.adapter.subscribeTicker({ instrumentId: 'BTCUSDT' }, f.context(100)),
    ).toMatchObject({ ok: false });
    await until(() => f.ws.sockets.size === 0);
  });
  it('real private WS HMAC subscribes and source closure requires resync', async () => {
    const f = await loopback();
    await f.adapter.getSymbols({ limit: 200, cursor: null, queryId: 'meta' }, f.context());
    const r = await f.adapter.subscribePrivateOrders({ instrumentId: 'BTCUSDT' }, f.context());
    if (!r.ok) throw new Error(r.error.code);
    const next = r.value[Symbol.asyncIterator]().next();
    for (const socket of f.ws.ws.clients) socket.terminate();
    expect(await next).toMatchObject({ value: { kind: 'RESYNC_REQUIRED' } });
    await until(() => f.ws.sockets.size === 0);
  });
});
