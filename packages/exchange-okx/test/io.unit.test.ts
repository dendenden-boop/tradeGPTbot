import dns from 'node:dns';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNetworkIo } from '../src/io.js';
import type { IoContext, NetworkIo } from '../src/io.js';
import { httpFixture, tlsHangFixture, until, wsFixture } from './fixtures/io.js';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of disposers.splice(0).reverse()) await close();
});
function io(): NetworkIo {
  const network = createNetworkIo();
  disposers.push(() => network.close());
  return network;
}
function context(milliseconds = 2000, signal = new AbortController().signal): IoContext {
  return { signal, deadline: Date.now() + milliseconds };
}
async function http(handler: Parameters<typeof httpFixture>[0]) {
  const fixture = await httpFixture(handler);
  disposers.push(() => fixture.close());
  return fixture;
}
async function ws(handler?: Parameters<typeof wsFixture>[0]) {
  const fixture = await wsFixture(handler);
  disposers.push(() => fixture.close());
  return fixture;
}

describe('bounded real HTTP IO', () => {
  it('preserves decimal and oversized integer JSON tokens as text', async () => {
    const body = '{"price":"0.00000001","id":90071992547409931234}';
    const fixture = await http((_request, response) => {
      response.setHeader('x-mbx-used-weight-1m', '17');
      response.end(body);
    });
    const result = await io().request({ url: fixture.url, method: 'GET' }, context());
    expect(result.body).toBe(body);
    expect(result.status).toBe(200);
    expect(result.headers['x-mbx-used-weight-1m']).toBe('17');
    await until(() => fixture.sockets.size === 0);
  });
  it('sends exactly one signed request without rewriting the query or form body', async () => {
    const calls: { url: string | undefined; method: string | undefined; body: string }[] = [];
    const fixture = await http((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (body += chunk));
      request.on('end', () => {
        calls.push({ url: request.url, method: request.method, body });
        response.end('{}');
      });
    });
    const url = new URL('/order?symbol=BTCUSDT&signature=abc%2Bdef', fixture.url);
    await io().request(
      { url, method: 'POST', body: 'quantity=0.01&newClientOrderId=abc' },
      context(),
    );
    expect(calls).toEqual([
      {
        url: url.pathname + url.search,
        method: 'POST',
        body: 'quantity=0.01&newClientOrderId=abc',
      },
    ]);
  });
  it.each(['headers', 'body'] as const)(
    'destroys a request hung in %s at deadline',
    async (stage) => {
      let count = 0;
      const fixture = await http((_request, response) => {
        count += 1;
        if (stage === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{');
        }
      });
      const start = Date.now();
      await expect(
        io().request({ url: fixture.url, method: 'POST' }, context(100)),
      ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
      expect(Date.now() - start).toBeLessThan(1000);
      await until(() => fixture.sockets.size === 0);
      expect(count).toBe(1);
    },
  );
  it('does not dispatch an already aborted signal or elapsed deadline', async () => {
    let count = 0;
    const fixture = await http((_request, response) => {
      count += 1;
      response.end();
    });
    const network = io();
    await expect(
      network.request(
        { url: fixture.url, method: 'GET' },
        context(1000, AbortSignal.abort('secret')),
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(
      network.request({ url: fixture.url, method: 'GET' }, context(-1)),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(count).toBe(0);
  });
  it.each(['headers', 'body'] as const)(
    'aborts and frees all 16 slots while %s are hung',
    async (stage) => {
      let count = 0;
      let hang = true;
      const fixture = await http((_request, response) => {
        count += 1;
        if (!hang) response.end('ok');
        else if (stage === 'body') response.write('partial');
      });
      const network = io();
      const controller = new AbortController();
      const pending = Array.from({ length: 16 }, () =>
        network
          .request({ url: fixture.url, method: 'GET' }, context(2500, controller.signal))
          .catch((error: unknown) => error),
      );
      await until(() => count === 16);
      await expect(
        network.request({ url: fixture.url, method: 'GET' }, context()),
      ).rejects.toMatchObject({ code: 'BUSY' });
      controller.abort('secret');
      expect(await Promise.all(pending)).toMatchObject(
        Array.from({ length: 16 }, () => ({ code: 'ABORTED' })),
      );
      await until(() => fixture.sockets.size === 0);
      hang = false;
      expect((await network.request({ url: fixture.url, method: 'GET' }, context())).body).toBe(
        'ok',
      );
      expect(count).toBe(17);
    },
  );
  it('never follows a redirect carrying a signed query and never retries', async () => {
    let leaked = false;
    const destination = await http((_request, response) => {
      leaked = true;
      response.end();
    });
    let count = 0;
    const fixture = await http((_request, response) => {
      count += 1;
      response.writeHead(307, { location: destination.url.href }).end();
    });
    const result = await io().request(
      { url: new URL('/?signature=secret', fixture.url), method: 'POST' },
      context(),
    );
    expect(result.status).toBe(307);
    expect(count).toBe(1);
    expect(leaked).toBe(false);
  });
  it.each(['declared', 'streamed'] as const)('bounds a %s oversized body', async (kind) => {
    const fixture = await http((_request, response) => {
      if (kind === 'declared') response.setHeader('content-length', 2 * 1024 * 1024 + 1);
      response.end(Buffer.alloc(2 * 1024 * 1024 + 1, 97));
    });
    await expect(
      io().request({ url: fixture.url, method: 'GET' }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await until(() => fixture.sockets.size === 0);
  });
  it('bounds response headers and suppresses Node parser details', async () => {
    const fixture = await http((_request, response) => {
      response.setHeader('x-secret', 'x'.repeat(17 * 1024));
      response.end();
    });
    await expect(
      io().request({ url: fixture.url, method: 'GET' }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects truncated bodies without a retry', async () => {
    let count = 0;
    const fixture = await http((_request, response) => {
      count += 1;
      response.writeHead(200, { 'content-length': '100' });
      response.write('partial');
      setTimeout(() => response.destroy(), 10);
    });
    await expect(
      io().request({ url: fixture.url, method: 'DELETE' }, context()),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(count).toBe(1);
  });
  it('destroys an HTTP request when DNS lookup never calls back', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(() => undefined);
    const network = io();
    await expect(
      network.request(
        { url: new URL('https://never-resolved.invalid'), method: 'GET' },
        context(100),
      ),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(lookup).toHaveBeenCalledTimes(1);
    await network.close();
  });
  it.each(['abort', 'deadline'] as const)(
    'destroys an HTTPS request stuck in TLS handshake after %s',
    async (mode) => {
      const fixture = await tlsHangFixture();
      disposers.push(() => fixture.close());
      const controller = new AbortController();
      const pending = io()
        .request(
          { url: fixture.url, method: 'GET' },
          context(mode === 'deadline' ? 100 : 2000, controller.signal),
        )
        .catch((error: unknown) => error);
      await until(() => fixture.bytes > 0);
      if (mode === 'abort') controller.abort();
      expect(await pending).toMatchObject({
        code: mode === 'abort' ? 'ABORTED' : 'DEADLINE_EXCEEDED',
      });
      await until(() => fixture.sockets.size === 0);
    },
  );
  it('rejects malformed UTF-8 instead of silently replacing bytes in JSON', async () => {
    const fixture = await http((_request, response) => response.end(Buffer.from([0xc3, 0x28])));
    await expect(
      io().request({ url: fixture.url, method: 'GET' }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('does not expose signed URLs, API keys, bodies, or raw Node errors', async () => {
    const fixture = await http((_request, response) => response.end());
    const failure: unknown = await io()
      .request(
        {
          url: new URL('/order?signature=URL_SECRET_SENTINEL', fixture.url),
          method: 'POST',
          headers: { 'x-api-key': 'KEY_SECRET_SENTINEL\r\ninjection' },
          body: 'BODY_SECRET_SENTINEL',
        },
        context(),
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'INVALID_RESPONSE', message: 'INVALID_RESPONSE' });
    expect(String(failure)).not.toContain('SECRET');
    expect(JSON.stringify(failure)).toBe('{"code":"INVALID_RESPONSE"}');
  });
  it('close aborts outstanding requests, closes sockets, and remains idempotent', async () => {
    const fixture = await http(() => undefined);
    const network = io();
    const pending = network
      .request({ url: fixture.url, method: 'GET' }, context())
      .catch((error: unknown) => error);
    await until(() => fixture.sockets.size === 1);
    await Promise.all([network.close(), network.close()]);
    expect(await pending).toMatchObject({ code: 'CLOSED' });
    await until(() => fixture.sockets.size === 0);
    await expect(
      network.request({ url: fixture.url, method: 'GET' }, context()),
    ).rejects.toMatchObject({ code: 'CLOSED' });
  });
  it.each([NaN, Infinity, 1.5, Date.now() + 60_000])(
    'rejects invalid or excessive deadline %s',
    async (deadline) => {
      await expect(
        io().request(
          { url: new URL('http://127.0.0.1:1'), method: 'GET' },
          { ...context(), deadline },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    },
  );
  it.each(['file:///etc/passwd', 'http://user:secret@127.0.0.1:1', 'http://127.0.0.1:1/#secret'])(
    'rejects an invalid internal URL %s without exposing it',
    async (url) => {
      await expect(
        io().request({ url: new URL(url), method: 'GET' }, context()),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    },
  );
});

describe('bounded real WebSocket IO', () => {
  it.each(['native handshake timeout', 'expired deadline before timer dispatch'] as const)(
    'classifies %s and physically releases the handshake socket',
    async (mode) => {
      const fixture = await http(() => undefined);
      fixture.server.on('upgrade', (_request, socket) => {
        socket.on('end', () => socket.end());
        socket.resume();
      });
      const url = new URL(fixture.url);
      url.protocol = 'ws:';
      const registrations = vi.spyOn(WebSocket.prototype, 'on');
      const network = io();
      const ctx = context();
      const end = vi.fn();
      const pending = network.openSocket(url, ctx, vi.fn(), end).catch((e: unknown) => e);
      await until(() => fixture.sockets.size === 1);
      const socket = registrations.mock.instances.find((s) => s instanceof WebSocket);
      expect(socket).toBeDefined();
      const clock =
        mode === 'expired deadline before timer dispatch'
          ? vi.spyOn(Date, 'now').mockReturnValue(ctx.deadline + 1)
          : undefined;
      socket!.emit(
        'error',
        new Error(
          mode === 'native handshake timeout'
            ? 'Opening handshake has timed out'
            : 'connection lost',
        ),
      );
      clock?.mockRestore();
      expect(await pending).toMatchObject({ code: 'DEADLINE_EXCEEDED' });
      await until(() => fixture.sockets.size === 0);
      expect(end).toHaveBeenCalledTimes(1);
      const healthy = await ws();
      const next = await network.openSocket(healthy.url, context(), vi.fn(), vi.fn());
      await next.close();
    },
  );
  it('exchanges text messages and automatically answers server pings', async () => {
    let pong = false;
    const fixture = await ws((socket) => {
      socket.on('message', (data) => socket.send(data, { binary: false }));
      socket.on('pong', () => {
        pong = true;
      });
      socket.ping('heartbeat');
    });
    const messages: string[] = [];
    const ended = vi.fn();
    const connection = await io().openSocket(
      fixture.url,
      context(),
      (text) => messages.push(text),
      ended,
    );
    await connection.send('{"method":"SUBSCRIBE"}');
    await until(() => messages.length === 1 && pong);
    expect(messages).toEqual(['{"method":"SUBSCRIBE"}']);
    await connection.close();
    expect(ended).toHaveBeenCalledTimes(1);
  });
  it.each(['abort', 'deadline'] as const)(
    'settles a hung handshake after %s and destroys its HTTP socket',
    async (mode) => {
      const fixture = await http(() => undefined);
      fixture.server.on('upgrade', (_request, socket) => {
        socket.on('end', () => socket.end());
        socket.resume();
      });
      const url = new URL(fixture.url);
      url.protocol = 'ws:';
      const controller = new AbortController();
      const end = vi.fn();
      const pending = io()
        .openSocket(url, context(mode === 'deadline' ? 100 : 2000, controller.signal), vi.fn(), end)
        .catch((error: unknown) => error);
      await until(() => fixture.sockets.size === 1);
      if (mode === 'abort') controller.abort('secret');
      expect(await pending).toMatchObject({
        code: mode === 'abort' ? 'ABORTED' : 'DEADLINE_EXCEEDED',
      });
      await until(() => fixture.sockets.size === 0);
      expect(end).toHaveBeenCalledTimes(1);
    },
  );
  it('settles a WebSocket DNS handshake that never calls back', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(() => undefined);
    const end = vi.fn();
    await expect(
      io().openSocket(new URL('wss://never-resolved.invalid'), context(100), vi.fn(), end),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
  it('cannot reopen or emit a late handshake after an abort', async () => {
    const fixture = await http(() => undefined);
    let upgraded = false;
    let lateAttempt = false;
    let wasDestroyed = false;
    fixture.server.on('upgrade', (_request, socket) => {
      upgraded = true;
      socket.on('end', () => socket.end());
      socket.resume();
      setTimeout(() => {
        lateAttempt = true;
        wasDestroyed = socket.destroyed;
        socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
      }, 100);
    });
    const url = new URL(fixture.url);
    url.protocol = 'ws:';
    const controller = new AbortController();
    const message = vi.fn();
    const end = vi.fn();
    const pending = io()
      .openSocket(url, context(2000, controller.signal), message, end)
      .catch((error: unknown) => error);
    await until(() => upgraded);
    controller.abort();
    expect(await pending).toMatchObject({ code: 'ABORTED' });
    await until(() => lateAttempt);
    expect(wasDestroyed).toBe(true);
    expect(message).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });
  it('settles a secure WebSocket hung in TLS handshake', async () => {
    const fixture = await tlsHangFixture();
    disposers.push(() => fixture.close());
    const url = new URL(fixture.url);
    url.protocol = 'wss:';
    const end = vi.fn();
    await expect(io().openSocket(url, context(100), vi.fn(), end)).rejects.toMatchObject({
      code: 'DEADLINE_EXCEEDED',
    });
    await until(() => fixture.sockets.size === 0);
    expect(fixture.bytes).toBeGreaterThan(0);
    expect(end).toHaveBeenCalledTimes(1);
  });
  it.each(['abort', 'deadline'] as const)('terminates an open socket after %s', async (mode) => {
    const fixture = await ws();
    const controller = new AbortController();
    const end = vi.fn();
    const connection = await io().openSocket(
      fixture.url,
      context(mode === 'deadline' ? 100 : 2000, controller.signal),
      vi.fn(),
      end,
    );
    if (mode === 'abort') controller.abort();
    await until(() => end.mock.calls.length === 1 && fixture.sockets.size === 0);
    await expect(connection.send('late')).rejects.toMatchObject({ code: 'CLOSED' });
  });
  it('bounds graceful close when the server never answers a close frame', async () => {
    const fixture = await ws((socket) => socket.pause());
    const end = vi.fn();
    const connection = await io().openSocket(fixture.url, context(), vi.fn(), end);
    const start = Date.now();
    await Promise.all([connection.close(), connection.close()]);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(end).toHaveBeenCalledTimes(1);
  });
  it.each(['binary', 'oversized'] as const)(
    'closes on %s frames without emitting data',
    async (kind) => {
      const fixture = await ws();
      const received = vi.fn();
      const end = vi.fn();
      await io().openSocket(fixture.url, context(), received, end);
      for (const socket of fixture.ws.clients)
        socket.send(kind === 'binary' ? Buffer.from('secret') : 'x'.repeat(1024 * 1024 + 1));
      await until(() => end.mock.calls.length === 1 && fixture.sockets.size === 0);
      expect(received).not.toHaveBeenCalled();
    },
  );
  it('contains a throwing consumer callback and closes the connection', async () => {
    const fixture = await ws();
    const end = vi.fn();
    await io().openSocket(
      fixture.url,
      context(),
      () => {
        throw new Error('secret');
      },
      end,
    );
    for (const socket of fixture.ws.clients) socket.send('{}');
    await until(() => end.mock.calls.length === 1 && fixture.sockets.size === 0);
  });
  it('refuses outbound frames above the 64KiB queue budget', async () => {
    const fixture = await ws();
    const connection = await io().openSocket(fixture.url, context(), vi.fn(), vi.fn());
    await expect(connection.send('x'.repeat(65537))).rejects.toMatchObject({ code: 'BUSY' });
    await connection.send('ok');
  });
  it('bounds concurrent sends and their aggregate bytes before send callbacks settle', async () => {
    const fixture = await ws();
    const connection = await io().openSocket(fixture.url, context(), vi.fn(), vi.fn());
    const pending = Array.from({ length: 16 }, () => connection.send('a'));
    await expect(connection.send('a')).rejects.toMatchObject({ code: 'BUSY' });
    await Promise.all(pending);
    const large = connection.send('a'.repeat(40 * 1024));
    await expect(connection.send('b'.repeat(40 * 1024))).rejects.toMatchObject({ code: 'BUSY' });
    await large;
  });
  it('bounds sockets at 16 and releases slots after abort', async () => {
    const fixture = await ws();
    const network = io();
    const controller = new AbortController();
    const sockets = await Promise.all(
      Array.from({ length: 16 }, () =>
        network.openSocket(fixture.url, context(2500, controller.signal), vi.fn(), vi.fn()),
      ),
    );
    await expect(
      network.openSocket(fixture.url, context(), vi.fn(), vi.fn()),
    ).rejects.toMatchObject({ code: 'BUSY' });
    controller.abort();
    await Promise.all(sockets.map((socket) => socket.close()));
    await until(() => fixture.sockets.size === 0);
    await network.openSocket(fixture.url, context(), vi.fn(), vi.fn());
  });
  it('never follows handshake redirects', async () => {
    let leaked = false;
    const destination = await ws(() => {
      leaked = true;
    });
    let count = 0;
    const fixture = await http((_request, response) => {
      count += 1;
      response.writeHead(302, { location: destination.url.href }).end();
    });
    const url = new URL(fixture.url);
    url.protocol = 'ws:';
    await expect(io().openSocket(url, context(), vi.fn(), vi.fn())).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(leaked).toBe(false);
    expect(count).toBe(1);
  });
  it('close rejects new sockets and terminates all live sockets exactly once', async () => {
    const fixture = await ws();
    const network = io();
    const end = vi.fn();
    await network.openSocket(fixture.url, context(), vi.fn(), end);
    await Promise.all([network.close(), network.close()]);
    await until(() => fixture.sockets.size === 0);
    expect(end).toHaveBeenCalledTimes(1);
    await expect(network.openSocket(fixture.url, context(), vi.fn(), end)).rejects.toMatchObject({
      code: 'CLOSED',
    });
  });
});
