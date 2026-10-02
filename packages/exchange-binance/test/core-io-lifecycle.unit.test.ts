import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeCommandHash, createExchangeAdapter } from '../../exchange-core/src/adapter.js';
import type { AdapterTransport, RequestContext } from '../../exchange-core/src/adapter.js';
import { createInstrumentRegistry } from '../../exchange-core/src/registry.js';
import {
  account,
  capabilities,
  instrument,
  operationFixtures,
  profile,
  rules,
} from '../../exchange-core/test/fixtures/adapter.js';
import { createNetworkIo } from '../src/io.js';

const disposers: (() => Promise<void>)[] = [];
const WAIT_BUDGET = 2000;

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await within(dispose());
});

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('LIFECYCLE_WAIT_BUDGET_EXCEEDED')), WAIT_BUDGET);
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + WAIT_BUDGET;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('LIFECYCLE_CONDITION_NOT_MET');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const sockets = new Set<Socket>();
  let receivedRequests = 0;
  const server = createServer((request, response) => {
    receivedRequests += 1;
    handler(request, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  });
  await within(new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)));
  disposers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture`);
  const io = createNetworkIo();
  disposers.push(() => io.close());
  const registry = createInstrumentRegistry({ capacity: 4 });
  const startedAt = Date.now();
  expect(
    registry.put(
      {
        instrument,
        rules: { ...rules, effectiveAt: startedAt - 1000, expiresAt: startedAt + 60_000 },
      },
      startedAt,
    ).ok,
  ).toBe(true);
  let networkSettled = 0;
  const networkFailures: unknown[] = [];
  const request = vi.fn<AdapterTransport['request']>(async (operation, _input, context) => {
    try {
      // A test-only bridge lets real network completion control the shared adapter's slot.
      await io.request({ url, method: operation === 'createOrder' ? 'POST' : 'GET' }, context);
      return structuredClone(operationFixtures[operation].output);
    } catch (error: unknown) {
      networkFailures.push(error);
      throw error;
    } finally {
      networkSettled += 1;
    }
  });
  const authorize = vi.fn(() => Promise.resolve(true));
  const disconnect = vi.fn(() => io.close());
  const adapter = createExchangeAdapter({
    profile,
    account,
    adapterVersion: 'v1',
    registry,
    capabilities: capabilities.map((record) => ({
      ...record,
      checkedAt: startedAt - 1000,
      expiresAt: startedAt + 60_000,
    })),
    transport: {
      request,
      subscribe: () => Promise.reject(new Error('UNUSED_TEST_STREAM')),
      disconnect,
    },
    authorization: { authorize },
  });
  disposers.push(() => adapter.disconnect());
  const context = (milliseconds = 1500, signal = new AbortController().signal): RequestContext => ({
    profile,
    account,
    signal,
    deadline: Date.now() + milliseconds,
    correlationId: 'core-real-io-fixture',
  });
  const mutation = () => {
    const fixture = operationFixtures.createOrder.input;
    const issuedAt = Date.now();
    return {
      ...fixture,
      authorization: {
        ...fixture.authorization,
        issuedAt,
        expiresAt: issuedAt + 10_000,
        commandHash: computeCommandHash('createOrder', fixture.command, { profile, account }),
      },
    };
  };
  return {
    adapter,
    context,
    mutation,
    sockets,
    request,
    authorize,
    disconnect,
    networkFailures,
    received: () => receivedRequests,
    settled: () => networkSettled,
  };
}

describe('Exchange Core composed with real bounded Binance network IO', () => {
  for (const stage of ['headers', 'body'] as const) {
    it.each(['deadline', 'abort'] as const)(
      `settles 16 requests hung in ${stage} after %s and releases every pending slot`,
      async (mode) => {
        let hang = true;
        const env = await setup((_request, response) => {
          if (!hang) response.end('{}');
          else if (stage === 'body') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.write('{');
          }
        });
        const controller = new AbortController();
        const pending = Array.from({ length: 16 }, () =>
          env.adapter.getTicker(
            { instrumentId: instrument.id },
            env.context(mode === 'deadline' ? 300 : 1500, controller.signal),
          ),
        );
        await expect(
          env.adapter.getTicker({ instrumentId: instrument.id }, env.context()),
        ).resolves.toEqual({ ok: false, error: { code: 'BUSY' } });
        await until(() => env.received() === 16);
        if (mode === 'abort') controller.abort('ignored-sensitive-reason');
        const code = mode === 'deadline' ? 'DEADLINE_EXCEEDED' : 'ABORTED';
        expect(await within(Promise.all(pending))).toEqual(
          Array.from({ length: 16 }, () => ({ ok: false, error: { code } })),
        );
        await until(() => env.settled() === 16 && env.sockets.size === 0);
        expect(env.networkFailures).toHaveLength(16);
        expect(env.request).toHaveBeenCalledTimes(16);
        // Success for a full second wave proves all retained Core and IO slots are released.
        hang = false;
        const recovered = await within(
          Promise.all(
            Array.from({ length: 16 }, () =>
              env.adapter.getTicker({ instrumentId: instrument.id }, env.context()),
            ),
          ),
        );
        expect(recovered).toEqual(
          Array.from({ length: 16 }, () => ({
            ok: true,
            value: operationFixtures.getTicker.output,
          })),
        );
        await until(() => env.settled() === 32 && env.sockets.size === 0);
        expect(env.received()).toBe(32);
        expect(env.request).toHaveBeenCalledTimes(32);
      },
    );
  }

  it.each(['deadline', 'abort', 'connection-loss'] as const)(
    'reports UNKNOWN after mutation dispatch and %s without retrying the request',
    async (mode) => {
      const env = await setup((_request, response) => {
        if (mode === 'connection-loss') response.destroy();
      });
      const controller = new AbortController();
      const pending = env.adapter.createOrder(
        env.mutation(),
        env.context(mode === 'deadline' ? 200 : 1500, controller.signal),
      );
      await until(() => env.received() === 1);
      if (mode === 'abort') controller.abort();
      expect(await within(pending)).toEqual({
        kind: 'UNKNOWN',
        error: { code: 'UNKNOWN_OUTCOME' },
      });
      await until(() => env.settled() === 1 && env.sockets.size === 0);
      expect(env.authorize).toHaveBeenCalledOnce();
      expect(env.request).toHaveBeenCalledOnce();
      expect(env.received()).toBe(1);
      expect(env.networkFailures).toHaveLength(1);
    },
  );

  it.each(['abort', 'elapsed-deadline'] as const)(
    'rejects reads and mutations before dispatch on %s without network IO',
    async (mode) => {
      const env = await setup((_request, response) => response.end('{}'));
      const context = env.context(
        mode === 'elapsed-deadline' ? -1 : 1500,
        mode === 'abort'
          ? AbortSignal.abort('ignored-sensitive-reason')
          : new AbortController().signal,
      );
      const code = mode === 'abort' ? 'ABORTED' : 'DEADLINE_EXCEEDED';
      await expect(
        env.adapter.getTicker({ instrumentId: instrument.id }, context),
      ).resolves.toEqual({ ok: false, error: { code } });
      await expect(env.adapter.createOrder(env.mutation(), context)).resolves.toEqual({
        kind: 'DEFINITIVELY_REJECTED',
        error: { code },
      });
      expect(env.authorize).not.toHaveBeenCalled();
      expect(env.request).not.toHaveBeenCalled();
      expect(env.received()).toBe(0);
      expect(env.settled()).toBe(0);
      expect(env.sockets.size).toBe(0);
    },
  );

  it('disconnect terminates all underlying hung requests and sockets and stays idempotent', async () => {
    const env = await setup(() => undefined);
    const pending = Array.from({ length: 16 }, () =>
      env.adapter.getTicker({ instrumentId: instrument.id }, env.context()),
    );
    await until(() => env.received() === 16);
    await within(Promise.all([env.adapter.disconnect(), env.adapter.disconnect()]));
    expect(await within(Promise.all(pending))).toEqual(
      Array.from({ length: 16 }, () => ({ ok: false, error: { code: 'CLOSED' } })),
    );
    await until(() => env.settled() === 16 && env.sockets.size === 0);
    expect(env.disconnect).toHaveBeenCalledOnce();
    expect(env.request).toHaveBeenCalledTimes(16);
    await expect(
      env.adapter.getTicker({ instrumentId: instrument.id }, env.context()),
    ).resolves.toEqual({ ok: false, error: { code: 'CLOSED' } });
    expect(env.request).toHaveBeenCalledTimes(16);
  });
});
