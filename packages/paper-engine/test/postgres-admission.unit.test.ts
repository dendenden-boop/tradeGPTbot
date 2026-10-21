import { createServer, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { OrderRiskPort } from '../../order-engine/src/service.js';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';

type Port = OrderRiskPort & { close(): Promise<void> };
async function factory(options: unknown): Promise<Port> {
  const create = (server as Record<string, unknown>).createPostgresPaperOrderRiskPort;
  expect(create, 'Server-owned atomic PAPER OrderRiskPort is required').toBeTypeOf('function');
  return (create as (options: unknown) => Promise<Port>)(options);
}
const connectionString = 'postgresql://paper-server:server-fixture@127.0.0.1:1/paper';

it('exports the real PAPER admission factory only on the server risk subpath', () => {
  expect(
    (server as Record<string, unknown>).createPostgresPaperOrderRiskPort,
    'Server-owned atomic PAPER OrderRiskPort is required',
  ).toBeTypeOf('function');
  expect(pure).not.toHaveProperty('createPostgresPaperOrderRiskPort');
  for (const name of ['persistPaperApproval', 'approveSnapshot', 'issuePaperGrant'])
    expect(server).not.toHaveProperty(name);
});

it.each([
  ['caller source', { source: {} }],
  ['caller snapshot', { snapshot: {} }],
  ['caller certificate', { certificate: {} }],
  ['caller evaluator', { evaluate: () => ({ kind: 'EVALUATED' }) }],
  ['caller grant', { grant: { reservationId: 'forged' } }],
  ['RPC override', { rpc: 'ctp_admission.persist' }],
  ['SQL override', { query: 'SELECT true' }],
  ['role selector', { role: 'ctp_api' }],
  ['connection/profile endpoint', { endpoint: 'https://user.invalid' }],
  ['exchange credentials', { credentials: { key: 'raw-fixture', secret: 'raw-fixture' } }],
  ['tenant authority', { tenantId: '11111111-1111-4111-8111-111111111111' }],
  ['completeness override', { complete: true }],
  ['metadata bypass', { skipMetadata: true }],
  ['loss bypass', { skipLossBaseline: true }],
  ['transport override', { client: {} }],
] as const)('rejects %s instead of opening an alternative authority path', async (_name, extra) => {
  await expect(factory({ connectionString, environment: 'test', ...extra })).rejects.toThrow(
    'PAPER_ADMISSION_DATABASE_URL',
  );
});

it.each([
  'https://user.invalid/paper',
  'postgresql://127.0.0.1/paper',
  'postgresql://paper-server:server-fixture@127.0.0.1/paper/other',
  'postgresql://paper-server:server-fixture@127.0.0.1/paper#fragment',
  'postgresql://paper-server:server-fixture@127.0.0.1/paper?options=-c%20role=ctp_api',
  'postgresql://paper-server:server-fixture@127.0.0.1/paper?sslmode=disable&sslmode=verify-full',
  'postgresql://paper-server:server-fixture@untrusted.invalid/paper',
])('rejects an invalid test database URL %s before network I/O', async (url) => {
  await expect(factory({ connectionString: url, environment: 'test' })).rejects.toThrow(
    'PAPER_ADMISSION_DATABASE_URL',
  );
});

it.each(['staging', 'production'])(
  'requires verify-full for %s database authority',
  async (environment) => {
    await expect(factory({ connectionString, environment })).rejects.toThrow(
      'PAPER_ADMISSION_DATABASE_URL',
    );
  },
);

async function blackhole() {
  const sockets = new Set<Socket>();
  let connected!: () => void;
  const accepted = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.resume();
    connected();
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw Error('fixture address');
  return {
    connectionString: `postgresql://paper-server:physical-canary@127.0.0.1:${address.port}/paper`,
    sockets,
    accepted,
    async drained() {
      const deadline = Date.now() + 1000;
      while (sockets.size && Date.now() < deadline) await delay(5);
      expect(sockets.size, 'A rejected constructor must physically close the hung operation').toBe(
        0,
      );
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

it.each(['abort', 'deadline'] as const)(
  'physically settles a hung PostgreSQL handshake after %s without grant or leaked credential',
  async (kind) => {
    const h = await blackhole(),
      controller = new AbortController(),
      start = performance.now();
    const opening = factory({
      connectionString: h.connectionString,
      environment: 'test',
      io: { signal: controller.signal, deadline: Date.now() + (kind === 'deadline' ? 250 : 2000) },
    });
    try {
      // Missing/fake factory must fail explicitly instead of hanging this test
      // waiting for a connection that no production implementation opened.
      await Promise.race([
        h.accepted,
        opening.then(async (port) => {
          await port.close();
          throw Error('PAPER_ADMISSION_CONSTRUCTOR_WITHOUT_ROLE_HANDSHAKE');
        }),
      ]);
      if (kind === 'abort') controller.abort();
      await expect(opening).rejects.toThrow('PAPER_ADMISSION_ABORTED');
      await h.drained();
      expect(performance.now() - start).toBeLessThan(1500);
      try {
        await opening;
      } catch (error) {
        expect((error as Error).message).not.toContain('physical-canary');
        expect(JSON.stringify(error)).not.toContain(h.connectionString);
      }
    } finally {
      controller.abort();
      await opening.catch(() => {});
      await h.close();
    }
  },
);

it.each(['aborted', 'expired'] as const)(
  'rejects %s constructor context without opening a socket',
  async (kind) => {
    const h = await blackhole(),
      controller = new AbortController();
    if (kind === 'aborted') controller.abort();
    try {
      await expect(
        factory({
          connectionString: h.connectionString,
          environment: 'test',
          io: {
            signal: controller.signal,
            deadline: Date.now() + (kind === 'expired' ? -1 : 1000),
          },
        }),
      ).rejects.toThrow('PAPER_ADMISSION_ABORTED');
      expect(h.sockets.size).toBe(0);
    } finally {
      await h.close();
    }
  },
);
